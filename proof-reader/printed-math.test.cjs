'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {formulas,printedExpression,boundSignature}=require('./printed-math.cjs');

const asFormula=tex=>formulas('\\('+tex+'\\)')[0];
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
