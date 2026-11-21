const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {compileFormalization,verifyFormalization,findLean,createLeanResolver} = require('./lean-verifier.cjs');

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

test('concurrent checks provision one runtime, recheck the installed compiler, and repair an incomplete installation',async()=>{
  let healthyInstall=false,installs=0;
  const seen=[];
  const resolver=createLeanResolver({supported:true,discover:async()=>[{exe:'managed',pinned:true}],
    healthy:async candidate=>{seen.push(candidate);return healthyInstall;},
    install:async()=>{installs++;healthyInstall=true;return 'managed';}});
  const first=await Promise.all([resolver(),resolver(),resolver()]);
  assert.deepEqual(first,[{exe:'managed'},{exe:'managed'},{exe:'managed'}]);
  assert.equal(installs,1);assert.deepEqual(seen,[{exe:'managed',pinned:true},{exe:'managed',pinned:true}]);
  assert.deepEqual(await resolver(),{exe:'managed'});assert.equal(installs,1);
  healthyInstall=false;
  assert.deepEqual(await resolver(),{exe:'managed'});assert.equal(installs,2);
});

test('a failed runtime acquisition backs off, recognizes a manual repair and never provisions an explicit override',async()=>{
  let now=100,installs=0,manual=false;
  const resolver=createLeanResolver({supported:true,now:()=>now,discover:async override=>!override && manual?[{exe:'local'}]:[],
    healthy:async()=>true,install:async()=>{installs++;throw Object.assign(Error('The official release could not be downloaded.'),{code:'LEAN_INSTALL_UNAVAILABLE'});}});
  assert.match((await resolver(undefined,false)).detail,/No working/);
  assert.match((await resolver('/configured')).detail,/configured/);
  assert.equal(installs,0);
  assert.match((await resolver()).detail,/could not be downloaded/);
  assert.match((await resolver()).detail,/could not be downloaded/);
  assert.equal(installs,1);
  manual=true;assert.deepEqual(await resolver(),{exe:'local'});
  manual=false;now+=60001;assert.match((await resolver()).detail,/could not be downloaded/);assert.equal(installs,2);
});

test('the bundled runtime takes precedence, and failed health checks cannot produce a working path',async()=>{
  const probes=[];
  const usable=createLeanResolver({supported:true,discover:async()=>[{exe:'bundle',pinned:true},{exe:'system'}],
    healthy:async({exe})=>{probes.push(exe);return true;},install:async()=>assert.fail('no download expected')});
  assert.deepEqual(await usable(),{exe:'bundle'});assert.deepEqual(probes,['bundle']);
  const failed=createLeanResolver({supported:true,discover:async()=>[],install:async()=>'bad',healthy:async()=>false});
  assert.match((await failed()).detail,/did not pass/);
  const unsupported=createLeanResolver({supported:false,discover:async()=>[],install:async()=>assert.fail('platform unavailable')});
  assert.match((await unsupported()).detail,/this platform/);
  const bug=createLeanResolver({supported:true,discover:async()=>[],install:async()=>{throw new TypeError('unexpected defect');}});
  await assert.rejects(()=>bug(),/unexpected defect/);
});

test('sequential parts reuse a successful probe until files change, an actual check fails or the lease expires',async()=>{
  let now=100,fingerprint='compiler-and-library-stamp',probes=0;
  const resolver=createLeanResolver({now:()=>now,supported:false,discover:async()=>[{exe:'bundle',pinned:true,fingerprint}],
    healthy:async()=>{probes++;return true;}});
  for (let i=0;i<25;i++) assert.deepEqual(await resolver(),{exe:'bundle'});
  assert.equal(probes,1);
  resolver.invalidate('another-checker');await resolver();assert.equal(probes,1);
  fingerprint='repaired-library';await resolver();assert.equal(probes,2);
  resolver.invalidate('bundle');await resolver();assert.equal(probes,3);
  now+=5*60000;await resolver();assert.equal(probes,4);
});

test('installed Lean checks the intended deduction and independently rejects a false sibling',async t=>{
  const executable=await findLean();
  if (!executable) return t.skip('No local Lean 4 runtime is available for the compiler integration test.');
  const goals=[
    counting,
    {...counting,conclusion:'machines < overlap'},
    {variables:[],hypotheses:[],conclusion:'((6 : Rat) / 5) * 5 = (6 : Rat)',tactic:'decide'},
    {variables:[{name:'P',type:'Prop'},{name:'Q',type:'Prop'}],hypotheses:[{name:'base',expression:'P'},{name:'step',expression:'P -> Q'}],conclusion:'Q',tactic:'auto'},
  ];
  const results=await Promise.all(goals.map(g=>verifyFormalization(g,{executable})));
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
