'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {formulas,printedExpression,boundSignature}=require('./printed-math.cjs');

const asFormula=tex=>formulas('\\('+tex+'\\)')[0];
test('the editor and assigned PDF source compare the same mathematical spelling',()=>{
  const same=[
    ['\\delta_{i}\\leq 2','δᵢ ≤ 2'], ['\\Gamma_{12}\\geq 3','Γ₁₂ ≥ 3'],
    ['\\gamma_2\\leqslant\\theta^2','γ₂ ⩽ θ²'], ['t_{i+1}=s_j','tᵢ₊₁ = sⱼ'],
    ['k^{-2}=n','k⁻² = n'], ['a_{i}=b^{n}','a_i = b^n'],
    ['y\\in\\mathbb{R}','y ∈ ℝ'], ['y\\in\\mathbb R','y ∈ ℝ'],
    ['\\Pi_{k}>0','Πₖ > 0'], ['\\dfrac{a}{s}\\gt 0','\\tfrac{a}{s}>0'],
    ['\\Bigl\\langle x,y\\Bigr\\rangle=0','⟨x,y⟩ = 0'],
    ['\\varphi_{3}\\ne\\phi','φ₃ ≠ ϕ'], ['\\omega\\approx\\Omega','ω ≈ Ω'],
    ['r=\\log_{2}(N)','r = log₂ N'], ['r=\\log_{10}(N)','r = log₁₀ N'],
  ];
  for (const [tex,printed] of same) {
    assert.equal(boundSignature(asFormula(tex)),boundSignature(printed),tex);
    const source='The hypothesis requires '+printed+' for this step.';
    assert.ok(printedExpression(asFormula(tex),[source]),tex);
    assert.ok(printedExpression(asFormula(tex),[source],{start:0,end:source.length}),tex);
  }
});

test('presentation equivalence keeps mathematical glyphs, script groups and positions distinct',()=>{
  const different=[
    ['\\epsilon\\leq 3','ε ≤ 3'], ['\\theta_{i}<4','ϑᵢ < 4'],
    ['\\Delta_k=0','Δₖ ≠ 0'], ['\\Pi_k=1','∏ₖ = 1'], ['\\Sigma_i=0','∑ᵢ = 0'],
    ['x_{12}=3','x_12 = 3'], ['x_{i+1}=3','xᵢ + 1 = 3'],
    ['x_i<y','xⁱ < y'], ['x^{-1}=y','x⁻² = y'], ['x^{n}=2','xₙ = 2'],
    ['k\\in\\mathbb R','k ∈ R'], ['k\\in\\mathbb C','k ∈ ℝ'],
    ['\\delta_{i}\\le2','δᵢ < 2'], ['\\gammafoo=2','γfoo = 2'],
    ['r=\\operatorname{gamma}(Q)','r=γ(Q)'],
    ['\\dfrac{a+1}{s}=2','\\dfrac{a}{s+1}=2'],
    ['\\lceil x\\rceil=1','⌊x⌋ = 1'], ['\\mathbf{x}=1','x = 1'],
    ['t=\\log_{2}(x)','t = log₃ x'], ['t=\\log_{2}(x)^2','t = log₂ x²'],
  ];
  for (const [tex,other] of different) {
    assert.notEqual(boundSignature(asFormula(tex)),boundSignature(other),tex);
    assert.equal(printedExpression(asFormula(tex),['The hypothesis requires '+other+'.']),false,tex);
  }
});

test('text inside math, identifier boundaries and multi-token exponents stay intact',()=>{
  for (const [first,second] of [
    ['q=\\text{red fox}','q=\\text{redfox}'],
    ['q=\\text{the {thin space} case}','q=\\text{the {thinspace} case}'],
    ['q=\\operatorname{cut here}(u)','q=\\operatorname{cuthere}(u)'],
    ['q=mn','q=m n'], ['q=123','q=12 3'], ['q=x^{10}','q=x^10'],
    ['y\\le0','y<0'], ['q=\\varphi','q=\\phi'],
  ]) assert.notEqual(boundSignature(asFormula(first)),boundSignature(asFormula(second)),first);
  assert.equal(printedExpression('q=3',['The label is \\text{skip q=3 here}.']),false);
  assert.equal(boundSignature(asFormula('q=\\text{one  leaf}')),boundSignature(asFormula('q=\\text{one leaf}')));
});

test('source witnesses preserve the boundary between a math operator and its operand',()=>{
  for (const [tex,printed] of [
    ['r=\\ln Q','r = ln Q'],['r=\\ln\\,Q','r = ln Q'],['r=\\ln{Q}','r = ln (Q)'],
    ['r=\\operatorname{ln}(Q)','r = \\ln Q'],['r=\\log_{2} Q','r = log_{2} Q'],
    ['r=\\exp T','r = exp(T)'],['r=\\sin\\left(x\\right)','r = sin x'],
    ['r=\\cos(0.5)','r = cos 0.5'],
  ]) {
    assert.ok(printedExpression(asFormula(tex),['The crossing satisfies '+printed+', as claimed.']),tex+' / '+printed);
  }
  assert.equal(asFormula('r = \\ln Q'),'r=\\ln Q');
  assert.equal(boundSignature(asFormula('r = \\ln Q')),boundSignature(asFormula('r = \\operatorname{ln}(Q)')));
  assert.notEqual(boundSignature(asFormula('r = \\lnQ')),boundSignature(asFormula('r = \\ln Q')));
  assert.equal(boundSignature(asFormula('r \\ne q'),true),boundSignature(asFormula('r=q'),true));
});

test('different functions, operands, scopes and arithmetic continuations cannot certify the requested identity',()=>{
  const requested=asFormula('r=\\ln Q');
  const different=['r < ln Q','r = log Q','r = log₂ Q','r = ln P','r = ln(Q + 1)','r = ln Q + 1',
    'r = ln Q\n− 1','r = ln Q * 3','r = ln Q/2','r = ln Q^2','r = ln Q²','r = ln Q_i','r = ln Q′',
    'r = ln Q(W)','r = ln Q ≥ 0','r = ln Q 12','r = ln Q sin W','r = ln Q \\tan(W)',
    'r = ln Q ∑ x','r = ln Q \\prod_i y_i','r = ln Q ⌈B⌉',
    '12 r = ln Q','p r = ln Q','Q2r = ln Q','far = ln Q','r = ln Q4','r = ln QZ',
    'r = \\lnQ','r = lnQ','r = LN Q','r = \\operatorname{log}(Q)','r = ln_2 Q'];
  for (const printed of different) assert.equal(printedExpression(requested,
    ['The crossing satisfies '+printed+' in this case.']),false,printed);
  assert.equal(printedExpression(requested,['The crossing satisfies r = ln','Q in this case.']),false);
  assert.notEqual(boundSignature(asFormula('r=\\ln(Q)^2')),boundSignature(asFormula('r=\\ln Q^2')));
  assert.notEqual(boundSignature(asFormula('r=\\log_{3}Q')),boundSignature(asFormula('r=\\log_{2}Q')));
  assert.equal(printedExpression(asFormula('r=\\custom Q'),['The crossing satisfies r = custom Q.']),false);
});

test('audit evidence must contain the entire source expression and its delimiters',()=>{
  const equation=asFormula('b=\\exp S');
  const passage='The scale is b = exp S, where the ranges meet.';
  const start=passage.indexOf('b ='),end=passage.indexOf(',');
  assert.ok(printedExpression(equation,[passage],{start,end}));
  assert.equal(printedExpression(equation,[passage],{start,end:end-1}),false);
  assert.equal(printedExpression(equation,[passage.replace(',',' + 7,')],{start,end}),false);
  for (const [open,close] of [['\\(','\\)'],['\\[','\\]'],['$','$'],['$$','$$']]) {
    const raw='The scale is '+open+'b = \\exp S'+close+', where the ranges meet.';
    const at=raw.indexOf(open),finish=raw.indexOf(close,at+open.length)+close.length;
    assert.ok(printedExpression(equation,[raw],{start:at,end:finish}));
    assert.equal(printedExpression(equation,[raw],{start:at,end:finish-1}),false);
    assert.equal(printedExpression(equation,[raw],{start:at+1,end:finish}),false);
  }
});
