(() => {
  "use strict";

  // Normalize prose spellings while keeping mathematical notation, signs, and
  // the case of single-letter variables (e.g. H versus h) meaningful.
  function techniqueKey(name) {
    if (typeof name !== "string") return "";
    const notation = /(\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\[a-zA-Z]+)/g;
    return name.trim().split(notation).map((part, index) => index % 2 ? part : part
      .replace(/\p{Script=Latin}{2,}/gu, word => word.toLowerCase())
      .replace(/[\u2010-\u2015\uFE63\uFF0D]/gu, "-")
      .replace(/(?<=\p{Script=Latin}{2})\s*-\s*(?=\p{Script=Latin}{2})/gu, " ")
      .replace(/\s+/gu, " ")).join("");
  }

  class TechniqueSet {
    constructor(names = []) {
      this.labels = new Map();
      for (const name of names) this.add(name);
    }
    add(name) {
      const key = techniqueKey(name);
      if (key && !this.labels.has(key)) this.labels.set(key, name.trim());
      return this;
    }
    has(name) { return this.labels.has(techniqueKey(name)); }
    delete(name) { return this.labels.delete(techniqueKey(name)); }
    get size() { return this.labels.size; }
    [Symbol.iterator]() { return this.labels.values(); }
  }

  function orderedQuestions(options, preferred) {
    const indices = options.map((_, i) => i);
    const target = preferred.trim().toLowerCase();
    const found = indices.find(i => options[i].label.trim().toLowerCase() === target)
      ?? indices.find(i => options[i].label.toLowerCase().includes(target));
    return found === undefined ? indices : [found, ...indices.filter(i => i !== found)];
  }

  function checkpointPrerequisites(steps, known) {
    const definition = new Map();
    for (const [index, step] of steps.entries()) {
      for (const point of step.checkpoints || []) {
        const key = techniqueKey(point.name);
        if (!key) continue;
        // Only a name established in one passage has an unambiguous source.
        if (!definition.has(key)) definition.set(key, index);
        else if (definition.get(key) !== index) definition.set(key, null);
      }
    }
    return steps.map((step, index) => [...new Set((step.checkpoints || [])
      .flatMap(point => point.prerequisites || []).filter(term => !known?.has(term))
      .map(term => definition.get(techniqueKey(term))).filter(i => Number.isInteger(i) && i !== index))]);
  }

  function checkpointRoute(steps, known) {
    const sourceOrder = steps.map((_, index) => index);
    if (!steps.some(step => step.checkpoints?.length)) return sourceOrder;
    const required = checkpointPrerequisites(steps, known);
    const selected = new Set();
    while (selected.size < steps.length) {
      const next = sourceOrder.find(i => !selected.has(i) && required[i].every(j => selected.has(j)));
      // Inconsistent inferred dependencies should never block the reader or hide a step.
      if (next === undefined) return sourceOrder;
      selected.add(next);
    }
    return [...selected];
  }

  function dependencies({steps, current = 0}) {
    if (!steps?.[current]) return {steps: [], skills: []};
    const step = steps[current];
    const skillNames = [
      step.technique,
      ...(step.checkpoints || []).flatMap(point => [point.name, ...(point.prerequisites || [])])
    ];
    return {
      steps: checkpointPrerequisites(steps)[current],
      skills: [...new TechniqueSet(skillNames.filter(name => techniqueKey(name) !== "source reading"))]
    };
  }

  function readConnections(literature, readPapers, current) {
    const publication = paper => paper.url?.split("#")[0];
    const readPublications = new Set(literature.filter(paper => readPapers.has(paper.id)).map(publication).filter(Boolean));
    return literature.filter(paper => paper.steps?.includes(current + 1) &&
      (readPapers.has(paper.id) || readPublications.has(publication(paper))));
  }

  function checkpointComparison(points, read) {
    for (const paper of read) {
      if (!paper.difference?.trim()) continue;
      const skills = new TechniqueSet(paper.skills);
      const point = points.find(p => [p.name, ...(p.prerequisites || [])].some(skill => skills.has(skill)));
      if (point) {
        const text = paper.difference.trim();
        const sentences = text.split(/(?<=[.!?])\s+/u);
        const sentence = sentences.find(part => /^(?:here\b|in (?:this|the current)\b|(?:the current|this) (?:paper|proof|argument|bound|manuscript|result)\b)/i.test(part)) || text;
        const focus = sentence.length > 220 ? sentence.slice(0, 216).replace(/\s+\S*$/, "") + "…" : sentence;
        return {point, paper, focus};
      }
    }
    return null;
  }

  function genericPlan(steps, current, known, read) {
    const route = checkpointRoute(steps, known);
    const step = steps[current];
    const options = step.options || [];
    const next = route[route.indexOf(current) + 1] ?? null;
    const points = (step.checkpoints || []).filter(point => point.name && point.question);
    if (points.length) {
      const pending = points.filter(point => !known.has(point.name));
      const ready = point => !!point.prerequisites?.length && point.prerequisites.every(skill => known.has(skill));
      const contrast = checkpointComparison(pending.length ? pending : points, read);
      const point = contrast?.point || pending.find(ready) || pending[0] || points[0];
      const missing = (point.prerequisites || []).filter(skill => !known.has(skill));
      const advanced = !!point.knownQuestion && (ready(point) || known.has(point.name));
      const label = advanced ? point.knownQuestion : point.question;
      const guidance = advanced
        ? "Use the familiar prerequisites to check the paper’s specific argument for " + point.name + "."
        : missing.length
          ? "Connect " + missing[0] + " to the proof of " + point.name + "."
          : "Trace how this passage establishes " + point.name + ".";
      return {route, next, skipped: [], focus: contrast?.focus || guidance, questions: orderedQuestions(options, label),
        suggestedSkill: missing[0] || (known.has(point.name) ? null : point.name), focusPaperId: contrast?.paper.id || null};
    }
    const familiar = known.has(step.technique);
    const preference = familiar
      ? /what (?:if|breaks)|why must|why compare|locate a condition|find the reference/i
      : /run |trace |see an exchange|example/i;
    const first = options.find(o => preference.test(o.label));
    const questions = first ? orderedQuestions(options, first.label) : options.map((_, i) => i);
    const hasSkill = step.technique && step.technique !== "Source reading" && options.length;
    const focus = familiar && options.length
      ? "Check the condition or proof obligation that makes the familiar method work in this passage."
      : step.page && !options.length
        ? "Read this page in the original paper. Its place in the page sequence is preserved."
        : "Follow the current passage in the author's order and try its first example or source-linked detail.";
    return {
      route, skipped: [], next, questions, focus,
      suggestedSkill: hasSkill && !familiar ? step.technique : null, focusPaperId: null
    };
  }

  function plan({steps, current = 0, known = new TechniqueSet(), readPapers = new Set(), literature = []}) {
    if (!steps?.length) {
      return {route: [], skipped: [], next: null, focus: "", questions: [], suggestedSkill: null, focusPaperId: null};
    }
    if (!(known instanceof TechniqueSet)) known = new TechniqueSet(known);
    current = Number.isInteger(current) ? Math.min(Math.max(0, current), steps.length - 1) : 0;
    const readHere = readConnections(literature, readPapers, current);
    return genericPlan(steps, current, known, readHere);
  }

  function preparationEstimate({overview = false, pages = 0, characters = 0, parts = 0, reference = false,
    startedAt, progress = {}, now = Date.now()}) {
    const minutesSince = stamp => Number.isFinite(stamp) ? Math.max(0, (now - stamp) / 60000) : 0;
    const size = pages || Math.ceil(characters / 4500);
    const stage = progress.stage || "preparing";
    const total = progress.totalParts || parts;
    if (!overview && progress.blockedParts?.length) {
      const numbers=progress.blockedParts;
      return "Time to finish depends on verifying the source for "+(numbers.length===1?"part ":"parts ")+numbers.join(", ")+".";
    }
    const completed = Math.min(total, Math.max(0, progress.completedParts || 0));
    const remaining = total - completed;
    const early = overview || stage === "preparing" || stage === "adapting-notation";
    const age = minutesSince(progress.phaseStartedAt ?? (early ? startedAt : progress.updatedAt));

    // A five-part batch typically takes 3–4 minutes for each of drafting and editing.
    const pass = n => Math.ceil(n / 5) * 0.65 + n * 0.56;
    const rewrite = n => Math.ceil(n / 6) * 0.9 + n * 0.25;
    const mapping = 1.5 + 0.2 * Math.sqrt(size);
    let active, later = 0, revision = false;
    if (overview) {
      if (!size) return "Estimating the time to prepare your overview…";
      active = 1.35 + 0.55 * Math.sqrt(size);
    } else if (stage === "saving" || (total > 0 && remaining === 0 && stage !== "rewriting-notation")) {
      return age < 1.5 ? "Usually less than a minute remaining." : "Saving is taking longer than usual.";
    } else if (!total) {
      return "Estimating the time to prepare your reading plan…";
    } else if (stage === "preparing") {
      active = 0.35;
      later = 2 * pass(remaining) + (reference && !completed ? mapping + rewrite(total) : 0);
    } else if (stage === "adapting-notation") {
      active = mapping;
      later = rewrite(total) + 2 * pass(total);
    } else {
      const adapting = stage === "rewriting-notation";
      const reported = Number.isInteger(progress.firstPart) && Number.isInteger(progress.lastPart) &&
        progress.firstPart > 0 && progress.lastPart >= progress.firstPart;
      const width = Math.min(remaining, reported ? progress.lastPart - progress.firstPart + 1 : adapting ? 6 : 5);
      if (adapting) {
        active = rewrite(width);
        later = rewrite(remaining - width) + 2 * pass(total);
      } else {
        const completedThisRun = completed - (progress.reviewStartPart || 0);
        let pace = 1;
        if (completedThisRun >= 3 && Number.isFinite(progress.reviewStartedAt)) {
          const observed = Math.max(0, minutesSince(progress.reviewStartedAt) - age);
          // At the start of editing, the clock already includes drafting the current batch.
          const drafted = ["editing","checking","revising-draft","revising-notation"].includes(stage) ? pass(width) : 0;
          pace = Math.max(0.55, Math.min(3, observed / (2 * pass(completedThisRun) + drafted)));
        }
        const onePass = pass(width) * pace;
        later = 2 * pass(remaining - width) * pace;
        revision = stage === "revising-draft" || stage === "revising-notation";
        if (revision) {
          active = 1 + 0.4 * width;
          later += onePass;
        } else if (stage === "editing" || stage === "checking") {
          active = onePass;
          // A source check may still be followed by a full editorial pass.
          if (stage === "checking") later += onePass / 2;
        } else if (stage === "reading-source") {
          active = 0.4;
          later += 2 * onePass;
        } else {
          active = onePass;
          later += onePass;
        }
      }
    }
    if (age > Math.max(3, 1 + 2 * active)) {
      return "This step is taking longer than usual. The estimate will update when the next step starts.";
    }
    const round = (n, up) => {
      const unit = n >= 20 ? 5 : 1;
      return Math.max(1, (up ? Math.ceil(n / unit) : Math.floor(n / unit)) * unit);
    };
    const lower = round(Math.max(0.5, active * 0.75 - age) + later * 0.75, false);
    const upper = Math.max(lower + 1, round(Math.max(1, active * 1.5 - age) + later * 1.5, true));
    return "About " + lower + "–" + upper + " minutes " + (overview ? "until the background choices." : "remaining.") +
      (revision ? " Includes an extra revision." : "");
  }

  window.READING_PLAN = {plan, dependencies, TechniqueSet, techniqueKey, preparationEstimate};
})();
