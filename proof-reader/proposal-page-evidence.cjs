'use strict';
const {formulas,boundSignature}=require('./printed-math.cjs');
const {createEvidenceIndex}=require('./prose-evidence.cjs');

// Parse only top-level comma-separated entries and exact equality sides. A sign,
// exponent, product, function argument or inequality stays attached to its term.
function formulaComponents(raw) {
  const result=new Set([boundSignature(raw)]);
  function groups(text) {
    const stack=[],commas=[],equals=[];
    let encloses=['(','[','⟨'].includes(text[0]);
    for (const m of text.matchAll(/\\(?:begin|end)\{[A-Za-z*]+\}|\\[A-Za-z]+|\\.|./gsu)) {
      const t=m[0],i=m.index;
      const closes={'(':')','[':']','{':'}','⟨':'⟩','\\{':'\\}','\\langle':'\\rangle'};
      if (Object.hasOwn(closes,t)) stack.push(closes[t]);
      else if (t.startsWith('\\begin{')) stack.push(t.replace('\\begin{','\\end{'));
      else if (t.startsWith('\\end{') || [')',']','}','⟩','\\}','\\rangle'].includes(t)) {
        if (stack.pop()!==t) return;
        if (!stack.length && i+t.length<text.length) encloses=false;
      } else if (!stack.length && t===',') commas.push(i);
      else if (!stack.length && t==='=' && !/[<>=!:\\]/u.test(text[i-1]||'') && text[i+1]!=='=') equals.push(i);
    }
    if (!stack.length) return {commas,equals,encloses};
  }
  function split(text,separators) {
    return [...separators,text.length].map((end,i)=>text.slice(i?separators[i-1]+1:0,end).trim());
  }
  const top=groups(raw);
  if (!top) return result;
  for (const claim of split(raw,top.commas)) {
    result.add(boundSignature(claim));
    const eq=groups(claim);
    if (!eq) continue;
    for (const side of split(claim,eq.equals)) {
      result.add(boundSignature(side));
      if (!groups(side)?.encloses) continue;
      const inner=side.slice(1,-1),list=groups(inner);
      if (list?.commas.length) for (const entry of split(inner,list.commas)) result.add(boundSignature(entry));
    }
  }
  return result;
}
function equationContent(text) {
  // An equation number and the sentence-ending full stop can be typeset
  // inside the display. Neither is an operand or part of a decimal literal.
  return text.trim().replace(/\\tag\*?\{\s*(?:[A-Za-z]\.)?\d+(?:\.\d+)*(?:[a-z])?\s*\}\s*\.?$/u,'')
    .trimEnd().replace(/(?<=[\p{L}\p{N}\]})])\.$/u,'');
}
function formulaKey(raw) {
  // The same rendering normalization must run on the bare verifier field and
  // on the delimited transcription (e.g. \ge / ≥ and \left ... \right).
  const enclosed=/^(?:\\\(([\s\S]*)\\\)|\\\[([\s\S]*)\\\])$/u.exec(raw.trim());
  return boundSignature(equationContent(formulas('\\('+(enclosed?enclosed[1]??enclosed[2]:raw)+'\\)')[0]));
}
function hasCompleteFormula(text,raw) {
  const target=formulaKey(raw);
  return formulas(text).some(formula=>formulaComponents(equationContent(formula)).has(target));
}
function matchingAnchors(unitText,transcription,anchor) {
  const source=createEvidenceIndex(unitText),witness=createEvidenceIndex(transcription);
  // A terminal comma, semicolon or full stop is not part of a prose locator.
  const phrase=anchor.trim().replace(/[.,;:!?]+$/u,'');
  const location=source.locate(phrase);
  if (!location) return null;
  const direct=witness.locate(phrase);
  if (direct) return {location,witness:direct};
  // PDF text often prints a one-letter subscript on the same baseline.
  // Match it only inside this already located prose anchor. Pad the
  // replacement so that subsequent formula checks use the original offsets.
  const flat=transcription.replace(/\\\(\s*([A-Za-z])_(?:([A-Za-z0-9])|\{([A-Za-z0-9]+)\})\s*\\\)/gu,
    (span,base,sub,group)=>(base+(sub??group)).padEnd(span.length));
  if (flat!==transcription) {
    const located=createEvidenceIndex(flat).locate(phrase);
    if (located) return {location,witness:located};
  }
  // A figure/table caption can precede its transcription. Require another
  // unique, nearby shared label or multiword phrase to identify that location.
  const prose=transcription.replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/gu,'\n');
  const labels=prose.match(/\b(?:Figure|Table|Plate|Lemma|Theorem|Proposition|Example)\s+[A-Za-z]?\d+(?:\.\d+)*\b/gu)||[];
  const phrases=prose.match(/[\p{L}]{2,}(?:[ \t]+[\p{L}]{2,}){3,7}/gu)||[];
  for (const shared of [...labels,...phrases]) {
    const adjacent=source.locate(shared),printed=witness.locate(shared);
    if (adjacent && printed && Math.max(adjacent.start-location.end,location.start-adjacent.end)<=450) return {location:adjacent,witness:printed};
  }
  return null;
}
function sourceExcerpts(units,anchors) {
  const perPage=Math.ceil(72000/units.length);
  return units.map(({step,page,text})=>{
    if (text.length<=perPage) return {step,page,text};
    const passages=[],ranges=[];
    function clip(center,width) {
      const start=Math.max(0,Math.min(text.length-width,center-Math.floor(width/2)));
      const end=Math.min(text.length,start+width);
      if (!ranges.some(([a,b])=>start>=a && end<=b)) {passages.push(text.slice(start,end));ranges.push([start,end]);}
    }
    const width=Math.max(1,Math.floor(perPage/6));
    for (const a of anchors.filter(a=>a.step===step).slice(0,3)) {
      const position=text.indexOf(a.phrase);
      if (position>=0) clip(position,width);
    }
    for (const fraction of [0,0.5,1]) clip(Math.floor(text.length*fraction),width);
    return {step,page,passages};
  });
}
module.exports={formulaKey,hasCompleteFormula,matchingAnchors,sourceExcerpts};
