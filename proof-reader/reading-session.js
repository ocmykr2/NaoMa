(() => {
  "use strict";

  function read(storage, key, fallback) {
    try { return JSON.parse(storage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  function write(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function pdfBytes(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("Could not read the original PDF."));
      reader.readAsDataURL(blob);
    });
  }
  async function request(url, args) {
    if (location.protocol === "file:") throw new Error("Open the local app to use Codex.");
    // Each request only transfers a document or reads one status snapshot. The
    // background generation has its own lifetime and may outlive any request.
    const timeout=args?.method==="POST" ? 60000 : 20000;
    const signal=typeof AbortSignal!=="undefined" && AbortSignal.timeout?.(timeout);
    let res;
    try { res=await fetch(url,signal ? {...args,signal} : args); }
    catch { throw Object.assign(new Error("The local reading service did not respond. Retry to reconnect."),{disconnected:true}); }
    let body;
    try { body = await res.json(); }
    catch {
      if (!res.ok) throw Object.assign(new Error("The local reading service returned an error. Try again."),{status:res.status});
      throw Object.assign(new Error("The local reading service did not finish its response. Retry to reconnect."),{disconnected:true});
    }
    if (!res.ok) throw Object.assign(new Error(body.error || body.message || "The agent request failed. Try again."),
      {status:res.status,needsAction:body.needsAction===true,actionRequired:body.actionRequired,
        unexpected:body.unexpected===true,failureStage:body.failureStage,failureCode:body.failureCode});
    return body;
  }
  async function post(url,payload) {
    const args={method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)};
    try { return await request(url,args); }
    catch (error) {
      // All four job endpoints deduplicate an identical submission. The first
      // request can have reached the service even if its reply never arrived.
      if (!error.disconnected) throw error;
      return request(url,args);
    }
  }
  const planDiagnostics=key=>request("/api/reading-plan/"+encodeURIComponent(key)+"/diagnostics");

  const connections = new Map();
  const polling = new Map();
  const restores = new Map();
  const studyRestores = new Map();
  const studyJobs = new Map();
  const checkedFailedPlans = new WeakMap();
  const studyWakeups = new WeakSet();
  const studyChannel=window.BroadcastChannel && new window.BroadcastChannel("proof.study.updates");
  const orientationJobs = new Map();
  const referenceSources = new Map();
  const pendingSelections = new Map();
  const sectionFormat = 4;
  const notify = (key, change) => window.dispatchEvent(new CustomEvent("reading-session-update", {detail:{key,change}}));
  const material = ["papers","skills","overview","knowledge","displayTitle","preparationVersion","parts","localIntroductions"];
  const generation = key => window.PAPER_REMOVAL?.generation(key) || "";
  function forget(key) {
    connections.delete(key);
    restores.delete(key);
    studyRestores.delete(key);
    pendingSelections.delete(key);
  }
  function currentConnection(key,data) {
    return connections.get(key)===data && data.generation===generation(key);
  }
  function scoped(record,epoch) {
    return (record?.generation || "")===epoch ? record : null;
  }

  function isPrepared(job) {
    const paras = job?.overview?.paragraphs;
    const questions = job?.overview?.suggestions;
    return job?.status === "ready" && job.preparationVersion === 2 && Array.isArray(job.parts) && job.parts.length > 0 &&
      job.parts.every(p => p?.id && p.title && Array.isArray(p.sourceSteps) && p.sourceSteps.length) &&
      Array.isArray(job.localIntroductions) && typeof job.displayTitle === "string" &&
      /\p{Script=Latin}/u.test(job.displayTitle) && job.displayTitle.length <= 500 &&
      !/[\u0000-\u001f\u007f\u2028\u2029]|\.(?:pdf|tex|latex|txt|md|markdown)$/iu.test(job.displayTitle) &&
      !/^(?:untitled(?: (?:paper|document|manuscript))?|(?:imported|uploaded)(?: pdf| paper| document| proof)?|page \d+|paper|document|manuscript|draft)$/i.test(job.displayTitle.trim()) &&
      Array.isArray(paras) && paras.length >= 2 && paras.length <= 3 &&
      paras.every(p => typeof p === "string" && p.trim() && p.length <= 1500) && Array.isArray(questions) && questions.length >= 2 && questions.length <= 4 &&
      questions.every(q => typeof q?.question === "string" && q.question.trim() && q.question.length <= 500 && Number.isInteger(q.step) && q.step > 0) &&
      Array.isArray(job.skills) && Array.isArray(job.papers) && (job.papers.length > 0 || (typeof job.message === "string" && !!job.message.trim())) &&
      Array.isArray(job.knowledge?.techniques) && Array.isArray(job.knowledge?.definitionGroups);
  }

  function recoverPreparation(job) {
    if (["running","starting"].includes(job.status)) job.status = job.key ? "running" : "queued";
    if (job.status === "failed") job.status = "error";
    if (job.status==="error" && !job.needsAction && !job.unexpected && !recoveringOverview(job)) {
      Object.assign(job,{unexpected:true,needsAction:false,failureCode:job.failureCode || "unexpected-failure",failureStage:job.failureStage || "analysis"});
    }
    return job;
  }

  function session(key) {
    const epoch=generation(key);
    if (connections.has(key) && connections.get(key).generation!==epoch) forget(key);
    if (!connections.has(key)) {
      const saved = scoped(read(localStorage, "proof.research." + key, {}),epoch) || {};
      const fallback = scoped(read(sessionStorage, "proof.preparation." + key, null),epoch);
      const research = recoverPreparation(fallback && fallback.savedAt > (saved.savedAt || 0) ? fallback : saved);
      const durableKey = "proof.tutor." + key;
      const durable = read(localStorage,durableKey,null);
      const turns = (durable || read(sessionStorage,"proof.questions." + key,[])).filter(t=>(t.generation || "")===epoch);
      // A reload may interrupt preparation before the server returns a resumable key.
      const recover = job => {
        if (job.status !== "starting" && job.status !== "running") return;
        if (job.key) job.status = "running";
        else Object.assign(job, {status:"error",message:"The request was interrupted before a job ID was received. Retry to continue."});
      };
      turns.forEach(t => { t.id ||= crypto.randomUUID(); recover(t); });
      if (!durable && turns.length) write(localStorage,durableKey,turns);
      const diskStudy = read(localStorage,"proof.study." + key,{});
      const tabStudy = read(sessionStorage,"proof.study." + key,{});
      const data = {research,turns,study:{},studyPlans:{},studySavedAt:0,studySelectedAt:0,generation:epoch};
      loadStudy(data,scoped(diskStudy,epoch));
      loadStudy(data,scoped(tabStudy,epoch));
      connections.set(key,data);
    }
    return connections.get(key);
  }
  function saveResearch(key, job) {
    const data=connections.get(key);
    if (!data || data.research!==job || !currentConnection(key,data)) return;
    if (data.generation) job.generation=data.generation;
    job.savedAt = Math.max(Date.now(),(job.savedAt || 0) + 1);
    if (!write(localStorage, "proof.research." + key, job)) {
      const marker = {...job,needsArtifacts:true};
      for (const field of material) delete marker[field];
      if (!write(localStorage,"proof.research." + key,marker)) write(sessionStorage,"proof.preparation." + key,marker);
    }
    if (job.preparation !== undefined) window.PAPER_LIBRARY?.savePreparation?.(key,job,data.generation)?.catch(() => {});
    notify(key, "research");
  }
  function restorePreparation(key) {
    const state = session(key);
    if (!restores.has(key)) {
      const lookup = window.PAPER_LIBRARY?.getPreparation?.(key);
      restores.set(key,Promise.resolve(lookup).catch(() => null).then(snapshot => {
        if (!currentConnection(key,state)) return;
        const saved=scoped(snapshot,state.generation);
        const job = state.research;
        if (saved && ((saved.savedAt || 0) > (job.savedAt || 0) ||
            (job.needsArtifacts && saved.savedAt === job.savedAt && saved.key === job.key))) {
          state.research = recoverPreparation(saved);
          notify(key,"research");
        } else if (job.needsArtifacts) {
          // A marker records a job transition, never the corresponding content.
          // A stale backup cannot certify that the latest job produced a complete guide.
          if (job.status === "ready") {
            if (isPrepared(saved)) state.research = {...saved,preparation:job.preparation ?? saved.preparation};
            else job.status = job.preparation === false ? "idle" : "queued";
          }
          if (saved && state.research === job && job.status !== "ready") {
            for (const field of material) if (saved[field] !== undefined) job[field] = saved[field];
          }
          delete job.needsArtifacts;
          notify(key,"research");
        }
        const current = state.research;
        if (current.preparation === undefined && (current.key || ["queued","starting","running","ready","error"].includes(current.status))) {
          if (current.status==="error" && (current.unexpected || current.needsAction)) {
            current.preparation=true; saveResearch(key,current);
          } else setPreparation(key,true);
        } else if (current.preparation && ((current.status === "ready" && !isPrepared(current)) ||
            (current.status === "error" && current.requestedVersion === 1 && !current.unexpected && !current.needsAction))) {
          current.status = "queued";
          saveResearch(key,current);
        }
      }));
    }
    return restores.get(key).then(() => session(key).research);
  }
  function saveTurn(key, turn, announce = true) {
    const data=connections.get(key);
    if (!data || !currentConnection(key,data) || !data.turns.includes(turn)) return;
    if (data.generation) turn.generation=data.generation;
    const name = "proof.tutor." + key;
    turn.id ||= crypto.randomUUID();
    turn.savedAt = Math.max(Date.now(),(turn.savedAt || 0) + 1);
    const all = (read(localStorage,name,null) || data.turns).filter(t=>(t.generation || "")===data.generation);
    const index = all.findIndex(t => t.id === turn.id);
    if (index >= 0 && turn.studyKey && all[index].status==="ready") Object.assign(turn,all[index]);
    if ((turn.exploration || turn.checkpoint) && turn.status === "ready") turn.stageDecision = {state:"continue",evidence:""};
    if (index < 0) all.push(turn); else all[index] = turn;
    if (!write(localStorage,name,all)) write(sessionStorage,"proof.questions." + key,session(key).turns);
    if (turn.studyKey) {
      const advanced = advanceFromTurn(key,turn);
      saveStudy(key,advanced);
    }
    if (announce) notify(key,"question");
  }
  function mergeResearch(job, update) {
    const prior = Object.fromEntries(material.map(field => [field,job[field]]));
    if (update.status === "ready" && job.preparation && job.requestedVersion === 2 && !isPrepared(update)) {
      update = {status:"error",unexpected:true,needsAction:false,failureCode:"invalid-response",failureStage:"analysis",
        message:"The reading service returned a completed overview with missing materials."};
    }
    if (update.status==="error" && !update.needsAction && !update.unexpected && !recoveringOverview(update)) {
      update={...update,unexpected:true,needsAction:false,failureCode:update.failureCode || "unexpected-failure",failureStage:update.failureStage || "analysis"};
    }
    Object.assign(job, update);
    // A pending or failed refresh can return an empty placeholder for papers.
    // Replace the previous guide only after its successor has finished.
    if (update.status !== "ready") {
      for (const [key,value] of Object.entries(prior)) {
        if (value !== undefined) job[key] = value;
      }
    }
  }
  function researchProgress(key,job,result) {
    if (session(key).research!==job) return;
    if (result.progress && !sameProfile(job.progress,result.progress)) {
      job.progress=result.progress;
      saveResearch(key,job);
    } else notify(key,"research-progress");
  }
  function recoveringOverview(job) {
    return job.status==="error" && !job.needsAction && !job.unexpected && (job.disconnected ||
      (!job.repairSubmitted && (job.expired || /^The agent returned an incomplete or invalid research result\./.test(job.message || ""))));
  }
  function repairOverview(key,source,job) {
    if (!source || !job.preparation || !recoveringOverview(job) || session(key).research!==job) return;
    if (job.disconnected) {
      if (!window.setTimeout || studyWakeups.has(job)) return;
      studyWakeups.add(job);
      window.setTimeout(()=>{
        studyWakeups.delete(job);
        if (session(key).research===job && job.disconnected) resume(key,source);
      },Math.min(120000,10000*2**Math.min(4,job.connectionMisses || 0)));
    } else return research(key,source,{repair:true});
  }
  function poll(url,onRunning) {
    let watch=polling.get(url);
    if (!watch) {
      watch={listeners:new Set()};
      polling.set(url,watch);
      watch.result=(async () => {
        let result;
        let misses=0;
        const isPlan=url.startsWith("/api/reading-plan/");
        do {
          await new Promise(resolve => setTimeout(resolve, document.hidden ? 5500 : 2200));
          try {
            result=await request(url);
            misses=0;
          } catch (error) {
            const transient=error.disconnected || [408,429,502,503,504].includes(error.status);
            if (transient && ++misses<3) { result={status:"running"}; continue; }
            result={status:"error",message:transient?(isPlan?"The reading service could not be reached. Retry to reconnect to this plan.":"The reading service could not be reached. Retry to reconnect."):error.message,
              unexpected:error.unexpected,needsAction:error.needsAction,actionRequired:error.actionRequired,failureStage:error.failureStage,failureCode:error.failureCode,
              ...(transient && !error.unexpected && !error.needsAction?{disconnected:true}:{}),...(error.status===404?{expired:true}:{})};
          }
          if (result.status==="running") for (const listen of watch.listeners) listen(result);
        } while (result.status === "running");
        return result;
      })().finally(() => polling.delete(url));
    }
    if (onRunning) watch.listeners.add(onRunning);
    return watch.result;
  }
  async function finish(endpoint, job, onChange, onRunning) {
    if (job.status !== "running" || !job.key) return;
    const key = job.key;
    const result = await poll(endpoint + "/" + encodeURIComponent(key), onRunning);
    // Several turns can reference the same server job. Each gets its own update.
    if (job.status !== "running" || job.key !== key) return;
    if (endpoint === "/api/techniques") mergeResearch(job, result);
    else Object.assign(job, result);
    onChange(job);
  }
  function setPreparation(key,enabled) {
    const job = session(key).research;
    const selected = enabled === true;
    const busy = ["starting","running"].includes(job.status);
    if (selected && !isPrepared(job) && !busy && (job.preparation !== true || !job.status || job.status === "idle")) job.status = "queued";
    if (!selected && job.status === "queued") job.status = "idle";
    job.preparation = selected;
    saveResearch(key,job);
  }
  async function resume(key,source) {
    const data = session(key);
    for (const turn of data.turns.filter(t => !t.studyKey)) {
      finish("/api/paper-question", turn, () => saveTurn(key,turn));
    }
    if (source) await restorePreparation(key);
    if (!currentConnection(key,data)) return;
    const job = data.research;
    if (source && job.preparation && job.status==="error" && job.disconnected && !job.key) return research(key,source);
    if (source && job.preparation && job.status==="error" && job.disconnected && job.key) {
      job.status="running";
      delete job.disconnected;
      delete job.message;
      saveResearch(key,job);
    }
    if (job.status === "running") {
      await finish("/api/techniques",job,result => {
        if (session(key).research === job) saveResearch(key,result);
      }, result => researchProgress(key,job,result));
      if (session(key).research !== job) return;
    }
    if (!source || !job.preparation || isPrepared(job)) return;
    // Old server jobs can complete with the previous output format, or expire on restart.
    if (job.status === "queued" || (job.requestedVersion !== 2 && job.status === "ready")) {
      return research(key,source);
    }
    return repairOverview(key,source,job);
  }
  async function research(key,source,{repair=false}={}) {
    const state=session(key),prior=state.research;
    if (prior.status === "running" || prior.status === "starting") return;
    const job = {...prior,status:"starting",startedAt:Date.now(),repairSubmitted:repair,
      connectionMisses:prior.disconnected?Math.min(5,(prior.connectionMisses || 0)+1):0};
    for (const field of ["key","error","message","expired","disconnected","unexpected","needsAction","actionRequired","failureStage","failureCode","progress"]) delete job[field];
    if (job.preparation) job.requestedVersion = 2;
    state.research=job;
    saveResearch(key, job);
    try {
      const doc=await source();
      if (!currentConnection(key,state) || state.research!==job) return;
      mergeResearch(job, await post("/api/techniques", doc));
      if (!currentConnection(key,state) || state.research!==job) return;
      saveResearch(key, job);
      await finish("/api/techniques", job, result => saveResearch(key, result), result => researchProgress(key,job,result));
    } catch (error) {
      const disconnected=transientPlanError(error) && !error.unexpected && !error.needsAction;
      Object.assign(job, {status:"error",message:error.message,disconnected,
        unexpected:!disconnected && !error.needsAction,needsAction:error.needsAction===true,actionRequired:error.actionRequired,
        failureCode:error.failureCode || (!disconnected && !error.needsAction?"unexpected-failure":undefined),failureStage:error.failureStage || "analysis"});
      saveResearch(key, job);
    }
    return repairOverview(key,source,job);
  }
  async function prepare(key,source) {
    const data=session(key);
    await restorePreparation(key);
    if (!currentConnection(key,data)) return;
    const job = data.research;
    if (job.preparation !== true) setPreparation(key,true);
    if (isPrepared(job)) return;
    if (job.status === "running" || (job.disconnected && job.key)) return resume(key,source);
    return research(key,source);
  }
  function savedExploration(turn) {
    // Keep earlier explanations in the transcript after their original action was retired.
    return turn.exploration?.mode === "intuition" ? undefined : turn.exploration;
  }
  function earlierExchanges(turns, turn, stage) {
    const visibleDiscussion = stage && savedExploration(turn);
    const prior = turns.slice(0, turns.indexOf(turn)).filter(t => t.status === "ready" &&
      !(visibleDiscussion && (t.checkpoint || t.question === stage.question)) &&
      (stage ? t.studyKey === turn.studyKey && t.partId === stage.partId :
        !t.studyKey && t.readingEdition===turn.readingEdition && (turn.topic ? t.topic === turn.topic : !t.topic)));
    const limit = turn.context ? 7 : 8;
    const sameStep = prior.filter(t => t.step === turn.step).slice(-limit);
    const remaining = limit - sameStep.length;
    const otherSteps = remaining ? prior.filter(t => t.step !== turn.step).slice(-remaining) : [];
    const selected = new Set([...sameStep, ...otherSteps]);
    const exchanges = prior.filter(t => selected.has(t)).map(t => ({
      question: ((t.step === turn.step ? "" : "Step " + t.step + ": ") + t.question).slice(0, 4000),
      answer: (t.answer || "").slice(0,12000),
      ...(savedExploration(t) ? {exploration:t.exploration} : {}),
      ...(t.checkpoint ? {checkpoint:true} : {})
    }));
    if (turn.context) exchanges.push({question:turn.context.question.slice(0,4000),answer:turn.context.answer.slice(0,12000)});
    return exchanges;
  }
  function visibleTurns(key) {
    const {turns,study}=session(key);
    const edition=study.notationEdition ? study.key : undefined;
    return turns.filter(t=>t.studyKey ? t.studyKey===study.key : t.readingEdition===edition);
  }
  function addPrepared(key, turn) {
    const study=session(key).study;
    if (!turn.studyKey && study.notationEdition) turn.readingEdition=study.key;
    turn.status = "ready";
    session(key).turns.push(turn);
    saveTurn(key,turn);
  }
  function rememberExamples(key,turn) {
    saveTurn(key,turn,false);
  }
  async function ask(key, source, {step,question,known,readPapers,stepSkills,readerKnowledge,context,retryTurn,topic,stage,studyKey,exploration,checkpoint}) {
    if (topic === "paper-overview" && session(key).research.preparation) return;
    const {turns,study}=session(key);
    const notationEdition=study.notationEdition;
    const readingEdition=notationEdition ? study.key : undefined;
    if (visibleTurns(key).some(t => t.step === step && t.topic === topic && (t.status === "starting" || t.status === "running"))) return;
    let turn = retryTurn;
    if (turn) {
      if (!visibleTurns(key).includes(turn) || turn.step !== step || !["failed","error"].includes(turn.status)) return;
      question = turn.question;
      delete turn.key;
      delete turn.error;
      delete turn.message;
    } else {
      turn = {step,question,context,topic,...(stage ? {studyKey,partId:stage.partId} : {}),
        ...(!stage && readingEdition ? {readingEdition} : {}),
        ...(stage?.moduleFocus ? {moduleFocus:stage.moduleFocus} : {}),
        ...(exploration ? {exploration} : {}),...(checkpoint ? {checkpoint:true} : {})};
      turns.push(turn);
    }
    if (checkpoint && stage) {
      turn.checkpointQuestion ||= stage.question;
      stage = {...stage,question:turn.checkpointQuestion};
    }
    turn.status = "starting";
    const history = earlierExchanges(turns, turn, stage);
    saveTurn(key,turn);
    try {
      const doc = await source();
      if (session(key).turns!==turns) return;
      Object.assign(turn, await post("/api/paper-question", {...doc,step,scope:step === 0 ? "paper" : "step",
        mathFormat:"latex",question,known,readPapers,stepSkills,readerKnowledge,history,...(stage ? {stage} : {}),
        ...(notationEdition ? {notationEdition} : {}),
        ...(exploration ? {exploration} : {}),...(checkpoint ? {checkpoint:true} : {})}));
      saveTurn(key,turn);
      await finish("/api/paper-question", turn, () => saveTurn(key,turn));
    } catch (error) {
      Object.assign(turn, {status:"error",message:error.message});
      saveTurn(key,turn);
    }
  }

  function loadStudy(data,record) {
    if (!record?.savedAt) return;
    const selectedAt=record.selectedAt || 0;
    if (selectedAt>data.studySelectedAt || (selectedAt===data.studySelectedAt && record.savedAt>data.studySavedAt)) {
      data.study=record.study || {};
      data.studySelectedAt=selectedAt;
      if (data.study.status==="failed") data.study.status="error";
      if (["starting","running"].includes(data.study.status)) data.study.status=data.study.key?"running":"queued";
    }
    data.studySavedAt=Math.max(data.studySavedAt,record.savedAt);
    mergeHistory(data,record);
  }
  function receiveStudy(key,record) {
    const data=connections.get(key);
    if (!data || !currentConnection(key,data) || !scoped(record,data.generation) || !record?.savedAt) return;
    const selected=record.selectedAt || 0, incoming=record.study || {}, current=data.study;
    if (selected<data.studySelectedAt || (selected===data.studySelectedAt && record.savedAt<=data.studySavedAt)) return;
    if (selected===data.studySelectedAt && incoming.key===current.key &&
        (current.status==="ready" || (current.status===incoming.status && studyJobs.has(current)))) {
      // Keep live poll listeners, section guides and the active discussion attached to their object.
      if (current.status!=="ready" && incoming.progress &&
          (incoming.progress.updatedAt || 0)>=(current.progress?.updatedAt || 0)) current.progress=incoming.progress;
      data.studySavedAt=record.savedAt;
      mergeHistory(data,record);
    } else loadStudy(data,record);
    notify(key,"study-external");
  }
  async function refreshStudy(key) {
    const data=connections.get(key);
    if (!data || !currentConnection(key,data)) return;
    receiveStudy(key,read(localStorage,"proof.study."+key,null));
    const saved=await window.PAPER_LIBRARY?.getPreparation?.("study/"+key)?.catch(()=>null);
    if (currentConnection(key,data)) receiveStudy(key,saved);
  }
  function mergeHistory(data,record) {
    if (!record || !scoped(record,data.generation)) return;
    for (const previous of Object.values(record?.plans || {})) {
      if (previous?.status!=="ready" || !previous.key || !Array.isArray(previous.completed)) continue;
      const ours=data.study.key===previous.key ? data.study : data.studyPlans[previous.key];
      const compatible=ours?.status==="ready" && ours.analysisKey===previous.analysisKey && sameSections(previous.parts,ours);
      if (compatible && !hasCurrentEdition(ours) &&
          (previous.orientationJob || previous.parts?.some(p=>p.orientation))) {
        const saved=previous.orientationJob, current=ours.orientationJob;
        if (hasCurrentEdition(previous) && applyOrientation(ours,previous.parts)) {
          markReviewed(ours,previous);
        } else {
          if (!hasOrientation(ours) && hasOrientation(previous)) applyOrientation(ours,previous.parts);
          if (saved?.format===sectionFormat && saved.status!=="ready" &&
              (current?.format!==sectionFormat || saved.generation>current.generation ||
              (saved.generation===current.generation && saved.updatedAt>current.updatedAt))) ours.orientationJob={...saved};
        }
      }
      if (compatible && previous.completed.length>ours.completed.length &&
          previous.completed.every((c,i)=>c.partId===ours.parts[i]?.id)) {
        ours.completed=previous.completed; ours.activeIndex=ours.completed.length;
      }
      data.studyPlans[previous.key]=ours?.status==="ready" ? ours : previous;
    }
    const turns = new Map(data.turns.map(t => [t.id,t]));
    for (const t of record?.turns || []) {
      if (!t.studyKey || !t.id) continue;
      const existing=turns.get(t.id);
      if (existing && (existing.status==="ready" || (t.status!=="ready" && (existing.savedAt || 0)>=(t.savedAt || 0)))) continue;
      if ((t.status === "starting" || t.status === "running") && !t.key) {
        Object.assign(t,{status:"error",message:"The question was interrupted. Retry to continue."});
      }
      if (existing) Object.assign(existing,t); else data.turns.push(t);
    }
  }
  function saveStudy(key,announce = true) {
    const data=session(key);
    // A second tab may have completed a later part or tailored a different plan.
    // Keep independent histories and the longest validated completion prefix.
    const other=scoped(read(localStorage,"proof.study."+key,null),data.generation);
    if (other?.savedAt>data.studySavedAt && (other.selectedAt || 0)===data.studySelectedAt &&
        other.study?.key && other.study.key===data.study.key) {
      if (other.study.status==="ready" && data.study.status!=="ready") {
        receiveStudy(key,other);
      } else if (other.study.status==="running" && data.study.status==="running" &&
          (other.study.progress?.updatedAt || 0)>(data.study.progress?.updatedAt || 0)) {
        data.study.progress=other.study.progress;
      }
    }
    mergeHistory(data,other);
    if (data.study.status === "ready") data.studyPlans[data.study.key]=data.study;
    data.studySavedAt=Math.max(Date.now(),data.studySavedAt+1,(other?.savedAt || 0)+1);
    const otherSelected=(other?.selectedAt || 0)>data.studySelectedAt;
    const selected=otherSelected ? other.study : data.study;
    const record={savedAt:data.studySavedAt,selectedAt:otherSelected?other.selectedAt:data.studySelectedAt,
      ...(data.generation?{generation:data.generation}:{}),
      study:selected.status==="ready" ? data.studyPlans[selected.key] || selected : selected,
      plans:data.studyPlans,turns:data.turns.filter(t=>t.studyKey)};
    const shared=write(localStorage,"proof.study."+key,record);
    if (!shared) write(sessionStorage,"proof.study."+key,record);
    const backup=window.PAPER_LIBRARY?.savePreparation?.("study/"+key,record,data.generation)?.then(()=>{
      if (!shared) studyChannel?.postMessage({key});
    }).catch(()=>{});
    if (announce) notify(key,"study");
    return backup;
  }
  function selectStudy(key,study) {
    const data=session(key);
    const previous=read(localStorage,"proof.study."+key,null);
    data.studySelectedAt=Math.max(Date.now(),data.studySelectedAt+1,(previous?.selectedAt || 0)+1);
    if (data.study.status==="ready" && data.study.key) data.studyPlans[data.study.key]=data.study;
    data.study=study;
  }
  function restoreStudy(key) {
    const data=session(key);
    if (!studyRestores.has(key)) {
      const lookup=window.PAPER_LIBRARY?.getPreparation?.("study/"+key);
      studyRestores.set(key,Promise.resolve(lookup).catch(()=>null).then(saved=>{
        if (!currentConnection(key,data)) return;
        loadStudy(data,scoped(saved,data.generation));
        let advanced=false;
        for (const turn of data.turns) if (advanceFromTurn(key,turn)) advanced=true;
        if (advanced) saveStudy(key);
      }));
    }
    return studyRestores.get(key).then(()=>session(key).study);
  }
  async function requestBackgroundChoices(key) {
    const data=session(key);
    await restoreStudy(key);
    if (!currentConnection(key,data)) return;
    pendingSelections.delete(key);
    // Advance the selected edition's timestamp. Other tabs may still finish
    // writing progress for an earlier edition while the reader chooses again.
    selectStudy(key,{});
    await saveStudy(key,false);
  }
  function recordCompletion(study,partId,turnId,evidence,by) {
    if (study.status!=="ready" || study.parts[study.activeIndex]?.id!==partId ||
        study.completed.some(c=>c.partId===partId)) return false;
    study.completed.push({partId,turnId,evidence,by});
    study.activeIndex++;
    return true;
  }
  function advanceFromTurn(key,turn) {
    const study=session(key).study;
    const decision=turn.stageDecision;
    if (turn.exploration || turn.checkpoint || !turn.studyKey || turn.studyKey!==study.key || turn.status!=="ready" || decision?.state!=="complete" ||
        typeof decision.evidence!=="string" || !decision.evidence.trim() || !turn.question.includes(decision.evidence)) return false;
    return recordCompletion(study,turn.partId,turn.id,decision.evidence,"tutor");
  }
  function finishPart(key,partId) {
    const data=session(key), study=data.study;
    mergeHistory(data,read(localStorage,"proof.study."+key,null));
    if (data.turns.some(t=>t.studyKey===study.key && t.partId===partId && !t.checkpoint && ["starting","running"].includes(t.status))) return false;
    if (!recordCompletion(study,partId,null,"The reader chose to finish this part.","reader")) return false;
    saveStudy(key);
    return true;
  }
  async function analysisId(analysis) {
    if (analysis.key || analysis.revision) return String(analysis.key || analysis.revision);
    const originalParts=analysis.parts.map(({orientation,...part})=>part);
    const bytes=new TextEncoder().encode(JSON.stringify([originalParts,analysis.localIntroductions,analysis.knowledge]));
    const digest=await crypto.subtle.digest("SHA-256",bytes);
    return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
  }
  const sameProfile = (a,b) => JSON.stringify(a)===JSON.stringify(b);
  function sameSections(parts,analysis) {
    return Array.isArray(parts) && parts.length>0 && parts.length===analysis?.parts?.length &&
      parts.every((part,i)=>part?.id===analysis.parts[i].id && part.title===analysis.parts[i].title &&
        sameProfile(part.sourceSteps,analysis.parts[i].sourceSteps));
  }
  async function rememberReference(ref) {
    if (!ref) return;
    if (typeof ref.id!=="string" || !/^[a-f0-9]{64}$/.test(ref.id) || typeof ref.title!=="string" || !ref.title.trim()) {
      throw new Error("Select a reference paper with a title and readable text.");
    }
    const metadata={id:ref.id,title:ref.title.trim()};
    if (Array.isArray(ref.units) && ref.units.length) {
      const source={units:ref.units,...(ref.file ? {file:ref.file} : {})};
      referenceSources.set(ref.id,source);
      // Store the reference once, independently of transcripts and saved plan versions.
      const storageKey="notation-reference/"+ref.id;
      try {
        if (!window.PAPER_LIBRARY?.savePreparation) throw new Error();
        await window.PAPER_LIBRARY.savePreparation(storageKey,source);
      } catch {
        const copy={units:ref.units,...(ref.file ? {pdfBase64:await pdfBytes(ref.file)} : {})};
        write(sessionStorage,storageKey,copy);
      }
    }
    return metadata;
  }
  async function referenceFor(ref) {
    if (!ref) return {};
    const storageKey="notation-reference/"+ref.id;
    let source=referenceSources.get(ref.id) || read(sessionStorage,storageKey,null);
    if (!source) source=await window.PAPER_LIBRARY?.getPreparation?.(storageKey);
    if (!source?.units?.length) throw Object.assign(new Error("Select the reference paper again to restore its notation."),
      {needsAction:true,actionRequired:"reference"});
    const pdfBase64=source.file ? await pdfBytes(source.file) : source.pdfBase64;
    return {notationReference:{title:ref.title,units:source.units,...(pdfBase64 ? {pdfBase64} : {})}};
  }
  function matchingEdition(result,job) {
    if (!job.notationReference) return !result.notationEdition;
    const edition=result.notationEdition;
    return !!edition && edition.referenceTitle===job.notationReference.title && !!edition.overview?.paragraphs?.length &&
      Array.isArray(edition.parts) && edition.parts.length===result.parts?.length &&
      edition.parts.every((p,i)=>p?.id===result.parts[i]?.id && typeof p.reading==="string" && p.reading.trim());
  }
  function referencesFor(analysis,revision) {
    return {revision,parts:analysis.parts.map(({orientation,...part})=>part),localIntroductions:analysis.localIntroductions,
      knowledge:analysis.knowledge,...(analysis.overview ? {overview:analysis.overview} : {})};
  }
  async function removalPlans(key,analysis) {
    if (!analysis?.parts?.length) return [];
    const data=session(key);
    await restoreStudy(key);
    const revision=await analysisId(analysis);
    if (!currentConnection(key,data)) return [];
    const stored=new Map(Object.values(data.studyPlans).map(s=>[s.key,s]));
    if (data.study.key) stored.set(data.study.key,data.study);
    const references=referencesFor(analysis,revision);
    const candidates=[],notation=new Map();
    let remainingBytes=64*1024*1024;
    for (const s of stored.values()) {
      if (candidates.length===100 || remainingBytes<=0) break;
      if (!/^[a-f0-9]{64}$/.test(s.key) || s.analysisKey!==revision || !s.readerKnowledge ||
          (s.status==="ready" && !sameSections(s.parts,analysis))) continue;
      try {
        const id=s.notationReference?.id || "";
        if (!notation.has(id)) notation.set(id,await referenceFor(s.notationReference));
        const candidate={key:s.key,title:analysis.displayTitle,analysis:references,readerKnowledge:s.readerKnowledge,...notation.get(id)};
        // The server index clears all registered editions. Evidence for older
        // files is optional and must leave space for the primary paper.
        const bytes=new TextEncoder().encode(JSON.stringify(candidate)).length;
        if (bytes>remainingBytes) continue;
        remainingBytes-=bytes;
        candidates.push(candidate);
      } catch { /* An unavailable reference cannot establish ownership of a legacy cache entry. */ }
    }
    return candidates;
  }
  const normalizeOrientation=value=>value && window.PART_ORIENTATION?.normalize(value);
  function hasOrientation(study) {
    return !!study?.parts?.length && study.parts.every(part=>normalizeOrientation(part.orientation));
  }
  function matchesEditorialRevision(result) {
    const revision=window.PART_ORIENTATION?.editorialRevision;
    return !!revision && result?.editorialRevision===revision;
  }
  function hasCurrentEdition(study) {
    return matchesEditorialRevision(study) && hasOrientation(study);
  }
  function needsEditorialReview(study) {
    return study?.status==="ready" && !hasCurrentEdition(study);
  }
  function markReviewed(study,result) {
    study.editorialRevision=result.editorialRevision;
    if (result.editorialSkill) study.editorialSkill=result.editorialSkill;
    else delete study.editorialSkill;
    study.orientationJob={status:"ready",format:sectionFormat};
  }
  function applyOrientation(study,rows) {
    if (rows?.length!==study.parts.length) return false;
    const byId=new Map(rows.map(row=>[row?.id,normalizeOrientation(row?.orientation)]));
    if (!study.parts.every(part=>byId.get(part.id))) return false;
    for (const part of study.parts) part.orientation=byId.get(part.id);
    return true;
  }
  function acceptPlan(key,job,result,analysis) {
    if (session(key).study!==job) return;
    if (result.progress) job.progress=result.progress;
    if (result.status==="ready") {
      const parts=result.parts;
      if (!result.key || !sameSections(parts,analysis) || !matchingEdition(result,job) ||
          parts.some(p=>typeof p.opening!=="string" || !p.opening.trim() ||
            typeof p.question!=="string" || !p.question.trim()) ||
          (matchesEditorialRevision(result) && !hasOrientation(result)) ||
          parts.some(p=>p.orientation!==undefined && !normalizeOrientation(p.orientation) &&
            !window.PART_ORIENTATION?.normalizeLegacy(p.orientation))) throw new Error("The saved plan did not pass the completeness check.");
      const archived=session(key).studyPlans[result.key];
      const previous=sameSections(archived?.parts,analysis)?archived:undefined;
      const completed=previous?.analysisKey===job.analysisKey ? previous.completed : [];
      Object.assign(job,{status:"ready",key:result.key,parts,completed,activeIndex:completed.length});
      if (result.notationEdition) job.notationEdition=result.notationEdition;
      delete job.progress; delete job.startedAt; delete job.reconnect; delete job.message;
      delete job.needsAction; delete job.actionRequired; delete job.nextCheckAt; delete job.connectionMisses; delete job.repairSubmitted;
      delete job.unexpected; delete job.failureStage; delete job.failureCode;
      if (hasCurrentEdition(result)) markReviewed(job,result);
      else if (previous?.analysisKey===job.analysisKey && hasCurrentEdition(previous) && applyOrientation(job,previous.parts)) {
        markReviewed(job,previous);
      }
      for (const turn of session(key).turns) advanceFromTurn(key,turn);
    } else if (result.status==="running" && result.key) {
      Object.assign(job,{status:"running",key:result.key});
      delete job.message; delete job.needsAction; delete job.actionRequired; delete job.nextCheckAt; delete job.reconnect;
      delete job.unexpected; delete job.failureStage; delete job.failureCode;
    } else {
      if (typeof result.key==="string" && result.key) job.key=result.key;
      throw Object.assign(new Error(result.message || result.error || "The reading service returned an incomplete preparation result."),
        {needsAction:result.needsAction===true,actionRequired:result.actionRequired,disconnected:!!result.disconnected,
          unexpected:result.unexpected===true,failureCode:result.failureCode,failureStage:result.failureStage});
    }
    saveStudy(key);
  }
  const transientPlanError=error=>error.disconnected || [408,429,502,503,504].includes(error.status);
  function legacyRepair(error) {
    return !error.unexpected && !error.needsAction &&
      /^(?:The notation (?:could not be adapted|correction)|The (?:source check needs another pass|source revision omitted|formatting correction for)|The (?:source for|review of) .+ (?:needs|still needs)|The personalized plan was incomplete|Codex (?:timed out during this step|could not finish the personalized plan)|The local Codex worker (?:stopped before completing|returned no result)|The reading service lost the job before the plan was saved)/.test(error.message || "");
  }
  function wakeStudy(key,source,analysis,job) {
    if (!window.setTimeout || studyWakeups.has(job)) return;
    studyWakeups.add(job);
    window.setTimeout(()=>{
      studyWakeups.delete(job);
      if (session(key).study===job && job.status==="waiting-service") runStudy(key,source,analysis,job);
    },Math.max(1000,job.nextCheckAt-Date.now()));
  }
  async function runStudy(key,source,analysis,job,{manual=false,checkBlocked=false}={}) {
    if (studyJobs.has(job)) return studyJobs.get(job);
    const current=()=>session(key).study===job;
    const endpoint="/api/reading-plan";
    function follow() {
      return poll(endpoint+"/"+encodeURIComponent(job.key),result=>{
        if (session(key).study!==job || (result.key && result.key!==job.key)) return;
        delete job.connectionMisses;
        if (result.progress && !sameProfile(job.progress,result.progress)) {
          job.progress=result.progress;
          saveStudy(key,false);
        }
        notify(key,"study-progress");
      });
    }
    async function submit(repair) {
      const send=async()=>{
        // Another window can receive the service key while we wait for the submission lock.
        receiveStudy(key,read(localStorage,"proof.study."+key,null));
        if (!current()) return;
        if (repair) job.repairSubmitted=true;
        job.status=repair?"recovering":"starting"; job.startedAt ||= Date.now();
        delete job.message; delete job.reconnect; delete job.needsAction; delete job.actionRequired;
        delete job.unexpected; delete job.failureCode; delete job.failureStage;
        saveStudy(key);
        const [doc,notation]=await Promise.all([source(),referenceFor(job.notationReference)]);
        if (!current()) return;
        const result=await post(endpoint,{...doc,title:analysis.displayTitle || doc.title,
          analysis:referencesFor(analysis,job.analysisKey),readerKnowledge:job.readerKnowledge,...notation});
        if (current()) acceptPlan(key,job,result,analysis);
      };
      const locks=window.navigator?.locks;
      return locks ? locks.request("proof.study-submit."+key,send) : send();
    }
    const run=Promise.resolve().then(async()=>{
      try {
        let repair=false;
        if (manual) delete job.repairSubmitted;
        if (job.key && (!manual || job.reconnect)) {
          const running=job.status==="running";
          if (!running && !checkBlocked) {
            job.status="recovering"; delete job.message;
            saveStudy(key);
          }
          let result;
          try { result=running?await follow():await request(endpoint+"/"+encodeURIComponent(job.key)); }
          catch(error) { if (error.status===404) result={expired:true}; else throw error; }
          if (!current()) return;
          if (result.key && result.key!==job.key) throw Object.assign(new Error("The service returned a different reading plan."),{unexpected:true,failureCode:"plan-key-mismatch"});
          if (checkBlocked && (result.expired || result.disconnected)) return;
          if (result.expired || (!checkBlocked && result.status==="error" && legacyRepair(result))) repair=true;
          else {
            if (checkBlocked && result.status==="error") {
              if (result.needsAction || result.unexpected) acceptPlan(key,job,result,analysis);
              return;
            }
            acceptPlan(key,job,result,analysis);
            if (job.status==="ready") return;
          }
        }
        let shouldSubmit=job.status!=="running" || repair || manual;
        while (current()) {
          try {
            if (shouldSubmit) {
              if (repair && job.repairSubmitted) throw Object.assign(new Error(job.message || "The reading service could not restore this plan after checking its saved work."),{needsAction:true,actionRequired:"service"});
              await submit(repair);
            }
            if (!current() || job.status!=="running") return;
            const result=await follow();
            if (!current()) return;
            if (result.expired) throw new Error("The reading service lost the job before the plan was saved.");
            if (result.key && result.key!==job.key) throw Object.assign(new Error("The service returned a different reading plan."),{unexpected:true,failureCode:"plan-key-mismatch"});
            acceptPlan(key,job,result,analysis);
            return;
          } catch(error) {
            if (error.status || !legacyRepair(error) || job.repairSubmitted) throw error;
            repair=true; shouldSubmit=true;
          }
        }
      } catch(error) {
        if (!current()) return;
        if (checkBlocked && transientPlanError(error) && !error.needsAction && !error.unexpected) return;
        if (transientPlanError(error) && !error.needsAction && !error.unexpected) {
          job.connectionMisses=Math.min(5,(job.connectionMisses || 0)+1);
          job.nextCheckAt=Date.now()+Math.min(120000,10000*2**(job.connectionMisses-1));
          job.status="waiting-service"; job.reconnect=!!job.key;
          delete job.message; delete job.needsAction; delete job.actionRequired;
          saveStudy(key);
          wakeStudy(key,source,analysis,job);
        } else {
          const action=error.actionRequired || (legacyRepair(error) ? "review" : undefined);
          Object.assign(job,{status:"error",message:error.message,needsAction:!!action,actionRequired:action,unexpected:!action,
            failureCode:error.failureCode || (action?undefined:"unexpected-failure"),
            failureStage:error.failureStage || job.progress?.stage || "preparing"});
          checkedFailedPlans.set(job,Date.now());
          saveStudy(key);
        }
      }
    }).finally(()=>studyJobs.delete(job));
    studyJobs.set(job,run);
    return run;
  }
  async function personalize(key,source,{analysis,readerKnowledge,notationReference}) {
    if (!analysis?.parts?.length || !readerKnowledge) return;
    const token=Symbol();
    pendingSelections.set(key,token);
    await restoreStudy(key);
    const data=session(key);
    const [revision,reference]=await Promise.all([analysisId(analysis),rememberReference(notationReference)]);
    if (pendingSelections.get(key)!==token) return;
    const matches=s=>s.analysisKey===revision && (s.status!=="ready" || sameSections(s.parts,analysis)) && sameProfile(s.readerKnowledge,readerKnowledge) &&
      s.notationReference?.id===reference?.id && s.notationReference?.title===reference?.title;
    if (matches(data.study) && data.study.status==="ready") return;
    const archived=Object.values(data.studyPlans).find(matches);
    if (archived) {
      selectStudy(key,archived);
      for (const turn of data.turns) advanceFromTurn(key,turn);
      saveStudy(key); return;
    }
    if (!matches(data.study)) {
      selectStudy(key,{version:1,analysisKey:revision,readerKnowledge:JSON.parse(JSON.stringify(readerKnowledge)),...(reference ? {notationReference:reference} : {}),
        status:"queued",parts:[],completed:[],activeIndex:0});
    }
    return runStudy(key,source,analysis,data.study);
  }
  async function retryStudy(key,source,analysis) {
    const study=await restoreStudy(key);
    if (["error","waiting-service"].includes(study.status) && study.analysisKey===await analysisId(analysis)) {
      return runStudy(key,source,analysis,study,{manual:true});
    }
  }
  async function resumeStudy(key,source,analysis,{wake=false}={}) {
    const study=await restoreStudy(key);
    if (!analysis?.parts?.length || !study.status) return;
    const revision=await analysisId(analysis);
    if (study!==session(key).study) return;
    if (study.analysisKey!==revision || (study.status==="ready" && !sameSections(study.parts,analysis))) {
      selectStudy(key,{}); saveStudy(key); return;
    }
    for (const turn of session(key).turns.filter(t=>t.studyKey && t.status==="running")) {
      finish("/api/paper-question",turn,()=>saveTurn(key,turn));
    }
    if (study.status==="error" && !study.needsAction && !study.unexpected && !study.reconnect && !legacyRepair(study)) {
      Object.assign(study,{unexpected:true,needsAction:false,failureCode:"unexpected-failure",failureStage:study.progress?.stage || "preparing"});
      saveStudy(key);
    }
    if (study.status==="error" && (study.needsAction || study.unexpected)) {
      const checked=checkedFailedPlans.get(study);
      if (!study.key || (checked && (!wake || Date.now()-checked<30000))) return;
      checkedFailedPlans.set(study,Date.now());
      return runStudy(key,source,analysis,study,{checkBlocked:true});
    }
    if (study.status==="waiting-service" && !wake && study.nextCheckAt>Date.now()) {
      wakeStudy(key,source,analysis,study); return;
    }
    if (["queued","starting","running","error","recovering","waiting-service"].includes(study.status)) return runStudy(key,source,analysis,study);
  }
  async function ensureOrientation(key,source,analysis,{retry=false}={}) {
    if (!analysis?.parts?.length) return;
    await restoreStudy(key);
    const data=session(key), selected=data.study;
    if (!needsEditorialReview(selected)) return;
    const revision=await analysisId(analysis), planKey=selected.key;
    if (selected!==data.study || selected.analysisKey!==revision ||
        selected.parts.length!==analysis.parts.length || selected.parts.some((part,i)=>
          part.id!==analysis.parts[i].id || !sameProfile(part.sourceSteps,analysis.parts[i].sourceSteps))) return;
    const lockKey=JSON.stringify([key,revision,planKey]);
    if (orientationJobs.has(lockKey)) return orientationJobs.get(lockKey);
    // A reader can switch plans while the worker is running. Look up the original
    // plan in its paper each time and merge only its additional orientation text.
    function original() {
      if (!currentConnection(key,data)) return null;
      const disk=read(localStorage,"proof.study."+key,null);
      const saved=disk?.plans?.[planKey];
      if (saved && saved.analysisKey!==revision) return null;
      mergeHistory(data,disk);
      const plan=data.study.key===planKey ? data.study : data.studyPlans[planKey];
      return plan?.status==="ready" && plan.analysisKey===revision ? plan : null;
    }
    async function upgrade() {
      const plan=original();
      if (!needsEditorialReview(plan)) return;
      if (!plan.notationReference && !hasOrientation(plan) && hasOrientation(analysis) && applyOrientation(plan,analysis.parts)) {
        if (hasCurrentEdition(analysis)) {
          markReviewed(plan,analysis);
          saveStudy(key);
          return;
        }
      }
      const previous=plan.orientationJob?.format===sectionFormat ? plan.orientationJob : null;
      if (!source || (previous?.status==="error" && !retry)) return;
      const job={format:sectionFormat,generation:(previous?.generation || 0)+1,token:crypto.randomUUID(),
        updatedAt:Math.max(Date.now(),(previous?.updatedAt || 0)+1),status:"starting"};
      if (previous?.status==="running" && previous.key) Object.assign(job,{status:"running",key:previous.key});
      plan.orientationJob=job;
      saveStudy(key);
      function current() {
        const target=original();
        return target?.orientationJob?.token===job.token && !hasCurrentEdition(target) ? target : null;
      }
      function update(target,status,extra={}) {
        job.updatedAt=Math.max(Date.now(),job.updatedAt+1);
        target.orientationJob=Object.assign(job,{status},extra);
        saveStudy(key);
      }
      try {
        let result, expectedKey=job.key;
        if (job.key) result=await poll("/api/reading-plan/"+encodeURIComponent(job.key));
        if (!result || result.expired) {
          const [doc,notation]=await Promise.all([source(),referenceFor(plan.notationReference)]);
          if (!current()) return;
          const payload={...doc,...notation,mode:"orientation",analysis:referencesFor(analysis,revision),readerKnowledge:plan.readerKnowledge,
            existingOpenings:plan.parts.map(({id,opening})=>({id,opening}))};
          if (hasOrientation(plan)) {
            payload.existingSections=plan.parts.map(({id,orientation})=>({id,orientation:normalizeOrientation(orientation)}));
          }
          result=await post("/api/reading-plan",payload);
          expectedKey=result.key;
          if (result.status==="running" && result.key) {
            const target=current();
            if (!target) return;
            update(target,"running",{key:result.key});
            result=await poll("/api/reading-plan/"+encodeURIComponent(result.key));
          }
        }
        const target=current();
        if (!target) return;
        if (result.status!=="ready") throw new Error(result.message || result.error || "Could not prepare the part introductions.");
        if (!expectedKey || result.key!==expectedKey || result.mode!=="orientation" || !matchesEditorialRevision(result) || !matchingEdition(result,target) ||
            !Array.isArray(result.parts) || !applyOrientation(target,result.parts)) {
          throw new Error("The part introductions were incomplete. Retry to prepare them again.");
        }
        if (result.notationEdition) target.notationEdition=result.notationEdition;
        markReviewed(target,result);
        saveStudy(key);
      } catch(error) {
        const target=current();
        if (target) update(target,"error",{message:error.message});
      }
    }
    // Web Locks serialize a resume with another live tab. The service also keys
    // an identical POST by content if a reload interrupted it before its job ID arrived.
    const locks=window.navigator?.locks;
    const run=Promise.resolve().then(()=>locks ? locks.request("proof.orientation."+lockKey,upgrade) : upgrade())
      .finally(()=>orientationJobs.delete(lockKey));
    orientationJobs.set(lockKey,run);
    return run;
  }
  const guides=new WeakMap();
  function partGuide(study,partId) { return guides.get(study)?.get(partId); }
  function sectionKeys(key) {
    const data=connections.get(key),keys=new Set();
    if (data && currentConnection(key,data)) {
      for (const study of [data.study,...Object.values(data.studyPlans)]) {
        for (const entry of guides.get(study)?.values() || []) if (entry.key) keys.add(entry.key);
      }
    }
    return [...keys];
  }
  function studyPartStage(part,analysis) {
    const partId=part.id;
    const original=analysis?.parts.find(p=>p.id===partId);
    const stage={partId,title:part.title,opening:part.opening,question:part.question,sourceSteps:part.sourceSteps};
    const orientation=normalizeOrientation(part.orientation) || normalizeOrientation(original?.orientation);
    if (orientation) {
      stage.orientation=orientation;
      stage.opening=orientation.paragraphs[0];
    }
    const anchors=original?.sourceAnchors || part.sourceAnchors;
    if (anchors?.length) stage.sourceAnchors=anchors;
    if (original?.localPrerequisiteIds?.length) {
      const priorIds=new Set(original.localPrerequisiteIds);
      stage.localPrerequisites=analysis.localIntroductions.filter(l=>priorIds.has(l.id)).map(l=>({
        id:l.id,kind:l.kind,title:l.title,meaning:l.meaning,originPartId:l.originPartId,
        originTitle:analysis.parts.find(p=>p.id===l.originPartId)?.title,
      }));
    }
    return stage;
  }
  async function readStructure(key,source,study,analysis,partId) {
    if (session(key).study!==study || study.status!=="ready") return;
    const part=study.parts.find(p=>p.id===partId);
    if (!part) return;
    let entries=guides.get(study);
    if (!entries) { entries=new Map(); guides.set(study,entries); }
    const prior=entries.get(partId);
    if (["running","ready"].includes(prior?.status)) return;
    entries.set(partId,{status:"running"});
    notify(key,"section-structure");
    let jobKey=prior?.disconnected?prior.key:undefined;
    const progress=result=>{
      const previous=entries.get(partId);
      const recovering=!!result.progress?.recovery || result.stage==="recovering";
      if (previous.key===jobKey && previous.recovering===recovering) return;
      entries.set(partId,{status:"running",key:jobKey,recovering});
      notify(key,"section-structure");
    };
    const sectionError=result=>{
      const classified=result.needsAction || result.failureCode && result.failureCode!=="unexpected-failure";
      const unexpected=result.unexpected || !classified && !result.disconnected;
      return {status:"error",key:jobKey,unexpected:!!unexpected,needsAction:result.needsAction===true,
        actionRequired:result.actionRequired,disconnected:!!result.disconnected,
        failureStage:result.failureStage || "section",failureCode:result.failureCode || (unexpected?"unexpected-failure":undefined),
        message:result.failureStage && result.failureCode?result.message:undefined};
    };
    async function submit() {
      const doc=await source();
      if (session(key).study!==study) return;
      const stage=studyPartStage(part,analysis);
      return post("/api/section-structure",{...doc,title:analysis.displayTitle || doc.title,
        studyKey:study.key,analysisKey:study.analysisKey,readerKnowledge:study.readerKnowledge,stage,
        ...(study.notationEdition ? {notationEdition:study.notationEdition} : {})});
    }
    const follow=()=>poll("/api/section-structure/"+encodeURIComponent(jobKey),progress);
    try {
      let result=jobKey?await follow():undefined;
      for (let attempt=0;attempt<2 && (!result || result.expired);attempt++) {
        result=await submit();
        if (!result) return;
        jobKey=result.key;
        if (result.status==="running" && jobKey) { progress(result); result=await follow(); }
      }
      if (result.status==="ready" && result.partId===partId && result.modules?.length) entries.set(partId,result);
      else entries.set(partId,sectionError(result));
    } catch(error) {
      entries.set(partId,sectionError(error));
    }
    const failed=entries.get(partId);
    if (failed.disconnected && !failed.unexpected && !failed.needsAction) {
      failed.status="waiting-service";
      failed.connectionMisses=Math.min(5,(prior?.connectionMisses || 0)+1);
      window.setTimeout?.(()=>{
        if (entries.get(partId)===failed) readStructure(key,source,study,analysis,partId);
      },Math.min(120000,10000*2**(failed.connectionMisses-1)));
    }
    notify(key,"section-structure");
  }
  async function askPart(key,source,{studyKey,analysis,partId,question,retryTurn,readerKnowledge,stepSkills=[],exploration,checkpoint,moduleId}) {
    const data=session(key),study=data.study;
    mergeHistory(data,read(localStorage,"proof.study."+key,null));
    if (study.status!=="ready" || (studyKey!==undefined && studyKey!==study.key) || typeof question!=="string" || !question.trim()) return false;
    const revision=analysis?.key || analysis?.revision;
    if (revision && String(revision)!==study.analysisKey) return false;
    const index=study.parts.findIndex(p=>p.id===partId);
    if (index<0 || index>study.activeIndex) return false;
    if (retryTurn && (!data.turns.includes(retryTurn) || retryTurn.studyKey!==study.key ||
        retryTurn.partId!==partId || !["failed","error"].includes(retryTurn.status))) return false;
    if (data.turns.some(t=>t.studyKey===study.key && t.partId===partId && ["starting","running"].includes(t.status))) return false;
    const selection = retryTurn ? savedExploration(retryTurn) : exploration;
    const feedback = retryTurn ? retryTurn.checkpoint : checkpoint;
    if ((feedback !== undefined && typeof feedback !== "boolean") || (feedback && selection)) return false;
    if (selection !== undefined && (!selection || !["example","simplify","remove"].includes(selection.mode) ||
        typeof selection.target !== "string" || selection.target.trim().length > 1000)) return false;
    if (index!==study.activeIndex && !(selection && study.completed.some(c=>c.partId===partId))) return false;
    const part=study.parts[index];
    if (retryTurn && retryTurn.step!==part.sourceSteps[0]) return false;
    const choices=readerKnowledge || study.readerKnowledge;
    const stage=studyPartStage(part,analysis);
    if (retryTurn?.moduleFocus) stage.moduleFocus=retryTurn.moduleFocus;
    if (!feedback && !retryTurn && moduleId) {
      const guide=partGuide(study,partId);
      const focus=guide?.modules?.find(m=>m.id===moduleId);
      if (focus) {
        const {title,claim,explanation,sourceStep,assumptions}=focus;
        stage.moduleFocus={title,claim,explanation,sourceStep,assumptions,
          dependsOn:guide.modules.filter(m=>focus.dependsOn.includes(m.id)).map(m=>m.title)};
      }
    }
    await ask(key,source,{step:part.sourceSteps[0],question:question.trim(),retryTurn,studyKey:study.key,stage,
      topic:"study/"+study.key+"/"+partId,readerKnowledge:choices,known:choices.techniques.map(t=>t.name),stepSkills,
      exploration:selection && {mode:selection.mode,target:selection.target.trim()},checkpoint:feedback});
    return true;
  }

  window.addEventListener?.("storage",event=>{
    if (!event.key?.startsWith("proof.study.") || !event.newValue) return;
    const key=event.key.slice("proof.study.".length);
    try { receiveStudy(key,JSON.parse(event.newValue)); } catch { /* Ignore a partially written storage record. */ }
  });
  if (studyChannel) studyChannel.onmessage=event=>{
    if (typeof event.data?.key==="string") refreshStudy(event.data.key);
  };

  window.READER_SESSION = {session, research, prepare, setPreparation, restorePreparation, isPrepared, ask, addPrepared,visibleTurns,retryStudy,planDiagnostics,
    rememberExamples, resume, pdfBytes, personalize, askPart, finishPart, restoreStudy, requestBackgroundChoices, sameSections, forget, removalPlans, sectionKeys,
    resumeStudy,refreshStudy,recoveringOverview,ensureOrientation,needsEditorialReview,sectionFormat,partGuide,readStructure};
})();
