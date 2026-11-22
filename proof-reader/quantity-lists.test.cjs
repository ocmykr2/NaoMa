'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {quantityReferences}=require('./quantity-lists.cjs');
const {boundSignature}=require('./printed-math.cjs');

test('a quantity can be extracted only at its stated position and in its stated role',()=>{
  const declaration='The rings \\(H_2,H_5,H_8\\) have angular frequencies \\(q^{-2},q^{-7},q^{-9}\\) in that order.';
  const citation='Follow \\(H_8\\), whose angular frequency is \\(q^{-9}\\).';
  const signature=boundSignature('q^{-9}');
  const check=(source,edited)=>quantityReferences([source],[edited]);
  assert(check(declaration,citation).verified.has(signature));
  assert(check(declaration,citation.replace('H_8','H_{8}')).verified.has(signature));
  const wrong=check(declaration,citation.replace('H_8','H_5'));
  assert.equal(wrong.conflicts.get(signature),'q^{-7}');
  assert.equal(wrong.verified.size,0);
  for (const [source,edited] of [
    [declaration.replace('The rings','If cooling succeeds, the rings'),citation],
    [declaration.replace('The rings','Only some rings'),citation],
    [declaration.replace('in that order',''),citation],
    [declaration.replace('in that order.','in that order?'),citation],
    [declaration.replace('H_2,H_5,H_8','H_2,H_5'),citation],
    [declaration.replace('q^{-2},q^{-7},q^{-9}','(q^{-2},q^{-7},q^{-9})'),citation],
    [declaration.replace('q^{-2},q^{-7},q^{-9}','f(q^{-2},q^{-7},q^{-9})'),citation],
    [declaration.replace('q^{-2},q^{-7},q^{-9}','\\{q^{-2},q^{-7},q^{-9}\\}'),citation],
    [declaration.replace('q^{-2},q^{-7},q^{-9}','q^{-2},q^{-7},v<q^{-9}'),citation],
    [declaration,citation.replace('angular frequency','amplitude')],
    [declaration,citation.replace('q^{-9}', 'v \\le q^{-9}')],
    [declaration,citation.replace('q^{-9}\\).','q^{-9}\\) times the input.')],
    [declaration,citation+' A different estimate also gives \\(q^{-9}\\).'],
    [declaration+' '+declaration.replace('q^{-9}', 'q^{-3}'),citation],
  ]) assert.equal(check(source,edited).verified.size,0,source+' '+edited);
});
