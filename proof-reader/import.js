(() => {
  'use strict';

  // The examples describe the named method. Their claims never depend on the imported paper.
  const methods = [
    {
      name: 'Exchange argument', pattern: /交换(?:论证|证明|引理)|\bexchange (?:arguments?|lemmas?|proofs?|steps?|properties|property)\b|\b(?:an? |by )exchange\b|interchange argument/i,
      idea: 'Replace one choice in a feasible solution. Check that the modified solution is still feasible, then check that its objective value is at least as good.',
      label: 'Exchange one interval in a schedule',
      example: 'Method example. A schedule contains intervals A and C. Replacing A with the earlier-finishing B leaves room for C and preserves the number of selected intervals.',
      table: {head: ['Schedule', 'First interval', 'Second interval', 'Count'], rows: [['Original', 'A = [0, 3)', 'C = [3, 4)', '2'], ['After exchange', 'B = [1, 2)', 'C = [3, 4)', '2']]}
    },
    {
      name: 'Induction', pattern: /归纳(?:法|假设|基础|步骤|证明)|\binduction\b|inductive (?:step|hypothesis)/i,
      idea: 'Locate the base case and identify which smaller cases are available in the induction step. In structural induction, those cases correspond to smaller parts of the object.',
      label: 'Trace the step from n to n + 1',
      example: 'Method example. The first n positive odd numbers sum to n². The base case is 1 = 1². If the first n terms sum to n², adding the next odd number gives n² + 2n + 1 = (n + 1)².',
      table: {head: ['n', 'Next odd number', 'Running total'], rows: [['1', '1', '1 = 1²'], ['2', '3', '1 + 3 = 2²'], ['3', '5', '4 + 5 = 3²']]}
    },
    {
      name: 'Proof by contradiction', pattern: /反证法|反设|反证假设|反证可得|by contradiction|(?:suppose|assume)(?:,? for (?:the sake of )?contradiction| to the contrary)|proof by contradiction/i,
      idea: 'Identify the negation of the claim. Follow its consequences until two statements contradict one another, and check which assumptions each consequence uses.',
      label: 'Test a candidate for the largest integer',
      example: 'Method example. Suppose M is the largest integer. Then M + 1 is also an integer and exceeds M. If M were 10, the integer 11 would already refute that candidate. The same argument applies to every M.'
    },
    {
      name: 'Double counting', pattern: /双计数|两种方式计数|double[- ]counting|count(?:ed|ing)? in two ways/i,
      idea: 'Describe the objects both sides count. Check that each count includes every object with the same multiplicity or weight.',
      label: 'Count incidences on a three-vertex path',
      example: 'Method example. In the path A—B—C, count pairs consisting of a vertex and an edge incident to it. Counting by vertex gives 1 + 2 + 1. Counting by edge gives 2 + 2. Both counts give four pairs.',
      table: {head: ['Vertex', 'Incident edges', 'Pairs'], rows: [['A', 'AB', '1'], ['B', 'AB, BC', '2'], ['C', 'BC', '1']]}
    },
    {
      name: 'Pigeonhole principle', pattern: /抽屉原理|鸽巢原理|pigeonhole principle/i,
      idea: 'Identify the objects and their possible categories. When each object belongs to one category and the objects outnumber the categories, two objects must share a category.',
      label: 'Place three integers into two categories',
      example: 'Method example. Place 7, 8 and 9 into categories by parity. There are three integers and two categories, so at least two integers have the same parity.',
      table: {head: ['Integer added', 'Odd', 'Even'], rows: [['7', '7', 'Empty'], ['8', '7', '8'], ['9', '7, 9', '8']]}
    },
    {
      name: 'Greedy choice', pattern: /贪心|貪心|\bgreed(?:y|ily)\b/i,
      idea: 'Write down the rule that selects the next feasible choice. To prove optimality, show that at least one optimal solution can make this choice and still complete the remaining problem optimally.',
      label: 'Trace an earliest-finish greedy choice',
      example: 'Method example. For unweighted interval scheduling, scan intervals in order of finish time and accept each interval compatible with the previous selection. In the instance below, that rule selects two intervals.',
      table: {head: ['Interval', 'Decision', 'Selected so far'], rows: [['A = [1, 2)', 'Accept the first interval', 'A'], ['B = [0, 3)', 'Skip B because it overlaps A', 'A'], ['C = [2, 4)', 'Accept C at the endpoint of A', 'A, C']]}
    }
  ];

  const environment = /^\s*\\begin\{(theorem|lemma|proposition|claim|corollary|proof|definition|example|remark)\*?\}(?:\[([^\]]+)\])?/i;
  const environmentNames = {theorem:'Theorem', lemma:'Lemma', proposition:'Proposition', claim:'Claim', corollary:'Corollary', proof:'Proof', definition:'Definition', example:'Example', remark:'Remark'};
  const compact = (value, limit) => {
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean;
  };

  function heading(line) {
    const md = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    if (md) return {title: md[1], marker: true};
    const tex = line.match(/^\s*\\(?:section|subsection|subsubsection|paragraph|title)\*?\{([^{}]+)\}/);
    if (tex) return {title: tex[1], marker: true};
    const env = line.match(environment);
    if (env) return {title: env[2] || environmentNames[env[1].toLowerCase()], marker: line.trim() === env[0].trim()};
    const numbered = line.match(/^\s*((?:步骤|第\s*[一二三四五六七八九十\d]+\s*步|引理|命题|定理|Step|Lemma|Theorem|Proposition)\s*[\d.]*)(?=[：:\s．.]|$)/i);
    if (numbered) return {title: compact(line, 48), marker: false};
    return null;
  }

  function splitSections(lines) {
    const result = [];
    let first = 0;
    let last = lines.length;
    const documentAt = lines.findIndex(line => /^\s*\\begin\{document\}\s*(?:%.*)?$/.test(line));
    if (documentAt >= 0) first = documentAt + 1;
    const documentEnd = lines.findIndex((line, i) => i >= first && /^\s*\\end\{document\}\s*(?:%.*)?$/.test(line));
    if (documentEnd >= 0) last = documentEnd;

    let start = -1, end = -1, title = '', hasContent = false;
    function flush() {
      if (start >= 0 && hasContent) {
        if (result.length >= 600) throw new Error('This document has more than 600 reading sections. Import one chapter or one proof at a time.');
        result.push({start, end, title, source: lines.slice(start, end + 1).join('\n')});
      }
      start = -1; end = -1; title = ''; hasContent = false;
    }
    for (let i = first; i < last; i++) {
      const line = lines[i];
      if (!line.trim()) {
        if (hasContent) flush();
        continue;
      }
      if (start < 0 && /^\s*(?:%|\\(?:maketitle|tableofcontents)\b|\\end\{)/.test(line)) continue;
      const label = heading(line);
      if (label && hasContent) flush();
      if (start < 0) start = i;
      end = i;
      if (label) title = label.title;
      if (!label?.marker) hasContent = true;
    }
    flush();
    return result;
  }

  function readable(line) {
    return line.replace(/^\s*#{1,6}\s+/, '').replace(environment, '').replace(/\\(?:begin|end|label)\{[^{}]*\}/g, '').replace(/\\(?:section|subsection|paragraph|title)\*?\{([^{}]*)\}/g, '$1').trim();
  }

  const assumption = /假设|设(?:有|定|为|一个|存在|\s)|若|当.+时|只要|对于任意|令|assum(?:e|ing|ption)|suppose|provided that|whenever|for (?:each|every|all)|\bif\b/i;
  const exampleCue = /例如|举例|例子|反例|for (?:example|instance)|counterexample/i;
  function createStep(section, lines, labels) {
    const {start, end, source} = section;
    const method = methods.find(entry => entry.pattern.test(source));
    const location = start === end ? `Line ${start + 1}` : `Lines ${start + 1}–${end + 1}`;
    const excerpts = [];
    for (let i = start; i <= end; i++) {
      const val = lines[i].trim();
      if (val && !val.startsWith('%') && !heading(val)?.marker && readable(val)) excerpts.push({line:i + 1, text:val});
    }
    const first = excerpts[0]?.text || lines[start];
    const title = compact(section.title || readable(first).split(/[。！？]|\.\s/)[0] || 'Passage', 48);
    const options = [];
    if (method) {
      options.push({label: method.label, body: method.example, ...(method.table ? {table: method.table} : {})});
      options.push({label: `Intuition behind ${method.name.toLowerCase()}`, body: method.idea + '\n\nThis is a general reading guide for the method. Compare each step with the wording of this passage.'});
    }
    function addExcerpt(pattern, label, lead) {
      const match = excerpts.find(entry => pattern.test(entry.text));
      if (match) options.push({label, body: `${lead}\n\nLine ${match.line} · ${compact(match.text, 650)}`});
    }
    addExcerpt(exampleCue, 'Locate the example in the text', 'The following line mentions an example or a counterexample.');
    addExcerpt(assumption, 'Locate a condition in this passage', 'The following line contains a possible assumption. Check which cases its wording covers.');
    const ref = source.match(/\\(?:eqref|ref|cref|Cref|autoref)\{([^}]+)\}/);
    if (ref) {
      const key = ref[1].split(',')[0].trim();
      const target = labels.get(key);
      options.push({label:`Find the reference to ${compact(key, 28)}`, body:target ? `Line ${target} defines the label ${key}.\n\n${compact(lines[target - 1], 500)}` : `This passage refers to ${key}. Its label definition is missing from the imported text.`});
    }
    if (!options.length || !method) {
      const tokens = [...new Set(source.match(/\$[^$\n]{1,90}\$|\\\([^\n]{1,90}?\\\)|\b[A-Za-z][A-Za-z0-9_]*\s*(?:<=|>=|≠|≤|≥|=|<|>)\s*[-+\w.]+/g) || [])];
      if (tokens.length) options.push({label:`Inspect the expression ${compact(tokens[0], 24)}`, body:`Expressions from this passage, in order of first appearance.\n\n${tokens.slice(0, 7).join('\n')}`});
      if (!options.length) options.push({label:'Read this passage sentence by sentence', body:(source.match(/[^。！？\n]+[。！？]?/g) || [source]).flatMap(part => part.split(/(?<=[.!?])\s+(?=[A-Z])/)).map(s=>s.trim()).filter(Boolean).join('\n\n')});
    }
    const cue = method && source.match(method.pattern)?.[0];
    const summary = method ? `The passage mentions “${cue}”. ${method.idea}` : 'Read the passage in the author’s words. The local index can highlight explicit conditions, examples, and notation when they appear.';
    return {title, location, source, technique: method?.name || 'Source reading', summary, options};
  }

  window.buildImportedProof = function buildImportedProof(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Paste a proof or choose a file containing its text.');
    if (text.length > 1_000_000) throw new Error('The import limit is one million characters. Choose a single chapter or proof and try again.');
    const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
    const sections = splitSections(lines);
    if (!sections.length) throw new Error('The document has no body text. Add a passage below the heading and try again.');
    const labels = new Map();
    lines.forEach((line, i) => { for (const match of line.matchAll(/\\label\{([^{}]+)\}/g)) if (!labels.has(match[1])) labels.set(match[1], i + 1); });
    const steps = sections.map(section => createStep(section, lines, labels));
    const headingTitle = text.match(/^\s*\\title\s*\{([^{}\n]{1,200})\}/m)?.[1] || text.match(/^\s*#\s+([^\n\r]+)/m)?.[1];
    const title = compact(headingTitle || 'Imported paper', 100);
    return {title, subtitle: 'Local index of passages and proof techniques', techniques:[...new Set(steps.map(step => step.technique).filter(name => name !== 'Source reading'))], steps};
  };
})();
