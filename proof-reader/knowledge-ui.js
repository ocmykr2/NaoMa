(() => {
  "use strict";

  const panels = new WeakMap();
  let nextId = 0;
  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === "string" ? value.trim() : "";
  const key = (...parts) => JSON.stringify(parts);

  function node(tag, className, content) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (content) result.textContent = content;
    return result;
  }

  function button(label, className, run) {
    const result = node("button", className, label);
    result.type = "button";
    result.addEventListener("click", run);
    return result;
  }

  function identify(panel, control, name) {
    panel.controls.set(name, control);
    control.dataset.knowledgeFocus = name;
    return control;
  }

  function disclosure(panel, name, label, details, initiallyOpen = false) {
    const toggle = identify(panel, button(label, "knowledge-disclosure", () => setOpen(details.hidden)), name);
    details.id = "knowledge-detail-" + (++nextId);
    toggle.setAttribute("aria-controls", details.id);
    function setOpen(open) {
      details.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      panel.open.set(name, open);
    }
    setOpen(panel.open.has(name) ? panel.open.get(name) : initiallyOpen);
    return {toggle, setOpen};
  }

  function checkbox(panel, name, label, description, getValue, setValue) {
    const wrapper = node("label", "knowledge-check");
    const input = identify(panel, node("input"), name);
    input.type = "checkbox";
    input.setAttribute("aria-label", description);
    input.addEventListener("change", () => {
      setValue(input.checked);
      refresh(panel);
    });
    panel.sync.push(() => { input.checked = !!getValue(); });
    wrapper.append(input);
    if (label) wrapper.append(document.createTextNode(label));
    return wrapper;
  }

  function citation(paper) {
    const value = text(paper.citeKey).replace(/^\[|\]$/g, "");
    return value ? "[" + value + "]" : text(paper.shortCitation);
  }

  function passageLink(paper) {
    const label = text(paper.locator) || "Open source passage";
    try {
      const url = new URL(paper.url);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
        const link = node("a", "knowledge-source-link", label);
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        return link;
      }
    } catch { /* Keep a plain locator for citations without a usable link. */ }
    return text(paper.locator) ? node("span", "knowledge-locator", label) : null;
  }

  function sourceRow(panel, techniqueId, reference, paper, index, onlyOne) {
    const paperId = String(reference.paperId);
    const name = key("source", techniqueId, paperId, index);
    const block = node("div", "knowledge-source");
    const evidence = node("div", "knowledge-evidence");
    const label = [citation(paper), text(paper.title)].filter(Boolean).join(" ");
    const control = disclosure(panel, name, label || "Source passage", evidence, onlyOne);
    const role = {uses:"Uses this technique", introduces:"Introduces this technique"}[reference.role];
    const header = node("div", "knowledge-source-head");
    header.append(control.toggle);
    if (role) header.append(node("span", "knowledge-role", role));
    const authors = Array.isArray(paper.authors) ? paper.authors.join(", ") : text(paper.authors);
    const metadata = [authors, paper.year].filter(Boolean).join(" · ");
    if (metadata) evidence.append(node("p", "knowledge-metadata", metadata));
    const link = passageLink(paper);
    if (link) {
      if (link.tagName === "A") identify(panel, link, key("locator", techniqueId, paperId, index));
      evidence.append(link);
    }
    const facts = node("dl", "knowledge-evidence-list");
    if (reference.role === "introduces" && text(reference.evidence)) {
      facts.append(node("dt", "", "Evidence for attribution"), node("dd", "", text(reference.evidence)));
    }
    const comparisons = [["Earlier argument", paper.idea]];
    if (!panel.options.preflight) comparisons.push(["Connection here", paper.connection], ["Difference", paper.difference]);
    for (const [term, value] of comparisons) {
      if (text(value)) facts.append(node("dt", "", term), node("dd", "", value));
    }
    if (facts.childElementCount) evidence.append(facts);
    if (panel.options.setRead && panel.options.isRead) {
      evidence.append(checkbox(panel, key("read", techniqueId, paperId, index), "I’ve read this paper",
        "I’ve read " + (paper.title || "the cited paper"), () => panel.options.isRead(paper),
        checked => panel.options.setRead(paper, checked)));
    }
    block.append(header, evidence);
    return {block, ...control};
  }

  function addSelfCheck(panel, details, type, id, authored, question, answer) {
    if (panel.options.preflight) return;
    if (text(authored?.question) && text(authored?.answer)) {
      question = authored.question;
      answer = authored.answer;
    }
    if (!text(question) || !text(answer)) return;
    const section = node("div", "knowledge-self-check");
    const prompt = node("div", "knowledge-check-prompt");
    const solution = node("p", "knowledge-check-answer", answer);
    const check = disclosure(panel, key("self-check", type, id), "Check my understanding", prompt);
    const show = disclosure(panel, key("self-check-answer", type, id), "Show answer", solution);
    prompt.append(node("p", "knowledge-check-question", question), show.toggle, solution);
    section.append(check.toggle, prompt);
    details.append(section);
  }

  function techniqueRow(panel, technique, papers) {
    const id = String(technique.id || technique.name);
    const row = node("article", "knowledge-item");
    const header = node("div", "knowledge-row");
    const details = node("div", "knowledge-details");
    const control = disclosure(panel, key("technique", id), technique.name, details);
    const label = node("div", "knowledge-name");
    label.append(control.toggle);
    const references = array(technique.sources).filter(ref => ref && papers.has(String(ref.paperId)));
    const sources = new Map();
    const buttons = new Map();
    const sourceGroup = node("div", "knowledge-sources");
    for (const [index, reference] of references.entries()) {
      const paperId = String(reference.paperId);
      const paper = papers.get(paperId);
      const source = sourceRow(panel, id, reference, paper, index, references.length === 1);
      if (!sources.has(paperId)) sources.set(paperId, source);
      sourceGroup.append(source.block);
      const cite = citation(paper);
      if (!technique.folklore && cite && !buttons.has(cite)) {
        const link = identify(panel, button(cite, "knowledge-cite", () => reveal(panel.host, id, paperId)), key("cite", id, paperId));
        link.setAttribute("aria-label", "Show " + cite + " · " + (paper.title || "source passage"));
        buttons.set(cite, link);
        label.append(link);
      }
    }
    header.append(label);
    if (panel.options.isKnown && panel.options.setKnown) {
      header.append(checkbox(panel, key("known", id), "I know this", "I know " + technique.name,
        () => panel.options.isKnown(technique), checked => panel.options.setKnown(technique, checked)));
    }
    if (text(technique.mechanism)) details.append(node("p", "knowledge-mechanism", technique.mechanism));
    if (!panel.options.preflight && text(technique.knownBridge)) {
      const bridge = node("p", "knowledge-bridge", technique.knownBridge);
      details.append(bridge);
    }
    addSelfCheck(panel, details, "technique", id, technique.selfCheck,
      "How would you explain “" + technique.name + "” in your own words?", technique.mechanism);
    if (sourceGroup.childElementCount) details.append(sourceGroup);
    row.append(header, details);
    panel.techniques.set(id, {...control, sources});
    return row;
  }

  function definitionRow(panel, group) {
    const id = String(group.id || group.title);
    const row = node("article", "knowledge-item");
    const header = node("div", "knowledge-row");
    const details = node("div", "knowledge-details knowledge-definitions");
    const definitions = array(group.definitions).filter(d => text(d?.term));
    const terms = new Map();
    const level = () => panel.options.definitionState?.(group) || "unfamiliar";
    const control = disclosure(panel, key("group", id), group.title, details, level() === "partial");
    header.append(control.toggle);
    if (panel.options.setDefinitionState) {
      const selector = identify(panel, node("select", "knowledge-level"), key("level", id));
      selector.setAttribute("aria-label", "Familiarity with " + group.title);
      for (const [value, label] of [["unfamiliar", "Unfamiliar"], ["partial", "Partially know"], ["known", "Familiar"]]) {
        const item = node("option", "", label);
        item.value = value;
        selector.append(item);
      }
      selector.addEventListener("change", () => {
        if (selector.value === "partial") control.setOpen(true);
        panel.options.setDefinitionState(group, selector.value);
        refresh(panel);
      });
      panel.sync.push(() => { selector.value = level(); });
      header.append(selector);
    }
    for (const [index, definition] of definitions.entries()) {
      const item = node("div", "knowledge-definition");
      item.tabIndex = -1;
      terms.set(definition.term, item);
      if (panel.options.setTermKnown) {
        const label = checkbox(panel, key("term", id, definition.term, index), definition.term, "I know " + definition.term,
          () => level() === "known" || panel.options.knownTerms?.(group)?.has(definition.term),
          checked => panel.options.setTermKnown(group, definition.term, checked));
        label.classList.add("knowledge-term-label");
        item.append(label);
      } else item.append(node("strong", "", definition.term));
      if (text(definition.meaning)) item.append(node("p", "", definition.meaning));
      details.append(item);
    }
    const first = definitions.find(definition => text(definition.meaning));
    addSelfCheck(panel, details, "definition", id, group.selfCheck,
      first && "What does “" + first.term + "” mean?", first?.meaning);
    row.append(header, details);
    panel.groups.set(id, {...control, terms});
    return row;
  }

  function refresh(panel) {
    for (const update of panel.sync) update();
  }

  function researchLine(panel, hasTechniques) {
    const line = node("div", "knowledge-research");
    const status = node("p", "knowledge-message");
    status.setAttribute("role", "status");
    const action = identify(panel, button("Research this paper", "knowledge-action",
      () => panel.options.researchAction?.()), key("research"));
    panel.sync.push(() => {
      const research = panel.options.research;
      const state = typeof research === "string" ? research : research?.status;
      const busy = ["starting", "running", "pending"].includes(state);
      const error = ["error", "failed"].includes(state);
      const completed = state === "ready" && !!research.knowledge;
      status.textContent = busy ? "Researching this paper’s techniques and definitions…"
        : error ? (text(research?.message) || "The paper research could not be completed.")
        : hasTechniques ? "" : completed ? "The analysis found no distinct reusable proof technique in this paper."
        : "No techniques have been identified for this paper yet.";
      status.hidden = !status.textContent;
      action.hidden = busy || !panel.options.researchAction || completed;
      action.textContent = error ? "Retry research" : "Research this paper";
      line.hidden = status.hidden && action.hidden;
    });
    line.append(status, action);
    return line;
  }

  function mount(host, options) {
    let panel = panels.get(host);
    if (!panel) {
      panel = {host, open: new Map(), techniques: new Map(), groups: new Map(), controls: new Map(), sync: [], signature: null};
      panels.set(host, panel);
    }
    const paperChanged = panel.options && panel.options.paperKey !== options.paperKey;
    if (paperChanged) panel.open.clear();
    panel.options = options;
    const techniques = array(options.knowledge?.techniques).filter(t => text(t?.name));
    const groups = array(options.knowledge?.definitionGroups).filter(g => text(g?.title));
    const papers = array(options.papers);
    const callbacks = ["isKnown", "setKnown", "isRead", "setRead", "setTermKnown", "setDefinitionState"]
      .map(name => typeof options[name] === "function");
    const signature = JSON.stringify([techniques, groups, papers, callbacks, !!options.preflight]);
    if (!paperChanged && signature === panel.signature && host.firstElementChild) {
      refresh(panel);
      return;
    }
    const focused = host.contains(document.activeElement) ? document.activeElement.dataset.knowledgeFocus : null;
    const scrollBox = host.closest("dialog") || host;
    const scrollTop = paperChanged ? 0 : scrollBox.scrollTop;
    panel.techniques.clear();
    panel.groups.clear();
    panel.controls.clear();
    panel.sync = [];
    const paperMap = new Map(papers.filter(p => p?.id).map(p => [String(p.id), p]));
    const tech = node("section", "knowledge-section");
    const defs = node("section", "knowledge-section");
    for (const [section, title] of [[tech, "Techniques I know"], [defs, "Definitions I’m familiar with"]]) {
      const heading = node("h3", "knowledge-heading", title);
      heading.id = "knowledge-heading-" + (++nextId);
      section.setAttribute("aria-labelledby", heading.id);
      section.append(heading);
    }
    for (const technique of techniques) tech.append(techniqueRow(panel, technique, paperMap));
    tech.append(researchLine(panel, !!techniques.length));
    for (const group of groups) defs.append(definitionRow(panel, group));
    if (!groups.length) {
      const message = node("p", "knowledge-message");
      panel.sync.push(() => {
        const research = panel.options.research;
        message.textContent = research?.status === "ready" && research.knowledge
          ? "The analysis found no definitions to group in this paper."
          : "No definition groups have been identified for this paper yet.";
      });
      defs.append(message);
    }
    host.replaceChildren(tech, defs);
    if (window.READER_MATH) {
      for (const part of host.querySelectorAll(".knowledge-mechanism,.knowledge-bridge,.knowledge-definition,.knowledge-evidence-list dd,.knowledge-check-question,.knowledge-check-answer")) {
        window.READER_MATH.render(part);
      }
    }
    panel.signature = signature;
    refresh(panel);
    if (focused && paperChanged) {
      const heading = tech.firstElementChild;
      heading.tabIndex = -1;
      heading.focus({preventScroll: true});
    } else if (focused) panel.controls.get(focused)?.focus({preventScroll: true});
    scrollBox.scrollTop = scrollTop;
  }

  function reveal(host, techniqueId, paperId) {
    const panel = panels.get(host);
    const technique = panel?.techniques.get(String(techniqueId));
    const source = paperId ? technique?.sources.get(String(paperId)) : null;
    if (!technique || (paperId && !source)) return false;
    const dialog = host.closest("dialog");
    if (dialog && !dialog.open) dialog.showModal();
    technique.setOpen(true);
    if (source) source.setOpen(true);
    const target = (source || technique).toggle;
    target.focus({preventScroll: true});
    target.scrollIntoView({block: "nearest", inline: "nearest"});
    return true;
  }

  function revealDefinition(host, groupId, term) {
    const group = panels.get(host)?.groups.get(String(groupId));
    const target = term ? group?.terms.get(term) : group?.toggle;
    if (!target) return false;
    const dialog = host.closest("dialog");
    if (dialog && !dialog.open) dialog.showModal();
    group.setOpen(true);
    target.focus({preventScroll: true});
    target.scrollIntoView({block: "nearest", inline: "nearest"});
    return true;
  }

  window.KNOWLEDGE_UI = {mount, reveal, revealDefinition};
})();
