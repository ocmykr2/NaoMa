(() => {
  "use strict";

  const byId = id => document.getElementById(id);
  const list = value => Array.isArray(value) ? value : [];
  const drafts = new Map();
  const positions = new Map();
  const checks = new Map();
  const localOpen = new Map();
  const explorationDrafts = new Map();
  const selectedSteps = new Map();
  let readingMode = "steps";
  try { if (window.localStorage?.getItem("proof.sectionReadingMode") === "full") readingMode = "full"; } catch {}
  let requestedStructure = "";
  let highlight = null;
  const modes = {
    example: {button: "stageExploreExample", label: "What would you like an example of?", submit: "Show example",
      cue: /\b(?:choose|assign|schedule|compute|apply|construct|take|place|count|example)\b/i},
    simplify: {button: "stageExploreSimplify", label: "Which subproblem or restriction should we try?", submit: "Try simpler case",
      cue: /\b(?:first|case|only|one|two|single|fix|restrict|special|consider|subproblem)\b/i},
    remove: {button: "stageExploreRemove", label: "Which condition would you like to drop?", submit: "Try without it",
      cue: /\b(?:if|when|unless|assuming|assume|requires?|provided|distinct|must|only|at most|at least|nonnegative|positive|independent|bounded|equal)\b|[≤≥<>]/i}
  };
  const signature = new Map();
  let model = null;
  let context = "";
  let focusKey = "";
  let bound = false;

  function savePosition() {
    if (!context || byId("stageReader").hidden) return;
    const focused = document.activeElement;
    const inside = byId("stageReader").contains(focused);
    const position = positions.get(context) || {};
    position.top = window.scrollY || 0;
    position.archiveOpen = byId("stageArchive").open;
    if (inside) {
      position.id = focused.id;
      position.href = focused.tagName === "A" ? focused.href : "";
    }
    positions.set(context, position);
  }

  function restorePosition() {
    const position = positions.get(context);
    if (document.activeElement?.closest("dialog")) return;
    let target = byId("stageTitle");
    if (position) {
      byId("stageArchive").open = !!position.archiveOpen;
      const candidate = position.id ? byId(position.id)
        : [...byId("stageReader").querySelectorAll("a")].find(anchor => anchor.href === position.href);
      if (candidate && !candidate.closest("[hidden]")) target = candidate;
    }
    target.focus({preventScroll: true});
    window.scrollTo?.(0, position?.top || 0);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function update(id, value, draw) {
    const key = JSON.stringify(value);
    if (signature.get(id) === key) return;
    signature.set(id, key);
    const node = byId(id);
    node.replaceChildren();
    draw(node);
    window.READER_MATH?.render(node);
  }

  function paragraphs(host, text) {
    const entries = Array.isArray(text) ? text : String(text || "").split(/\n\s*\n/);
    for (const paragraph of entries) {
      if (typeof paragraph === "string" && paragraph.trim()) host.append(element("p", "", paragraph.trim()));
    }
  }

  function hrefFor(partId, hash, step) {
    const url = new URL(location.href);
    url.searchParams.delete("topic");
    url.searchParams.delete("step");
    url.searchParams.delete("part");
    if (partId) url.searchParams.set("part", partId);
    if (step) url.searchParams.set("step", step);
    url.hash = hash || "";
    return url.search + url.hash;
  }

  function link(label, href, open) {
    const anchor = element("a", "", label);
    anchor.href = href;
    anchor.addEventListener("click", event => {
      if (event.button || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      savePosition();
      open();
    });
    return anchor;
  }

  function reviewLink(label, parts, index) {
    return link(label, hrefFor(parts[index].id), () => model?.onReview?.(index));
  }

  function stepGuide(data) {
    const guide = data?.sectionGuide;
    return guide && (!guide.partId || guide.partId === data.part.id) ? guide : null;
  }

  function activeStep() {
    if (!model || readingMode !== "steps" || byId("stageProofStructure").hidden) return null;
    return list(stepGuide(model)?.modules).find(step => step.id === selectedSteps.get(context)) || null;
  }

  function requestSteps(retry = false) {
    if (!model?.onReadStructure || (!retry && requestedStructure === context)) return;
    requestedStructure = context;
    const key = context;
    // A request can synchronously redraw the page. Finish this render before dispatch.
    Promise.resolve().then(() => {
      if (key === context && readingMode === "steps") model?.onReadStructure?.();
      else if (requestedStructure === key) requestedStructure = "";
    });
  }

  function moveToStep(index) {
    const step = list(stepGuide(model)?.modules)[index];
    if (!step) return;
    selectedSteps.set(context, step.id);
    highlight = null;
    byId("stageProofOutline").open = false;
    renderStructure(model);
    renderExploration(model);
    byId("stageProofHeading").focus({preventScroll:true});
    byId("stageProofHeading").scrollIntoView?.({block:"nearest"});
  }

  function renderStructure(data, changed = false) {
    const guide = stepGuide(data);
    const modules = list(guide?.modules);
    const isReady = guide?.status === "ready" && modules.length > 0;
    const offered = isReady || typeof data.onReadStructure === "function";
    const steps = offered && readingMode === "steps";
    const visible = steps && isReady;
    const failed = guide?.status === "error" || (guide?.status === "ready" && !isReady);
    byId("stageReadMode").hidden = !offered;
    byId("stageModeSteps").setAttribute("aria-pressed", String(readingMode === "steps"));
    byId("stageModeFull").setAttribute("aria-pressed", String(readingMode === "full"));
    byId("stageFullSection").hidden = visible;
    byId("stageProofStructure").hidden = !visible;
    byId("stageProofNotice").hidden = !steps || visible;
    byId("stageProofRetry").hidden = !failed || !data.onReadStructure;
    const notice = steps && !visible ? (failed ? sectionFailureNotice(guide) : guide?.status==="waiting-service" ?
      "Waiting for the reading service to reconnect. This section will resume automatically." : guide?.recovering ?
      "Checking this section again against the paper…" : "Preparing the step-by-step explanation…") : "";
    if (byId("stageProofStatus").textContent !== notice) byId("stageProofStatus").textContent = notice;
    const diagnostics=byId("stageProofDiagnostics");
    if (diagnostics) {
      diagnostics.hidden=!steps || !failed || !guide?.unexpected;
      if (diagnostics.hidden) diagnostics.open=false;
      const fields=["key","failureStage","failureCode"].filter(name=>typeof guide?.[name]==="string" && /^[a-zA-Z0-9_-]{1,160}$/.test(guide[name]));
      byId("stageProofDiagnosticReport").textContent=diagnostics.hidden?"":fields.map(name=>name+"  "+guide[name]).join("\n");
    }
    if (changed) byId("stageProofOutline").open = false;
    if (!visible) {
      if (steps && (!guide || guide.status === "idle")) requestSteps();
      return;
    }

    const index = Math.max(0, modules.findIndex(step => step.id === selectedSteps.get(context)));
    const step = modules[index];
    selectedSteps.set(context,step.id);
    update("stageProofIntro", [guide.goal,guide.overview], host => {
      if (guide.goal) host.append(element("p","proof-goal",guide.goal));
      if (guide.overview && guide.overview !== guide.goal) host.append(element("p","proof-overview",guide.overview));
    });
    update("stageProofOutlineList", [modules.map(m=>[m.id,m.title]), index], host => {
      for (const [i,m] of modules.entries()) {
        const li = element("li"), button = element("button","",m.title);
        button.type = "button";
        if (i === index) button.setAttribute("aria-current","step");
        button.addEventListener("click",()=>moveToStep(i));
        li.append(button);
        host.append(li);
      }
    });
    byId("stageProofOutline").hidden = modules.length < 2;
    byId("stageProofCount").textContent = "Step " + (index + 1) + " of " + modules.length;
    update("stageProofHeading",step.title,host=>{ host.textContent = step.title; });
    update("stageProofContent",[step, modules.map(m=>m.title), data.parts.map(p=>p.title)], host=>{
      if (step.claim && step.claim !== step.title) host.append(element("p","proof-claim",step.claim));
      if (step.explanation && step.explanation !== step.claim) paragraphs(host,step.explanation);
      const assumptions = list(step.assumptions);
      if (assumptions.length) {
        const section = element("details","proof-assumptions"), ul = element("ul");
        section.append(element("summary","","Assumptions for this step"));
        for (const assumption of assumptions) ul.append(element("li","",assumption));
        section.append(ul);
        host.append(section);
      }
      const connections = element("div","proof-links");
      for (const id of list(step.dependsOn)) {
        const previous = modules.findIndex(m=>m.id === id);
        if (previous < 0 || previous >= index) continue;
        const button = element("button","",modules[previous].title);
        button.type="button";
        button.addEventListener("click",()=>moveToStep(previous));
        connections.append(button);
      }
      for (const id of list(step.priorPartIds)) {
        const previous = data.parts.findIndex(p=>p.id === id);
        if (previous >= 0 && previous < data.index) connections.append(reviewLink(data.parts[previous].title,data.parts,previous));
      }
      if (connections.childElementCount) {
        const dependencies = element("div","proof-links");
        dependencies.append(element("span","","Builds on"),connections);
        host.append(dependencies);
      }
      if (Number.isInteger(step.sourceStep) && step.sourceStep > 0 && data.onSource) {
        const source = link(step.sourcePage ? "Open page " + step.sourcePage : "Open passage " + step.sourceStep,
          hrefFor(data.part.id,"",step.sourceStep),()=>model?.onSource?.(step.sourceStep));
        if (step.sourceQuote) {
          const passage = element("details","proof-source");
          passage.append(element("summary","","Source passage"),element("blockquote","",step.sourceQuote),source);
          host.append(passage);
        } else host.append(source);
      }
    });
    byId("stageProofNav").hidden = modules.length < 2;
    byId("stageProofBack").disabled = index === 0;
    byId("stageProofNext").disabled = index === modules.length - 1;
  }

  function sectionFailureNotice(guide) {
    if (guide?.unexpected) return "Couldn’t prepare this explanation. See Diagnostics for the saved failure details.";
    if (guide?.disconnected) return "The reading service lost its connection. Retry to reconnect.";
    // The service maps typed section failures to reader-facing messages. Older
    // responses contain only a generic message and no public failure code.
    if (guide?.failureStage && guide.failureCode && guide.message) return guide.message;
    return "Couldn’t prepare this explanation.";
  }

  function preflight(options) {
    byId("preflightPaperTitle").textContent = options.title || "";
    const catalog = options.knowledge || {};
    const transferable = item => item && item.transferable !== false && !item.originPartId && item.scope !== "local";
    const techniques = list(catalog.techniques).filter(transferable);
    const definitionGroups = list(catalog.definitionGroups).filter(transferable).map(group => ({
      ...group, definitions: list(group.definitions).filter(transferable)
    })).filter(group => group.definitions.length);
    const knowledge = {techniques, definitionGroups};
    window.KNOWLEDGE_UI.mount(byId("preflightKnowledge"), {...options, knowledge, preflight: true,
      research: {status: "ready", knowledge}, researchAction: null});
  }

  function references(data) {
    const refs = [];
    const add = (ids, items, kind, label) => {
      const indexed = new Map(list(items).map(item => [item.id, item]));
      for (const id of list(ids)) {
        const item = indexed.get(id);
        if (item) refs.push({kind, id, title: label(item), originPartId: item.originPartId});
      }
    };
    add(data.part.techniqueIds, data.knowledge?.techniques, "technique", t => data.techniqueLabel?.(t) || t.name);
    add(data.part.definitionGroupIds, data.knowledge?.definitionGroups, "definition", group => group.title);
    add(data.part.localPrerequisiteIds, data.localIntroductions, "local", item => item.title);
    return refs;
  }

  function prerequisites(data) {
    const refs = references(data);
    update("stagePrerequisites", refs, host => {
      if (!refs.length) return;
      host.append(element("h3", "", "Used here"));
      const links = element("div", "stage-prerequisite-links");
      for (const ref of refs) {
        const hash = ref.kind + "/" + encodeURIComponent(ref.id);
        const href = ref.originPartId ? hrefFor(ref.originPartId, hash) : "#" + hash;
        const target = {kind: ref.kind, id: ref.id};
        if (ref.originPartId) target.originPartId = ref.originPartId;
        const anchor = link(ref.title, href, () => model?.onReference?.(target));
        if (ref.originPartId) {
          const origin = data.parts.findIndex(part => part.id === ref.originPartId);
          if (origin >= 0) anchor.append(element("span", "stage-origin", " · Part " + (origin + 1)));
        }
        links.append(anchor);
      }
      host.append(links);
    });
  }

  function introductions(data) {
    const items = list(data.localIntroductions).filter(item => item.originPartId === data.part.id);
    let target = null;
    update("stageIntroductions", [items, data.localId], host => {
      if (items.length) host.append(element("h3", "", "Introduced here"));
      for (const item of items) {
        const entry = element("details", "stage-introduction");
        const heading = element("summary", "", item.title);
        heading.id = "local/" + item.id;
        const openKey = JSON.stringify([context, item.id]);
        entry.open = !!localOpen.get(openKey);
        entry.addEventListener("toggle", () => localOpen.set(openKey, entry.open));
        entry.append(heading, element("p", "", item.meaning));
        if (item.id === data.localId) {
          entry.open = true;
          entry.className += " is-target";
          target = heading;
        }
        host.append(entry);
      }
    });
    return target;
  }

  function previousCompletion(data) {
    const previous = data.previousCompletion;
    update("stagePrevious", previous || null, host => {
      if (!previous) return;
      const item = element("details", "stage-previous");
      item.open = !data.archived && !data.preview;
      item.append(element("summary", "", "Completed · " + previous.title));
      paragraphs(item, previous.answer || previous.evidence);
      if (data.parts[previous.index]) item.append(reviewLink("Review that discussion", data.parts, previous.index));
      host.append(item);
    });
  }

  function formalStatement(statement) {
    if (!statement) return null;
    const {kind, label, text} = statement;
    const hasKind = new RegExp("\\b" + kind + "\\b", "i").test(label);
    const heading = hasKind ? label : [kind, label].filter(Boolean).join(" ");
    // Some source transcriptions repeat the heading on the first line of the statement.
    const prefixes = [heading, heading.match(/^(?:Theorem|Lemma|Proposition|Corollary|Definition)\s+[A-Z\d]+(?:\.\d+)*/i)?.[0]];
    for (const prefix of prefixes.filter(Boolean)) {
      if (!text.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const rest = text.slice(prefix.length);
      const separator = rest.match(/^(?:[.:]\s+|\s*\r?\n\s*|\s+[–—]\s+)/);
      if (separator && rest.slice(separator[0].length).trim()) return {heading, text: rest.slice(separator[0].length).trim()};
    }
    return {heading, text};
  }

  function visibleReadingAnchor() {
    if (!window.scrollY) return null;
    const stage = byId("stageReader");
    const focus = document.activeElement;
    const anchors = ["stageNotation", "stageSources", "stageIntroductions", "stageTurns", "stageExplore", "stageAskForm", "stageCheckpoint", "stageArchive"].map(byId);
    if (stage.contains(focus) && anchors.some(node => node.contains(focus))) anchors.unshift(focus);
    else if (byId("stageOrientation").getBoundingClientRect?.().bottom > 0) return null;
    for (const node of anchors) {
      const rect = node.getBoundingClientRect?.();
      if (rect?.height && rect.bottom > 0 && rect.top < window.innerHeight) return {node, top: rect.top};
    }
    return null;
  }

  function renderOrientation(data, changedPart) {
    const notes = data.orientation?.introduction ? data.orientation : null;
    const introduction = notes?.introduction || data.part.summary || "";
    const notation = list(notes?.notation);
    const definitions = list(notes?.definitions);
    const handoff = notes?.handoff || "";
    const statement = formalStatement(notes?.statement);
    const status = data.orientationStatus?.status || data.orientationStatus;
    const failed = ["error", "failed"].includes(status);
    const loading = ["starting", "running", "loading", "pending", "preparing", "queued"].includes(status);
    let notice = "";
    if (loading) notice = notes ? "The editor is revising this part’s explanation…" : "Preparing this part’s reading notes…";
    if (failed) notice = notes ? "The revision of this part’s explanation could not be completed."
      : data.orientationStatus?.message || "The reading notes for this part could not be prepared.";
    const retry = failed && !!data.onRetryOrientation;
    const original = notes ? notes.paragraphs : data.opening || "";
    const paragraphsToRead = Array.isArray(original) ? original : String(original).split(/\n\s*\n/);
    const formalAfter = (definitions.length || statement) && Number.isInteger(notes?.formalAfter)
      ? Math.max(0, Math.min(notes.formalAfter, paragraphsToRead.length)) : 0;
    const key = JSON.stringify([introduction, notation, definitions, statement, handoff, paragraphsToRead, formalAfter, notice, retry]);
    if (signature.get("orientationView") === key) return;
    signature.set("orientationView", key);
    const anchor = changedPart ? null : visibleReadingAnchor();
    byId("stageOrientation").hidden = !(introduction || definitions.length || statement || notice);
    byId("stageIntroduction").hidden = !introduction;
    const reference = byId("stageNotation");
    reference.hidden = !notation.length;
    if (changedPart || reference.hidden) reference.open = false;
    byId("stageDefinitions").hidden = !definitions.length;
    byId("stageStatement").hidden = !statement;
    byId("stageHandoff").hidden = !handoff;
    byId("stageOrientationNotice").hidden = !notice;
    const retryButton = byId("stageOrientationRetry");
    retryButton.hidden = !retry;
    if (retry) retryButton.textContent = notes ? "Retry revision" : "Retry part notes";
    if (byId("stageOrientationStatus").textContent !== notice) byId("stageOrientationStatus").textContent = notice;
    for (const [id, value] of [["stageIntroduction", introduction],
      ["stageStatementLabel", statement?.heading || ""], ["stageStatementText", statement?.text || ""], ["stageHandoff", handoff]]) {
      update(id, value, node => { node.textContent = value; });
    }
    update("stageNotationList", notation, host => {
      for (const entry of notation) {
        const row = element("div", "stage-notation-row");
        row.append(element("dt", "", entry.symbol), element("dd", "", entry.meaning));
        host.append(row);
      }
    });
    update("stageDefinitions", definitions, host => {
      let card;
      for (const [index,definition] of definitions.entries()) {
        const source=definition.claimSource, group=source?.group;
        const continuing=group && definitions[index-1]?.claimSource?.group===group;
        const grouped=continuing || (group && definitions[index+1]?.claimSource?.group===group);
        const title=grouped?group:definition.name;
        const label = /^definition\b/i.test(title) ? title : "Definition · " + title;
        const formal = formalStatement({kind: "Definition", label, text: definition.text});
        if (!continuing) {
          card=element("section","stage-definition");
          card.append(element("h3","stage-definition-title",formal.heading));
          host.append(card);
        }
        if (grouped) card.append(element("h4","stage-definition-claim",definition.name));
        card.append(element("p", "stage-definition-text", formal.text));
        if (definition.intuition) {
          const intuition = element("p", "stage-definition-intuition");
          intuition.append(element("span", "stage-intuition-label", "Intuition"), document.createTextNode(" " + definition.intuition));
          card.append(intuition);
        }
        if (source && data.onSource) {
          const reference=link(source.page?"Page "+source.page:"Source passage "+source.step,
            hrefFor(data.part.id,"",source.step),()=>model?.onSource?.(source.step));
          reference.setAttribute("aria-label","Read the source for "+definition.name+
            (source.page?" on page "+source.page:" in passage "+source.step));
          reference.classList.add("stage-definition-source");
          card.append(reference);
        }
      }
    });
    const comparable = text => clean(text).replace(/(?<!\.)\.$/, "");
    const seen = new Set([introduction, statement?.text, handoff].filter(Boolean).map(comparable));
    const body = seen.has(comparable(paragraphsToRead.join(" "))) ? [] : paragraphsToRead;
    const isNewParagraph = p => typeof p === "string" && p.trim() && !seen.has(comparable(p));
    for (const [id, section] of [["stageLeadIn", body.slice(0, formalAfter)], ["stageOpening", body.slice(formalAfter)]]) {
      const content = section.filter(isNewParagraph);
      update(id, content, node => paragraphs(node, content));
    }
    if (anchor) {
      const delta = anchor.node.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) >= 1) window.scrollBy?.(0, delta);
    }
  }

  const isBusy = turn => ["starting", "running", "pending"].includes(turn.status);
  const clean = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  const passageText = value => clean(value).replace(/^(?:[.,;:!?…。，、；：！？]+(?:\s+|$))+/u, "");

  function readingElement(point) {
    let node = point?.nodeType === 3 ? point.parentElement || point.getRootNode?.().host : point;
    // Rendered formula tokens live inside the math host's shadow tree.
    while (node && !byId("stageReader").contains(node)) node = node.getRootNode?.().host;
    return node;
  }

  function passageBlock(point) {
    const node = readingElement(point);
    if (!node?.closest) return null;
    if (byId("stageProofStructure").contains(node)) return activeStep()
      ? node.closest("p") || node.closest("blockquote") || node.closest("li") || node.closest("h3") : null;
    if (byId("stageTurns").contains(node)) return node.closest(".turn-answer") || node.closest(".turn-question");
    if (byId("stageIntroductions").contains(node)) return node.closest("p") || node.closest("summary");
    if (byId("stageNotationList").contains(node)) return byId("stageNotation").open ? node.closest("dt") || node.closest("dd") : null;
    if (byId("stageDefinitions").contains(node)) return node.closest("p") || node.closest("h3");
    return ["stageTitle", "stageLeadIn", "stageOpening", "stageIntroduction", "stageStatementText", "stageHandoff"]
      .map(byId).find(area => area.contains(node)) || null;
  }

  function selectedPassage() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const block = passageBlock(selection.anchorNode);
    if (!block || block !== passageBlock(selection.focusNode)) return null;
    const text = passageText(selection.toString());
    if (!text || text.length > 1000) return null;
    const formula = readingElement(selection.anchorNode)?.closest?.(".reader-math");
    const inFormula = formula && formula.contains(readingElement(selection.focusNode));
    const symbol = (block.tagName === "DT" || inFormula) && /[\p{L}\p{N}\p{Sm}]/u.test(text);
    const words = text.match(/[\p{L}\p{N}]+/gu) || [];
    const term = words.length === 1 && ((words[0].length >= 3 && !/^(?:the|and|but|for|that|this|from|with|are|was)$/i.test(words[0]))
      || /[\p{Sm}^_]/u.test(text));
    if (!(symbol || words.length > 1 || /^[-+−]?\.\d+$/u.test(text) || term)) return null;
    const group = ["stageTurns", "stageDefinitions", "stageNotationList", "stageIntroductions", "stageProofContent", "stageProofIntro"]
      .map(byId).find(node => node.contains(block));
    return {text, block, group, source: block.textContent};
  }

  function excerpt(text, mode, requireCue = false) {
    const segments = String(text || "").split(/\n+|(?<=[.!?])\s+/).map(passageText).filter(Boolean);
    const sentence = segments.find(s => modes[mode].cue.test(s)) || (!requireCue && segments[0]);
    return sentence || "";
  }

  function targetChoices(data, mode, latestTurn) {
    const choices = [];
    function add(target, prefix = "") {
      target = passageText(target).slice(0, 1000);
      if (!target || choices.some(item => item.target === target) || choices.length >= 3) return;
      const clip = target.length > 88 ? target.slice(0, 85).replace(/\s+\S*$/, "").trimEnd() + "…" : target;
      choices.push({target, label: prefix + clip});
    }
    const latest = latestTurn?.answer;
    const step = activeStep();
    if (step) add(mode === "remove" && step.assumptions?.length ? step.assumptions[0] : step.claim || step.title);
    const own = list(data.localIntroductions).filter(item => item.originPartId === data.part.id);
    const section = data.orientation;
    const prose = section?.introduction ? [section.introduction, ...section.paragraphs, section.statement?.text,
      ...section.definitions.map(entry => entry.text), section.handoff].filter(Boolean)
      : [data.part.summary, ...[].concat(data.opening || [])];
    if (mode === "simplify") {
      const restrictionCue = /\b(?:when|if|suppose|assume|restrict|disjoint|identical|equal|single|only|unweighted|symmetric|independent|at most)\b/i;
      const relaxationCue = /\b(?:relax\w*|remov\w*|without|drop\w*|fail\w*|violat\w*|weaken\w*|abandon\w*|no longer)\b/i;
      const offered = list(latestTurn?.followups).find(question => restrictionCue.test(question) && !relaxationCue.test(question));
      add(offered);
      const material = [latest, data.part.title, ...prose, ...own.map(item => item.title)].join(" ");
      const intersection = /\bsets?\b[^.!?]{0,80}\b(?:overlap\w*|intersect\w*)\b|\b(?:overlap\w*|intersect\w*)\b[^.!?]{0,80}\bsets?\b|[A-Z]\s*(?:∩|\\cap)\s*[A-Z]/i;
      const requiredOverlap = /\b(?:must|have to|required to)\s+(?:overlap|intersect)|\b(?:nonempty|non-empty) intersection\b/i;
      if (intersection.test(material) && !requiredOverlap.test(material) && !/disjoint/i.test(offered || "")) add("What if the two sets are disjoint?");
      const oneMachine = /\b(?:one|single)[ -](?:machine|processor)\b/i.test(material);
      const cases = [[/\bdensity rows\b/i, "What if there is only one density row?"],
        [oneMachine ? null : /\bmachines\b/i, "What if there are only two machines?"],
        [/\bjobs\b/i, "What if there are only two jobs?"], [/\bintervals\b/i, "What if there are only two intervals?"],
        [/\bvertices\b/i, "What if the graph has three vertices?"]];
      if (!offered && !intersection.test(material)) {
        const restriction = cases.find(([pattern]) => pattern?.test(material));
        if (restriction) add(restriction[1]);
      }
    }
    if (latest) add(excerpt(latest, mode), "From the latest answer · ");
    if (mode === "remove") {
      const passages = [...prose, ...own.map(item => item.meaning)];
      for (const passage of passages) add(excerpt(passage, mode, true));
      const claim = own.find(item => item.kind === "lemma");
      if (claim) add("An assumption behind " + claim.title);
    } else {
      const refs = references(data);
      for (const item of [...own, ...refs]) add(item.title);
      if (!own.length && !refs.length) add(excerpt(prose[0], mode));
    }
    add(mode === "remove" ? "An assumption behind " + data.part.title : data.part.title);
    return choices;
  }

  function explorationState() {
    const key = JSON.stringify([context,activeStep()?.id || null]);
    if (!explorationDrafts.has(key)) explorationDrafts.set(key, {mode: "", values: {}});
    return explorationDrafts.get(key);
  }

  function canExplore(data) {
    return !data.preview && typeof data.onExplore === "function";
  }

  function renderExploration(data) {
    const section = byId("stageExplore");
    section.hidden = !canExplore(data) || !byId("stageCheckpoint").hidden;
    if (section.hidden) { highlight = null; return; }
    const state = explorationState();
    const mode = state.mode;
    const busy = !!data.busy || list(data.turns).some(isBusy);
    for (const [key, config] of Object.entries(modes)) {
      const button = byId(config.button);
      button.disabled = busy;
      button.setAttribute("aria-expanded", String(key === mode));
    }
    const form = byId("stageExploreForm");
    form.hidden = !mode;
    if (!mode) return;
    const target = byId("stageExploreTarget");
    if (highlight && (!byId("stageReader").contains(highlight.block) || highlight.block.textContent !== highlight.source)) {
      // An appended discussion turn can recreate earlier rows without changing their text.
      const replacement = [...(highlight.group?.querySelectorAll(highlight.block.tagName) || [])]
        .find(node => node.className === highlight.block.className && node.textContent === highlight.source);
      if (replacement) highlight.block = replacement;
      else highlight = null;
    }
    const fromHighlight = !!highlight && !Object.hasOwn(state.values, mode);
    const saved = fromHighlight ? highlight.text : state.values[mode] || "";
    if (target.value !== saved) target.value = saved;
    target.rows = fromHighlight ? Math.min(8, Math.max(2, Math.ceil(saved.length / 55))) : 2;
    target.readOnly = busy;
    const latest = list(data.turns).findLast(turn => turn.answer && turn.status === "ready" && !isCheckTurn(turn, data));
    const choices = targetChoices(data, mode, latest);
    const alternative = highlight && !fromHighlight && saved !== highlight.text ? highlight.text : "";
    update("stageExploreSuggestions", [mode, choices, busy, alternative], node => {
      if (alternative) {
        const preview = element("div");
        const use = element("button", "", "Use passage you highlighted");
        const quote = element("blockquote", "", alternative);
        quote.id = "stageHighlightedPassage";
        use.type = "button";
        use.disabled = busy;
        use.setAttribute("aria-describedby", quote.id);
        use.addEventListener("click", () => {
          delete state.values[mode];
          renderExploration(model);
          target.focus({preventScroll: true});
        });
        preview.append(quote, use);
        node.append(preview);
      }
      for (const choice of choices) {
        const chip = element("button", "", choice.label);
        chip.type = "button";
        chip.title = choice.target;
        chip.setAttribute("aria-label", choice.target);
        chip.disabled = busy;
        chip.addEventListener("click", () => {
          highlight = null;
          state.values[mode] = choice.target;
          renderExploration(model);
          target.focus({preventScroll: true});
        });
        node.append(chip);
      }
    });
    byId("stageExploreLabel").textContent = fromHighlight ? "Passage you highlighted" : modes[mode].label;
    target.placeholder = mode === "simplify" ? "Name a subproblem or suggest a restriction…" : "Write your own target…";
    byId("stageExploreHint").textContent = mode === "simplify" ? "Leave blank to let the tutor choose a simpler case."
      : latest ? "Leave blank to explore the latest answer." : "Leave blank to explore this part’s argument.";
    byId("stageExploreSubmit").textContent = modes[mode].submit;
    byId("stageExploreSubmit").disabled = busy;
  }

  function bindExploration() {
    const target = byId("stageExploreTarget");
    let consumed = "";
    let captured = null;
    function commitSelection() {
      if (!model || byId("stageExplore").hidden || byId("stageExploreForm").hidden) return;
      const selected = selectedPassage();
      if (!selected || (selected.text === highlight?.text && selected.block === highlight.block)) return;
      consumed = context + selected.text;
      highlight = selected;
      renderExploration(model);
    }
    document.addEventListener("pointerdown", event => {
      if (byId("stageExplore").contains(event.target)) return;
      captured = null;
      if (passageBlock(event.target)) consumed = "";
      if (highlight && model) {
        highlight = null;
        renderExploration(model);
      }
    });
    document.addEventListener("pointerup", event => {
      if (passageBlock(event.target)) commitSelection();
    });
    document.addEventListener("keyup", event => {
      if (event.shiftKey && /^(?:Arrow|Home$|End$|Page)/.test(event.key)) {
        consumed = "";
        commitSelection();
      }
    });
    for (const [mode, config] of Object.entries(modes)) {
      const control = byId(config.button);
      control.addEventListener("pointerdown", () => { captured = {context, mode, passage: selectedPassage()}; });
      control.addEventListener("pointercancel", () => { captured = null; });
      control.addEventListener("click", event => {
        if (!model || byId("stageExplore").hidden || control.disabled) return;
        const state = explorationState();
        state.mode = state.mode === mode ? "" : mode;
        const useCapture = event.detail !== 0 && captured?.context === context && captured.mode === mode;
        const currentSelection = useCapture ? captured.passage : selectedPassage();
        captured = null;
        highlight = state.mode && currentSelection && consumed !== context + currentSelection.text ? currentSelection : null;
        if (currentSelection) consumed = context + currentSelection.text;
        renderExploration(model);
        if (state.mode) target.focus();
      });
    }
    target.addEventListener("input", () => {
      const state = explorationState();
      if (state.mode) state.values[state.mode] = target.value;
      if (highlight) {
        highlight = null;
        renderExploration(model);
      }
    });
    const form = byId("stageExploreForm");
    form.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.isComposing) return;
      const state = explorationState();
      if (!state.mode) return;
      event.preventDefault();
      const control = byId(modes[state.mode].button);
      state.mode = "";
      highlight = null;
      renderExploration(model);
      control.focus();
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const state = explorationState();
      const mode = state.mode;
      if (!mode || !model?.onExplore || byId("stageExplore").hidden || byId("stageExploreSubmit").disabled) return;
      const value = target.value.trim().slice(0, 1000);
      state.mode = "";
      highlight = null;
      delete state.values[mode];
      renderExploration(model);
      const focusAfterSubmit = byId("stageAskForm").hidden ? byId("stageExplore") : byId("stageAskText");
      focusAfterSubmit.focus({preventScroll: true});
      model.onExplore({mode, target: value});
    });
  }

  function isCheckTurn(turn, data) {
    // Older readers sent the prepared question as a normal tutor request.
    return turn.checkpoint === true || (!turn.exploration && !!data.firstQuestion && turn.question === data.firstQuestion);
  }

  function turnRow(turn, canRetry, inCheck = false) {
    const row = element("article", "turn");
    if (turn.checkpoint && !inCheck) row.append(element("p", "turn-question", turn.checkpointQuestion || model.firstQuestion));
    row.append(element("p", "turn-question", turn.checkpoint ? "Your answer · " + turn.question : turn.question));
    if (turn.answer) row.append(element("p", "turn-answer", turn.answer));
    if (turn.locator) row.append(element("p", "turn-locator", turn.locator));
    if (["failed", "error"].includes(turn.status)) {
      row.append(element("p", "stage-status", turn.message || turn.error || "The response could not be prepared."));
      if (canRetry) {
        const retry = element("button", "ghost", turn.checkpoint ? "Retry feedback" : "Retry question");
        retry.type = "button";
        retry.addEventListener("click", () => {
          const currentTurn = model?.turns?.find(item => item.id === turn.id);
          if (!currentTurn || model.turns.some(isBusy)) return;
          if (currentTurn.checkpoint) model.onCheckpoint?.(currentTurn.question, currentTurn);
          else model.onAsk?.(currentTurn.question, currentTurn);
        });
        row.append(retry);
      }
    }
    return row;
  }

  function turns(data) {
    const history = list(data.turns);
    const readOnly = data.archived || data.preview || data.complete;
    const visible = readOnly ? history : history.filter(turn => !isCheckTurn(turn,data));
    const reviewExplorations = canExplore(data);
    update("stageTurns", [visible, readOnly, reviewExplorations], host => {
      for (const turn of visible) {
        const retry = !readOnly || (reviewExplorations && Object.hasOwn(modes, turn.exploration?.mode));
        host.append(turnRow(turn, retry));
      }
    });
    return !!data.busy || history.some(isBusy);
  }

  function studyPartKey(data) {
    const paperKey = data.paperKey || data.studyKey || location.search.split("&part=")[0];
    const partKey = JSON.stringify([paperKey, data.part.id]);
    // Keep the same key as the optional checkpoint saved by earlier versions.
    return JSON.stringify([partKey, data.studyKey]);
  }
  const checkKey = () => "proofreader.optionalCheck." + context;
  function checkState() {
    const key = checkKey();
    if (!checks.has(key)) {
      let saved;
      try { saved = JSON.parse(sessionStorage.getItem(key)); } catch { /* Tab storage is optional. */ }
      checks.set(key,{open:saved?.open === true, draft:typeof saved?.draft === "string" ? saved.draft : ""});
    }
    return checks.get(key);
  }
  function saveCheck() {
    const state = checkState();
    try {
      if (state.open || state.draft) sessionStorage.setItem(checkKey(),JSON.stringify(state));
      else sessionStorage.removeItem(checkKey());
    } catch { /* Keep the current window usable. */ }
  }
  function renderCheckpoint(data,readOnly,busy) {
    const check = byId("stageCheckpoint");
    const state = checkState();
    const open = !readOnly && state.open && !!data.firstQuestion;
    check.hidden = !open;
    byId("stageContinue").setAttribute("aria-expanded",String(open));
    if (!open) return false;
    update("stageFirstQuestion",data.firstQuestion, host => paragraphs(host,data.firstQuestion));
    const attempts = list(data.turns).filter(turn => turn.checkpoint);
    const oldAnswer = list(data.turns).find(turn => !turn.checkpoint && isCheckTurn(turn,data) && turn.answer);
    update("stageCheckFeedback",[attempts, oldAnswer], host => {
      if (oldAnswer) {
        const details = element("details", "stage-previous");
        details.append(element("summary","","View earlier explanation"));
        paragraphs(details,oldAnswer.answer);
        host.append(details);
      }
      for (const turn of attempts) host.append(turnRow(turn,true,true));
    });
    const latest = attempts.at(-1);
    const input = byId("stageCheckText");
    if (latest?.status === "ready" && state.draft && state.draft.trim() === latest.question) {
      state.draft = "";
      saveCheck();
    }
    if (input.value !== state.draft) input.value = state.draft;
    input.readOnly = busy;
    byId("stageCheckSubmit").disabled = busy || !state.draft.trim();
    const form = byId("stageCheckForm");
    const feedbackReady = latest?.status === "ready";
    const shouldFocusContinue = feedbackReady && !form.hidden && form.contains(document.activeElement);
    form.hidden = feedbackReady;
    byId("stageCheckSkip").textContent = latest?.status === "ready" ? "Continue" : "Skip";
    if (shouldFocusContinue) byId("stageCheckSkip").focus({preventScroll:true});
    return true;
  }

  function bindCheckpoint() {
    byId("stageContinue").addEventListener("click", () => {
      if (!model || model.archived || model.preview || model.complete || byId("stageContinue").hidden) return;
      if (!model.firstQuestion) { model.onContinue?.(); return; }
      checkState().open = true;
      saveCheck();
      part(model);
      byId("stageCheckHeading").focus();
    });
    byId("stageCheckText").addEventListener("input", () => {
      if (!model || byId("stageCheckpoint").hidden) return;
      checkState().draft = byId("stageCheckText").value;
      saveCheck();
      byId("stageCheckSubmit").disabled = byId("stageCheckText").readOnly || !checkState().draft.trim();
    });
    byId("stageCheckForm").addEventListener("submit", event => {
      event.preventDefault();
      if (!model?.onCheckpoint || byId("stageCheckpoint").hidden || byId("stageCheckSubmit").disabled) return;
      const answer = byId("stageCheckText").value.trim();
      if (!answer) return;
      checkState().draft = byId("stageCheckText").value;
      saveCheck();
      byId("stageCheckSubmit").disabled = true;
      const lastAttempt = list(model.turns).findLast(turn => turn.checkpoint);
      const retry = lastAttempt?.question === answer && ["failed","error"].includes(lastAttempt.status);
      model.onCheckpoint(answer,retry ? lastAttempt : undefined);
    });
    byId("stageCheckSkip").addEventListener("click", () => {
      if (!model || byId("stageCheckpoint").hidden) return;
      Object.assign(checkState(),{open:false,draft:""});
      saveCheck();
      model.onContinue?.();
    });
    byId("stageCheckBack").addEventListener("click", () => {
      if (!model || byId("stageCheckpoint").hidden) return;
      checkState().open = false;
      saveCheck();
      part(model);
      byId("stageContinue").focus();
    });
  }

  function bind() {
    if (bound) return;
    bound = true;
    for (const [id,mode] of [["stageModeSteps","steps"],["stageModeFull","full"]]) {
      byId(id).addEventListener("click",()=>{
        if (!model || readingMode === mode) return;
        readingMode = mode;
        try { window.localStorage?.setItem("proof.sectionReadingMode",mode); } catch {}
        highlight = null;
        renderStructure(model);
        renderExploration(model);
      });
    }
    byId("stageProofRetry").addEventListener("click",()=>requestSteps(true));
    for (const [id,delta] of [["stageProofBack",-1],["stageProofNext",1]]) {
      byId(id).addEventListener("click",()=>{
        const modules = list(stepGuide(model)?.modules);
        const current = modules.indexOf(activeStep());
        if (current >= 0) moveToStep(current + delta);
      });
    }
    bindExploration();
    bindCheckpoint();
    byId("stageOrientationRetry").addEventListener("click", () => {
      byId("stageOrientationStatus").focus({preventScroll: true});
      model?.onRetryOrientation?.();
    });
    window.addEventListener?.("scroll", savePosition, {passive: true});
    const text = byId("stageAskText");
    const form = byId("stageAskForm");
    text.addEventListener("input", () => {
      if (context) drafts.set(context, text.value);
      byId("stageSend").disabled = text.readOnly || !text.value.trim();
    });
    text.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        if (!byId("stageSend").disabled) form.requestSubmit();
      }
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const question = text.value.trim();
      if (!model?.onAsk || model.archived || model.preview || model.complete || text.readOnly || !question) return;
      drafts.delete(context);
      text.value = "";
      byId("stageSend").disabled = true;
      model.onAsk(question);
    });
    byId("stageResume").addEventListener("click", () => model?.onResume?.());
  }

  function part(data) {
    const host = byId("stageReader");
    if (!data?.part) {
      savePosition();
      highlight = null;
      host.hidden = true;
      model = null;
      context = "";
      focusKey = "";
      return;
    }
    bind();
    const next = studyPartKey(data);
    const changed = context !== next;
    if (changed) savePosition();
    model = data;
    host.hidden = false;
    const text = byId("stageAskText");
    if (changed) {
      signature.clear();
      highlight = null;
      requestedStructure = "";
      context = next;
      focusKey = "";
      text.value = drafts.get(next) || "";
      byId("stageArchive").open = false;
    }
    const {parts, index, furthest} = data;
    byId("stagePosition").textContent = "Part " + (index + 1) + " of " + parts.length + (data.preview ? " · Preview" : data.archived ? " · Reading history" : "");
    update("stageTitle", data.part.title, node => { node.textContent = data.part.title; });
    renderOrientation(data, changed);
    renderStructure(data, changed);
    previousCompletion(data);
    update("stageSources", data.part.sourceSteps, node => {
      for (const step of list(data.part.sourceSteps)) {
        node.append(link("Source passage " + step, hrefFor(data.part.id, "", step), () => model?.onSource?.(step)));
      }
    });
    prerequisites(data);
    const local = introductions(data);
    const busy = turns(data);
    const readOnly = !!data.archived || !!data.preview || !!data.complete;
    const checking = renderCheckpoint(data,readOnly,busy);
    renderExploration(data);
    byId("stageAskForm").hidden = readOnly || checking;
    text.readOnly = busy || readOnly || checking;
    byId("stageSend").disabled = text.readOnly || !text.value.trim();
    const finalPart = data.complete && index === parts.length - 1;
    const message = data.status || (busy ? (checking ? "Checking your answer…" : "Preparing a response…") : finalPart ? "You’ve completed this paper." : "");
    if (byId("stageStatus").textContent !== message) byId("stageStatus").textContent = message;
    byId("stageResume").hidden = finalPart || (!data.archived && !data.preview);
    const pendingCheck = list(data.turns).some(turn => turn.checkpoint && isBusy(turn));
    byId("stageContinue").hidden = readOnly || checking || (!data.canContinue && !pendingCheck);
    const reached = Math.min(parts.length - 1, furthest ?? index);
    const archive = byId("stageArchive");
    archive.hidden = reached <= 0 && !data.complete;
    update("stageArchiveList", [reached, index, data.complete, parts.map(p => [p.id, p.title])], node => {
      for (let i = 0; i <= reached; i++) {
        const anchor = reviewLink("Part " + (i + 1) + " · " + parts[i].title, parts, i);
        if (i === index) anchor.setAttribute("aria-current", "page");
        node.append(anchor);
      }
    });
    const wanted = data.localId ? next + data.localId : "";
    if (wanted && wanted !== focusKey && local) {
      local.focus({preventScroll: true});
      local.scrollIntoView({block: "center"});
    } else if (changed && !wanted) restorePosition();
    focusKey = wanted;
  }

  window.STAGE_UI = {part, preflight, currentModule:()=>activeStep()?.id || null};
})();
