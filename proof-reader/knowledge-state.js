(() => {
  "use strict";
  const {techniqueKey,TechniqueSet} = window.READING_PLAN;
  // Preserve references bookmarked from the earlier paper-card view.
  function oldPassageId(paper) {
    const title = paper.title.trim().normalize("NFKC").toLowerCase();
    const fields = JSON.stringify([paper.id,title,paper.url,paper.locator,paper.relation,[...(paper.steps || [])].sort((a,b) => a-b)]);
    let hash = 14695981039346656037n;
    for (let i = 0; i < fields.length; i++) hash = BigInt.asUintN(64,(hash ^ BigInt(fields.charCodeAt(i))) * 1099511628211n);
    const slug = String(paper.id || paper.title).toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,40).replace(/^-+|-+$/g,"") || "passage";
    return "lit-ref-" + slug + "-" + hash.toString(36);
  }

  function create(profile, legacy) {
    const old = new TechniqueSet(legacy);
    const mastery = new Map(profile.mastery || []);
    const linkedSources = new Map(profile.linkedTechniqueSources || []);
    const groups = new Map(profile.definitionChoices || []);
    // Unfamiliar choices stay with this paper. A checked draft becomes shared
    // mastery when the reader confirms the preflight.
    const paperTechniques = new Map(profile.paperTechniqueChoices || []);
    const itemKey = (paper,item) => JSON.stringify([paper,item.id]);
    function keys(technique,papers) {
      const name = techniqueKey(technique.name);
      if (technique.folklore) return [JSON.stringify(["folklore",name])];
      return technique.sources.map(source => papers.find(p => p.id === source.paperId)).filter(Boolean)
        .map(p => JSON.stringify([techniqueKey(p.title),name]));
    }
    function isKnown(technique,papers,paper) {
      const choice = paperTechniques.get(itemKey(paper,technique));
      if (typeof choice === "boolean") return choice;
      const values = keys(technique,papers).filter(key => mastery.has(key));
      if (values.length) return values.some(key => mastery.get(key));
      return [technique.name,...(technique.aliases || [])].some(name => old.has(name));
    }
    function setKnown(technique,papers,value,paper) {
      paperTechniques.delete(itemKey(paper,technique));
      // One technique can cite A and B here and cite only A in another paper.
      // Changing its status in either place should update the same choice.
      const equivalent = new Set(keys(technique,papers));
      for (const key of equivalent) {
        for (const other of linkedSources.get(key) || []) equivalent.add(other);
      }
      const sources = [...equivalent];
      for (const key of sources) {
        mastery.set(key,value);
        if (sources.length > 1) linkedSources.set(key,sources);
      }
    }
    function setPreflightKnown(paper,technique,value) {
      paperTechniques.set(itemKey(paper,technique),value);
    }
    function confirmPreflightKnown(paper,techniques,papers) {
      let changed = false;
      for (const t of techniques) {
        if (paperTechniques.get(itemKey(paper,t)) !== true) continue;
        setKnown(t,papers,true,paper);
        changed = true;
      }
      return changed;
    }
    function groupChoice(paper,group) {
      const saved = groups.get(itemKey(paper,group));
      const terms = group.definitions.map(d => d.term);
      const selected = saved ? terms.filter(t => saved.terms.includes(t)) :
        group.definitions.filter(d => [d.term,...(d.aliases || [])].some(term => old.has(term))).map(d => d.term);
      const state = terms.length && selected.length === terms.length ? "known" :
        selected.length || saved?.state === "partial" || saved?.state === "known" ? "partial" : "unfamiliar";
      return {state,terms:selected};
    }
    function setGroup(paper,group,state) {
      const current = groupChoice(paper,group);
      const terms = state === "known" ? group.definitions.map(d => d.term) :
        state === "partial" && current.state === "partial" ? current.terms : [];
      groups.set(itemKey(paper,group),{state,terms});
    }
    function setTerm(paper,group,term,value) {
      if (!group.definitions.some(d => d.term === term)) return;
      const terms = new Set(groupChoice(paper,group).terms);
      if (value) terms.add(term); else terms.delete(term);
      groups.set(itemKey(paper,group),{state:terms.size === group.definitions.length ? "known" : "partial",terms:[...terms]});
    }
    function tutor(paper,knowledge,papers) {
      const techniques = knowledge.techniques.filter(t => isKnown(t,papers,paper)).map(t => ({
        name:t.name,mechanism:t.mechanism,knownBridge:t.knownBridge,
        sources:[...new Set(t.sources.map(s => papers.find(p => p.id === s.paperId)?.citeKey).filter(Boolean))]
      }));
      const definitionGroups = [];
      for (const g of knowledge.definitionGroups) {
        const choice = groupChoice(paper,g);
        if (choice.state !== "unfamiliar") definitionGroups.push({title:g.title,state:choice.state,knownTerms:choice.terms,
          remainingTerms:g.definitions.map(d => d.term).filter(t => !choice.terms.includes(t))});
      }
      return {techniques,definitionGroups};
    }
    function forgetPaper(paper) {
      for (const choices of [groups,paperTechniques]) {
        for (const key of choices.keys()) {
          try { if (JSON.parse(key)[0]===paper) choices.delete(key); } catch { /* Older unrelated choice. */ }
        }
      }
    }
    return {isKnown,setKnown,setPreflightKnown,confirmPreflightKnown,groupChoice,setGroup,setTerm,tutor,forgetPaper,
      serialize:() => ({mastery:[...mastery],linkedTechniqueSources:[...linkedSources],definitionChoices:[...groups],paperTechniqueChoices:[...paperTechniques]})};
  }
  window.READER_KNOWLEDGE = {create,oldPassageId};
})();
