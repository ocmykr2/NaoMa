const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {compileFormalization,verifyFormalization,findLean} = require('./lean-verifier.cjs');

const counting = {
  variables:[{name:'machines',type:'Nat'},{name:'overlap',type:'Nat'}],
  hypotheses:[{name:'onePerMachine',expression:'overlap <= machines'}],
  conclusion:'2 * machines + 1 - overlap > 2 * machines - overlap',tactic:'omega',
};

test('compiles only declared variables, bounded formulas and fixed tactics',async()=>{
  const source=compileFormalization(counting);
  assert.match(source,/«onePerMachine» : \(«overlap» ≤ «machines»\)/);
  assert.match(source,/#print axioms readingPart/);
  for (const change of [
    {conclusion:'free = free'}, {conclusion:'True\nTrue'}, {conclusion:'(1 : Unknown) = 1'},
    {conclusion:'f(2) = 3'},{tactic:'custom'},{source:'plain text'},
    {variables:[{name:'x)',type:'Nat'}]}, {variables:[{name:'x',type:'Custom'}]},
    {hypotheses:[{name:'machines',expression:'True'}]}, {conclusion:'1'.repeat(200)},
  ]) {
    const result=await verifyFormalization({...counting,...change});
    assert.equal(result.status,'unsupported');
    assert.equal(result.source,'');
  }
  const missing=await verifyFormalization(counting,{executable:path.join(os.tmpdir(),'missing-proof-reader-runtime','lean')});
  assert.equal(missing.status,'unavailable');
  assert.equal(missing.version,'');
  assert.equal(missing.digest,undefined);
});

test('literal types, implication and logical operator precedence are preserved',()=>{
  const source=compileFormalization({variables:[{name:'h',type:'Rat'},{name:'P',type:'Prop'}],
    hypotheses:[],conclusion:'not h < (3 : Rat) / 2 and P -> h >= 0',tactic:'auto'});
  assert.ok(source.includes('(((¬ («h» < ((3 : Rat) / 2))) ∧ «P») → («h» ≥ 0))'));
});

test('installed Lean checks the intended deduction and independently rejects a false sibling',async t=>{
  if (!await findLean()) return t.skip('Install the local Lean 4 runtime for the compiler integration test.');
  const goals=[
    counting,
    {...counting,conclusion:'machines < overlap'},
    {variables:[],hypotheses:[],conclusion:'((6 : Rat) / 5) * 5 = (6 : Rat)',tactic:'decide'},
    {variables:[{name:'P',type:'Prop'},{name:'Q',type:'Prop'}],hypotheses:[{name:'base',expression:'P'},{name:'step',expression:'P -> Q'}],conclusion:'Q',tactic:'auto'},
  ];
  const results=await Promise.all(goals.map(g=>verifyFormalization(g)));
  assert.deepEqual(results.map(r=>r.status),['verified','unproved','verified','verified'],JSON.stringify(results.map(r=>[r.status,r.detail])));
  for (const i of [0,2,3]) {
    const r=results[i];
    assert.match(r.version,/Lean \(version 4\./);
    assert.match(r.digest,/^[a-f0-9]{64}$/);
    assert.ok(!r.axioms.includes('sorryAx'));
    assert.equal(r.source,compileFormalization(goals[i]));
  }
  assert.equal(results[1].digest,undefined);
});
