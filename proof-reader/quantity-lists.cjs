'use strict';
const {formulas,boundSignature}=require('./printed-math.cjs');

function mathSpans(block) {
  return [...block.matchAll(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/gu)].map(match=>({
    start:match.index,end:match.index+match[0].length,formula:formulas(match[0])[0],
  }));
}

const scalar=/^(?:\p{L}|\d+(?:\.\d+)?)(?:[_^](?:[\p{L}\d]|\{[+\-−]?(?:\d+|\p{L})\}))*$/u;

// Only a flat list of named or numeric quantities qualifies. In particular,
// commas in tuples, function calls, sets, bounds and conditions are excluded.
function scalarList(formula) {
  const items=formula.split(',').map(s=>s.trim());
  return items.length>1 && items.every(item=>scalar.test(item))?items:null;
}

function quantityReferences(draft,edited) {
  const assignments=new Map();
  for (const block of draft) {
    if (!/\b(?:respectively|in (?:that|this) order)\b/iu.test(block)) continue;
    const spans=mathSpans(block);
    for (let i=1;i<spans.length;i++) {
      const left=spans[i-1],right=spans[i];
      // Require a complete affirmative declaration with a neutral subject.
      // Conditional alternatives or a later comparison cannot bind a value.
      if (!/(?:^|[.!?]\s+)(?:(?:the|these)\s+)?(?:(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?[a-z]+s\s*$/iu.test(block.slice(0,left.start)) ||
          !/^\s*,?\s*(?:respectively|in (?:that|this) order)\s*\.(?:\s|$)/iu.test(block.slice(right.end))) continue;
      const relation=/^\s+have\s+(?:the\s+)?([a-z]+(?:[- ][a-z]+){0,4})\s*$/iu.exec(block.slice(left.end,right.start));
      if (!relation || !/s$/iu.test(relation[1])) continue;
      const plural=relation[1].toLowerCase();
      const noun=plural.endsWith('ies')?plural.slice(0,-3)+'y':plural.slice(0,-1);
      const subjects=scalarList(left.formula),values=scalarList(right.formula);
      if (!subjects || !values || subjects.length!==values.length) continue;
      for (const [j,subject] of subjects.entries()) {
        const key=boundSignature(subject)+'\n'+noun;
        const value=values[j],previous=assignments.get(key);
        assignments.set(key,previous===undefined || (previous!==null && boundSignature(previous)===boundSignature(value))?value:null);
      }
    }
  }
  const verified=new Set(),otherUses=new Set(),conflicts=new Map();
  if (assignments.size) for (const block of edited) {
    const spans=mathSpans(block);
    for (const [i,span] of spans.entries()) {
      const current=boundSignature(span.formula),subject=spans[i-1];
      const relation=subject && /^\s*,\s*whose\s+([a-z]+(?:[- ][a-z]+){0,4})\s+is\s*$/iu.exec(block.slice(subject.end,span.start));
      const wholeQuantity=scalar.test(span.formula) && /^\s*(?:[,.;:)—]|$)/u.test(block.slice(span.end));
      const expected=relation && wholeQuantity && assignments.get(boundSignature(subject.formula)+'\n'+relation[1].toLowerCase());
      if (expected && boundSignature(expected)===current) verified.add(current);
      else {
        otherUses.add(current);
        if (expected) conflicts.set(current,expected);
      }
    }
  }
  for (const value of otherUses) verified.delete(value);
  return {verified,conflicts};
}

module.exports={quantityReferences};
