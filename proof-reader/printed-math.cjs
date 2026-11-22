'use strict';

function displayedText(text) {
  // Only normalize presentation. Changes in names, signs, or quantifiers stay detectable.
  const symbols = {le:'≤', leq:'≤', ge:'≥', geq:'≥', neq:'≠', ne:'≠', in:'∈', notin:'∉', forall:'∀', exists:'∃',
    times:'×', cdot:'⋅', to:'→', rightarrow:'→', infty:'∞', sum:'∑', mu:'μ', alpha:'α', beta:'β'};
  return text.normalize('NFC').replace(/\$\$([^$]+)\$\$|\$([^$]+)\$/gu,(_,display,inline)=>display??inline)
    .replace(/\\[()[\]]/g,'').replace(/\\([a-zA-Z]+)\b/g,(whole,name)=>symbols[name] ?? whole)
    .replace(/\s*([≤≥≠∈∉∀∃×⋅→∞∑=<>+−])\s*/gu,'$1').replace(/\s+/gu,' ').trim();
}

function formulas(text) {
  return [...text.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/gu)].map(m=>
    // A TeX control word ends at whitespace. Joining \sin and x creates a
    // different command, \sinx, which cannot be compared to the printed text.
    displayedText(m[1]??m[2]).replace(/\\(?:left|right)(?![a-zA-Z])/gu,'')
      .replace(/\\[,;!: ]|\\(?:quad|qquad)(?![a-zA-Z])/gu,' ')
      .replace(/(\\[a-zA-Z]+)\s+(?=[a-zA-Z])|\s+/gu,(_,command)=>command?command+' ':''));
}
const printedFunctions=new Set(['ln','log','lg','exp','sin','cos','tan','cot','sec','csc','sinh','cosh','tanh',
  'arcsin','arccos','arctan','max','min','sup','inf','lim','limsup','liminf','det','dim','ker','gcd']);
const boundTokens=/\\operatorname\s*\{([a-zA-Z]+)\}|\\[A-Za-z]+|\\[,;!: ()[\]]|<=|>=|!=|\d+(?:\.\d+)?|\.\d+|\p{L}+|[^\s]/gu;
const postfix=/^(?:[\^_'′″!({\[]|\\prime|[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉])$/u;
function boundWords(text) {
  const words=[];
  for (const m of text.matchAll(boundTokens)) {
    const raw=m[0];
    if (/^\\(?:left|right|quad|qquad|[,;!: ])$/u.test(raw)) continue;
    const name=m[1] || raw.slice(1);
    // Only established operators have a conventional plain-text spelling.
    // An unknown TeX macro and an identifier with that name remain distinct.
    const value=raw.startsWith('\\') && printedFunctions.has(name)?name:
      raw==='−'?'-':raw==='<='?'≤':raw==='>='?'≥':raw==='!='?'≠':
      /^\\[a-zA-Z]+$/u.test(raw)?displayedText(raw):raw;
    words.push({value,start:m.index,end:m.index+raw.length});
  }
  const normalized=[];
  for (let i=0;i<words.length;i++) {
    const word=words[i];
    normalized.push(word);
    if (!printedFunctions.has(word.value)) continue;
    const open=words[i+1],argument=words[i+2],close=words[i+3],next=words[i+4];
    // Parentheses around a single argument are interchangeable in ln(q) and
    // ln q. Keep compound arguments, bases and powers with their own scope.
    if ((open?.value==='(' && close?.value===')' || open?.value==='{' && close?.value==='}') &&
        /^(?:\p{L}|\d+(?:\.\d+)?|\.\d+)$/u.test(argument.value) && !postfix.test(next?.value || '')) {
      normalized.push({value:argument.value,start:open.start,end:close.end});
      i+=3;
    }
  }
  return normalized;
}
function printedExpression(formula,passages,within) {
  const expected=boundWords(formula);
  if (!expected.length) return false;
  const continuation=/^(?:[-+*/^_=<>≤≥≠×⋅÷·±∓]|\\(?:pm|mp|div|over|approx|equiv|sim|lt|gt))$/u;
  const alphanumeric=/^[\p{L}\d]/u;
  const factor=value=>printedFunctions.has(value) || /^(?:\p{L}|[A-Z]{2,}|\d+(?:\.\d+)?|\.\d+|\\[A-Za-z]+)$/u.test(value);
  return passages.some(passage=>{
    const words=boundWords(passage);
    const clipped=within?[...passage.matchAll(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[^$]*\$\$|\$[^$\n]+\$/gu)]
      .filter(span=>span.index<within.start || span.index+span[0].length>within.end):[];
    for (let i=0;i+expected.length<=words.length;i++) {
      if (words[i].value!==expected[0].value || !expected.every((word,j)=>words[i+j].value===word.value)) continue;
      const end=i+expected.length,first=words[i],last=words[end-1],before=words[i-1],after=words[end];
      if (within && (first.start<within.start || last.end>within.end)) continue;
      if (clipped.some(span=>span.index<last.end && span.index+span[0].length>first.start)) continue;
      if ((before && continuation.test(before.value)) || (after && continuation.test(after.value))) continue;
      // Inspect both sides in the complete passage even when verifying a
      // quote. A cropped quote or a line break cannot truncate an expression.
      const attached=(left,right)=>left && right && left.end===right.start &&
        alphanumeric.test(left.value) && alphanumeric.test(right.value);
      if (attached(before,first) || attached(last,after)) continue;
      if (after && (postfix.test(after.value) || factor(after.value) && alphanumeric.test(last.value))) continue;
      if (before && factor(before.value) && alphanumeric.test(first.value)) continue;
      return true;
    }
    return false;
  });
}

function boundSignature(text, maskBounds=false) {
  return boundWords(text).map(({value})=>maskBounds ? value.replace(/\d+(?:\.\d+)?|[≤≥≠<>=+\u2212-]/gu,'#') : value).join('\t');
}

module.exports={displayedText,formulas,printedExpression,boundSignature};
