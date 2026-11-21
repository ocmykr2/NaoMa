(() => {
  "use strict";
  const hashKey=/^[a-f0-9]{64}$/;
  const bundles=new Set(["intervals"]);
  const isBundle=id=>bundles.has(id);
  const paperChoice=id=>isBundle(id)?id:"doc-"+id;
  const removable=id=>isBundle(id) || (typeof id==="string" && hashKey.test(id));
  const prefix="proofreader.generation.";
  const pendingPrefix="proofreader.removing.";
  const ongoing=new Map();
  function validate(hash) {
    if (!removable(hash)) throw new Error("Select a paper from your library to remove.");
  }
  function generation(hash) {
    try {return localStorage.getItem(prefix+hash) || "";} catch {return "";}
  }
  // Re-uploaded PDFs use their own hash even when the bytes match a bundled paper.
  const isBundleHidden=id=>isBundle(id) && !!generation(id);
  function parse(value) {
    try {return JSON.parse(value);} catch {return null;}
  }
  async function evidence(hash,current) {
    validate(hash);
    const [prepared,backup]=await Promise.all([window.PAPER_LIBRARY.getPreparation(hash),
      window.PAPER_LIBRARY.getPreparation("study/"+hash)]);
    const analysisKeys=new Set(),planKeys=new Set();
    const add=(set,key)=>{if (typeof key==="string" && hashKey.test(key)) set.add(key);};
    const available=current || window.READER_SESSION?.session?.(hash);
    for (const research of [prepared,available?.research,parse(localStorage.getItem("proof.research."+hash)),
      parse(sessionStorage.getItem("proof.preparation."+hash))]) add(analysisKeys,research?.key);
    for (const state of [backup,{study:available?.study,plans:available?.studyPlans},
      parse(localStorage.getItem("proof.study."+hash)),parse(sessionStorage.getItem("proof.study."+hash))]) {
      for (const plan of [state?.study,...Object.values(state?.plans || {})]) {
        add(planKeys,plan?.key);
        add(planKeys,plan?.orientationJob?.key);
        add(analysisKeys,plan?.analysisKey);
      }
    }
    const sectionKeys=[...new Set(window.READER_SESSION?.sectionKeys?.(hash) || [])].filter(key=>hashKey.test(key));
    return {analysisKeys:[...analysisKeys],planKeys:[...planKeys],sectionKeys};
  }
  function clearSession(hash) {
    const choice=paperChoice(hash),previous=parse(sessionStorage.getItem("proofreader.lastImport"));
    const reader=parse(sessionStorage.getItem("proofreader.reading"));
    if (previous?.hash===hash) sessionStorage.removeItem("proofreader.lastImport");
    if (reader?.paperId===choice || (reader?.paperId==="import" && previous?.hash===hash)) sessionStorage.removeItem("proofreader.reading");
    for (const kind of ["preparation","questions","study"]) sessionStorage.removeItem("proof."+kind+"."+hash);
    const checkPrefix="proofreader.optionalCheck.";
    for (let i=sessionStorage.length-1;i>=0;i--) {
      const key=sessionStorage.key(i);
      if (!key?.startsWith(checkPrefix)) continue;
      const context=parse(key.slice(checkPrefix.length)),part=Array.isArray(context)?parse(context[0]):null;
      if (Array.isArray(part) && part[0]===hash) sessionStorage.removeItem(key);
    }
  }
  function notify(hash) {
    clearSession(hash);
    window.READER_SESSION?.forget?.(hash);
    window.dispatchEvent(new CustomEvent("proofreader-paper-removed",{detail:{hash}}));
  }
  async function finishRemoval(hash,token) {
    if (!isBundle(hash)) await window.PDF_READER.removeIfMatching(hash,token);
    await window.PAPER_LIBRARY.remove(hash,token);
    const profile=parse(localStorage.getItem("proofreader.knowledge"));
    let changed=false;
    for (const field of ["definitionChoices","paperTechniqueChoices"]) {
      if (!Array.isArray(profile?.[field])) continue;
      const keep=profile[field].filter(entry=>{
        const id=Array.isArray(entry)?parse(entry[0]):null;
        return !Array.isArray(id) || id[0]!==hash;
      });
      if (keep.length!==profile[field].length) {
        profile[field]=keep;
        changed=true;
      }
    }
    if (changed) localStorage.setItem("proofreader.knowledge",JSON.stringify(profile));
    for (const kind of ["research","study","tutor"]) localStorage.removeItem("proof."+kind+"."+hash);
    const choice=paperChoice(hash);
    localStorage.removeItem("proofreader.partLocation."+choice);
    if (localStorage.getItem("proofreader.lastPaper")===choice) localStorage.removeItem("proofreader.lastPaper");
    localStorage.setItem(prefix+hash,token);
    localStorage.removeItem(pendingPrefix+hash);
    notify(hash);
  }
  function remove(hash,pendingToken) {
    validate(hash);
    if (ongoing.has(hash)) return ongoing.get(hash);
    const starting=generation(hash);
    async function run() {
      const key=pendingPrefix+hash;
      let token=localStorage.getItem(key);
      if ((pendingToken && pendingToken!==token) || (!token && starting!==generation(hash))) return;
      if (token && generation(hash)===token) {
        localStorage.removeItem(key);
        notify(hash);
        return;
      }
      if (!token) {
        token=crypto.randomUUID();
        // Each affected database records the same token inside its deletion transaction.
        localStorage.setItem(key,token);
      }
      await finishRemoval(hash,token);
    }
    const locks=window.navigator?.locks;
    const task=(locks?locks.request(pendingPrefix+hash,run):run()).finally(()=>ongoing.delete(hash));
    ongoing.set(hash,task);
    return task;
  }
  async function resumePending(hash) {
    if (hash) {
      validate(hash);
      const token=localStorage.getItem(pendingPrefix+hash);
      if (token) await remove(hash,token);
      return;
    }
    const interrupted=[];
    for (let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);
      if (key?.startsWith(pendingPrefix) && removable(key.slice(pendingPrefix.length))) interrupted.push(key.slice(pendingPrefix.length));
    }
    await Promise.all(interrupted.map(id=>resumePending(id)));
  }
  window.addEventListener("storage",event=>{
    if (!event.key?.startsWith(prefix) || !event.newValue) return;
    const hash=event.key.slice(prefix.length);
    if (removable(hash) && event.newValue===generation(hash)) notify(hash);
  });
  window.PAPER_REMOVAL={evidence,remove,generation,resumePending,isBundle,isBundleHidden};
})();
