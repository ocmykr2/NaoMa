'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {planDiagnostics} = require('./plan-diagnostics.cjs');
const key = 'd'.repeat(64);
async function temporaryCache(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'proof-reader-diagnostics-'));
  t.after(async () => {
    assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('proof-reader-diagnostics-'));
    await fs.rm(directory,{recursive:true,force:true});
  });
  return directory;
}

test('a persisted failure can be traced to a single field, and the next attempt records a separate recovery',async t=>{
  const cache=await temporaryCache(t), writer=planDiagnostics(cache,key);
  assert.equal(await writer.read(),null);
  const privateValue='PRIVATE PDF quotation with name@example.org';
  const inputs=[
    {event:'started',totalParts:7,account:privateValue},
    {event:'stage',stage:'checking',firstPart:2,lastPart:5,completedParts:0},
    {event:'check-failed',check:'source',code:'source-quote-unrelated',part:3,
      field:'orientation.definitions.1.sourceQuote',page:2,sourceStep:5,sourceQuote:privateValue,stderr:privateValue},
    {event:'retry',action:'verify-page',part:3},
    {event:'failed',check:'definition',code:'source-page-unverified',field:privateValue,stage:privateValue,message:privateValue}
  ];
  // report() is synchronous so the caller can queue several writes while a
  // stage advances. The terminal await must also wait for earlier writes.
  for (const input of inputs) writer.record(input);
  const failed=await writer.read();
  assert.equal(failed.status,'error');
  assert.equal(failed.attempt,1);
  assert.equal(failed.retryCount,1);
  assert.deepEqual(failed.events.map(e=>e.sequence),[1,2,3,4,5]);
  const issue=failed.events[2];
  assert.equal(issue.field,inputs[2].field);
  assert.equal(issue.code,'source-quote-unrelated');
  assert.deepEqual([issue.part,issue.page,issue.sourceStep],[3,2,5]);
  assert.equal(failed.events[1].completedParts,0);
  const contents=await fs.readFile(path.join(cache,key+'.diagnostics'),'utf8');
  assert.equal(contents.includes(privateValue),false,'raw messages, unsupported fields and enum values must never reach disk');
  const cold=planDiagnostics(cache,key);
  assert.deepEqual(await cold.read(),failed);
  await cold.record({event:'resumed',action:'resume-checkpoint',completedParts:4});
  await cold.record({event:'checked',check:'source',code:'source-page-verified',part:3});
  await cold.record({event:'ready',completedParts:7,action:'save-result'});
  const ready=await planDiagnostics(cache,key).read();
  assert.equal(ready.status,'ready');
  assert.equal(ready.attempt,2);
  assert.equal(ready.retryCount,0);
  assert.equal(ready.events.at(-1).sequence,8);
  assert.equal(ready.events[5].attempt,2);
  assert.equal(ready.events[5].retryCount,0);
  assert.deepEqual(await fs.readdir(cache),[key+'.diagnostics']);
});

test('history is bounded and keeps monotonic event numbers after pruning',async t=>{
  const cache=await temporaryCache(t),log=planDiagnostics(cache,key);
  for (let part=1; part<=110; part++) log.record({event:'checked',check:'checkpoint',part,completedParts:part});
  const saved=await log.read();
  assert.deepEqual([saved.events.length,saved.events[0].sequence,saved.events.at(-1).sequence],[96,15,110]);
  assert.equal(saved.events[0].part,15);
  const cold=planDiagnostics(cache,key);
  await cold.record({event:'failed',check:'worker',code:'empty'});
  const next=await cold.read();
  assert.equal(next.events.length,96);
  assert.equal(next.events.at(-1).sequence,111);
  assert.equal(next.status,'error');
});

test('notation diagnostics identify the failing correspondence and keep both papers private',async t=>{
  const cache=await temporaryCache(t),log=planDiagnostics(cache,key);
  const privateQuote='Private source and reference words';
  for (const [field,code,action] of [
    ['retained.0.sourceStep','notation-source-locator','revise-notation'],
    ['mappings.12.referenceQuote','notation-reference-locator','revise-notation'],
    ['mappings.3.preferred','notation-map-conflict',undefined],
    ['mappings','notation-map-invalid','revise-notation'],
    ['mappings.3.'+privateQuote,privateQuote,privateQuote],
  ]) await log.record({event:'check-failed',stage:'adapting-notation',check:'notation',field,code,action,
    original:privateQuote,preferred:privateQuote,referenceQuote:privateQuote,sourceQuote:privateQuote});
  const {events}=await planDiagnostics(cache,key).read();
  assert.deepEqual(events.slice(0,4).map(row=>[row.field,row.code,row.action]),[
    ['retained.0.sourceStep','notation-source-locator','revise-notation'],
    ['mappings.12.referenceQuote','notation-reference-locator','revise-notation'],
    ['mappings.3.preferred','notation-map-conflict',undefined],
    ['mappings','notation-map-invalid','revise-notation'],
  ]);
  for (const name of ['field','code','action']) assert.equal(Object.hasOwn(events[4],name),false);
  assert.equal((await fs.readFile(path.join(cache,key+'.diagnostics'),'utf8')).includes(privateQuote),false);
});

test('a cold report distinguishes a source failure from sections waiting on it',async t=>{
  const dir=await temporaryCache(t),log=planDiagnostics(dir,key);
  await log.record({event:'deferred',part:2,totalParts:3,check:'dependency',code:'prerequisite-pending',action:'wait-for-prerequisite'});
  await log.record({event:'failed',stage:'checking',totalParts:3,completedParts:1,draftedParts:2,
    blockedParts:[1],waitingParts:[2,2,0,'private excerpt',4]});
  const {events}=await planDiagnostics(dir,key).read();
  assert.equal(events[0].code,'prerequisite-pending');
  assert.equal(events[0].action,'wait-for-prerequisite');
  assert.equal(events[1].draftedParts,2);
  assert.deepEqual(events[1].blockedParts,[1]);
  assert.deepEqual(events[1].waitingParts,[2]);
});

test('malformed traces and unavailable diagnostic storage cannot prevent preparation',async t=>{
  const cache=await temporaryCache(t),filename=path.join(cache,key+'.diagnostics'),log=planDiagnostics(cache,key);
  const invalid=planDiagnostics(cache,'../'+key);
  await invalid.record({event:'started'});
  assert.equal(await invalid.read(),null);
  await log.record({event:'private unrecognized text',field:'none'});
  assert.deepEqual(await fs.readdir(cache),[]);
  await fs.writeFile(filename,'truncated JSON');
  assert.equal(await log.read(),null);
  await log.record({event:'started'});
  const stored=JSON.parse(await fs.readFile(filename,'utf8'));
  stored.events[0].prompt='private text';
  stored.events[0].code='private text';
  stored.message='private text';
  await fs.writeFile(filename,JSON.stringify(stored));
  assert.equal(JSON.stringify(await log.read()).includes('private text'),false);
  await fs.writeFile(filename,' '.repeat(128*1024+1));
  assert.equal(await log.read(),null);
  const unavailable=planDiagnostics(filename,key); // Cache directory is actually a file.
  await unavailable.record({event:'failed',code:'storage-error'});
  assert.equal(await unavailable.read(),null);
});
