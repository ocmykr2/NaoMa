(() => {
  "use strict";

  const statementKinds = new Set(["Theorem", "Lemma", "Proposition", "Corollary"]);
  const editorialRevision = "naoma-editor-v1-inline-notation";
  const nonempty = (value, limit) => typeof value === "string" && value.length <= limit && !!value.trim();

  function statementOf(value) {
    if (value === null) return null;
    if (!value || !statementKinds.has(value.kind) || typeof value.label !== "string" ||
        value.label.length > 200 || !nonempty(value.text,4000)) return undefined;
    return {kind:value.kind, label:value.label.trim(), text:value.text.trim()};
  }

  function normalizeLegacy(value) {
    if (!value || !nonempty(value.purpose,600) || !nonempty(value.takeaway,600) || !nonempty(value.handoff,600)) return null;
    const statement = statementOf(value.statement);
    if (statement === undefined) return null;
    return {purpose:value.purpose.trim(), takeaway:value.takeaway.trim(), handoff:value.handoff.trim(), statement};
  }

  function normalize(value) {
    if (!value || !nonempty(value.introduction,1200) || !Array.isArray(value.notation) || value.notation.length > 64 ||
        !Array.isArray(value.definitions) || value.definitions.length > 16 || !Array.isArray(value.paragraphs) ||
        !value.paragraphs.length || value.paragraphs.length > 16 || !value.paragraphs.every(p => nonempty(p,3500))) return null;
    const statement = statementOf(value.statement);
    const handoff = value.handoff ?? "";
    const formalAfter = value.formalAfter === undefined ? 0 : value.formalAfter;
    if (!Number.isInteger(formalAfter) || formalAfter < 0 || formalAfter > value.paragraphs.length) return null;
    if (statement === undefined || typeof handoff !== "string" || handoff.length > 800) return null;
    const notation = [];
    for (const entry of value.notation) {
      if (!nonempty(entry?.symbol,350) || !nonempty(entry.meaning,1000)) return null;
      notation.push({symbol:entry.symbol.trim(), meaning:entry.meaning.trim()});
    }
    const definitions = [];
    for (const entry of value.definitions) {
      if (!nonempty(entry?.name,250) || !nonempty(entry.text,3000)) return null;
      const intuition = entry.intuition ?? "";
      if (typeof intuition !== "string" || intuition.length > 900) return null;
      const ref=entry.claimSource;
      const claimSource=nonempty(ref?.group,250) && Number.isSafeInteger(ref.step) && ref.step>0 &&
        (ref.page===undefined || (Number.isSafeInteger(ref.page) && ref.page>0)) ?
        {group:ref.group.trim(),step:ref.step,...(ref.page?{page:ref.page}:{})} : null;
      definitions.push({name:entry.name.trim(), text:entry.text.trim(), ...(intuition.trim() ? {intuition:intuition.trim()} : {}),
        ...(claimSource?{claimSource}:{})});
    }
    return {introduction:value.introduction.trim(), notation, definitions,
      paragraphs:value.paragraphs.map(p => p.trim()), handoff:handoff.trim(), statement,
      ...(formalAfter && (statement || definitions.length) ? {formalAfter} : {})};
  }

  const api = {normalize, normalizeLegacy, editorialRevision};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PART_ORIENTATION = api;
})();
