const assert = require('node:assert/strict');
require('./test-support/editorial-fixture.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const test = require('node:test');
const {createPlanHandler} = require('./personalized-plan.cjs');

const endpoint = '/api/reading-plan';
const printed = 'A fixed endpoint is an endpoint that the pairing maps to itself.';
const section = 'Privately drafted paragraph about the pairing and the unique endpoint.';
const wrongQuote = 'Private ungrounded sentence about a different construction.';
const source = 'Private manuscript line about the original experiment.';
const request = {
  title: 'Counting endpoint pairs',
  units: [{title:'Pair construction',text:source + ' ' + printed,page:1}],
  analysis: {
    parts: [{id:'pairing',title:'Count fixed endpoints',summary:'Identify the endpoints left unmatched.',sourceSteps:[1]}],
    localIntroductions: [],
    knowledge: {techniques:[],definitionGroups:[]},
  },
  readerKnowledge: {techniques:[],definitionGroups:[]},
};

function draft(sourceQuote) {
  return {
    id:'pairing',question:'Which endpoint is mapped to itself?',
    orientation:{
      introduction:'Pair the endpoints to find the one that stays fixed.',
      paragraphs:[section],notation:[],handoff:'',statement:null,
      definitions:[{name:'Fixed endpoint',text:printed,intuition:'',sourceStep:1,sourceQuote,dependsOn:[]}],
    },
  };
}

function editorRow(part) {
  const {introduction,paragraphs,handoff} = part.orientation;
  return {
    id:part.id,introduction,paragraphs,handoff,formalAfter:0,referenceNotation:null,
    proseNotationCards:[],notationEvidence:[],definitionCorrections:[],
    sourceCheck:'Checked the endpoint definition against the printed statement.',unresolved:'',
  };
}

async function temporaryCache(t) {
  const root = path.resolve(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root,'reader-plan-diagnostics-'));
  t.after(async () => {
    assert.equal(path.dirname(dir),root);
    assert.ok(path.basename(dir).startsWith('reader-plan-diagnostics-'));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:3});
  });
  return dir;
}

function client(cacheDir, worker, selectWorker) {
  const handle = createPlanHandler({cacheDir,worker,selectWorker,readLocalJson: async req => req.body,checkLocalRequest() {}});
  async function send(method, route, body) {
    let status, value;
    await handle({method,body},{
      writeHead(code) { status = code; },
      end(json) { value = JSON.parse(json); },
    },route);
    assert.ok([200,202].includes(status));
    return value;
  }
  return {
    post: (body=request) => send('POST',endpoint,body),
    diagnostics: key => send('GET',endpoint+'/'+key+'/diagnostics'),
    get: key => send('GET',endpoint+'/'+key),
    async finished(job) {
      const until = Date.now()+10000;
      while (job.status==='running' && Date.now()<until) {
        await delay(15);
        job = await send('GET',endpoint+'/'+job.key);
      }
      assert.notEqual(job.status,'running','the test worker should finish');
      return job;
    },
  };
}

function assertPrivate(report) {
  const json = JSON.stringify(report);
  for (const excerpt of [printed,section,wrongQuote,source]) assert.equal(json.includes(excerpt),false);
}

test('equivalent first-use evidence finishes the ordinary review without sending a revision',async t=>{
  const dir=await temporaryCache(t),body=structuredClone(request);
  const prose='The degree \\(d_{i}\\) counts the neighbors of the chosen vertex.';
  const quote='The  degree \\[d_i\\] counts the neighbors of the chosen vertex.';
  body.units[0].text+=' '+prose;
  const row=draft(printed);
  row.orientation.paragraphs=[prose];
  row.orientation.notation=[{symbol:'\\(d_i\\)',meaning:'The degree of the chosen vertex.'}];
  const calls=[];
  const api=client(dir,async({outputPath})=>{
    const file=path.basename(outputPath);calls.push(file);
    const parts=file==='plan.json'?[row]:[{...editorRow(row),notationEvidence:[quote]}];
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  });
  const ready=await api.finished(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(calls,['plan.json','edited.json']);
  assert.deepEqual(ready.parts[0].orientation.paragraphs,[prose]);
  assert.equal((await api.diagnostics(ready.key)).retryCount,0);
});

test('plan drafting and editorial review use the provider selected at submission',async t=>{
  const cacheDir=await temporaryCache(t);
  let provider='claude';
  const outputs=[];
  const claude=async ({directory,outputPath})=>{
    const name=path.basename(outputPath);
    outputs.push(name);
    provider='codex';
    const parts=name==='edited.json'
      ? JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8')).parts.map(editorRow)
      : [draft(printed)];
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  };
  const codex=()=>assert.fail('Unexpected Codex call');
  const api=client(cacheDir,codex,async req=>{
    assert.equal(req.method,'POST');
    return {provider,worker:provider==='claude'?claude:codex};
  });
  const plan=await api.finished(await api.post());
  assert.equal(plan.status,'ready',plan.message);
  assert.deepEqual(outputs,['plan.json','edited.json']);
  assert.equal((await api.post()).status,'ready');
});

test('a repeated change of strict inequality recovers from inline PDF text only with the complete source expression',async t=>{
  const printedLine='The calibration threshold satisfies ln 8 > 1 because eight exceeds Euler’s number.';
  const longerLine='The stronger requirement ln 8 > 10 would need a different calibration.';
  const body={title:'Calibrate a logarithmic scale',units:[{title:'Threshold',page:1,text:longerLine+' '+printedLine}],
    analysis:{parts:[{id:'calibrate',title:'Compare the threshold',sourceSteps:[1],summary:'Compare the logarithm with one.'}],
      localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
  const sound=String.raw`The scale crosses its unit mark because \(\ln 8>1\).`;
  const wrong=sound.replace('8>1','8=1');
  const draftRow={id:'calibrate',question:'Why does the reading exceed one?',orientation:{
    introduction:'The unit mark corresponds to Euler’s number on the original scale.',
    paragraphs:[sound],notation:[],definitions:[],handoff:'',statement:null}};
  const incomplete='The stronger requirement ln 8 > 1';
  for(const citations of [[printedLine],[incomplete,printedLine],[incomplete,incomplete]]){
    const dir=await temporaryCache(t);
    let drafts=0,audits=0;
    const worker=async({directory,schemaPath,outputPath,prompt})=>{
      let row;
      if(path.basename(outputPath)==='plan.json'){drafts++;row=draftRow;}
      else {
        assert.equal(path.basename(outputPath),'edited.json');
        const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
        if(schema.properties.parts.items.required.includes('originalBound')){
          audits++;
          const {alternatives}=JSON.parse(prompt.split('Section and prior validation finding (data): ').at(-1).split('\n')[0]);
          assert.equal(alternatives.length,1);
          row={id:draftRow.id,supported:true,sourceStep:1,originalBound:alternatives[0],sourceQuote:citations[audits-1],
            sourceCheck:'The original strict inequality follows by monotonicity of the natural logarithm.',
            unresolved:'',formalAfter:0,notationEvidence:[]};
        } else {
          const {parts}=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
          row={...editorRow(parts[0]),paragraphs:[wrong]};
        }
      }
      await fs.writeFile(outputPath,JSON.stringify({parts:[row]}));
    };
    const api=client(dir,worker);
    const job=await api.finished(await api.post(body));
    assert.equal(drafts,1);
    assert.equal(audits,citations.length,'retry only a malformed supporting citation');
    if(citations.at(-1)===printedLine){
      assert.equal(job.status,'ready',job.message);
      assert.deepEqual(job.parts[0].orientation.paragraphs,[sound]);
      const cold=client(dir,()=>assert.fail('reopening used a worker'));
      const reopened=await cold.get(job.key);
      assert.deepEqual(reopened.parts,job.parts);
      const trace=await cold.diagnostics(job.key);
      const actions=trace.events.map(event=>event.action).filter(Boolean);
      assert.ok(actions.includes('verify-bound'));
      assert.ok(actions.indexOf('restore-grounded-draft')>actions.indexOf('verify-bound'));
      for(const content of ['calibration threshold','unit mark','8>1','8=1']) assert.ok(!JSON.stringify(trace).includes(content));
    }else{
      assert.equal(job.status,'error','a prefix of 10 cannot attest a bound of 1');
      assert.equal(job.parts,undefined);
    }
  }
});

test('a definition source rejection is diagnosable after restart and a successful retry retains its history',async t => {
  const dir = await temporaryCache(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0, repaired = false;
  const worker = async ({directory,outputPath}) => {
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    }
    const name = path.basename(outputPath);
    let parts;
    if (name === 'plan.json') parts = [draft(repaired ? printed : wrongQuote)];
    else if (name === 'definition-recovery.json') parts = [{id:'pairing',definitions:[]}];
    else {
      assert.equal(name,'edited.json');
      const input = JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
      parts = input.parts.map(editorRow);
    }
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  };
  const first = client(dir,worker);
  const job = await first.post();
  await entered.promise;
  try {
    const running = await first.diagnostics(job.key);
    assert.equal(running.status,'running');
    assert.equal(running.attempt,1);
    assert.equal(calls,1);
    assertPrivate(running);
  } finally {
    release.resolve();
  }

  const failure = await first.finished(job);
  assert.equal(failure.status,'error');
  assert.match(failure.message,/fixed endpoint/i);
  const countAtFailure = calls;
  const afterRestart = client(dir,worker);
  const failed = await afterRestart.diagnostics(job.key);
  assert.equal(failed.version,1);
  assert.equal(failed.key,job.key);
  assert.equal(failed.status,'error');
  assert.equal(failed.attempt,1);
  assert.equal(failed.historyAvailable,true);
  assert.deepEqual(failed.progress.blockedParts,[1]);
  assert.equal(failed.progress.draftedParts,1);
  assert.equal(failed.progress.completedParts,0);
  assert.ok(failed.events.some(row => row.event==='check-failed' && row.attempt===1 && row.part===1 &&
    row.field==='definitions.0.sourceQuote' && row.check==='source-quote' && row.code==='source-quote-not-found'));
  const dedicated = failed.events.find(row => row.event==='retry' && row.action==='find-defining-passage');
  assert.equal(dedicated?.attempt,1);
  assert.equal(dedicated.part,1);
  assert.ok(failed.events.some(row => row.event==='failed' && row.sequence>dedicated.sequence));
  const again = await afterRestart.diagnostics(job.key);
  assert.deepEqual(again.events,failed.events);
  assert.equal(calls,countAtFailure,'reading diagnostics must not start a job');
  assertPrivate(failed);

  repaired = true;
  const ready = await afterRestart.finished(await afterRestart.post());
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(ready.parts[0].orientation.definitions[0].text,printed);
  const countAtReady = calls;
  const cold = client(dir,worker);
  const final = await cold.diagnostics(job.key);
  assert.equal(final.status,'ready');
  assert.equal(final.attempt,2);
  assert.equal(final.historyAvailable,true);
  assert.ok(final.events.some(row => row.attempt===2));
  assert.ok(final.events.some(row => row.attempt===1 && row.code==='source-quote-not-found'));
  assert.deepEqual((await cold.get(job.key)).parts,ready.parts);
  assert.equal((await cold.post()).status,'ready');
  assert.deepEqual((await cold.diagnostics(job.key)).events,final.events,'a cache hit must not add an attempt');
  assert.equal(calls,countAtReady);
  assertPrivate(final);

  // A previously published plan can predate diagnostic recording.
  await fs.unlink(path.join(dir,job.key+'.diagnostics'));
  const historical = client(dir,worker);
  const legacy = await historical.diagnostics(job.key);
  assert.equal(legacy.status,'ready');
  assert.equal(legacy.historyAvailable,false);
  assert.deepEqual(legacy.events,[]);
  assert.equal((await historical.get(job.key)).status,'ready');
  assert.equal(calls,countAtReady);
});

test('one preparation request finds a defining passage on an earlier page after the ordinary correction fails',async t => {
  const body = structuredClone(request);
  body.analysis.parts.unshift({id:'setup',title:'Introduce the pairing',summary:'Pair each point with its image.',sourceSteps:[1]});
  body.analysis.parts[1].sourceSteps=[2];
  body.units.push({title:'Count the survivors',text:'Only the fixed endpoints remain after pairing.',page:2});
  const setup = draft(printed);
  setup.id='setup';
  setup.orientation.definitions=[];
  setup.orientation.paragraphs=['Each point has a unique image under the pairing.'];
  const invalid = draft(wrongQuote);
  invalid.orientation.definitions[0].sourceStep=2;
  const calls=[];
  const api = client(await temporaryCache(t),async ({directory,outputPath}) => {
    const name = path.basename(outputPath);
    calls.push(name);
    let parts;
    if (calls.length===1) {
      assert.equal(name,'plan.json');
      parts=[setup,invalid];
    } else if (name==='plan.json') {
      const rows=JSON.parse(await fs.readFile(path.join(directory,'drafts.json'),'utf8'));
      assert.deepEqual(rows.map(row=>row.id),['pairing'],'a source correction should not redraft the other section');
      parts=[invalid];
    } else if (name==='definition-recovery.json') {
      const input=JSON.parse(await fs.readFile(path.join(directory,'definition-recovery-input.json'),'utf8'));
      assert.deepEqual(input.targets.map(t=>t.id),['pairing']);
      assert.ok(input.sources.some(unit=>unit.step===1 && unit.text.includes(printed)));
      parts=[{id:'pairing',definitions:draft(printed).orientation.definitions}];
    } else {
      assert.equal(name,'edited.json');
      const input = JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
      parts = input.parts.map(editorRow);
    }
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  });
  const ready = await api.finished(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(ready.parts[0].orientation.paragraphs,setup.orientation.paragraphs);
  assert.equal(ready.parts[1].orientation.definitions[0].text,printed);
  assert.deepEqual(calls,['plan.json','plan.json','definition-recovery.json','edited.json']);
  const report=await api.diagnostics(ready.key);
  assert.equal(report.status,'ready');
  assert.equal(report.attempt,1);
  assert.ok(report.events.some(row=>row.event==='retry' && row.action==='find-defining-passage' && row.part===2));
  assertPrivate(report);
});

test('unknown and malformed plan diagnostic keys cannot start work or read a different file',async t => {
  const dir = await temporaryCache(t);
  const api = client(dir,() => assert.fail('a diagnostics request started a worker'));
  const unknown = 'a'.repeat(64);
  await assert.rejects(api.diagnostics(unknown),error => error.status===404);
  for (const key of ['../'+unknown,unknown+'/extra','not-a-key']) {
    await assert.rejects(api.diagnostics(key),error => [400,404,405].includes(error.status));
  }
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('one submitted plan keeps its key, accepted notation edition and siblings while recovering an incomplete batch',async t=>{
  const dir=await temporaryCache(t);
  const body=structuredClone(request);
  body.analysis.parts.push({...body.analysis.parts[0],id:'result'});
  const originalSymbol='Write x for the unique fixed endpoint.',referenceSymbol='Write y for the unique fixed endpoint.';
  body.units[0].text+=' '+originalSymbol;
  body.notationReference={title:'The reader’s notation source',units:[{text:referenceSymbol}]};
  const calls=[],entered=Promise.withResolvers(),release=Promise.withResolvers();
  let failed=false;
  const api=client(dir,async({directory,prompt,outputPath})=>{
    const name=path.basename(outputPath);calls.push(name);
    let reply;
    if(name==='notation-map.json')reply={mappings:[{original:'x',preferred:'y',concept:'the unique fixed endpoint',
      partIds:['pairing','result'],sourceStep:1,sourceQuote:originalSymbol,referenceStep:1,referenceQuote:referenceSymbol}],retained:[]};
    else if(name==='notation-rewrite-0.json')reply={overview:{paragraphs:['The pairing preserves its fixed endpoints.'],
      suggestions:[{question:'Which endpoint is fixed?',step:1}]},mappingIssue:'',
      parts:body.analysis.parts.map(p=>({id:p.id,title:p.title,reading:'The unique fixed endpoint is \\(y\\).',sourceStep:1,sourceQuote:printed}))};
    else if(name==='plan.json'){
      const ids=JSON.parse(await fs.readFile(path.join(directory,'batch.json'),'utf8')).parts.map(p=>p.id);
      if(!failed){failed=true;reply={parts:[]};}
      else {
        assert.equal(ids.length,1);
        assert.ok(prompt.includes('prior validation finding'));
        assert.ok(prompt.includes(body.notationReference.title));
        entered.resolve();await release.promise;
        reply={parts:ids.map(id=>({...draft(printed),id}))};
      }
    }else{
      assert.equal(name,'edited.json');
      const editor=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
      reply={parts:editor.parts.map(editorRow)};
    }
    await fs.writeFile(outputPath,JSON.stringify(reply));
  });
  const submitted=await api.post(body);
  await entered.promise;
  try{
    const during=await api.get(submitted.key);
    assert.equal(during.status,'running');
    assert.deepEqual(during.progress.recovery,{attempt:1,reason:'invalid-output',action:'split-batch'});
    assert.ok(!during.parts);
    assert.equal((await api.post(body)).key,submitted.key);
  }finally{release.resolve();}
  const ready=await api.finished(submitted);
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(ready.parts.map(p=>p.id),['pairing','result']);
  assert.equal(ready.notationEdition.referenceTitle,body.notationReference.title);
  assert.equal(ready.notationEdition.mappings[0].referenceQuote,referenceSymbol);
  assert.ok(ready.notationEdition.parts.every(p=>p.reading.includes('\\(y\\)')));
  assert.deepEqual(calls,['notation-map.json','notation-rewrite-0.json','plan.json','plan.json','edited.json','plan.json','edited.json']);
  const trace=await api.diagnostics(submitted.key);
  assert.equal(trace.attempt,1);
  assert.ok(trace.events.some(e=>e.event==='retry' && e.code==='invalid-output' && e.action==='split-batch'));
  assert.ok(!trace.events.some(e=>e.event==='failed'));
});

test('authentication and quota require action immediately, while a transient disconnect recovers under the same job',async t=>{
  for(const code of ['login','quota','network']){
    const dir=await temporaryCache(t);
    let calls=0,checks=0;
    const api=client(dir,async({directory,outputPath})=>{
      const name=path.basename(outputPath);
      if(name==='plan.json'){
        calls++;
        if(code!=='network' || calls<=2)throw Object.assign(Error('Worker unavailable.'),{workerCode:code});
        return fs.writeFile(outputPath,JSON.stringify({parts:[draft(printed)]}));
      }
      checks++;
      const input=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
      await fs.writeFile(outputPath,JSON.stringify({parts:input.parts.map(editorRow)}));
    });
    const complete=await api.finished(await api.post());
    if(code==='network'){
      assert.equal(complete.status,'ready',complete.message);assert.equal(calls,3);assert.equal(checks,1);
    }else{
      assert.equal(complete.status,'error');assert.equal(complete.needsAction,true);
      assert.equal(complete.actionRequired,code==='quota'?'quota':'sign-in');assert.equal(calls,1);assert.equal(checks,0);
    }
  }
});

test('an unexpected worker exception stays visible at its real stage without spending a recovery attempt',async t=>{
  const dir=await temporaryCache(t);let calls=0;
  const body=structuredClone(request);body.analysis.parts.push({...body.analysis.parts[0],id:'second'});
  const api=client(dir,async()=>{calls++;throw new TypeError('Private invariant failure: nonnumeric timeout setting');});
  const stopped=await api.finished(await api.post(body));
  assert.equal(calls,1);assert.equal(stopped.status,'error');assert.equal(stopped.unexpected,true);
  assert.equal(stopped.needsAction,false);assert.equal(stopped.failureStage,'drafting');
  assert.equal(stopped.failureCode,'unexpected-failure');assert.match(stopped.message,/Couldn’t/u);
  assert.ok(!JSON.stringify(stopped).includes('Private invariant'));
  const trace=await api.diagnostics(stopped.key);
  assert.equal(trace.events.at(-1).stage,'drafting');assert.equal(trace.events.at(-1).code,'unexpected-failure');
  assert.ok(!trace.events.some(e=>e.event==='retry'));
  let reruns=0;
  const cold=client(dir,async({outputPath,directory})=>{
    reruns++;
    const rows=path.basename(outputPath)==='plan.json'?
      body.analysis.parts.map(p=>({...draft(printed),id:p.id})):
      JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8')).parts.map(editorRow);
    await fs.writeFile(outputPath,JSON.stringify({parts:rows}));
  });
  const restored=await cold.get(stopped.key);
  assert.equal(restored.unexpected,true);assert.equal(restored.failureStage,'drafting');assert.equal(restored.key,stopped.key);
  assert.equal(reruns,0);assert.ok(!JSON.stringify(restored).includes('nonnumeric'));
  const afterFix=await cold.finished(await cold.post(body));
  assert.equal(afterFix.status,'ready',afterFix.message);assert.equal(afterFix.key,stopped.key);
  assert.equal(afterFix.parts.length,2);
});

test('one preparation repairs an ungrounded notation rewrite and preserves the good sibling and reference map',async t=>{
  const dir=await temporaryCache(t),body=structuredClone(request),scopes=[];
  body.analysis.parts.push({...body.analysis.parts[0],id:'later'});
  body.notationReference={title:'Another pairing convention',units:[{text:printed}]};
  let comparisons=0;
  const api=client(dir,async({directory,prompt,outputPath})=>{
    const name=path.basename(outputPath);
    let data;
    if(name==='notation-map.json'){comparisons++;data={mappings:[],retained:[]};}
    else if(name.startsWith('notation-rewrite-')){
      const assigned=JSON.parse(prompt.match(/Assigned parts \(data\): ([^\n]+)/u)[1]);
      scopes.push(assigned.map(p=>p.id));
      if(scopes.length>1){
        assert.equal(assigned.length,1);assert.equal(assigned[0].id,'later');
        assert.ok(prompt.includes(wrongQuote));assert.ok(prompt.includes('sourceQuote'));
      }
      data={mappingIssue:'',overview:scopes.length===1?{paragraphs:['The pairing fixes one endpoint.'],suggestions:[{question:'Which endpoint stays fixed?',step:1}]}:null,
        parts:assigned.map(p=>({id:p.id,title:p.title,reading:'Count the endpoints left fixed by the pairing.',
          sourceStep:1,sourceQuote:scopes.length===1 && p.id==='later'?wrongQuote:printed}))};
    }else if(name==='plan.json'){
      data={parts:body.analysis.parts.map(p=>({...draft(printed),id:p.id}))};
    }else{
      const input=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
      data={parts:input.parts.map(editorRow)};
    }
    await fs.writeFile(outputPath,JSON.stringify(data));
  });
  const ready=await api.finished(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(comparisons,1);assert.deepEqual(scopes,[['pairing','later'],['later']]);
  assert.ok(ready.notationEdition.parts.every(p=>p.sourceQuote===printed));
});

test('the notation map reports a rejected reference passage in the live and persisted diagnostics',async t=>{
  const dir=await temporaryCache(t),body=structuredClone(request);
  const sourceDefinition='Write x for the unique fixed endpoint.';
  const referenceDefinition='Let y denote the unique fixed endpoint.';
  const missing='This passage describes a completely different object.';
  body.units[0].text+=' '+sourceDefinition;
  body.notationReference={title:'A second convention',units:[{title:'Endpoint notation',text:referenceDefinition}]};
  const api=client(dir,async({outputPath})=>{
    if (path.basename(outputPath)==='notation-map.json') {
      await fs.writeFile(outputPath,JSON.stringify({mappings:[{concept:'the unique fixed endpoint',original:'x',preferred:'y',
        partIds:['pairing'],sourceStep:1,sourceQuote:sourceDefinition,referenceStep:1,referenceQuote:missing}],retained:[]}));
      return;
    }
    throw Error('The Codex account reached a usage limit.');
  });
  const job=await api.finished(await api.post(body));
  assert.equal(job.status,'error');
  const live=await api.diagnostics(job.key);
  const finding=live.events.find(row=>row.code==='notation-reference-locator');
  assert.ok(finding,'expected the failed reference locator to be recorded before recovery');
  assert.equal(finding.event,'check-failed');assert.equal(finding.stage,'adapting-notation');
  assert.equal(finding.check,'notation');assert.equal(finding.field,'mappings.0.referenceQuote');
  const cold=await client(dir,()=>assert.fail('diagnostics started a worker')).diagnostics(job.key);
  assert.deepEqual(cold.events,live.events);
  for (const excerpt of [missing,sourceDefinition,referenceDefinition]) assert.equal(JSON.stringify(cold).includes(excerpt),false);
});

test('older unpublished checkpoints expose counts without exposing manuscript content or starting a worker',async t=>{
  const dir=await temporaryCache(t),key='e'.repeat(64);
  const {planCheckpoints}=require('./plan-checkpoints.cjs');
  await planCheckpoints(dir,key,100000).save(new Map([
    ['notation-edition',{parts:Array.from({length:7},()=>({reading:'private background'}))}],
    [0,{drafts:[{id:'private section'},{id:'another private section'}]}],
  ]));
  const api=client(dir,()=>assert.fail('reading the checkpoint started a worker'));
  const report=await api.diagnostics(key);
  assert.equal(report.status,'saved');
  assert.equal(report.historyAvailable,false);
  assert.equal(report.progress.draftedParts,2);
  assert.equal(report.progress.completedParts,0);
  assert.equal(report.progress.totalParts,7);
  assert.deepEqual(report.events,[]);
  assert.equal(JSON.stringify(report).includes('private'),false);
});

test('an older rejected bound with a saved candidate can resume once under the new source check',async t=>{
  const dir=await temporaryCache(t);
  const {planCheckpoints}=require('./plan-checkpoints.cjs');
  const {planDiagnostics}=require('./plan-diagnostics.cjs');
  const {readingPlanKey}=require('./personalized-plan.cjs');
  const key=await readingPlanKey(request), history=planCheckpoints(dir,key,100000);
  const log=planDiagnostics(dir,key);
  const failed={event:'failed',code:'editorial-rejected',stage:'revising-draft',firstPart:1,lastPart:1,totalParts:1};
  const proposed={...draft(printed),title:request.analysis.parts[0].title,sourceSteps:[1],opening:section},partId=proposed.id;
  const reason='Editorial review changed a mathematical bound without a matching source expression (h=\\logN). Restore the grounded expression or its source-supported derivation.';
  const rows=new Map([[0,{grounded:[proposed],reviewed:[],editNotes:[{id:partId,reason,proposal:editorRow(proposed)}]}]]);
  const api=client(dir,()=>assert.fail('a read-only check or stale submission started generation'));
  await log.record(failed);
  await assert.rejects(api.get(key),{status:404});
  await history.save(rows);
  const offer=await api.get(key);
  assert.equal(offer.actionRequired,'review');assert.equal(offer.resumeReview,key+'/1');
  assert.ok(!JSON.stringify(offer).includes('logN'));
  await log.record({...failed,code:'quota'});
  await assert.rejects(api.get(key),{status:404});
  await log.record({...failed,boundCheckVersion:2});
  assert.equal((await api.get(key)).actionRequired,'review');
  await log.record({...failed,boundCheckVersion:3});
  assert.equal((await api.get(key)).actionRequired,'review');
  await log.record({...failed,boundCheckVersion:4});
  const exhausted=await api.get(key);
  assert.equal(exhausted.status,'error');assert.equal(exhausted.resumeReview,undefined);
  const stale=await api.post({...request,resumeReview:offer.resumeReview});
  assert.equal(stale.status,'error');assert.equal(stale.resumeReview,undefined);
  await log.record(failed);
  const available=await api.get(key);
  assert.notEqual(available.resumeReview,offer.resumeReview);
  // A second client still holding the first offer sees the latest state
  // without starting a second review.
  assert.deepEqual(await api.post({...request,resumeReview:offer.resumeReview}),available);
  const fixed=client(dir,()=>assert.fail('a valid saved candidate should pass replay without another model call'));
  const submissions=await Promise.all([1,2].map(()=>fixed.post({...request,resumeReview:available.resumeReview})));
  const ready=await fixed.finished(submissions[0]);
  assert.equal(ready.status,'ready',ready.message);assert.equal(ready.key,key);
  assert.equal((await fixed.post({...request,resumeReview:available.resumeReview})).status,'ready');
  assert.equal((await fixed.diagnostics(key)).events.filter(e=>e.event==='resumed').length,1);
});

test('recovery locates a rejected part inside its saved batch and leaves accepted siblings alone',async t=>{
  const dir=await temporaryCache(t),key='b'.repeat(64);
  const {planCheckpoints}=require('./plan-checkpoints.cjs');
  const {planDiagnostics}=require('./plan-diagnostics.cjs');
  const history=planCheckpoints(dir,key,100000),log=planDiagnostics(dir,key);
  const api=client(dir,()=>assert.fail('checking the saved status invoked a worker'));
  const earlier={id:'first'}, rejected={id:'second'};
  const note={id:rejected.id,proposal:{id:rejected.id},reason:
    'Editorial review changed a mathematical bound without a matching source expression (d=2). Restore the grounded expression or its source-supported derivation.'};
  const row={grounded:[earlier,rejected],reviewed:[earlier],editNotes:[note]};
  await history.save(new Map([[3,row]]));
  const failed={event:'failed',code:'editorial-rejected',stage:'revising-draft',boundCheckVersion:2,firstPart:5,lastPart:5,totalParts:8};
  await log.record(failed);
  assert.equal((await api.get(key)).resumeReview,key+'/1');
  await log.record({...failed,firstPart:4,lastPart:4});
  await assert.rejects(api.get(key),{status:404});
  await log.record(failed);
  await history.save(new Map([[3,{...row,editNotes:[{...note,reason:'Editorial review returned incomplete sections.'}]}]]));
  await assert.rejects(api.get(key),{status:404});
});

test('only a locally resolved first-use spelling failure can reopen an older paused notation review',async t=>{
  const dir=await temporaryCache(t);
  const {planCheckpoints}=require('./plan-checkpoints.cjs');
  const {planDiagnostics}=require('./plan-diagnostics.cjs');
  const {readingPlanKey}=require('./personalized-plan.cjs');
  const key=await readingPlanKey(request),history=planCheckpoints(dir,key,100000);
  const log=planDiagnostics(dir,key),part=draft(printed);
  const clause='The vertex degree \\(d_{i}\\) counts its neighbors.';
  part.orientation.paragraphs=[clause];
  part.orientation.notation=[{symbol:'\\(d_i\\)',meaning:'The degree of the chosen vertex.'}];
  const proposal=editorRow(part);
  const note={id:part.id,reason:'Editorial review of first-use notation: Quote exact prose from a first-use clause that actually names the mathematical object, including the delimited symbol.',proposal};
  const save=()=>history.save(new Map([[0,{grounded:[part],editNotes:[note]}]]));
  await log.record({event:'failed',code:'editorial-rejected',stage:'revising-notation',boundCheckVersion:3,firstPart:1,lastPart:1,totalParts:1});
  const api=client(dir,()=>assert.fail('Checking a saved status invoked a worker'));
  proposal.notationEvidence=[clause.replace('{i}','j')];await save();
  await assert.rejects(api.get(key),{status:404});
  proposal.notationEvidence=[clause.replace('{i}','i')];await save();
  assert.equal((await api.get(key)).resumeReview,key+'/1');
});

test('finishing a verified section restores recovery capacity for a later independent failure',async t=>{
  const dir=await temporaryCache(t),body=structuredClone(request);
  body.analysis.parts.push({...body.analysis.parts[0],id:'second'});
  const {readingPlanKey}=require('./personalized-plan.cjs');
  const {planCheckpoints}=require('./plan-checkpoints.cjs');
  const key=await readingPlanKey(body);
  // Resume one attempt below the consecutive limit for a two-part plan.
  await planCheckpoints(dir,key,100000).save(new Map([
    ['draft-width',1],['recovery-state',{attempts:8,consecutiveAttempts:8,tried:[],networkProbes:[]}],
  ]));
  const calls=new Map();
  const api=client(dir,async({directory,outputPath})=>{
    let parts;
    if(path.basename(outputPath)==='plan.json') {
      const assigned=JSON.parse(await fs.readFile(path.join(directory,'batch.json'),'utf8')).parts;
      assert.equal(assigned.length,1);
      const {id}=assigned[0],count=calls.get(id) || 0;
      calls.set(id,count+1);
      parts=count?[{...draft(printed),id}]:[];
    } else {
      assert.equal(path.basename(outputPath),'edited.json');
      const assigned=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8')).parts;
      parts=assigned.map(editorRow);
    }
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  });
  const ready=await api.finished(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(ready.parts.map(p=>p.id),['pairing','second']);
  assert.deepEqual([...calls],[['pairing',2],['second',2]]);
});
