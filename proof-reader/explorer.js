(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function action(text, handler, className = "ghost") {
    const node = element("button",text,className);
    node.type = "button";
    node.addEventListener("click",handler);
    return node;
  }
  const briefTopic = "paper-overview";
  const busy = t => t && (t.status === "starting" || t.status === "running");
  const failed = t => t && (t.status === "failed" || t.status === "error");

  function create({state,openTopic,openSource,openPart,showTechnique,source,markSkill}) {
    const drafts = new Map();
    const session = window.READER_SESSION;
    const composer = byId("overviewText");
    const form = byId("overviewForm");
    const draftKey = s => [s.key,s.editionKey || "",s.topic].join("/");
    function ask(question, topic, retryTurn) {
      const s = state();
      session.ask(s.key,source,{question,topic,step:0,retryTurn,known:s.known,readPapers:s.readPapers,
        stepSkills:s.skills.slice(0,200),readerKnowledge:s.readerKnowledge});
    }
    function submit(raw, suggestion, retryTurn) {
      const question = raw.trim();
      if (!question) { composer.focus(); return; }
      const s = state();
      if (!s.overview) return;
      if (s.turns.some(t => s.topic && t.topic === s.topic && busy(t))) return;
      const topic = s.topic || crypto.randomUUID();
      if (!retryTurn) drafts.delete(draftKey(s));
      if (!s.topic) openTopic(topic);
      if (suggestion?.answer && !s.notationEdition) {
        session.addPrepared(s.key,{topic,step:0,question,answer:suggestion.answer,
          sourceStep:suggestion.step,experiment:suggestion.experiment,followups:suggestion.followups || []});
      } else ask(question,topic,retryTurn);
    }
    form.addEventListener("submit",event => {
      event.preventDefault();
      submit(composer.value);
      composer.focus({preventScroll:true});
    });
    composer.addEventListener("input",() => drafts.set(draftKey(state()),composer.value));
    composer.addEventListener("keydown",event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        if (!byId("overviewSend").disabled) form.requestSubmit();
      }
    });
    function paragraphs(host, value) {
      const parts = Array.isArray(value) ? value : value.split(/\n\s*\n/);
      for (const p of parts.filter(Boolean)) host.append(element("p",p));
    }
    function familiarQuestion(s, index) {
      const transfer = s.transferQuestion(index);
      if (transfer) return transfer;
      const sources = s.stepTechniques(index+1).flatMap(t => t.sources.map(source => source.paperId));
      const entry = s.entries.find(e => sources.includes(e.id) && e.steps.includes(index+1) && s.isRead(e));
      if (entry) return {question:"What changes from " + (entry.shortCitation || entry.title) + " here?",
        answer:entry.connection + "\n\n" + entry.difference,step:index+1};
      return null;
    }
    function renderTurn(turn, s) {
      const article = element("article",null,"exploration-turn");
      article.append(element("p",turn.question,"exploration-question"));
      if (failed(turn)) {
        article.append(element("p",turn.error || turn.message || "The answer could not be loaded."),
          action("Try again",() => submit(turn.question,null,turn)));
      }
      if (turn.status !== "ready") return article;
      const answer = element("div",null,"exploration-answer");
      paragraphs(answer,turn.answer);
      article.append(answer);
      const index = turn.sourceStep - 1;
      const unit = s.steps[index];
      const links = element("div",null,"exploration-links");
      if (unit) {
        const label = unit.page ? "Source passage · p. " + unit.page : "Read the source passage";
        links.append(action(label,() => openSource(index),"path-link"));
        for (const part of s.partsForStep(index+1)) {
          links.append(action("Discuss " + part.title,() => openPart(part.id),"path-link"));
        }
        const choices = s.stepTechniques(index+1);
        const method = choices.find(t => t.name === turn.discussedSkill) || choices[0];
        if (method) links.append(action(s.techniqueLabel(method),() => showTechnique(method),"path-link"));
      }
      const discussed = s.namedTechnique(turn.discussedSkill);
      if (discussed) {
        const skill = discussed.name;
        const label = element("label",null,"turn-check");
        const input = element("input");
        input.type = "checkbox";
        input.checked = s.isKnown(skill);
        input.addEventListener("change",() => {
          markSkill(skill,input.checked);
          const updated = [...byId("overviewTurns").querySelectorAll("input")];
          updated.find(c => c.dataset.skill === skill)?.focus({preventScroll:true});
        });
        input.dataset.skill = skill;
        label.append(input,document.createTextNode("I understand " + s.techniqueLabel(discussed)));
        links.append(label);
      }
      if (links.childElementCount) article.append(links);
      return article;
    }
    function render() {
      const s = state();
      const topics = new Map();
      for (const t of s.turns) {
        if (t.topic && t.topic !== briefTopic && !topics.has(t.topic)) topics.set(t.topic,t.question);
      }
      const turns = s.topic ? s.turns.filter(t => t.topic === s.topic) : [];
      const body = byId("overviewBody");
      const log = byId("overviewTurns");
      const dock = byId("threadDock");
      body.replaceChildren(); log.replaceChildren(); dock.replaceChildren();
      body.hidden = !!s.topic;
      let suggestions = s.overview.suggestions || [];
      if (!s.topic) {
        paragraphs(body,s.overview.paragraphs);
        let bridge;
        if (!s.notationEdition && (s.known.length || s.readPapers.length)) {
          for (let i = 0; !bridge && i < s.steps.length; i++) bridge = familiarQuestion(s,i);
        }
        if (bridge) suggestions = [...suggestions.slice(0,2),bridge];
        if (!s.notationEdition && s.readerKnowledge.definitionGroups.some(g => g.state === "partial")) {
          const index = s.steps.findIndex((_,i) => s.definitionQuestion(i));
          if (index !== -1) suggestions = [suggestions[0],s.definitionQuestion(index),bridge || suggestions[1]].filter(Boolean);
        }
        if (topics.size) {
          dock.append(element("p","Your questions","thread-label"));
          for (const [id,q] of [...topics].reverse()) dock.append(action(q,() => openTopic(id),"thread-link"));
        }
      } else {
        log.append(...turns.map(t => renderTurn(t,s)));
        const last = turns.at(-1);
        suggestions = (last?.followups || []).map(question => ({question}));
        if (last?.status === "ready") {
          const index = last.sourceStep - 1;
          const asked = new Set(turns.map(t => t.question));
          if (!s.notationEdition && !suggestions.length && s.steps[index]) {
            suggestions = s.steps[index].options.map(o => ({question:o.label}));
          }
          const bridge = !s.notationEdition && familiarQuestion(s,index);
          if (bridge) suggestions = [bridge,...suggestions];
          const review = !s.notationEdition && s.definitionQuestion(index);
          if (review) suggestions.splice(bridge ? 1 : 0,0,review);
          suggestions = suggestions.filter(q => !asked.has(q.question));
        }
      }
      const active = turns.some(busy);
      byId("overviewSuggestions").replaceChildren(...(active ? [] : suggestions.slice(0,3))
        .map(q => action(q.question,() => submit(q.question,q),"suggestion")));
      const draft = drafts.get(draftKey(s)) || "";
      if (composer.value !== draft) composer.value = draft;
      composer.placeholder = s.topic ? "Ask a follow-up…" : "What would you like to understand?";
      byId("overviewSend").disabled = active;
      byId("overviewStatus").textContent = active ? "Reading the paper…" : "";
      window.READER_MATH?.render(byId("overviewPanel"));
    }
    return {render};
  }
  window.PAPER_EXPLORER = {create};
})();
