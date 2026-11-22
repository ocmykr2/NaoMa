'use strict';

// Map established TeX spellings to their printed glyph. Keep Greek variants
// (such as phi and varphi) and the strictness and direction of relations.
const glyphs={
  alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ϵ',varepsilon:'ε',zeta:'ζ',eta:'η',
  theta:'θ',vartheta:'ϑ',iota:'ι',kappa:'κ',varkappa:'ϰ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',
  pi:'π',varpi:'ϖ',rho:'ρ',varrho:'ϱ',sigma:'σ',varsigma:'ς',tau:'τ',upsilon:'υ',phi:'ϕ',
  varphi:'φ',chi:'χ',psi:'ψ',omega:'ω',Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',
  Pi:'Π',Sigma:'Σ',Upsilon:'Υ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',
  lt:'<',gt:'>',le:'≤',leq:'≤',leqslant:'≤',ge:'≥',geq:'≥',geqslant:'≥',neq:'≠',ne:'≠',
  in:'∈',notin:'∉',forall:'∀',exists:'∃',subset:'⊂',subseteq:'⊆',supset:'⊃',supseteq:'⊇',
  approx:'≈',equiv:'≡',sim:'∼',times:'×',cdot:'⋅',div:'÷',pm:'±',mp:'∓',
  to:'→',rightarrow:'→',Rightarrow:'⇒',infty:'∞',sum:'∑',prod:'∏',int:'∫',
  langle:'⟨',rangle:'⟩',lceil:'⌈',rceil:'⌉',lfloor:'⌊',rfloor:'⌋',dfrac:'\\frac',tfrac:'\\frac',
};
const numberSets={N:'ℕ',Q:'ℚ',R:'ℝ',C:'ℂ',Z:'ℤ'};
const numberSet=/\\mathbb\s*(?:\{([NQRCZ])\}|\s+([NQRCZ])(?![A-Za-z]))/gu;
const sizing=/\\(?:left|right|(?:big|Big|bigg|Bigg)(?:l|r|m)?)(?![A-Za-z])/u;
const sizes=new RegExp(sizing,'gu');
const textCommand=/\\(?:text(?:normal|rm|sf|tt|bf|it|md|up|sl|sc)?|mbox|hbox|operatorname)(?![A-Za-z])/u;
function displayedText(text) {
  // Only normalize presentation. Changes in names, signs, or quantifiers stay detectable.
  return text.normalize('NFC').replace(/\$\$([^$]+)\$\$|\$([^$]+)\$/gu,(_,display,inline)=>display??inline)
    .replace(/\\[()[\]]/g,'').replace(numberSet,(_,braced,single)=>numberSets[braced||single])
    .replace(/\\([a-zA-Z]+)/g,(whole,name)=>Object.hasOwn(glyphs,name)?glyphs[name]:whole)
    .replace(/\s*([≤≥≠∈∉∀∃×⋅→∞∑=<>+−])\s*/gu,'$1').replace(/\s+/gu,' ').trim();
}

function formulas(text) {
  return [...text.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/gu)].map(m=>{
    const raw=m[1]??m[2];
    // Preserve prose and named operators for the lexer. For instance,
    // deleting the blank in \text{no tie} changes a word in the formula.
    if (textCommand.test(raw)) return raw.trim();
    // A control word ends at whitespace. Adjacent letters or numbers must
    // retain their token boundaries even when whitespace is typographic.
    return displayedText(raw).replace(sizes,'')
      .replace(/\\[,;!: ]|\\(?:quad|qquad)(?![a-zA-Z])/gu,' ')
      .replace(/([\p{L}\d])\s+(?=[\p{L}\d])|\s+/gu,(_,last)=>last?last+' ':'');
  });
}
const printedFunctions=new Set(['ln','log','lg','exp','sin','cos','tan','cot','sec','csc','sinh','cosh','tanh',
  'arcsin','arccos','arctan','max','min','sup','inf','lim','limsup','liminf','det','dim','ker','gcd']);
// Modifier letters include the Unicode subscript i/j used in extracted PDFs.
// Keep script runs separate from the base letter and preserve their positions.
const boundTokens=/\\operatorname\s*\{\s*([a-zA-Z]+)\s*\}|\\mathbb\s*(?:\{[NQRCZ]\}|\s+[NQRCZ](?![A-Za-z]))|\\[A-Za-z]+|\\[,;!: ()[\]]|<=|>=|!=|[₀-₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ]+|\d+(?:\.\d+)?|\.\d+|[\p{Lu}\p{Ll}\p{Lt}\p{Lo}]+|[^\s]/gu;
const plainSymbols={'−':'-','<=':'≤','⩽':'≤','>=':'≥','⩾':'≥','!=':'≠'};
const postfix=/^(?:[\^_'′″!({\[⟨⌈⌊]|\\prime|[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉])$/u;
function textGroupEnd(text,afterCommand) {
  let at=afterCommand;
  while (at<text.length && /\s/u.test(text[at])) at++;
  if (text[at]!=='{') return afterCommand;
  let depth=1;
  for (at++;at<text.length;at++) {
    if (text[at]==='\\') at++;
    else if (text[at]==='{') depth++;
    else if (text[at]==='}' && --depth===0) return at+1;
  }
  return text.length;
}
function boundWords(text) {
  const words=[];
  let literalEnd=0;
  for (const m of text.matchAll(boundTokens)) {
    if (m.index<literalEnd) continue;
    const raw=m[0];
    if (sizing.test(raw) || /^\\(?:quad|qquad|[,;!: ])$/u.test(raw)) continue;
    const start=m.index,end=start+raw.length;
    if (!m[1] && textCommand.test(raw)) {
      literalEnd=textGroupEnd(text,end);
      if (literalEnd>end) {
        words.push({value:raw+text.slice(end,literalEnd).trimStart().normalize('NFC').replace(/\s+/gu,' '),start,end:literalEnd});
        continue;
      }
    }
    const subscript=/^[₀-₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]/u.test(raw);
    if (subscript || /^[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ]/u.test(raw)) {
      // Normalize only the characters already recognized as a script. Applying
      // NFKC to an entire equation would also turn ℝ into plain R.
      const contents=raw.normalize('NFKC').replaceAll('−','-').match(/\d+|[a-z]+|./gu);
      const values=raw.length===1?contents:['{',...contents,'}'];
      for (const value of [subscript?'_':'^',...values]) words.push({value,start,end});
      continue;
    }
    const name=m[1] || raw.slice(1);
    // Only established operators have a conventional plain-text spelling.
    // An unknown TeX macro and an identifier with that name remain distinct.
    let value=raw;
    if (Object.hasOwn(plainSymbols,raw)) value=plainSymbols[raw];
    else if (raw.startsWith('\\') && printedFunctions.has(name)) value=name;
    else if (!m[1] && raw.startsWith('\\') && Object.hasOwn(glyphs,name)) value=glyphs[name];
    else if (/^\\mathbb(?:\s|\{)/u.test(raw)) value=displayedText(raw);
    words.push({value,start:m.index,end:m.index+raw.length});
  }
  const scripts=[];
  for (let i=0;i<words.length;i++) {
    const word=words[i];
    scripts.push(word);
    const open=words[i+1],argument=words[i+2],close=words[i+3];
    // TeX braces around one script token specify the same attachment. A
    // multi-token script remains grouped: x^{12} differs from x^12 in TeX.
    if ((word.value==='^' || word.value==='_') && open?.value==='{' && close?.value==='}' &&
        /^(?:[\p{L}\d+-]|\\[A-Za-z]+)$/u.test(argument.value)) {
      scripts.push({value:argument.value,start:open.start,end:close.end});
      i+=3;
    }
  }
  const normalized=[];
  for (let i=0;i<scripts.length;i++) {
    const word=scripts[i];
    normalized.push(word);
    if (!printedFunctions.has(word.value)) continue;
    // In log_2(Q), the base belongs to log. Keep it verbatim while finding
    // the argument, including braces for a multi-token base such as {10}.
    let at=i+1;
    if (scripts[at]?.value==='_') {
      if (scripts[at+1]?.value==='{') {
        if (scripts[at+3]?.value!=='}') continue;
        at+=4;
      } else at+=2;
    }
    const open=scripts[at],argument=scripts[at+1],close=scripts[at+2],next=scripts[at+3];
    // Parentheses around a single argument are interchangeable in ln(q) and
    // ln q. Keep compound arguments, bases and powers with their own scope.
    if ((open?.value==='(' && close?.value===')' || open?.value==='{' && close?.value==='}') &&
        /^(?:\p{L}|\d+(?:\.\d+)?|\.\d+)$/u.test(argument.value) && !postfix.test(next?.value || '')) {
      normalized.push(...scripts.slice(i+1,at),{value:argument.value,start:open.start,end:close.end});
      i=at+2;
    }
  }
  return normalized;
}
function printedExpression(formula,passages,within) {
  const expected=boundWords(formula);
  if (!expected.length) return false;
  const continuation=/^(?:[-+*/^_=<>≤≥≠×⋅÷·±∓≈≡∼∈∉⊂⊆⊃⊇→⇒]|\\over)$/u;
  const alphanumeric=/^[\p{L}\d]/u;
  const factor=value=>printedFunctions.has(value) || /^(?:\p{L}|[∞∑∏∫√]|[A-Z]{2,}|\d+(?:\.\d+)?|\.\d+|\\[A-Za-z]+)$/u.test(value);
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
