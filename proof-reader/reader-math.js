(() => {
  "use strict";

  const ignored = "math,.reader-math,script,style,code,pre,textarea,input,select,option,label:not(.knowledge-term-label),svg,.exploration-links,.turn-locator,.source-actions,.step-meta,.lit-source,.lit-back,.prior-citation,[contenteditable]:not([contenteditable='false'])";
  const scripts = new Map();
  function mapScripts(chars, plain, operator) {
    [...chars].forEach((c, n) => scripts.set(c, {char: [...plain][n], operator}));
  }
  mapScripts("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ", "0123456789+-=()aehijklmnoprstuvx", "_");
  mapScripts("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿᵃᵇᶜᵈᵉʰᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ",
    "0123456789+-=()inabcdehklmoprstuvwxyzABDEGHIJKLMNOPRTUVW", "^");

  const relations = new Map(Object.entries({
    "=": "=", "<": "<", ">": ">", "≤": "\\le", "≥": "\\ge", "≠": "\\ne",
    "≈": "\\approx", "∈": "\\in", "∉": "\\notin", "⊂": "\\subset", "⊆": "\\subseteq",
    "→": "\\to", "⇒": "\\Rightarrow", "≡": "\\equiv", "∼": "\\sim", "∝": "\\propto",
  }));
  const operators = new Map(Object.entries({
    "+": "+", "-": "-", "−": "-", "±": "\\pm", "×": "\\times", "·": "\\cdot", "*": "\\cdot",
  }));
  const functions = new Set(["log","ln","exp","min","max","sup","inf","sin","cos","tan"]);
  const named = new Set(["ALG", "OPT", "SRPT"]);
  const products = new Set(["av","bv","bm","ag","ah","aH","KH","dt","dv","dx"]);
  const closeFor = {"(": ")", "[": "]", "{": "}"};
  const texFence = {"(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}"};
  const greek = /^[\u0391-\u03a9\u03b1-\u03c9ϕϵϑϱϖ]$/u;
  const lexeme = /https?:\/\/[^\s<>()]+|(?:[A-Za-z]\.){2,}|[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9]+(?:\.[0-9]+)?|[^\S\r\n]+|\r?\n|./gu;
  const number = s => /^[0-9]+(?:\.[0-9]+)?$/.test(s);
  const letter = s => /^[A-Za-z]$/.test(s);

  function mathNode(raw, tex, display) {
    if (!window.katex || tex.length > 12000) return null;
    const host = document.createElement("span");
    host.className = display ? "reader-math reader-math-display" : "reader-math";
    // Keep DOM text searches, copy fallbacks and sentence anchors tied to the exact source.
    // The shadow tree presents a single accessible equation in its place.
    host.textContent = raw;
    const root = host.attachShadow({mode: "open"});
    const content = document.createElement("span");
    try {
      window.katex.render(tex, content, {
        output: "mathml", displayMode: display, throwOnError: true, strict: "ignore",
        trust: false, maxExpand: 300, maxSize: 15, macros: {},
      });
      const math = content.querySelector("math");
      if (!math) return null;
      // Drop the hidden TeX annotation. The native formula already exposes its structure.
      math.querySelector("annotation")?.remove();
      root.append(math);
      return host;
    } catch {
      return null;
    }
  }

  // This is intentionally a small grammar for math already written in prose.
  // Complete TeX delimited by the author goes directly to KaTeX.
  function plainFormula(tokens, start) {
    let pos = start;
    const end = Math.min(tokens.length, start + 220);
    const value = i => i < end ? tokens[i].s : "";
    const next = () => {
      while (pos < end && /^[^\S\r\n]+$/.test(value(pos))) pos++;
      return value(pos);
    };
    function scalar(s) {
      return number(s) || letter(s) || greek.test(s) || named.has(s) ||
        functions.has(s) || products.has(s) || ["∑","∫","∞"].includes(s);
    }
    function atom(depth) {
      const before = pos;
      const s = next();
      if (depth > 12) return null;
      let result;
      if (s === "−" || s === "-") {
        pos++;
        const arg = atom(depth + 1);
        if (arg) result = {tex: "-" + arg.tex, signal: true};
      } else if (Object.hasOwn(closeFor, s)) {
        pos++;
        const first = expression(depth + 1);
        if (first) {
          const args = [first.tex];
          while (next() === ",") {
            pos++;
            const term = expression(depth + 1);
            if (!term) break;
            args.push(term.tex);
          }
          if (next() === closeFor[s]) {
            pos++;
            const inner = args.join(", ");
            result = {tex: "\\left" + texFence[s] + inner + "\\right" + texFence[closeFor[s]], inner,
              signal: first.signal || args.length > 1, grouped: true};
          }
        }
      } else if (scalar(s)) {
        pos++;
        let tex = s;
        if (functions.has(s)) tex = "\\" + s + " ";
        if (named.has(s)) tex = "\\mathrm{" + s + "}";
        if (s === "Σ" || s === "∑") tex = "\\sum ";
        if (s === "∫") tex = "\\int ";
        if (s === "∞") tex = "\\infty ";
        result = {tex, number: number(s), signal: greek.test(s) || s === "∫" || s === "∑" || s === "∞",
          variable: letter(s) || greek.test(s), function: functions.has(s)};
      }
      if (!result) { pos = before; return null; }
      while (pos < end) {
        if (value(pos) === "\u0302" && result.variable) {
          pos++;
          result.tex = "\\hat{" + result.tex + "}";
          result.signal = true;
          continue;
        }
        if (value(pos) === "′" || value(pos) === "″") {
          result.tex += value(pos++) === "′" ? "'" : "''";
          result.signal = true;
          delete result.inner;
          continue;
        }
        const script = scripts.get(value(pos));
        let op, arg;
        if (script) {
          op = script.operator;
          arg = "";
          while (scripts.get(value(pos))?.operator === op) arg += scripts.get(value(pos++)).char;
        } else if (value(pos) === "_" || value(pos) === "^") {
          const save = pos;
          op = value(pos++);
          const s = value(pos);
          if (s === "{") {
            const group = atom(depth + 1);
            if (group?.inner) arg = group.inner;
          } else if (number(s) || letter(s) || greek.test(s) || named.has(s)) {
            pos++;
            arg = named.has(s) ? "\\mathrm{" + s + "}" : s;
          } else if (s === "*" || s === "∗") {
            pos++;
            arg = "\\ast";
          }
          if (!arg) { pos = save; break; }
        } else break;
        result.tex += op + "{" + arg + "}";
        result.signal = true;
        delete result.inner;
      }
      return result;
    }
    function product(depth) {
      let left = atom(depth);
      if (!left) return null;
      while (pos < end) {
        const save = pos;
        const s = next();
        if (s === "/") {
          pos++;
          const right = atom(depth);
          if (!right) { pos = save; break; }
          left = {tex: "\\frac{" + (left.inner ?? left.tex) + "}{" + (right.inner ?? right.tex) + "}", signal: true};
          continue;
        }
        const gap = pos > save;
        // Implicit products can join adjacent symbols, a coefficient to a variable,
        // or a function to its argument. Never join ordinary adjacent words.
        const adjacent = !gap && (scalar(s) || Object.hasOwn(closeFor, s));
        const spaced = gap && ((left.number && (greek.test(s) || (letter(s) && s !== "a" && s !== "A" && s !== "I"))) ||
          (left.function && scalar(s)) || Object.hasOwn(closeFor, s) ||
          (left.signal && (functions.has(s) || greek.test(s))));
        if (!adjacent && !spaced) { pos = save; break; }
        const right = atom(depth);
        if (!right) { pos = save; break; }
        left = {tex: left.tex + " " + right.tex, signal: left.signal || right.signal ||
          (left.variable && right.grouped) || left.number || left.function, function: right.function};
      }
      return left;
    }
    function expression(depth) {
      let left = product(depth);
      if (!left) return null;
      while (pos < end) {
        const save = pos;
        const s = next();
        if (!operators.has(s) && !relations.has(s)) { pos = save; break; }
        pos++;
        const right = product(depth);
        if (!right) { pos = save; break; }
        left = {tex: left.tex + " " + (operators.get(s) ?? relations.get(s)) + " " + right.tex, signal: true};
      }
      return left;
    }
    const out = expression(0);
    if (!out || pos === start) return null;
    const first = value(start);
    const singleVariable = letter(first) && first !== "A" && first !== "I" && first !== "a" && pos === start + 1;
    return (out.signal || singleVariable) ? {end: pos, tex: out.tex} : null;
  }

  function appendPlain(fragment, source) {
    if (!source) return;
    const tokens = [...source.matchAll(lexeme)].map(m => ({s: m[0], at: m.index}));
    let offset = 0;
    for (let i = 0; i < tokens.length;) {
      const token = tokens[i];
      if (/^\s|^https?:\/\//.test(token.s)) { i++; continue; }
      const result = plainFormula(tokens, i);
      if (!result) { i++; continue; }
      const end = tokens[result.end]?.at ?? source.length;
      const raw = source.slice(token.at, end);
      const node = mathNode(raw, result.tex, false);
      if (node) {
        fragment.append(source.slice(offset, token.at), node);
        offset = end;
      }
      i = result.end;
    }
    fragment.append(source.slice(offset));
  }

  function closing(text, from, delimiter) {
    for (let i = text.indexOf(delimiter, from); i !== -1; i = text.indexOf(delimiter, i + 1)) {
      let slash = i;
      while (slash > 0 && text[slash - 1] === "\\") slash--;
      if ((i - slash) % 2) continue;
      if (delimiter === "$" && (/\s/.test(text[i - 1]) || /\d/.test(text[i + 1] || ""))) continue;
      return i;
    }
    return -1;
  }

  function renderText(node) {
    const source = node.data;
    if (!source.trim()) return;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    const delimiters = /\$\$|\$|\\\(|\\\[|\x60+/g;
    for (let m; (m = delimiters.exec(source));) {
      const open = m[0];
      if (m.index > 0 && source[m.index - 1] === "\\") continue;
      if (open === "$" && /\s/.test(source[delimiters.lastIndex] || "")) continue;
      const code = open.startsWith("\x60");
      const close = open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open;
      const end = closing(source, delimiters.lastIndex, close);
      if (end < 0 || (open === "$" && source.slice(delimiters.lastIndex, end).includes("\n"))) continue;
      const finish = end + close.length;
      const raw = source.slice(m.index, finish);
      appendPlain(fragment, source.slice(offset, m.index));
      const equation = code ? null : mathNode(raw, source.slice(delimiters.lastIndex, end), open === "$$" || open === "\\[");
      fragment.append(equation || raw);
      offset = finish;
      delimiters.lastIndex = finish;
    }
    appendPlain(fragment, source.slice(offset));
    if (fragment.querySelector(".reader-math")) node.replaceWith(fragment);
  }

  function render(root) {
    if (!root || !window.katex) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (!root.parentElement?.closest(ignored)) renderText(root);
      return;
    }
    if (root.nodeType === Node.ELEMENT_NODE && root.closest(ignored)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest(ignored) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(renderText);
  }
  window.READER_MATH = {render};
})();
