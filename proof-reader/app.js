(() => {
  "use strict";

  const el = (id) => document.getElementById(id);
  // A desktop service already open during an update can still serve the old
  // list of assets. Reading and recovery should work until its next launch.
  const showDiagnostics=window.PLAN_DIAGNOSTICS?.attach(window.READER_SESSION.planDiagnostics) || (()=>{});
  const make = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const button = (label, className, handler) => {
    const node = make("button", className, label);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  };
  const readSession = (key, fallback) => {
    try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  };
  const saveSession = (key, value) => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ }
  };

  const catalog = new Map([["intervals", window.PROOF_DEMO]]);
  async function digest(bytes) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
  }
  let paper = null;
  let paperId = "";
  let view = "overview";
  let topic = "";
  let partId = "";
  let followActive = false;
  let localFocus = "";
  let originalText = "";
  let current = 0;
  let activeOption = -1;
  let moreQuestions = false;
  let traceRows = 1;
  let exampleFocus = -1;
  let sourceOpen = true;
  let draftName = "";
  let draftPdf = null;
  let lastImport = null;
  let localPdfUrl = "";
  let viewedPage = 1;
  let loadVersion = 0;
  let choiceVersion = 0;
  let openingChoice = "";
  let profile;
  try { profile = JSON.parse(localStorage.getItem("proofreader.knowledge")) || {}; }
  catch { profile = {}; }
  const legacyKnown = profile.known || readSession("proofreader.familiar", []);
  const knowledgeState = window.READER_KNOWLEDGE.create(profile,legacyKnown);
  let familiar = new window.READING_PLAN.TechniqueSet();
  const readWorks = new Map(profile.read || []);
  const stepHistory = [];
  let showAllSteps = false;
  let visitSkill = "";
  let routedSteps = [];
  let currentPlan;
  const drafts = new Map();
  const step = () => routedSteps[current] || paper.steps[current];
  const paperKey = () => paperId === "import" ? lastImport.hash : paperId;
  const paperChoice = () => paperId === "import" ? "doc-" + lastImport.hash : paperId;
  const normalTitle = entry => entry.title.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]/gu,"");
  const read = entry => readWorks.has(normalTitle(entry));
  const currentSession = () => window.READER_SESSION.session(paperKey());
  const visibleTurns = () => window.READER_SESSION.visibleTurns(paperKey());
  const notationPicker=window.NOTATION_PICKER.create({digest,extractPages:extractPdfPages,loadPaper:loadNotationPaper});
  let editingNotation=null;
  const editionKey=()=>currentSession().study.notationEdition ? currentSession().study.key : "";
  function displayPart(part) {
    const adapted=currentSession().study.notationEdition?.parts.find(p=>p.id===part.id);
    return adapted ? {...part,title:adapted.title} : part;
  }
  function saveProfile() {
    try {
      localStorage.setItem("proofreader.knowledge",JSON.stringify({...profile,known:legacyKnown,read:[...readWorks],...knowledgeState.serialize()}));
    } catch { /* Keep the profile in memory when browser storage is full. */ }
  }
  function entries() {
    return currentSession().research.papers || [];
  }
  const emptyKnowledge = {techniques:[],definitionGroups:[]};
  const knowledge = () => window.PAPER_KNOWLEDGE_DATA[paperId] || currentSession().research.knowledge || emptyKnowledge;
  function studyAnalysis() {
    const bundled = window.PAPER_KNOWLEDGE_DATA[paperId];
    if (!bundled) return currentSession().research;
    return {key:"bundled-" + paperId + "-v2",preparationVersion:2,displayTitle:paper.title,
      overview:overviewData(),knowledge:{techniques:bundled.techniques,definitionGroups:bundled.definitionGroups},
      parts:bundled.parts,localIntroductions:bundled.localIntroductions};
  }
  function selectedSource() {
    const selected = paper, doc = paperId === "import" ? lastImport : null;
    return () => paperSource(selected,doc);
  }
  const groupChoice = group => knowledgeState.groupChoice(paperKey(),group);
  const isKnown = technique => knowledgeState.isKnown(technique,entries(),paperKey());
  function namedTechnique(name) {
    return knowledge().techniques.find(t => t.name === name || t.aliases?.includes(name));
  }
  function techniqueLabel(t) {
    const keys = t.sources.map(s => entries().find(p => p.id === s.paperId)?.citeKey).filter(Boolean);
    return t.name + (!t.folklore && keys.length ? " [" + [...new Set(keys)].join(", ") + "]" : "");
  }
  function readerKnowledge() {
    return knowledgeState.tutor(paperKey(),knowledge(),entries());
  }
  function transferQuestion(index) {
    const technique = knowledge().techniques.find(t => t.steps.includes(index+1) && isKnown(t));
    return technique && {question:"What changes when this proof uses " + technique.name + "?",
      answer:technique.knownBridge,step:index+1};
  }
  function definitionQuestion(index) {
    const group = knowledge().definitionGroups.find(g => g.steps.includes(index+1) && groupChoice(g).state === "partial");
    if (!group) return null;
    const selected = groupChoice(group).terms;
    const missing = group.definitions.find(d => !selected.includes(d.term));
    if (selected.length && missing) return {question:"What does “" + missing.term + "” mean here?",answer:missing.meaning,step:index+1};
    return {question:"Review the definitions for " + group.title,step:index+1,
      answer:group.definitions.map(d => d.term + " — " + d.meaning).join("\n\n")};
  }
  function refreshPlan() {
    familiar = new window.READING_PLAN.TechniqueSet();
    for (const t of knowledge().techniques.filter(isKnown)) {
      for (const term of [t.name,...(t.planningSkills || [])]) familiar.add(term);
    }
    for (const g of knowledge().definitionGroups) {
      const selected = groupChoice(g).terms;
      for (const d of g.definitions.filter(d => selected.includes(d.term))) {
        familiar.add(d.term);
        for (const alias of d.aliases || []) familiar.add(alias);
      }
    }
    const checkpoints = currentSession().research.skills || [];
    routedSteps = paper.steps.map((s,i) => {
      const checks = checkpoints.filter(c => c.step === i + 1);
      const added = checks.flatMap(c => [{label:c.question,body:c.explanation},{label:c.knownQuestion,body:c.knownExplanation}]);
      for (const q of [transferQuestion(i),definitionQuestion(i)].filter(Boolean)) added.push({label:q.question,body:q.answer});
      if (!added.length) return s;
      return {...s,title:isPageReader() && checks.length ? checks[0].name : s.title,
        technique:s.technique || checks[0]?.name,checkpoints:checks,
        options:[...s.options,...added.filter(opt => !s.options.some(o => o.label === opt.label))]};
    });
    const papers = entries();
    currentPlan = window.READING_PLAN.plan({paperId,steps:routedSteps,current,known:familiar,
      readPapers:new Set(papers.filter(read).map(entry => entry.id)),literature:papers});
    const promoted = [transferQuestion(current),definitionQuestion(current)].filter(Boolean)
      .map(q => step().options.findIndex(o => o.label === q.question)).filter(i => i >= 0);
    currentPlan.questions = [...promoted,...currentPlan.questions.filter(i => !promoted.includes(i))];
  }
  async function extractPdfPages(pdf) {
    const response=await fetch("/api/pdf",{method:"POST",headers:{"Content-Type":"application/pdf"},body:pdf});
    const result=await response.json();
    if (!response.ok) throw new Error(result.error || "Could not read this PDF.");
    if (!Array.isArray(result.pages) || !result.pages.length) throw new Error("The PDF page index is unavailable. Reopen the updated reader and try again.");
    return result.pages;
  }
  async function loadNotationPaper(entry) {
    const {paperPages,textUnits}=window.NOTATION_PICKER;
    const doc=await window.PAPER_LIBRARY.get(entry.key);
    if (!doc) throw new Error("The reference paper could not be found. Choose the file or paste a passage.");
    return {id:entry.key,title:doc.preparedTitle || entry.title,units:doc.pages ? paperPages(doc.pages) : textUnits(doc.text || ""),
      ...(doc.pages && doc.file instanceof Blob ? {file:doc.file} : {})};
  }
  async function paperSource(selected = paper, imported = paperId === "import" ? lastImport : null) {
    const units = selected.steps.map((s,i) => {
      let text = imported?.pages ? imported.pages[i] : s.source;
      if (selected === window.PROOF_DEMO && i === 0) {
        text = selected.subtitle + "\n\n" + text;
      }
      const unit = {title:s.title,text:text || ""};
      if (s.page) unit.page = s.page;
      return unit;
    });
    const result = {title:selected.title,units};
    if (imported?.text) {
      result.sourceOpening = imported.text.slice(0,16000);
      if (!imported.pages) {
        result.paperId=imported.hash;
        result.sourceText=imported.text;
      }
    }
    if (imported?.file) result.pdfBase64 = await window.READER_SESSION.pdfBytes(imported.file);
    return result;
  }
  const isDemo = () => paper === window.PROOF_DEMO;
  const isPageReader = () => paperId === "import" && !!lastImport?.pages;
  function paperState() {
    if (openingChoice) return "opening";
    if (!paperId) return "empty";
    const research = currentSession().research;
    if (paperId === "import" && research.preparation === false) return "source-only";
    if (paperId === "import" && !window.READER_SESSION.isPrepared(research)) {
      if (!research.preparation) return "source-only";
      return research.status==="error" && !window.READER_SESSION.recoveringOverview(research) ? "failed" : "preparing";
    }
    const study = currentSession().study;
    if (editingNotation===study && ["ready","error"].includes(study.status)) return "preflight";
    if (!study?.status || study.analysisKey !== studyAnalysis().key) return "preflight";
    if (study.status === "ready") return window.READER_SESSION.sameSections(study.parts,studyAnalysis())?"":"preflight";
    return study.status === "error" && (study.needsAction || study.unexpected) ? "tailor-failed" : "tailoring";
  }
  function showPlanProgress(state) {
    const {study,research}=currentSession();
    const overview=state==="preparing", running=state==="tailoring", failed=state==="tailor-failed";
    const progress=(running || failed) && study?.progress;
    const total=progress?.totalParts, completed=progress?.completedParts;
    const counted=Number.isInteger(total) && total>0 && Number.isInteger(completed) && completed>=0 && completed<=total;
    const start=overview ? research.startedAt : progress?.startedAt || study?.startedAt;
    const details=[];
    const adapting=progress?.stage==="rewriting-notation" || progress?.stage==="adapting-notation";
    const drafted=progress?.draftedParts;
    const draftCounted=counted && !adapting && Number.isInteger(drafted) && drafted>=completed && drafted<=total;
    if (draftCounted) details.push(drafted+" of "+total+" parts drafted");
    if (counted) details.push(completed+" of "+total+(adapting?" parts adapted":" parts reviewed"));
    const work=details.join(" · ");
    const waiting=progress?.waitingParts;
    if (Array.isArray(waiting) && waiting.length) {
      details.push(waiting.length===1?"Part "+waiting[0]+" is waiting for a prerequisite":
        "Parts "+waiting.join(", ")+" are waiting for prerequisites");
    }
    if ((running || overview) && Number.isFinite(start)) {
      const seconds=Math.max(0,Math.floor((Date.now()-start)/1000));
      details.push((seconds>=60?Math.floor(seconds/60)+"m ":"")+(seconds%60)+"s elapsed");
    }
    const bar=el("planPartCount");
    bar.hidden=!counted;
    if (counted) {
      bar.max=draftCounted?2*total:total;
      bar.value=draftCounted?drafted+completed:completed;
      bar.setAttribute("aria-label",adapting?"Notation adaptation":"Reading plan preparation");
      bar.setAttribute("aria-valuetext",work);
    }
    const imported=paperId==="import" && lastImport;
    const reconnecting=running && study.status==="waiting-service";
    const estimate=(overview || running) && !reconnecting ? window.READING_PLAN.preparationEstimate({overview,startedAt:start,
      pages:imported?.pages?.length,characters:imported?.text?.length,parts:studyAnalysis().parts?.length,
      reference:!!study?.notationReference,progress:progress || {}}) : "";
    const estimateLine=el("preparationEstimate");
    if (estimateLine.textContent!==estimate) estimateLine.textContent=estimate;
    estimateLine.hidden=!estimate;
    el("planProgress").hidden=!details.length && !estimate;
    el("paperStateActivity").hidden=counted;
    const detail=details.join(" · ");
    if (el("planProgressDetail").textContent!==detail) el("planProgressDetail").textContent=detail;
    if (overview && research.disconnected) return "Waiting for the local reading service to reconnect. Preparation will resume from the saved paper.";
    if (overview && (research.progress?.recovery || research.repairSubmitted)) return "The reading service is checking the paper again and will continue preparing its overview.";
    if (!running) return "";
    if (reconnecting) return "Waiting for the local reading service to reconnect. Your selections are saved. Preparation will resume automatically.";
    if (study.status==="recovering" || study.status==="error") return "Checking the saved work for this plan and resuming with your selected notation.";
    const first=progress?.firstPart, last=progress?.lastPart;
    let range="the reading plan";
    if (Number.isInteger(first) && Number.isInteger(last) && first>0 && last>=first && last<=total) {
      range=first===last?"part "+first:"parts "+first+"–"+last;
    }
    const messages={
      preparing:"Preparing the paper and your background selections.",
      "adapting-notation":"Matching symbols to your reference paper before preparing the reading plan.",
      "rewriting-notation":"Adapting the notation in "+range+".",
      "reading-source":"Reading the source for "+range+".",
      drafting:"Drafting "+range+".",
      checking:"Checking "+range+" against the paper.",
      "revising-draft":"Revising "+range+" after checking the source.",
      editing:"The editor is reviewing "+range+".",
      "revising-notation":"Clarifying the notation in "+range+".",
      saving:"Saving the reviewed reading plan."
    };
    if (progress?.recovery) {
      const actions={"revise-notation":"Checking the symbol mapping against your reference paper.",
        "split-batch":"Preparing the affected sections in smaller groups.",
        "find-defining-passage":"Locating the definitions in the original paper.",
        "review-section":"Checking the affected section against the paper.",
        "revise-draft":"Revising the affected draft against the paper."};
      return actions[progress.recovery.action] || "Resuming preparation from the last saved section.";
    }
    return messages[progress?.stage] || (study?.status==="running"?"Waiting for a progress report from the reading service.":"Sending the paper and your selections to the reading service.");
  }
  function definitionSourceFailure(study) {
    let cards=study?.progress?.sourceDefinitions;
    if (!cards?.length) {
      // Previous services saved the card names only in the error message.
      const message=study?.message || "";
      if (!message.startsWith("The source check needs another pass for ")) return "";
      const matches=[...message.matchAll(/“([^”]+)” — (?:use the defining source words for|supply the source passage defining) (.+?)\.(?= “| Retry to continue)/gu)];
      if (!matches.length || matches.length!==(message.match(/” — /gu) || []).length) return "";
      const parts=studyAnalysis().parts || [];
      cards=matches.map(([,title,name])=>({title,name,part:parts.findIndex(p=>p.title===title)+1}));
    }
    const labels=cards.map(c=>"“"+c.name+"” ("+(c.part?"part "+c.part:c.title)+")");
    return "The reader couldn’t verify the source for "+labels.join(" and ")+". Retry to check "+(cards.length===1?"this definition":"these definitions")+" again.";
  }
  function showPaperState(state) {
    const planPending=state==="tailoring" || state==="tailor-failed";
    const overviewFailure=state==="failed" && currentSession().research.unexpected;
    showDiagnostics(planPending || overviewFailure?paperKey():null,planPending?currentSession().study:overviewFailure?currentSession().research:null,
      overviewFailure?"overview":"plan");
    document.body.dataset.paperState = state === "tailoring" ? "preparing" : state === "tailor-failed" ? "failed" : state;
    el("paperTitle").textContent = "";
    window.STAGE_UI.part(null);
    el("overviewPanel").hidden = el("stepSheet").hidden = el("stageReader").hidden = true;
    if (state === "empty" || state === "opening") {
      const empty = state === "empty";
      el("paperStateTitle").textContent = empty ? "Your library is empty" : "Opening paper…";
      el("paperStateMessage").textContent = empty ? "Import a paper to start reading." : "Loading the saved document.";
      el("paperStateActivity").hidden = empty;
      el("planProgress").hidden = el("changeFailedNotation").hidden = true;
      return;
    }
    if (state === "preflight") {
      window.STAGE_UI.preflight({...profileOptions(),title:studyAnalysis().displayTitle,
        setKnown:(technique,known) => {
          knowledgeState.setPreflightKnown(paperKey(),technique,known);
          updateProfile();
        }});
      const current=currentSession(), selected=paperKey();
      const library=[...el("paperPicker").options].filter(o=>o.value.startsWith("doc-") && o.value!=="doc-"+selected)
        .map(o=>({key:o.value.slice(4),title:o.textContent}));
      const refs=Object.values(current.studyPlans).map(s=>s.notationReference);
      notationPicker.mount(selected,current.study.notationReference,refs,library);
      el("cancelNotation").hidden=!editingNotation;
      el("cancelNotation").textContent=current.study.status==="error"?"Cancel":"Back to reading";
      return;
    }
    const progressMessage=showPlanProgress(state);
    const {study,research}=currentSession();
    const sourceFailure=state==="tailor-failed" && !study.unexpected && definitionSourceFailure(study);
    const messages = {
      preparing:["Preparing your paper…",progressMessage || "Preparing the overview, proof techniques, and definitions."],
      tailoring:["Preparing your reading plan…",progressMessage],
      "tailor-failed":[study.unexpected?"Couldn’t prepare your reading plan":sourceFailure?"Preparation paused at source review":"Preparation needs attention",sourceFailure || study.message || "Check the local reading service, then continue with your saved selections."],
      failed:[research.needsAction?"Paper preparation needs attention":"Couldn’t prepare this paper",research.message || "Check the local reading service, then continue from your saved document."],
      "source-only":["Original document","Open the original or prepare a reading guide."]
    };
    const [title,message] = messages[state];
    el("changeFailedNotation").hidden=state!=="tailor-failed" || !["source","reference"].includes(currentSession().study.actionRequired) || !!sourceFailure || !currentSession().study.notationReference;
    if (el("paperStateTitle").textContent !== title) el("paperStateTitle").textContent = title;
    if (el("paperStateMessage").textContent !== message) el("paperStateMessage").textContent = message;
  }
  function focusReadingTitle() {
    const state = document.body.dataset.paperState;
    el(state === "preflight" ? "preflightTitle" : state ? "paperStateTitle" : "paperTitle").focus({preventScroll:true});
  }

  function storeReading(push = false) {
    const choice = paperChoice();
    const savedPart = view === "part" || view === "passage" ? partId : "";
    saveSession("proofreader.reading", {paperId:choice,current,part:savedPart,view,followActive});
    try {
      localStorage.setItem("proofreader.lastPaper",choice);
      if (!document.body.dataset.paperState) localStorage.setItem("proofreader.partLocation." + choice,
        JSON.stringify({part:view === "part" ? partId : "",followActive:view === "part" && followActive}));
    } catch { /* The current paper is still open. */ }
    if (location.protocol !== "file:") {
      const url = new URL(location.href);
      const paperChanged = url.searchParams.has("paper") && url.searchParams.get("paper") !== choice;
      const nextStep = view === "passage" ? String(current + 1) : null;
      if (paperChanged || url.searchParams.get("step") !== nextStep || (url.searchParams.get("topic") || "") !== topic ||
          (url.searchParams.get("part") || "") !== savedPart) {
        url.hash = "";
        pendingReference = "";
      }
      url.searchParams.set("paper",choice);
      if (view === "passage") url.searchParams.set("step",String(current + 1));
      else url.searchParams.delete("step");
      if (topic && (view === "topic" || view === "passage")) url.searchParams.set("topic",topic);
      else url.searchParams.delete("topic");
      if (savedPart) url.searchParams.set("part",savedPart);
      else url.searchParams.delete("part");
      if (view === "part" && localFocus) url.hash = "local/" + encodeURIComponent(localFocus);
      else if (url.hash.startsWith("#local/")) url.hash = "";
      if (location.href !== url.href) history[push ? "pushState" : "replaceState"](null,"",url);
    }
  }
  function overviewData() {
    return window.PAPER_OVERVIEW.get({paperId,research:currentSession().research});
  }
  function showExploration(nextTopic = "",push = true) {
    topic = nextTopic;
    partId = localFocus = "";
    followActive = false;
    view = topic ? "topic" : "overview";
    render();
    storeReading(push);
    focusReadingTitle();
    window.scrollTo(0,0);
  }
  function techniqueFragment(t,paper) {
    return "technique/" + encodeURIComponent(t.id) + (paper ? "/" + encodeURIComponent(paper.id) : "");
  }
  function showTechnique(t,paper,changeUrl = true) {
    referenceDialog = true;
    renderProfile();
    if (!el("profileDialog").open) el("profileDialog").showModal();
    window.KNOWLEDGE_UI.reveal(el("paperKnowledge"),t.id,paper?.id);
    const hash = "#" + techniqueFragment(t,paper);
    if (changeUrl && location.protocol !== "file:" && location.hash !== hash) history.pushState(null,"",hash);
  }
  function showDefinition(group,changeUrl = true) {
    referenceDialog = true;
    renderProfile();
    const dialog = el("profileDialog");
    if (!dialog.open) dialog.showModal();
    window.KNOWLEDGE_UI.revealDefinition(el("paperKnowledge"),group.id);
    const hash = "#definition/" + encodeURIComponent(group.id);
    if (changeUrl && location.protocol !== "file:" && location.hash !== hash) history.pushState(null,"",hash);
  }
  function openStage(id,{track = false,introduction = "",push = true} = {}) {
    view = "part";
    topic = "";
    partId = id || "";
    localFocus = introduction;
    followActive = track;
    render();
    storeReading(push);
  }
  function resumePart() {
    const study = currentSession().study;
    if (study?.status !== "ready") return;
    openStage(study.parts[Math.min(study.activeIndex,study.parts.length - 1)].id,{track:true});
  }
  function openPartReference(ref) {
    if (ref.kind === "local") {
      const intro = studyAnalysis().localIntroductions.find(item => item.id === ref.id);
      if (intro) openStage(intro.originPartId,{introduction:intro.id});
    } else if (ref.kind === "definition") {
      const group = knowledge().definitionGroups.find(g => g.id === ref.id);
      if (group) showDefinition(group);
    } else if (ref.kind === "technique") {
      const method = knowledge().techniques.find(t => t.id === ref.id);
      if (method) showTechnique(method);
    }
  }
  const explorationQuestions = {
    example:"Walk me through a small worked example.",
    simplify:"Can you solve a simpler version of this problem?",
    remove:"What breaks in the proof if we remove a condition?"
  };
  function renderStage() {
    const analysis = studyAnalysis();
    const study = currentSession().study;
    const parts = analysis.parts.map(displayPart);
    const activeIndex = Math.min(study.activeIndex,parts.length - 1);
    let index = parts.findIndex(p => p.id === partId);
    if (followActive || index < 0) index = activeIndex;
    const part = parts[index];
    const changed = partId !== part.id;
    partId = part.id;
    const completed = study.completed || [];
    const prior = completed.find(c => c.partId === parts[index-1]?.id);
    const turns = currentSession().turns.filter(t => t.studyKey === study.key);
    const discussion = turns.filter(t => t.partId === partId);
    const busy = discussion.some(t => t.status === "starting" || t.status === "running");
    const tailored = study.parts.find(p => p.id === partId);
    const savedSection = window.PART_ORIENTATION.normalize(tailored.orientation);
    const orientation = savedSection || window.PART_ORIENTATION.normalize(part.orientation);
    const sectionJob = study.orientationJob?.format === window.READER_SESSION.sectionFormat ? study.orientationJob : null;
    const archived = index < study.activeIndex;
    const enrich = (retry = false) => window.READER_SESSION.ensureOrientation(paperKey(),selectedSource(),analysis,{retry});
    function askInPart(question,retryTurn,exploration,checkpoint) {
      if (busy || !question.trim()) return;
      const exploringHistory = archived && !checkpoint && (exploration || retryTurn?.exploration);
      if (!exploringHistory && index !== study.activeIndex) return;
      followActive = !archived;
      const stepSkills = analysis.knowledge.techniques.filter(t => part.techniqueIds.includes(t.id)).map(t => t.name);
      return window.READER_SESSION.askPart(paperKey(),selectedSource(),{
        analysis,studyKey:study.key,partId:part.id,question,retryTurn,stepSkills,readerKnowledge:readerKnowledge(),exploration,checkpoint,
        moduleId:window.STAGE_UI.currentModule?.()
      });
    }
    window.STAGE_UI.part({
      paperKey:paperKey(),studyKey:study.key,part,parts,index,furthest:activeIndex,archived,busy,preview:index > study.activeIndex,complete:study.activeIndex >= parts.length,
      localId:localFocus,knowledge:analysis.knowledge,localIntroductions:analysis.localIntroductions,techniqueLabel,
      opening:tailored.opening,firstQuestion:tailored.question,turns:discussion,
      orientation,orientationStatus:sectionJob,onRetryOrientation:() => enrich(true),
      sectionGuide:window.READER_SESSION.partGuide(study,part.id),
      onReadStructure:()=>window.READER_SESSION.readStructure(paperKey(),selectedSource(),study,analysis,part.id),
      canContinue:index === study.activeIndex && !busy,
      previousCompletion:prior ? {index:index-1,title:parts[index-1].title,evidence:prior.evidence,
        answer:turns.find(t => t.id === prior.turnId)?.answer} : null,
      onReference:openPartReference,onReview:i => openStage(parts[i].id),onResume:resumePart,
      onSource:n => openStep(n-1,true),
      onAsk:askInPart,
      onCheckpoint:(answer,retryTurn) => askInPart(answer,retryTurn,undefined,true),
      onExplore:({mode,target}) => {
        const prompt = explorationQuestions[mode];
        if (!prompt) return;
        const question = target ? prompt + "\n\n" + target : prompt;
        return askInPart(question,undefined,{mode,target});
      },
      onContinue:() => {
        followActive = true;
        window.READER_SESSION.finishPart(paperKey(),part.id);
      }
    });
    if (changed) storeReading(false);
    if (window.READER_SESSION.needsEditorialReview(study) && sectionJob?.status !== "error") void enrich();
  }
  const explorer = window.PAPER_EXPLORER.create({
    state:() => ({key:paperKey(),editionKey:editionKey(),notationEdition:currentSession().study.notationEdition,topic,
      overview:currentSession().study.notationEdition?.overview || overviewData(),turns:visibleTurns().filter(t => !t.studyKey),steps:routedSteps,entries:entries(),
      known:knowledge().techniques.filter(isKnown).map(t => t.name),readPapers:entries().filter(read).map(p => p.title),isRead:read,
      isKnown:skill => !!namedTechnique(skill) && isKnown(namedTechnique(skill)), namedTechnique,techniqueLabel,
      readerKnowledge:readerKnowledge(),skills:knowledge().techniques.map(t => t.name),transferQuestion,definitionQuestion,
      stepTechniques:n => knowledge().techniques.filter(t => t.steps.includes(n)),
      partsForStep:n => (studyAnalysis().parts || []).filter(p => p.sourceSteps.includes(n)).map(displayPart)}),
    openPart:id => openStage(id),
    openTopic:showExploration,openSource:index => openStep(index,true),showTechnique,source:paperSource,markSkill
  });

  function openStep(index, focus = false, remember = true) {
    if (view !== "passage" && view !== "part") partId = "";
    localFocus = "";
    view = "passage";
    if (focus && remember && index !== current) stepHistory.push(current);
    current = Math.max(0, Math.min(index, paper.steps.length - 1));
    activeOption = -1;
    moreQuestions = false;
    traceRows = 1;
    exampleFocus = -1;
    visitSkill = "";
    sourceOpen = true;
    render();
    storeReading(focus);
    if (focus) el(document.body.dataset.paperState ? "paperStateTitle" : "stepTitle").focus();
  }

  function renderNavigation() {
    const nav = el("roadmap");
    const study = currentSession().study;
    if (study?.status === "ready" && !showAllSteps) {
      el("navTitle").textContent = "Reading parts";
      nav.setAttribute("aria-label","Choose a part discussion");
      el("routeToggle").hidden = false;
      el("routeToggle").textContent = "View source passages";
      nav.replaceChildren(...study.parts.map((p,i) => {
        const control = button("","road-step",() => {
          el("navigationDialog").close();
          openStage(p.id,{track:i === study.activeIndex});
        });
        if (view === "part" && p.id === partId) control.setAttribute("aria-current","page");
        const status = i < study.activeIndex ? " · Completed" : i === study.activeIndex ? " · Current" : "";
        control.append(make("span","step-no",String(i+1).padStart(2,"0")),make("span","step-title",displayPart(p).title + status));
        return control;
      }));
      window.READER_MATH?.render(nav);
      return;
    }
    const hasPageGuide = isPageReader() && routedSteps.some(s => s.checkpoints?.length);
    el("navTitle").textContent = isPageReader() && !hasPageGuide ? "Original pages" : "Reading route";
    nav.setAttribute("aria-label", isPageReader() ? "Choose a page" : "Choose a proof step");
    const originalOrder = paper.steps.map((_,i) => i);
    const adjusted = currentPlan.route.length !== originalOrder.length || currentPlan.route.some((n,i) => n !== i);
    el("routeToggle").hidden = study?.status !== "ready" && !adjusted;
    el("routeToggle").textContent = showAllSteps ? "View reading parts" : "View steps in source order";
    const sequence = showAllSteps ? originalOrder : [...currentPlan.route];
    if (!sequence.includes(current)) sequence.unshift(current);
    nav.replaceChildren(...sequence.map(i => {
      const s = routedSteps[i];
      const control = button("", "road-step", () => { el("navigationDialog").close(); openStep(i,true); });
      if (i === current) control.setAttribute("aria-current", "step");
      control.append(make("span", "step-no", String(i + 1).padStart(2, "0")), make("span", "step-title", s.title));
      return control;
    }));
    el("profileButton").textContent = "Reading knowledge";
  }

  let pendingReference = "";
  let referenceDialog = false;
  function openReferenceAtHash() {
    const id = location.hash.slice(1);
    if (paperState()) { pendingReference = id; return; }
    pendingReference = "";
    const waiting = paperId === "import" && ["starting","running"].includes(currentSession().research.status);
    if (id.startsWith("technique/")) {
      let parts;
      try { parts = id.split("/").slice(1).map(decodeURIComponent); } catch { return; }
      const t = knowledge().techniques.find(item => item.id === parts[0]);
      if (t) showTechnique(t,entries().find(p => p.id === parts[1]),false);
      else if (waiting) pendingReference = id;
    } else if (id.startsWith("definition/")) {
      let key;
      try { key = decodeURIComponent(id.slice(11)); } catch { return; }
      const g = knowledge().definitionGroups.find(group => group.id === key);
      if (g) showDefinition(g,false);
    } else if (id.startsWith("local/")) {
      let key;
      try { key = decodeURIComponent(id.slice(6)); } catch { return; }
      const intro = studyAnalysis().localIntroductions.find(item => item.id === key);
      if (referenceDialog && el("profileDialog").open) el("profileDialog").close();
      if (intro && (view !== "part" || partId !== intro.originPartId || localFocus !== key)) {
        openStage(intro.originPartId,{introduction:key,push:false});
      }
    } else if (id.startsWith("lit-ref-") || id.startsWith("prior-lit-ref-")) {
      const prior = id.startsWith("prior-");
      const anchor = prior ? id.slice(6) : id;
      const p = entries().find(item => window.READER_KNOWLEDGE.oldPassageId(item) === anchor);
      const matches = p ? knowledge().techniques.filter(item => item.sources.some(s => s.paperId === p.id)) : [];
      const t = matches.find(item => item.steps.includes(current+1)) || matches[0];
      if (!t) { if (waiting) pendingReference = id; return; }
      if (!prior) { showTechnique(t,p,false); return; }
      if (referenceDialog && el("profileDialog").open) el("profileDialog").close();
      const origin = el("prior-" + t.id);
      if (origin) {
        origin.focus({preventScroll:true});
        origin.scrollIntoView({block:"center"});
      }
    } else {
      if (referenceDialog && el("profileDialog").open) el("profileDialog").close();
      if (view === "part" && localFocus) { localFocus = ""; renderStage(); }
    }
  }
  window.addEventListener("hashchange",openReferenceAtHash);

  function referenceLink(ref, className) {
    const link = make("a",className);
    link.href = "#" + techniqueFragment(ref.technique,ref.entry);
    link.title = techniqueLabel(ref.technique);
    link.setAttribute("aria-label","Explore " + link.title + (ref.entry ? " in " + ref.entry.title : ""));
    link.addEventListener("click", event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      showTechnique(ref.technique,ref.entry);
    });
    return link;
  }
  function markPassage(host, text, references) {
    host.replaceChildren();
    const matches = [];
    for (const ref of references) {
      if (!ref.phrase || ref.placed) continue;
      const start = text.indexOf(ref.phrase);
      if (start !== -1 && text.lastIndexOf(ref.phrase) === start) matches.push({ref,start});
    }
    matches.sort((a,b) => a.start - b.start || b.ref.phrase.length - a.ref.phrase.length);
    let offset = 0;
    for (const {ref,start} of matches) {
      if (start < offset) continue;
      const link = referenceLink(ref,"prior-phrase");
      link.id = "prior-" + ref.id;
      link.append(document.createTextNode(ref.phrase), make("sup","prior-marker",String(ref.number)));
      host.append(document.createTextNode(text.slice(offset,start)),link);
      offset = start + ref.phrase.length;
      ref.placed = true;
    }
    host.append(document.createTextNode(text.slice(offset)));
  }
  function renderSource() {
    const s = step();
    const papers = entries();
    const references = knowledge().techniques.filter(t => t.steps.includes(current+1)).map((technique,i) => {
      const candidates = technique.sources.map(s => papers.find(p => p.id === s.paperId)).filter(Boolean);
      const entry = candidates.find(p => p.steps.includes(current+1)) || candidates[0];
      const phrase = entry?.anchors?.[current+1] || entry?.sourceAnchors?.find(a => a.step === current+1)?.phrase;
      return {technique,entry,phrase,number:i+1,id:technique.id,citation:techniqueLabel(technique)};
    });
    markPassage(el("summary"),s.summary || "",references);
    const excerpt = el("excerpt");
    excerpt.hidden = !sourceOpen || isPageReader();
    if (excerpt.hidden) excerpt.textContent = s.source || "";
    else markPassage(excerpt,s.source || "",references);
    const notes = el("priorWork");
    notes.hidden = !references.length;
    notes.replaceChildren();
    if (references.length) {
      notes.append(make("span","prior-label",references.length === 1 ? "Technique" : "Techniques"));
      for (const ref of references) {
        const link = referenceLink(ref,"prior-citation");
        if (!ref.placed) link.id = "prior-" + ref.id;
        link.append(make("span","prior-number","[" + ref.number + "] "),document.createTextNode(ref.citation));
        if (isPageReader() && ref.phrase) link.append(make("span","prior-quote"," · “" + ref.phrase + "”"));
        notes.append(link);
      }
    }
    const toggle = el("showSource");
    const kind = "source passage";
    toggle.hidden = isPageReader();
    toggle.textContent = (sourceOpen ? "Hide " : "Show ") + kind;
    toggle.setAttribute("aria-expanded", String(sourceOpen));
    window.READER_MATH?.render(el("summary"));
    window.READER_MATH?.render(excerpt);
  }

  function render() {
    const choice = openingChoice || paperChoice();
    el("paperPicker").value = choice;
    el("paperPicker").disabled = !choice;
    el("removePaper").hidden = !paperId || !!openingChoice;
    const state = paperState();
    if (state) {
      if (paperId === "import" && !openingChoice && (state === "failed" || state === "preparing")) {
        registerPaper(paperKey(),state === "failed" ? "Preparation paused" : "Preparing paper…");
      }
      showPaperState(state);
      return;
    }
    const focusFromState = document.body.dataset.paperState && (el("paperStatePanel").contains(document.activeElement) || el("preflightPanel").contains(document.activeElement));
    showDiagnostics(null,null);
    delete document.body.dataset.paperState;
    if (paperId === "import") paper.title = currentSession().research.displayTitle;
    refreshPlan();
    const s = step();
    document.body.dataset.readingView = view;
    if (view !== "part") window.STAGE_UI.part(null);
    el("stepSheet").hidden = view !== "passage";
    el("overviewPanel").hidden = view !== "overview" && view !== "topic";
    el("stageReader").hidden = view !== "part";
    el("backOverview").hidden = view === "overview";
    el("returnTopic").hidden = view !== "passage" || (!topic && !partId);
    el("returnTopic").textContent = partId ? "Back to part discussion" : "Back to discussion";
    el("readCurrentPart").hidden = false;
    const study = currentSession().study;
    el("readCurrentPart").textContent = study.activeIndex >= study.parts.length ? "Review your discussions" :
      (study.activeIndex > 0 ? "Continue reading" : "Read the first part") + " · " + displayPart(study.parts[study.activeIndex]).title;
    window.READER_MATH?.render(el("readCurrentPart"));
    el("paperTitle").textContent = paper.title;
    el("sourceToggle").textContent = isPageReader() ? "Original PDF" : "Original text";
    renderNavigation();
    if (focusFromState) focusReadingTitle();
    if (view === "part") {
      renderStage();
      if (pendingReference) openReferenceAtHash();
      return;
    }
    if (view !== "passage") {
      explorer.render();
      if (pendingReference) openReferenceAtHash();
      return;
    }
    el("stepTitle").textContent = s.title;
    el("stepMeta").textContent = s.location || "";
    el("stepMeta").hidden = isPageReader() && !s.checkpoints?.length;
    const inline = el("inlinePage");
    inline.hidden = !isPageReader();
    if (isPageReader()) window.pageView.show(inline, {file:lastImport.file, page:s.page});
    else window.pageView.clear(inline);
    el("optionList").hidden = !s.options.length;
    el("previous").disabled = previousStep() === null;
    el("next").disabled = nextStep() === null;
    el("previous").textContent = isPageReader() ? "Previous page" : "Previous step";
    el("next").textContent = isPageReader() ? "Next page" : "Next step";
    el("readCount").textContent = (current + 1) + " / " + paper.steps.length;
    renderSource();
    const matchingParts = studyAnalysis().parts.filter(part => part.sourceSteps.includes(current+1));
    const links = el("sourcePartLinks");
    links.hidden = !matchingParts.length;
    links.replaceChildren(...matchingParts.map(part => button("Discuss " + displayPart(part).title,"path-link",() => openStage(part.id))));
    renderOptions();
    renderKnowledge();
    renderConversation();
    if (pendingReference) openReferenceAtHash();
    window.READER_MATH?.render(el("stepSheet"));
  }

  function renderOptions() {
    const choices = currentPlan.questions;
    const visible = 3;
    el("moreQuestions").hidden = choices.length <= visible;
    el("moreQuestions").textContent = moreQuestions ? "Fewer questions" : "More questions (" + (choices.length - visible) + ")";
    el("moreQuestions").setAttribute("aria-expanded",String(moreQuestions));
    el("optionList").replaceChildren(...choices.map((index,rank) => {
      const option = step().options[index];
      const control = button(option.label, "option", () => {
        activeOption = activeOption === index ? -1 : index;
        traceRows = 1;
        exampleFocus = -1;
        updateAnswer();
      });
      control.setAttribute("aria-controls", "answer");
      control.dataset.index = String(index);
      control.hidden = rank >= visible && !moreQuestions && index !== activeOption;
      return control;
    }));
    updateAnswer();
  }
  el("moreQuestions").addEventListener("click",() => { moreQuestions = !moreQuestions; renderOptions(); });

  function updateProfile() {
    saveProfile();
    render();
    if (el("profileDialog").open) renderProfile();
  }
  function markSkill(skill,known) {
    const technique = typeof skill === "string" ? namedTechnique(skill) : skill;
    if (!technique) return;
    const inCheckpoint = el("skillPrompt").contains(document.activeElement);
    knowledgeState.setKnown(technique,entries(),known,paperKey());
    updateProfile();
    if (inCheckpoint) el("skillPrompt").querySelector("button")?.focus({preventScroll:true});
  }
  function markRead(entry,checked) {
    if (checked) readWorks.set(normalTitle(entry),entry.title);
    else readWorks.delete(normalTitle(entry));
    updateProfile();
  }
  function nextStep() {
    if (showAllSteps) return current < paper.steps.length - 1 ? current + 1 : null;
    return currentPlan.next;
  }
  function previousStep() {
    if (stepHistory.length) return stepHistory.at(-1);
    if (showAllSteps) return current > 0 ? current - 1 : null;
    const position = currentPlan.route.indexOf(current);
    return position > 0 ? currentPlan.route[position - 1] : null;
  }
  function renderKnowledge() {
    const area = el("skillPrompt");
    area.replaceChildren();
    const candidates = knowledge().techniques.filter(t => t.steps.includes(current+1));
    const t = candidates.find(t => t.id === visitSkill) || candidates.find(t => !isKnown(t)) || candidates[0];
    area.hidden = !t;
    if (!t) return;
    visitSkill = t.id;
    const known = isKnown(t);
    const title = make("strong","",(known ? "Familiar technique · " : "Familiar with ") + techniqueLabel(t) + (known ? "" : "?"));
    const controls = make("div","skill-controls");
    if (!known) controls.append(button("I know this","control",() => markSkill(t,true)));
    controls.append(button("See the technique","ghost",() => showTechnique(t)));
    area.append(title,controls);
    if (known) area.append(make("p","transfer-note",t.knownBridge));
  }
  function profileOptions() {
    return {
      knowledge:knowledge(),papers:entries(),paperKey:paperKey(),isKnown,setKnown:markSkill,isRead:read,setRead:markRead,
      definitionState:g => groupChoice(g).state,knownTerms:g => new Set(groupChoice(g).terms),
      setDefinitionState:(g,state) => { knowledgeState.setGroup(paperKey(),g,state); updateProfile(); },
      setTermKnown:(g,term,value) => { knowledgeState.setTerm(paperKey(),g,term,value); updateProfile(); },
      research:currentSession().research
    };
  }
  function renderProfile() {
    window.KNOWLEDGE_UI.mount(el("paperKnowledge"),profileOptions());
    const study=currentSession().study,edition=study.notationEdition;
    el("currentNotation").hidden=study.status!=="ready";
    el("notationName").textContent="Notation · "+(study.notationReference?.title || "This paper");
    const rows=edition?.mappings || [];
    el("notationKey").hidden=!edition;
    const content=el("notationMappings");
    if (rows.length) {
      const list=make("dl","notation-list");
      for (const r of rows) {
        const scope=r.partIds?.length && r.partIds.length < study.parts.length ?
          r.partIds.map(id=>displayPart(study.parts.find(part=>part.id===id)).title).join(", ") : "";
        list.append(make("dt","",r.concept),make("dd","",
          "\\("+r.preferred+"\\) here · \\("+r.original+"\\) in the original"+(scope ? " · "+scope : "")));
      }
      content.replaceChildren(list);
      window.READER_MATH?.render(content);
    } else content.textContent=edition ? "This reading uses the original symbols throughout." : "";
  }
  const draftKey = () => paperKey() + "/" + current + "/" + editionKey();
  function renderEarlierQuestions() {
    const other = visibleTurns().filter(t => !t.studyKey && t.step > 0 && t.step !== current + 1 && t.status === "ready").reverse();
    const area = el("earlierQuestions");
    area.hidden = !other.length;
    el("earlierList").replaceChildren(...other.map(turn => button("Step " + turn.step + " · " + turn.question,
      "path-link", () => {
        openStep(turn.step - 1,true);
        const item = [...el("turns").children].find(node => node.querySelector(".turn-question")?.textContent === turn.question);
        if (item) { item.tabIndex = -1; item.focus(); }
      })));
  }
  function renderConversation() {
    const log = el("turns");
    log.replaceChildren();
    const turns = visibleTurns().filter(t => !t.studyKey && t.step === current + 1);
    for (const turn of turns) {
      const group = make("div","turn");
      group.append(make("p","turn-question",turn.question));
      if (turn.status === "ready") {
        group.append(make("p","turn-answer",turn.answer));
        if (turn.locator) group.append(make("p","turn-locator",turn.locator));
        const discussed = namedTechnique(turn.discussedSkill);
        if (discussed) {
          const skill = discussed.name;
          const row = make("label","turn-check");
          const input = make("input");
          input.type = "checkbox";
          input.checked = isKnown(discussed);
          input.id = "turn-skill-" + turns.indexOf(turn);
          input.addEventListener("change", () => {
            markSkill(skill,input.checked);
            el(input.id)?.focus({preventScroll:true});
          });
          row.append(input,document.createTextNode("I understand " + techniqueLabel(discussed)));
          group.append(row);
        }
        if (turn === turns.at(-1) && turn.followups?.length) {
          const follow = make("div","followups");
          turn.followups.forEach(q => follow.append(button(q,"ghost", () => submitQuestion(q))));
          group.append(follow);
        }
      } else if (turn.status === "failed" || turn.status === "error") {
        group.append(make("p","turn-locator",turn.error || turn.message || "The reading service could not answer this question."));
        group.append(button("Retry question","ghost",() => submitQuestion(turn.question, turn)));
      }
      log.append(group);
    }
    const busy = turns.some(t => t.status === "starting" || t.status === "running");
    el("askSubmit").disabled = busy;
    el("askStatus").textContent = busy ? "Reading the passage and your earlier questions…" : "";
    const draft = drafts.get(draftKey()) || "";
    if (el("askText").value !== draft) el("askText").value = draft;
    renderEarlierQuestions();
    window.READER_MATH?.render(log);
  }
  function submitQuestion(value, retryTurn) {
    if (paperState()) return;
    const question = value.trim();
    if (!question) { el("askText").focus(); return; }
    const opt = step().options[activeOption];
    let context = null;
    if (opt) {
      const shown = [opt.body];
      const target = opt.targets?.[exampleFocus];
      if (target) shown.push(target.label + "\n" + target.body);
      if (opt.table) {
        const isTrace = opt.trace || (isDemo() && activeOption === 0 && (current === 0 || current === 2));
        const rows = isTrace ? opt.table.rows.slice(0,traceRows) : opt.table.rows;
        shown.push([opt.table.head,...rows].map(row => row.join(" | ")).join("\n"));
      }
      context = {question:opt.label,answer:shown.join("\n\n")};
    }
    if (el("askSubmit").disabled) return;
    if (!retryTurn) drafts.delete(draftKey());
    const key = paperKey();
    const reader = readerKnowledge();
    const stepSkills = knowledge().techniques.filter(t => t.steps.includes(current+1)).map(t => t.name);
    window.READER_SESSION.ask(key,paperSource,{step:current+1,question,known:reader.techniques.map(t => t.name),readerKnowledge:reader,
      readPapers:entries().filter(read).map(p => p.title),stepSkills,context,retryTurn});
  }
  function startResearch() {
    if (paperId === "import") {
      const doc = lastImport;
      return window.READER_SESSION.prepare(doc.hash,() => paperSource(doc.paper,doc));
    }
    return window.READER_SESSION.research(paperKey(),paperSource);
  }
  async function personalize() {
    if (el("continuePreflight").disabled) return;
    const version=choiceVersion;
    notationPicker.busy(true);
    try {
      const notationReference=await notationPicker.selection();
      if (version!==choiceVersion || paperState()!=="preflight") return;
      if (knowledgeState.confirmPreflightKnown(paperKey(),knowledge().techniques,entries())) saveProfile();
      editingNotation=null;
      await window.READER_SESSION.personalize(paperKey(),selectedSource(),{analysis:studyAnalysis(),readerKnowledge:readerKnowledge(),
        ...(notationReference?{notationReference}:{})});
      if (version===choiceVersion) render();
    } catch(error) {
      if (version===choiceVersion) {
        editingNotation=currentSession().study;
        render();
        notationPicker.showError(error.message || "Could not prepare this notation. Select a reference and try again.");
      }
    } finally {if (version===choiceVersion) notationPicker.busy(false);}
  }
  function resumePersonalization(options) {
    const research=currentSession().research;
    if (paperId === "import" && (research.preparation===false || !window.READER_SESSION.isPrepared(research))) return;
    const study = currentSession().study;
    if (study?.status && study.analysisKey === studyAnalysis().key) {
      window.READER_SESSION.resumeStudy(paperKey(),selectedSource(),studyAnalysis(),options);
    }
  }
  async function refreshOpenPreparation() {
    if (openingChoice || !paperId) return;
    const key=paperKey();
    if (paperId==="import" && currentSession().research.disconnected) window.READER_SESSION.resume(key,selectedSource());
    await window.READER_SESSION.refreshStudy(key);
    if (!openingChoice && key===paperKey()) resumePersonalization({wake:true});
  }
  for (const event of ["focus","pageshow","online"]) window.addEventListener(event,refreshOpenPreparation);
  document.addEventListener?.("visibilitychange",()=>{if (!document.hidden) refreshOpenPreparation();});
  el("continuePreflight").addEventListener("click",personalize);
  el("retryPaper").addEventListener("click",() => paperState() === "tailor-failed" ?
    window.READER_SESSION.retryStudy(paperKey(),selectedSource(),studyAnalysis()) : startResearch());
  function changeNotation() {
    if (el("profileDialog").open) el("profileDialog").close();
    editingNotation=currentSession().study;
    notationPicker.reset();
    render();
    el("notationChoice").focus();
  }
  el("editNotation").addEventListener("click",changeNotation);
  el("changeFailedNotation").addEventListener("click",changeNotation);
  el("cancelNotation").addEventListener("click",()=>{
    editingNotation=null;
    notationPicker.reset();
    render();
    focusReadingTitle();
  });
  el("readCurrentPart").addEventListener("click",resumePart);
  el("preparePaperButton").addEventListener("click",startResearch);
  el("viewOriginalButton").addEventListener("click",openOriginal);
  window.addEventListener("reading-session-update", event => {
    const {key,change} = event.detail;
    if (change === "research" && !catalog.has(key)) publishTitle(key);
    if (openingChoice || key !== paperKey()) return;
    if (change === "section-structure") {
      if (view === "part" && !paperState()) renderStage();
      return;
    }
    if (change === "study-progress") {
      if (paperState()==="tailoring") {
        const message=showPlanProgress("tailoring");
        if (el("paperStateMessage").textContent!==message) el("paperStateMessage").textContent=message;
      }
      return;
    }
    if (change === "research-progress") {
      if (paperState()==="preparing") {
        const message=showPlanProgress("preparing");
        if (message) el("paperStateMessage").textContent=message;
      }
      return;
    }
    if (change === "question") {
      if (paperState()) return;
      if (view === "part") renderStage();
      else if (view === "passage") renderConversation();
      else explorer.render();
      return;
    }
    if (change === "research" && window.READER_SESSION.isPrepared(currentSession().research)) {
      visitSkill = "";
      resumePersonalization();
    }
    if (change==="study-external") resumePersonalization();
    render();
    if (el("profileDialog").open) renderProfile();
  });
  el("askText").addEventListener("input",event => drafts.set(draftKey(),event.target.value));
  el("askText").addEventListener("keydown",event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!el("askSubmit").disabled) el("askForm").requestSubmit();
    }
  });
  el("askForm").addEventListener("submit",event => { event.preventDefault(); submitQuestion(el("askText").value); });
  el("routeToggle").addEventListener("click",() => { showAllSteps = !showAllSteps; render(); });
  el("profileButton").addEventListener("click",() => { renderProfile(); el("profileDialog").showModal(); });
  el("profileDialog").addEventListener("close",() => {
    if (el("profileDialog").open) return;
    referenceDialog = false;
    if (/^#(?:technique\/|definition\/|lit-ref-)/.test(location.hash)) {
      const url = new URL(location.href);
      url.hash = "";
      history.replaceState(null,"",url);
    }
  });
  const paperTools = document.querySelector(".paper-tools");
  el("exploreTools").addEventListener("click",event => { if (event.target.closest("button")) paperTools.open = false; });
  document.addEventListener("click",event => { if (paperTools.open && !paperTools.contains(event.target)) paperTools.open = false; });
  paperTools.addEventListener("keydown",event => {
    if (event.key === "Escape") { paperTools.open = false; paperTools.querySelector("summary").focus(); }
  });
  el("backOverview").addEventListener("click",() => showExploration());
  el("returnTopic").addEventListener("click",() => partId ? openStage(partId,{track:followActive}) : showExploration(topic));
  el("openRoute").addEventListener("click",() => el("navigationDialog").showModal());

  function appendTable(container, data, rows) {
    const frame = make("div", "table-wrap");
    const table = make("table");
    const header = table.createTHead().insertRow();
    data.head.forEach((name) => {
      const th = make("th", "", name);
      th.scope = "col";
      header.append(th);
    });
    const body = table.createTBody();
    data.rows.slice(0, rows).forEach((values) => {
      const row = body.insertRow();
      values.forEach((v) => { row.insertCell().textContent = v; });
    });
    frame.append(table);
    container.append(frame);
  }

  function addIntervalChart(parent, count) {
    const chart = make("div", "interval-chart");
    chart.setAttribute("aria-label", "Time intervals for three activities");
    const activities = [{ name:"A", start:0, end:2 }, { name:"B", start:2, end:3 }, { name:"C", start:1, end:4 }];
    let available = -Infinity;
    activities.forEach(({ name, start, end }, index) => {
      const done = index < count;
      const accepted = start >= available;
      if (done && accepted) available = end;
      const state = done ? (accepted ? "selected" : "skipped") : "waiting";
      const row = make("div", "interval-row");
      const track = make("div", "interval-track");
      const bar = make("span", "interval-bar " + (done ? (accepted ? "picked" : "skipped") : "pending"), start + "–" + end);
      bar.style.left = (25 * start) + "%";
      bar.style.width = (25 * (end - start)) + "%";
      track.append(bar);
      row.append(make("span", "interval-label", name + " · " + state), track);
      chart.append(row);
    });
    parent.append(chart);
  }

  function updateAnswer(focusControl) {
    [...el("optionList").children].forEach(node => node.setAttribute("aria-expanded", String(Number(node.dataset.index) === activeOption)));
    const panel = el("answer");
    const option = step().options[activeOption];
    panel.replaceChildren();
    panel.hidden = !option;
    if (!option) return;
    panel.append(make("h3", "", option.label), make("p", "", option.body));
    if (option.targets?.length) {
      const label = make("label", "example-focus", "Focus on ");
      const selector = make("select");
      selector.append(new Option("The whole example", "-1"));
      option.targets.forEach((target, index) => selector.append(new Option(target.label, String(index))));
      selector.value = String(exampleFocus);
      selector.addEventListener("change", () => {
        exampleFocus = Number(selector.value);
        updateAnswer("target");
      });
      label.append(selector);
      panel.append(label);
      if (exampleFocus >= 0) panel.append(make("p", "target-explanation", option.targets[exampleFocus].body));
      if (focusControl === "target") selector.focus({preventScroll:true});
    }
    if (option.table) {
      const trace = option.trace === true || (isDemo() && activeOption === 0 && (current === 0 || current === 2));
      const maxRows = option.table.rows.length;
      if (isDemo() && trace && current === 0) addIntervalChart(panel, traceRows);
      appendTable(panel, option.table, trace ? traceRows : maxRows);
      if (trace && maxRows > 1) {
        const controls = make("div", "trace-controls");
        const back = button("Back one move", "control", () => { traceRows--; updateAnswer("back"); });
        const advance = button("Run next move", "control", () => { traceRows++; updateAnswer("advance"); });
        back.disabled = traceRows <= 1;
        advance.disabled = traceRows >= maxRows;
        controls.append(back, make("span", "", traceRows + " / " + maxRows), advance);
        panel.append(controls);
        if (focusControl === "back" || focusControl === "advance") {
          const preferred = focusControl === "back" ? back : advance;
          (preferred.disabled ? (preferred === back ? advance : back) : preferred).focus({preventScroll:true});
        }
      }
    }
    if (isDemo() && option.reference) {
      const source = make("a", "", option.reference.label);
      source.href = option.reference.url;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      panel.append(source);
    }
    window.READER_MATH?.render(panel);
  }

  function selectPaper(id, index = null, restoredTopic = "", push = false, stage = {}) {
    ++choiceVersion;
    editingNotation=null;
    notationPicker.reset();
    openingChoice = "";
    paperId = id;
    paper = id === "import" ? lastImport.paper : catalog.get(id);
    originalText = id === "import" ? lastImport.text : "";
    if (localPdfUrl) URL.revokeObjectURL(localPdfUrl);
    localPdfUrl = isPageReader() && lastImport.file ? URL.createObjectURL(lastImport.file) : "";
    stepHistory.length = 0;
    showAllSteps = false;
    current = 0;
    partId = stage.id || "";
    localFocus = "";
    followActive = !!stage.follow;
    topic = restoredTopic && restoredTopic !== "paper-overview" && visibleTurns().some(t => t.topic === restoredTopic) ? restoredTopic : "";
    if (Number.isInteger(index)) {
      view = "passage";
      openStep(index);
    } else if (partId) openStage(partId,{push,track:followActive,introduction:stage.localId || ""});
    else showExploration(topic,push);
    const doc = id === "import" ? lastImport : null;
    if (doc) publishTitle(doc.hash);
    window.READER_SESSION.resume(paperKey(),doc ? () => paperSource(doc.paper,doc) : undefined);
    resumePersonalization();
    if (view !== "part") window.scrollTo(0, 0);
  }
  function firstLibraryChoice() {
    return [...el("paperPicker").options].find(option => !window.PAPER_REMOVAL?.isBundleHidden?.(option.value))?.value || "";
  }
  function isRemovedChoice(choice) {
    if (catalog.has(choice)) return !!window.PAPER_REMOVAL?.isBundleHidden?.(choice);
    return choice.startsWith("doc-") && !!window.PAPER_REMOVAL?.generation(choice.slice(4)) &&
      ![...el("paperPicker").options].some(option => option.value === choice);
  }
  function openEmptyLibrary() {
    ++choiceVersion;
    openingChoice = paperId = partId = topic = pendingReference = "";
    paper = editingNotation = null;
    notationPicker.reset();
    if (localPdfUrl) URL.revokeObjectURL(localPdfUrl);
    localPdfUrl = "";
    render();
    if (location.protocol !== "file:") {
      const url = new URL(location.href);
      for (const key of ["paper","part","step","topic"]) url.searchParams.delete(key);
      url.hash = "";
      history.replaceState(null,"",url);
    }
    focusReadingTitle();
  }
  async function selectChoice(choice,index = null,restoredTopic = "",push = false,stage = {}) {
    if (!choice) { openEmptyLibrary(); return; }
    if (isRemovedChoice(choice)) {
      await selectChoice(firstLibraryChoice());
      return;
    }
    const version = ++choiceVersion;
    if (catalog.has(choice)) {
      openingChoice = choice;
      render();
      await window.READER_SESSION.restoreStudy(choice);
      if (version === choiceVersion) selectPaper(choice,index,restoredTopic,push,stage);
      return;
    }
    const hash = choice === "import" ? lastImport?.hash : choice.startsWith("doc-") ? choice.slice(4) : null;
    if (!hash) return;
    openingChoice = "doc-" + hash;
    render();
    let item;
    try {
      [item] = await Promise.all([lastImport?.hash === hash ? lastImport : window.PAPER_LIBRARY.get(hash),
        window.READER_SESSION.restorePreparation(hash),window.READER_SESSION.restoreStudy(hash)]);
    } catch (error) {
      if (version === choiceVersion) { openingChoice = ""; throw error; }
      return;
    }
    if (version !== choiceVersion) return;
    openingChoice = "";
    if (!item) throw new Error("Choose this paper again to restore its source.");
    if (item !== lastImport) {
      item.paper = item.pages ? window.PDF_READER.build(item.pages) : window.buildImportedProof(item.text);
      lastImport = item;
      registerPaper(item.hash,item.preparedTitle || sourceLabel(item));
    }
    selectPaper("import",index,restoredTopic,push,stage);
  }

  function showPage(number) {
    const count = lastImport.pages.length;
    viewedPage = Math.min(count, Math.max(1, number));
    el("pdfCount").textContent = "Page " + viewedPage + " of " + count;
    el("pdfPrev").disabled = viewedPage === 1;
    el("pdfNext").disabled = viewedPage === count;
    const url = localPdfUrl;
    el("sourcePdf").hidden = !url;
    el("sourcePdf").href = url + "#page=" + viewedPage;
    window.pageView.show(el("dialogPage"), {file:lastImport.file, page:viewedPage});
  }
  function openOriginal() {
    const pdf = isPageReader();
    el("originalHeading").textContent = pdf ? "Original paper" : "Full text";
    el("pageControls").hidden = el("dialogPage").hidden = !pdf;
    el("fullSource").hidden = pdf;
    if (pdf) {
      const first = view === "part" ? studyAnalysis().parts.find(p => p.id === partId)?.sourceSteps[0] : null;
      showPage(view === "passage" ? paper.steps[current].page : first ? paper.steps[first-1].page || 1 : 1);
    }
    else el("fullSource").textContent = originalText || paper.subtitle + "\n\n" + paper.steps.map((s) => s.title + "\n" + s.source).join("\n\n");
    el("fullDialog").showModal();
  }
  el("sourceToggle").addEventListener("click", openOriginal);
  el("pdfPrev").addEventListener("click", () => showPage(viewedPage - 1));
  el("pdfNext").addEventListener("click", () => showPage(viewedPage + 1));
  el("fullDialog").addEventListener("close", () => window.pageView.clear(el("dialogPage")));
  el("showSource").addEventListener("click", () => { sourceOpen = !sourceOpen; renderSource(); });
  el("previous").addEventListener("click", () => {
    const previous = previousStep();
    if (previous !== null) {
      stepHistory.pop();
      openStep(previous, true, false);
    }
  });
  el("next").addEventListener("click", () => { const next = nextStep(); if (next !== null) openStep(next,true); });
  el("paperPicker").addEventListener("change", event => selectChoice(event.target.value,null,"",true).catch(error => {
    render();
    importStatus(error.message);
    el("uploadDialog").showModal();
  }));
  el("openImport").addEventListener("click", () => el("uploadDialog").showModal());
  function attachProviderPicker() {
    const trigger = el("chooseProvider"), dialog = el("providerDialog"), choice = el("providerChoice");
    const save = el("saveProvider"), retry = el("retryProvider"), status = el("providerStatus");
    const names = {codex:"Codex", claude:"Claude"};
    let saved = "", busy = false;
    window.getConfirmedModelProvider = () => busy ? "" : saved;

    function showSaved(provider) {
      saved = provider;
      el("activeProvider").textContent = names[provider] || "";
      trigger.setAttribute("aria-label", provider ? "Choose AI provider. Current provider: " + names[provider] : "Choose AI provider");
      el("researchConsentLabel").textContent = "Use " + (names[provider] || "the selected AI provider") + " to prepare the overview, techniques, and definitions";
    }
    function updateChoice() {
      const help = el("providerSetup");
      help.hidden = !choice.value;
      help.textContent = choice.value === "claude" ? "Install Claude Code and sign in on this device. Naoma requests the latest Opus through Claude Code." :
        choice.value === "codex" ? "Install Codex CLI and sign in on this device." : "";
      save.disabled = busy || !choice.value || choice.value === saved;
    }
    async function syncProvider(method) {
      if (busy) return;
      const writing = method === "PUT", requested = choice.value;
      busy = true;
      el("closeProvider").disabled = writing;
      choice.disabled = true;
      save.disabled = true;
      retry.hidden = true;
      status.textContent = writing ? "Saving…" : "Loading setting…";
      try {
        const options = writing ? {method,headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:requested})} : {cache:"no-store"};
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(5000);
        const response = await fetch("/api/model-provider",options);
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Object.hasOwn(names,result?.provider) || (writing && result.provider !== requested)) {
          throw Error(result?.error || "Naoma could not confirm the AI provider. Reload the setting to try again.");
        }
        showSaved(result.provider);
        choice.value = saved;
        choice.disabled = false;
        status.textContent = "";
        if (writing && dialog.open) dialog.close();
      } catch (error) {
        showSaved("");
        choice.value = "";
        choice.disabled = false;
        status.textContent = error.message || "Naoma could not reach the reading service.";
        retry.hidden = false;
      } finally {
        busy = false;
        el("closeProvider").disabled = false;
        updateChoice();
      }
    }
    function open() {
      dialog.showModal();
      syncProvider("GET");
    }
    trigger.addEventListener("click", open);
    el("changeImportProvider").addEventListener("click", open);
    dialog.addEventListener("cancel", event => { if (el("closeProvider").disabled) event.preventDefault(); });
    choice.addEventListener("change", updateChoice);
    retry.addEventListener("click", () => syncProvider("GET"));
    save.addEventListener("click", () => { if (!save.disabled) syncProvider("PUT"); });
    if (location.protocol === "file:") { trigger.hidden = el("changeImportProvider").hidden = true; return; }
    return syncProvider("GET");
  }
  const loadingProvider = attachProviderPicker();
  const removalDialog=el("removePaperDialog");
  let removalTarget=null,removalPending=false;
  el("removePaper").addEventListener("click",()=>{
    if (!paperId || openingChoice) return;
    const doc=paperId==="import"?lastImport:null;
    removalTarget={id:paperKey(),source:selectedSource()};
    el("removePaperTitle").textContent=currentSession().research.displayTitle || doc?.preparedTitle || doc?.name || paper.title;
    el("removePaperDescription").textContent=doc
      ? "This clears the app’s saved copy, reading plans, conversations, and choices for this paper. You can import the original file again."
      : "This removes the example from your library and clears its reading plans, conversations, and choices.";
    el("removePaperError").textContent="";
    el("removePaperError").hidden=true;
    removalDialog.showModal();
    el("cancelRemovePaper").focus();
  });
  el("cancelRemovePaper").addEventListener("click",()=>{if (!removalPending) removalDialog.close();});
  removalDialog.addEventListener("cancel",event=>{if (removalPending) event.preventDefault();});
  removalDialog.addEventListener("close",()=>{removalTarget=null;});
  window.addEventListener("proofreader-paper-removed",async event=>{
    const hash=event.detail?.hash;
    if (!hash) return;
    const picker=el("paperPicker"),value=picker.value,choice=catalog.has(hash)?hash:"doc-"+hash;
    picker.replaceChildren(...[...picker.options].filter(o=>o.value!==choice));
    if (value!==choice) picker.value=value;
    savedTitles.delete(hash);
    knowledgeState.forgetPaper(hash);
    for (const key of drafts.keys()) if (key.startsWith(hash+"/")) drafts.delete(key);
    if (removalTarget?.id===hash && removalDialog.open) removalDialog.close();
    if ((openingChoice || paperChoice())===choice) {
      for (const id of ["profileDialog","fullDialog","navigationDialog"]) if (el(id).open) el(id).close();
      await selectChoice(firstLibraryChoice());
    }
    if (lastImport?.hash===hash && paperId!=="import") lastImport=null;
  });
  el("confirmRemovePaper").addEventListener("click",async()=>{
    const target=removalTarget;
    if (!target || removalPending || openingChoice || paperKey()!==target.id) return;
    removalPending=true;
    const confirm=el("confirmRemovePaper"),cancel=el("cancelRemovePaper"),error=el("removePaperError");
    error.hidden=true;
    confirm.disabled=cancel.disabled=true;
    confirm.textContent="Removing…";
    try {
      const restartMessage="Close and reopen Naoma to load paper removal, then try again.";
      if (!window.PAPER_REMOVAL) throw Error(restartMessage);
      const hash=target.id,session=currentSession(),analysis=studyAnalysis();
      const [evidence,legacyPlans]=await Promise.all([
        window.PAPER_REMOVAL.evidence(hash,session),window.READER_SESSION.removalPlans(hash,analysis)
      ]);
      if (location.protocol!=="file:" || evidence.analysisKeys.length || evidence.planKeys.length || evidence.sectionKeys.length) {
        const source=await target.source();
        const response=await fetch("/api/paper-cache/clear",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({source,...evidence,legacyPlans})});
        const result=await response.json().catch(()=>({}));
        if (response.status===404 || response.status===405) throw Error(restartMessage);
        if (!response.ok || result.cleared!==true) throw Error(result.error || "The reading service could not remove this paper. Please try again.");
      }
      await window.PAPER_REMOVAL.remove(hash);
      if (removalDialog.open) removalDialog.close();
    } catch (cause) {
      error.textContent=cause.message || "The paper could not be removed. Please try again.";
      error.hidden=false;
    } finally {
      removalPending=false;
      confirm.disabled=cancel.disabled=false;
      confirm.textContent="Remove paper";
    }
  });
  document.querySelectorAll(".close-dialog").forEach((node) => node.addEventListener("click", () => node.closest("dialog").close()));

  function importStatus(message) { el("importMessage").textContent = message; }
  function setLoading(value) {
    el("confirmImport").disabled = value;
    el("paperText").disabled = value;
  }
  function setPdfDraft(value) {
    draftPdf = value;
    const pdf = Boolean(value);
    el("paperText").hidden = el("textLabel").hidden = pdf;
    el("useText").hidden = !pdf;
    el("confirmImport").textContent = "Open paper";
  }
  el("useText").addEventListener("click", () => {
    ++loadVersion;
    draftName = "";
    setLoading(false);
    setPdfDraft(null);
    importStatus("");
    el("paperText").focus();
  });

  function registerPaper(hash,title) {
    const choice = "doc-" + hash;
    let item = [...el("paperPicker").options].find(opt => opt.value === choice);
    if (!item) {
      item = new Option("",choice);
      el("paperPicker").append(item);
    }
    item.textContent = title;
  }
  const sourceLabel = item => item.name ? "Source · " + item.name : "Pasted document";
  const savedTitles = new Map();
  function publishTitle(hash) {
    const research = window.READER_SESSION.session(hash).research;
    if (!window.READER_SESSION.isPrepared(research)) return;
    const title = research.displayTitle;
    registerPaper(hash,title);
    if (savedTitles.get(hash) === title) return;
    savedTitles.set(hash,title);
    window.PAPER_LIBRARY.renameTitle(hash,title).catch(() => false).then(saved => {
      if (!saved && savedTitles.get(hash) === title) savedTitles.delete(hash);
    });
  }
  async function rememberImport(value,prepare) {
    if (!value.hash) value.hash = await digest(new TextEncoder().encode(value.text || "").buffer);
    const explicit=typeof prepare === "boolean";
    if (explicit) await window.PAPER_REMOVAL?.resumePending?.(value.hash);
    const generation=window.PAPER_REMOVAL?.generation(value.hash) || "";
    if (!explicit && (value.generation || "")!==generation) return;
    await Promise.all([window.PAPER_LIBRARY.save(value,generation).catch(() => {}),window.READER_SESSION.restorePreparation(value.hash),
      explicit ? window.READER_SESSION.requestBackgroundChoices(value.hash) : window.READER_SESSION.restoreStudy(value.hash)]);
    if ((window.PAPER_REMOVAL?.generation(value.hash) || "")!==generation) {
      if (explicit) throw Error("This paper was removed while it was opening. Import it again to start over.");
      return;
    }
    if (explicit) window.READER_SESSION.setPreparation(value.hash,prepare);
    registerPaper(value.hash,value.preparedTitle || (prepare ? "Preparing paper…" : sourceLabel(value)));
    lastImport = value;
    saveSession("proofreader.lastImport", {name:value.name, text:value.text, pages:value.pages, hash:value.hash,...(generation?{generation}:{})});
    return generation;
  }
  async function readFile(file) {
    if (!file) return;
    const version = ++loadVersion;
    setLoading(true);
    setPdfDraft(null);
    draftName = "";
    el("paperText").value = "";
    importStatus("Reading " + file.name + "…");
    try {
      const pdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      if (!pdf && !/\.(tex|md|markdown|txt)$/i.test(file.name)) throw new Error("Choose a PDF, LaTeX, Markdown or plain text file.");
      if (file.size > (pdf ? 12 * 1024 * 1024 : 4 * 1024 * 1024)) throw new Error(pdf ? "Choose a PDF of 12 MiB or less, or paste the proof passage." : "This file is too large. Paste one proof or section.");
      let text;
      if (pdf) {
        const hash = await digest(await file.arrayBuffer());
        if (version !== loadVersion) return;
        if (location.protocol === "file:") throw new Error("Use the local app to import a PDF, or paste the text here.");
        const pages=await extractPdfPages(file);
        if (version !== loadVersion) return;
        setPdfDraft({pages, file, hash});
        importStatus(file.name + " selected.");
        return;
      } else {
        text = await file.text();
      }
      if (version !== loadVersion) return;
      if (!text.trim()) throw new Error("This file contains no readable text.");
      draftName = file.name;
      el("paperText").value = text;
      importStatus(file.name + " selected.");
    } catch (error) {
      if (version === loadVersion) importStatus(error.message || "Could not read this file. Paste the text to try again.");
    } finally {
      if (version === loadVersion) setLoading(false);
    }
  }

  el("paperFile").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    readFile(file);
  });
  el("fileLabel").addEventListener("dragover", (event) => event.preventDefault());
  el("fileLabel").addEventListener("drop", (event) => {
    event.preventDefault();
    readFile(event.dataTransfer.files[0]);
  });
  el("paperText").addEventListener("input", () => {
    if (!el("paperText").value.trim()) draftName = "";
    importStatus("");
  });
  el("confirmImport").addEventListener("click", async () => {
    const prepare = el("researchOnImport").checked;
    if (prepare && location.protocol !== "file:" && !window.getConfirmedModelProvider()) {
      importStatus("Choose an AI provider before preparing the paper.");
      el("changeImportProvider").focus();
      return;
    }
    el("changeImportProvider").disabled = el("confirmImport").disabled = true;
    importStatus("Opening the document…");
    try {
      if (draftPdf) {
        const {pages,file,hash} = draftPdf;
        const doc = window.PDF_READER.build(pages);
        const generation=await rememberImport({paper:doc, pages, file, hash, name:file.name, text:""},prepare);
        selectPaper("import");
        window.PDF_READER.save(file,hash,generation).catch(() => {});
      } else {
        const text = el("paperText").value;
        const doc = window.buildImportedProof(text);
        await rememberImport({paper:doc, text, name:draftName},prepare);
        selectPaper("import");
      }
      el("uploadDialog").close();
      el("paperText").value = "";
      draftName = "";
      setPdfDraft(null);
      importStatus("");
      focusReadingTitle();
    } catch (error) { importStatus(error.message); }
    finally { el("changeImportProvider").disabled = el("confirmImport").disabled = false; }
  });
  async function initialize() {
    for (const option of [...el("paperPicker").options]) {
      if (window.PAPER_REMOVAL?.isBundleHidden?.(option.value)) option.remove();
    }
    try { await window.PAPER_REMOVAL?.resumePending?.(); }
    catch {
      await selectChoice(firstLibraryChoice());
      importStatus("A previous paper removal could not finish. Reopen Naoma to retry, or import another paper.");
      el("uploadDialog").showModal();
      return;
    }
    const openingVersion = choiceVersion;
    const saved = readSession("proofreader.reading", {});
    const query = new URLSearchParams(location.search);
    const requested = query.get("paper");
    let lastPaper;
    try { lastPaper = localStorage.getItem("proofreader.lastPaper"); } catch { /* Storage is optional. */ }
    let id = requested || saved.paperId || lastPaper || "";
    const index = query.has("step") ? Number(query.get("step")) - 1 : null;
    let reopenPdf = false;
    try {
      const library = await window.PAPER_LIBRARY.list().catch(() => []);
      library.forEach(item => registerPaper(item.hash,item.preparedTitle || sourceLabel(item)));
      let previous = readSession("proofreader.lastImport", null);
      if (previous?.hash && (previous.generation || "")!==(window.PAPER_REMOVAL?.generation(previous.hash) || "")) previous=null;
      if (previous?.hash && library.some(item => item.hash === previous.hash)) {
        if (id === "import") id = "doc-" + previous.hash;
        previous = null;
      }
      if (saved.text && !previous) {
        if (/\.pdf$/i.test(saved.fileName || "")) {
          if (!requested) reopenPdf = true;
        } else {
          previous = {text:saved.text, name:saved.fileName};
          if (!requested) id = "import";
        }
      }
      if (previous?.pages) {
        const file = await window.PDF_READER.restore();
        if (file && await digest(await file.arrayBuffer()) === previous.hash) {
          await rememberImport({...previous,file,paper:window.PDF_READER.build(previous.pages)});
        } else if (id === "import") {
          reopenPdf = true;
        }
      } else if (previous?.text) {
        await rememberImport({...previous,paper:window.buildImportedProof(previous.text)});
      }
    } catch {
      if (id === "import") reopenPdf = true;
    }
    if (openingVersion !== choiceVersion) return;
    if (!id.startsWith("doc-") && !catalog.has(id) && !(id === "import" && lastImport)) id = firstLibraryChoice();
    const stage = stageLocation(query);
    if (!requested && !stage.id && index === null) {
      try {
        const prior = JSON.parse(localStorage.getItem("proofreader.partLocation." + id));
        if (prior?.part) Object.assign(stage,{id:prior.part,follow:prior.followActive});
      } catch { /* Session storage remains available for this window. */ }
    } else if (id === saved.paperId && stage.id && stage.id === saved.part) stage.follow = saved.followActive;
    try { await selectChoice(id,index,query.get("topic") || "",false,stage); }
    catch {
      const fallback=firstLibraryChoice();
      await selectChoice(fallback===id?"":fallback);
      reopenPdf = true;
    }
    if (location.hash) openReferenceAtHash();
    if (reopenPdf) {
      importStatus("Choose the PDF again to restore its original pages. The previous session saved extracted text only.");
      el("uploadDialog").showModal();
    }
  }
  function stageLocation(params) {
    let localId = "";
    if (location.hash.startsWith("#local/")) {
      try { localId = decodeURIComponent(location.hash.slice(7)); } catch { /* Ignore malformed fragments. */ }
    }
    return {id:params.get("part") || "",localId};
  }
  window.addEventListener("popstate",async () => {
    const params = new URLSearchParams(location.search);
    const id = params.get("paper") || firstLibraryChoice();
    if (id && !id.startsWith("doc-") && !catalog.has(id) && !(id === "import" && lastImport)) return;
    const index = params.has("step") ? Number(params.get("step")) - 1 : null;
    const restored = params.get("topic") || "";
    const stage = stageLocation(params);
    const targetView = index !== null ? "passage" : stage.id ? "part" : restored ? "topic" : "overview";
    if (id !== paperChoice() || view !== targetView || index !== null && index !== current || partId !== stage.id || topic !== restored) {
      try { await selectChoice(id,index,restored,false,stage); } catch { return; }
    }
    openReferenceAtHash();
  });
  Promise.resolve(loadingProvider).then(initialize);
})();
