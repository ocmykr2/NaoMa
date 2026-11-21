const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {Readable} = require('node:stream');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {setTimeout: delay} = require('node:timers/promises');
const test = require('node:test');
const {createPaperAgentHandler,runCodexWorker,runPlanWorker} = require('./paper-agent.cjs');

const route = '/api/techniques';
const passage = {title: 'Counting endpoints', text: 'Counting each edge at its two ends gives a total degree of twice the number of edges.'};
const paper = {units: [passage]};

function complete(displayTitle) {
  return {
    analysisStatus: 'analyzed', displayTitle,
    overview: {
      paragraphs: ['The proof counts the endpoints in a finite graph.', 'Grouping the same endpoints by edge or vertex gives the degree sum.'],
      suggestions: [{question: 'What is being counted?', step: 1}, {question: 'Why does each edge contribute twice?', step: 1}],
    },
    papers: [], skills: [], reason: 'The proof uses ordinary double counting.',
    knowledge: {techniques: [], definitionGroups: []},
    parts: [{id: 'count-ends', title: 'Count edge ends twice', summary: 'Count the same ends by edge and by vertex.',
      sourceSteps: [1], techniqueIds: [], definitionGroupIds: [], localPrerequisiteIds: []}],
    localIntroductions: [],
  };
}

async function cacheFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proof-reader-preparation-test-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

// A worker tool may inherit Codex's stderr. Keep the helper alive until the test
// releases it, independently of the actual worker's successful exit or timeout.
for (const ending of ['success','failure','timeout']) {
  test('a helper retaining stderr cannot stall worker '+ending,async t=>{
    const dir=await cacheFor(t),release=path.join(dir,'release');
    const helper=[
      "const fs=require('node:fs'), path=require('node:path'), dir=process.argv[1];",
      "const max=Date.now()+15000;",
      "const tick=setInterval(()=>{",
      "  if(!fs.existsSync(dir) || fs.existsSync(path.join(dir,'release')) || Date.now()>max) clearInterval(tick);",
      "},20);"
    ].join('\n');
    const worker=[
      "const helper="+JSON.stringify(helper)+";",
      "require('node:child_process').spawn(process.execPath,['-e',helper,process.cwd()],{",
      "  cwd:require('node:os').tmpdir(),stdio:['ignore','ignore',2],windowsHide:true,detached:true",
      "}).unref();",
      {success:"require('node:fs').writeFileSync('output','{}');",
        failure:"process.stderr.write('429 Too Many Requests'); process.exitCode=1;",
        timeout:"setInterval(()=>{},1000);"}[ending]
    ].join('\n');
    let exited;
    const result=runCodexWorker({directory:dir,outputPath:path.join(dir,'output'),schemaPath:'unused',prompt:'',timeoutMs:ending==='timeout'?1500:10000},
      (_name,_args,options)=>{
        const child=spawn(process.execPath,['-e',worker],options);
        exited=once(child,'exit');
        return child;
      }).then(()=>({done:true}),e=>({error:e.message}));
    const controller=new AbortController();
    try {
      await exited;
      const outcome=await Promise.race([result,delay(1200,{stillPending:true},{signal:controller.signal})]);
      assert.ok(!outcome.stillPending,'still waiting for an unrelated process to close its inherited pipe');
      if(ending==='success') {
        assert.ok(outcome.done);
        assert.equal(await fs.readFile(path.join(dir,'output'),'utf8'),'{}');
      } else assert.match(outcome.error,ending==='timeout'?/timed out/:/usage limit/);
    } finally {
      controller.abort();
      await fs.writeFile(release,'');
      await result;
    }
  });
}

test('reading-plan retries share their deadline and discard partial worker output',async t=>{
  const directory=await cacheFor(t),outputPath=path.join(directory,'result.json');
  const job={directory,outputPath,schemaPath:'unused',prompt:'use the same input',timeoutMs:5000};
  const transientScripts=[
    '', // A clean exit without --output-last-message, as observed during preparation.
    'process.exitCode=1;',
    "require('node:fs').writeFileSync(process.argv[1],'{'); process.stderr.write('stream disconnected'); process.exitCode=1;",
  ];
  for (const script of transientScripts) {
    await fs.rm(outputPath,{force:true});
    const seen=[];
    await runPlanWorker(job,async current=>{
      seen.push(current);
      if (seen.length===2) await assert.rejects(()=>fs.stat(outputPath),{code:'ENOENT'});
      const body=seen.length===1?script:"require('node:fs').writeFileSync(process.argv[1],'{}');";
      await runCodexWorker(current,(_bin,_args,options)=>spawn(process.execPath,['-e',body,outputPath],options));
    },()=>1000+seen.length*1250);
    assert.deepEqual(seen.map(c=>c.timeoutMs),[5000,3750]);
    assert.deepEqual(seen.map(c=>c.prompt),[job.prompt,job.prompt]);
    assert.equal(await fs.readFile(outputPath,'utf8'),'{}');
  }
});

test('reading-plan workers stop at terminal diagnostics, the second failure, or the original deadline',async t=>{
  const directory=await cacheFor(t),outputPath=path.join(directory,'missing');
  const job={directory,outputPath,schemaPath:'unused',prompt:'',timeoutMs:5000};
  const cases=[
    ['401 Unauthorized',1,'login',1],
    ['429 Too Many Requests',0,'quota',1],
    ['model refusal',1,'refused',1],
    ['invalid_request_error',1,'configuration',1],
    ['stream disconnected',1,'network',2],
    ['',1,'exit',2],
    ['',0,'empty',2],
    ['stream disconnected',1,'timeout',1,5000],
  ];
  for (const [diagnostic,exitCode,workerCode,expected,elapsed=20] of cases) {
    let calls=0;
    await assert.rejects(()=>runPlanWorker(job,current=>{
      calls++;
      const body='process.stderr.write(process.argv[1]);process.exitCode=Number(process.argv[2]);';
      return runCodexWorker(current,(_bin,_args,options)=>spawn(process.execPath,['-e',body,diagnostic,String(exitCode)],options));
    },()=>calls*elapsed),{workerCode});
    assert.equal(calls,expected,diagnostic || workerCode);
  }
});

async function request(handle, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]);
  Object.assign(req, {method, headers: {host: 'localhost:1234', 'content-type': 'application/json'}, socket: {localPort: 1234}});
  let response;
  await handle(req, {setHeader() {}, writeHead() {}, end(body) {response = JSON.parse(body);}}, url);
  return response;
}

async function finish(handle, data) {
  const submission = await request(handle, 'POST', route, data);
  if (submission.status !== 'running') return submission;
  for (let i = 0; i < 200; i++) {
    const progress = await request(handle, 'GET', route + '/' + submission.key);
    if (progress.status !== 'running') return progress;
    await delay(10);
  }
  throw new Error('The injected local worker did not finish.');
}

test('preparation sees the original opening, excludes the filename, and persists the prepared title', async t => {
  const dir = await cacheFor(t);
  const displayTitle = 'The Degree Sum in Finite Graphs';
  const sourceOpening = '\\documentclass{article}\n\\title{' + displayTitle + '}';
  const calls = [];
  const handle = createPaperAgentHandler({cacheDir: dir, runner: async ({directory, prompt, outputPath, schemaPath}) => {
    calls.push({source: JSON.parse(await fs.readFile(path.join(directory, 'paper.json'), 'utf8')), prompt});
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
    assert(schema.required.includes('displayTitle'));
    assert(schema.required.includes('parts'));
    assert(schema.required.includes('localIntroductions'));
    await fs.writeFile(outputPath, JSON.stringify(complete(displayTitle)));
  }});
  const label = 'Private filename for group B (19).tex';
  const result = await finish(handle, {...paper, sourceOpening, title: label});
  assert.equal(result.status, 'ready');
  assert.equal(result.displayTitle, displayTitle);
  assert.equal(result.preparationVersion, 2);
  assert.deepEqual(calls[0].source, {...paper, sourceOpening});
  assert(calls[0].prompt.includes(displayTitle));
  assert(!calls[0].prompt.includes(label));

  const renamed = await finish(handle, {...paper, sourceOpening, title: 'A different file label'});
  assert.deepEqual(renamed, result);
  assert.equal(calls.length, 1);
  const restarted = createPaperAgentHandler({cacheDir: dir, runner: () => assert.fail('No additional worker expected')});
  assert.deepEqual(await request(restarted, 'GET', route + '/' + result.key), result);
});

test('analysis pins its provider through a retry and reports a Claude login failure without exposing raw diagnostics', async t=>{
  const cacheDir=await cacheFor(t);
  let provider='claude',calls=0;
  const workers={
    claude:async ({outputPath})=>{
      calls++;
      if (calls===1) {
        provider='codex';
        throw Object.assign(Error('temporary connection failure'),{workerCode:'network'});
      }
      if (calls===2) return fs.writeFile(outputPath,JSON.stringify(complete('Degree Sums')));
      throw Object.assign(Error('private source excerpt'),{workerCode:'login'});
    },
    codex:()=>assert.fail('Unexpected Codex call'),
  };
  const handle=createPaperAgentHandler({cacheDir,selectWorker:async()=>({provider,worker:workers[provider]})});
  const first=await finish(handle,paper);
  assert.equal(first.status,'ready');
  assert.deepEqual(await finish(handle,paper),first);
  assert.equal(calls,2);
  provider='claude';
  const blocked=await finish(handle,{...paper,sourceOpening:'A second count.'});
  assert.equal(blocked.actionRequired,'sign-in');
  assert.match(blocked.message,/Claude/);
  assert.doesNotMatch(blocked.message,/private source|Codex/);
});

test('an untitled excerpt can receive an English descriptive title without any upload label', async t => {
  const dir = await cacheFor(t);
  const title = 'Counting the Two Ends of an Edge';
  const handle = createPaperAgentHandler({cacheDir: dir, runner: async ({prompt, outputPath}) => {
    assert(prompt.includes(passage.text));
    await fs.writeFile(outputPath, JSON.stringify(complete(title)));
  }});
  const prepared = await finish(handle, paper);
  assert.equal(prepared.displayTitle, title);
  assert.equal(prepared.preparationVersion, 2);
});

test('invalid titles and incomplete fresh preparations do not become ready', async t => {
  const dir = await cacheFor(t);
  const cases = [
    ['missing title', {displayTitle: undefined}], ['upload name', {displayTitle: 'scan (4).pdf'}],
    ['generic label', {displayTitle: 'Untitled paper'}], ['multiline', {displayTitle: 'The degree\nsum'}],
    ['untranslated title', {displayTitle: '图的度数和'}], ['missing overview', {overview: undefined}],
    ['missing knowledge', {knowledge: undefined}], ['missing plan', {parts: undefined}],
    ['empty plan', {parts: []}], ['missing local items', {localIntroductions: undefined}],
    ['unreadable source', {analysisStatus: 'source-unavailable'}],
  ];
  for (const [name, changes] of cases) {
    const handle = createPaperAgentHandler({cacheDir: dir, runner: async ({outputPath}) => {
      await fs.writeFile(outputPath, JSON.stringify({...complete('Degree Sums'), ...changes}));
    }});
    const result = await finish(handle, {...paper, sourceOpening: name});
    assert.equal(result.status, 'error', name);
    assert.equal(result.preparationVersion, undefined, name);
  }
});

test('historical results remain available and incomplete versioned caches are repaired by resubmission', async t => {
  const dir = await cacheFor(t);
  let runs = 0;
  const handle = createPaperAgentHandler({cacheDir: dir, runner: async ({outputPath}) => {
    runs++;
    await fs.writeFile(outputPath, JSON.stringify(complete('Degree Sums')));
  }});
  const oldKey = 'a'.repeat(64);
  await fs.writeFile(path.join(dir, oldKey + '.json'), JSON.stringify({key: oldKey, unitCount: 1, result: {
    papers: [], skills: [], reason: 'Earlier cached analysis.',
  }}));
  const old = await request(handle, 'GET', route + '/' + oldKey);
  assert.equal(old.status, 'ready');
  assert.equal(old.displayTitle, undefined);
  assert.equal(old.preparationVersion, undefined);

  const laterOldKey = 'b'.repeat(64);
  const earlierAnalysis = complete(undefined);
  await fs.writeFile(path.join(dir, laterOldKey + '.json'), JSON.stringify({
    key: laterOldKey, unitCount: 1, knowledgeVersion: 1, result: earlierAnalysis,
  }));
  const oldOverview = await request(handle, 'GET', route + '/' + laterOldKey);
  assert.deepEqual(oldOverview.overview, earlierAnalysis.overview);
  assert.deepEqual(oldOverview.knowledge, earlierAnalysis.knowledge);
  assert.equal(oldOverview.preparationVersion, undefined);

  const v1Key = 'c'.repeat(64);
  const versionOne = {...complete('Historical Degree Sums'), preparationVersion: 1};
  delete versionOne.parts;
  delete versionOne.localIntroductions;
  await fs.writeFile(path.join(dir, v1Key + '.json'), JSON.stringify({key: v1Key, unitCount: 1, result: versionOne}));
  const versionOneReady = await request(handle, 'GET', route + '/' + v1Key);
  assert.equal(versionOneReady.preparationVersion, 1);
  assert.equal(versionOneReady.displayTitle, versionOne.displayTitle);
  assert.equal(versionOneReady.parts, undefined);

  const prepared = await finish(handle, paper);
  const filename = path.join(dir, prepared.key + '.json');
  const cache = JSON.parse(await fs.readFile(filename, 'utf8'));
  cache.result.parts = [];
  await fs.writeFile(filename, JSON.stringify(cache));
  assert.match((await request(handle, 'GET', route + '/' + prepared.key)).error, /not found/);
  assert.deepEqual(await finish(handle, paper), prepared);
  assert.equal(runs, 2);
  await fs.writeFile(filename, JSON.stringify({key: prepared.key, unitCount: 1, result: versionOne}));
  assert.deepEqual(await finish(handle, paper), prepared);
  assert.equal(runs, 3);
});

const markedGraph = {units: [
  {title: 'Page 1', page: 1, text: 'Mark a subset of edges in a finite graph. Define the charge of a vertex as its degree plus its marked incidence count. Counting the extra charge'},
  {title: 'Page 2', page: 2, text: 'over all vertices counts each marked edge twice (extra-charge lemma). This implies the total charge equals twice the number of edges plus twice the number of marked edges.'},
]};

function markedGraphResult() {
  const result = complete('Counting Marked Incidences');
  result.knowledge = {
    techniques: [{id: 'double-counting', name: 'Double counting', mechanism: 'Count marked ends by vertex and by edge.',
      steps: [1, 2], knownBridge: 'Check that each marked edge still supplies two ends.', folklore: true, sources: []}],
    definitionGroups: [{id: 'degree', title: 'Vertex degree', steps: [1],
      definitions: [{term: 'Vertex degree', meaning: 'The number of edge ends incident to the vertex.'}]}],
  };
  result.parts = [
    {id: 'assign-charge', title: 'Assign a charge to each vertex', summary: 'Add an extra unit for each marked edge end.',
      sourceSteps: [1], techniqueIds: [], definitionGroupIds: ['degree'], localPrerequisiteIds: []},
    {id: 'extra-charge', title: 'Count the extra charge', summary: 'Counting by marked edge proves the extra-charge lemma.',
      sourceSteps: [1, 2], techniqueIds: ['double-counting'], definitionGroupIds: [], localPrerequisiteIds: ['vertex-charge']},
    {id: 'sum-charges', title: 'Recover the total charge', summary: 'Add the ordinary degree sum to the extra charge given by the lemma.',
      sourceSteps: [2], techniqueIds: [], definitionGroupIds: [], localPrerequisiteIds: ['vertex-charge', 'extra-charge-lemma']},
  ];
  result.localIntroductions = [
    {id: 'vertex-charge', kind: 'definition', title: 'Vertex charge', meaning: 'Vertex degree plus the number of incident marked edge ends.', originPartId: 'assign-charge'},
    {id: 'extra-charge-lemma', kind: 'lemma', title: 'Extra-charge lemma', meaning: 'With the stated charge assignment, the total excess over degree equals twice the marked edge count.', originPartId: 'extra-charge'},
  ];
  return result;
}

test('logical parts may share and span units, with local introductions scoped to later uses', async t => {
  const cacheDir = await cacheFor(t);
  const analyzed = markedGraphResult();
  const handle = createPaperAgentHandler({cacheDir, runner: async ({outputPath}) => fs.writeFile(outputPath, JSON.stringify(analyzed))});
  const prepared = await finish(handle, markedGraph);
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(prepared.parts, analyzed.parts);
  assert.deepEqual(prepared.localIntroductions, analyzed.localIntroductions);
  assert.deepEqual(prepared.knowledge, analyzed.knowledge);
  const reloaded = createPaperAgentHandler({cacheDir, runner: () => assert.fail('Already prepared')});
  assert.deepEqual(await request(reloaded, 'GET', route + '/' + prepared.key), prepared);
});

test('a rejected analysis is repaired against its original source and links before publishing', async t => {
  const cacheDir = await cacheFor(t), good = markedGraphResult(), draft = structuredClone(good);
  draft.parts[0].localPrerequisiteIds.push('extra-charge-lemma');
  draft.parts[1].techniqueIds = [];
  let calls = 0;
  const handle = createPaperAgentHandler({cacheDir, runner: async ({directory,outputPath,prompt}) => {
    if (++calls === 1) return fs.writeFile(outputPath,JSON.stringify(draft));
    assert.equal(calls,2);
    assert.match(prompt,/parts\[0\]\.localPrerequisiteIds\[0\].*strictly earlier/);
    assert.match(prompt,/double-counting has no part linking it to source steps 1, 2/);
    assert.ok(prompt.includes(markedGraph.units[0].text));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'previous-analysis.json'),'utf8')),draft);
    await assert.rejects(fs.stat(outputPath),{code:'ENOENT'});
    await fs.writeFile(outputPath,JSON.stringify(good));
  }});
  const ready = await finish(handle,markedGraph);
  assert.equal(ready.status,'ready');
  assert.deepEqual(ready.parts,good.parts);
  assert.deepEqual(await request(handle,'GET',route+'/'+ready.key),ready);
  assert.equal(calls,2);
});

test('an analysis that stays invalid through focused repair reports its field and is never cached', async t => {
  const cacheDir = await cacheFor(t), draft = markedGraphResult();
  draft.parts[0].localPrerequisiteIds.push('extra-charge-lemma');
  let calls = 0;
  const handle = createPaperAgentHandler({cacheDir, runner: async ({outputPath}) => {
    calls++;
    await fs.writeFile(outputPath,JSON.stringify(draft));
  }});
  const failed = await finish(handle,markedGraph);
  assert.equal(failed.status,'error');
  assert.match(failed.message,/parts\[0\]\.localPrerequisiteIds\[0\].*strictly earlier/);
  assert.equal(calls,3);assert.equal(failed.actionRequired,'review');
  await assert.rejects(fs.stat(path.join(cacheDir,failed.key+'.json')),{code:'ENOENT'});
});

test('one analysis submission repairs just the reading graph when a whole-document revision repeats its mistake',async t=>{
  const cacheDir=await cacheFor(t),good=markedGraphResult(),malformed=structuredClone(good);
  malformed.parts[0].localPrerequisiteIds.push('extra-charge-lemma');
  let calls=0;
  const handle=createPaperAgentHandler({cacheDir,runner:async ({outputPath,schemaPath,prompt})=>{
    if (++calls<=2) return fs.writeFile(outputPath,JSON.stringify(malformed));
    const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
    assert.deepEqual(schema.required,['parts']);
    assert.match(prompt,/strictly earlier/);
    return fs.writeFile(outputPath,JSON.stringify({parts:good.parts}));
  }});
  const ready=await finish(handle,markedGraph);
  assert.equal(ready.status,'ready');assert.deepEqual(ready.parts,good.parts);
  assert.equal(ready.displayTitle,good.displayTitle);assert.equal(calls,3);
});

test('an unexpected overview failure is surfaced as a bug without rerunning the worker',async t=>{
  const cacheDir=await cacheFor(t);
  let calls=0;
  const handle=createPaperAgentHandler({cacheDir,runner:async()=>{
    calls++;throw Error('Unexpected private fixture detail');
  }});
  const state=await finish(handle,markedGraph);
  assert.equal(calls,1);assert.equal(state.unexpected,true);assert.equal(state.failureStage,'analysis');
  assert.equal(state.failureCode,'unexpected-failure');assert.match(state.message,/Couldn’t/);
  assert.doesNotMatch(state.message,/private fixture/);
  const fixed=createPaperAgentHandler({cacheDir,runner:async({outputPath})=>fs.writeFile(outputPath,JSON.stringify(markedGraphResult()))});
  assert.deepEqual(await request(fixed,'GET',route+'/'+state.key),state);
  assert.equal((await finish(fixed,markedGraph)).status,'ready');
  await assert.rejects(fs.stat(path.join(cacheDir,state.key+'.fault')),{code:'ENOENT'});
});

test('each part dependency resolves to a genuine earlier origin or a catalog item used in that passage', async t => {
  const cacheDir = await cacheFor(t);
  const mutations = [
    ['future local', r => r.parts[0].localPrerequisiteIds.push('extra-charge-lemma')],
    ['same-part local', r => r.parts[1].localPrerequisiteIds.push('extra-charge-lemma')],
    ['missing local', r => r.parts[2].localPrerequisiteIds.push('not-proved')],
    ['bad origin', r => {r.localIntroductions[0].originPartId = 'unknown-part';}],
    ['duplicate local ID', r => {r.localIntroductions[1].id = 'vertex-charge';}],
    ['duplicate part ID', r => {r.parts[2].id = 'extra-charge';}],
    ['bad local kind', r => {r.localIntroductions[0].kind = 'paper';}],
    ['local definition also on global checklist', r => {r.knowledge.definitionGroups[0].definitions.push({term: 'Vertex charge', meaning: 'The charge assignment constructed in the paper.'});}],
    ['a page number used as the mathematical part title', r => {r.parts[1].title = 'Page 1';}],
    ['empty source', r => {r.parts[1].sourceSteps = [];}],
    ['out-of-bounds source', r => {r.parts[1].sourceSteps = [3];}],
    ['unordered source', r => {r.parts[1].sourceSteps = [2, 1];}],
    ['duplicate source', r => {r.parts[1].sourceSteps = [1, 1];}],
    ['missing technique', r => r.parts[1].techniqueIds.push('unknown-method')],
    ['unlinked checklist item', r => {r.parts[1].techniqueIds = [];}],
    ['unused in this passage', r => r.parts[2].definitionGroupIds.push('degree')],
    ['duplicate prerequisite', r => r.parts[1].localPrerequisiteIds.push('vertex-charge')],
  ];
  for (const [name, mutate] of mutations) {
    const analyzed = markedGraphResult();
    mutate(analyzed);
    const handle = createPaperAgentHandler({cacheDir, runner: async ({outputPath}) => fs.writeFile(outputPath, JSON.stringify(analyzed))});
    const response = await finish(handle, {...markedGraph, sourceOpening: name});
    assert.equal(response.status, 'error', name);
    assert.equal(response.preparationVersion, undefined, name);
  }
});

const schedulingSource = {units: [
  {title: 'Page 1', page: 1, text: [
    'Priority and dispatch eligibility.',
    'A unit-speed machine receives jobs at their release times. It runs one job at a time and may preempt it. Each job has a processing time and a deadline.',
    'A job gets a dispatch mark of two if it was interrupted after receiving more than half its work, and zero otherwise.',
    'Dispatch eligibility requires a maximal mark among released unfinished jobs. Break ties by earliest deadline.',
  ].join('\n')},
  {title: 'Page 2', page: 2, text: [
    'Deadline and packing witnesses.',
    'Call a pair consisting of a set of jobs and an interval a packing witness if every release and deadline lies in the interval and total required processing exceeds its length.',
    'A packing witness certifies infeasibility for every policy. All the required work must occur within that interval.',
    'The unit-speed machine can supply at most the interval length there. This argument does not use dispatch marks.',
  ].join('\n')},
]};

function schedulingResult() {
  const parts = [
    {id:'job-model', title:'Set up the scheduling model', summary:'The machine supplies one unit of work per time unit.',
      sourceSteps:[1], sourceAnchors:[{step:1,phrase:'It runs one job at a time and may preempt it.'}],
      techniqueIds:[], definitionGroupIds:['model'], localPrerequisiteIds:[]},
    {id:'dispatch', title:'Determine which jobs can be dispatched', summary:'Mark a job according to its interrupted service, then compare marks before deadlines.',
      sourceSteps:[1], sourceAnchors:[{step:1,phrase:'Break ties by earliest deadline.'}],
      techniqueIds:[], definitionGroupIds:['model'], localPrerequisiteIds:[]},
    {id:'witness', title:'Define the interval certificate', summary:'Contain each entire job window and compare its demand to the available time.',
      sourceSteps:[2], sourceAnchors:[{step:2,phrase:'a packing witness if every release and deadline lies in the interval'}],
      techniqueIds:[], definitionGroupIds:['model'], localPrerequisiteIds:[]},
    {id:'capacity', title:'Prove the certificate rules out every schedule', summary:'Compare the required work to the amount the machine can deliver.',
      sourceSteps:[2], sourceAnchors:[{step:2,phrase:'The unit-speed machine can supply at most the interval length there.'}],
      techniqueIds:['capacity-bound'], definitionGroupIds:['model'], localPrerequisiteIds:['packing-witness']},
  ];
  const localIntroductions = [
    {id:'dispatch-eligibility',kind:'definition',title:'Dispatch eligibility',originPartId:'dispatch',
      meaning:'A released, unfinished job is eligible when its mark is maximal. The mark is two after an interruption beyond half its processing, otherwise zero.',
      sourceAnchors:[{step:1,phrase:'Dispatch eligibility requires a maximal mark among released unfinished jobs.'}]},
    {id:'packing-witness',kind:'definition',title:'Packing witness',originPartId:'witness',
      meaning:'Every selected job window is contained in the interval, and the total required work strictly exceeds its length.',
      sourceAnchors:[{step:2,phrase:'total required processing exceeds its length'}]},
  ];
  const knowledge = {techniques:[{id:'capacity-bound',name:'Interval capacity bound',mechanism:'Compare required work to available machine time.',
    steps:[2],knownBridge:'Check that every selected job must run wholly inside the same interval.',folklore:true,sources:[],
    selfCheck:{question:'Can a unit-speed machine finish five units of work in a four-unit interval?',answer:'No. It can complete at most four units of work in that interval.'}}],
  definitionGroups:[{id:'model',title:'Single-machine scheduling',steps:[1,2],
    definitions:[{term:'Release time',meaning:'The earliest instant a job can be processed.'},
      {term:'Deadline',meaning:'The latest allowed completion time.'},{term:'Preemption',meaning:'A running job can be interrupted and resumed later.'}],
    selfCheck:{question:'A job is released at time 3 and needs two units on a unit-speed machine. Can it meet a deadline of 5?',
      answer:'Yes, if the machine serves it throughout the interval from 3 to 5.'}}]};
  return {...complete('Dispatch Rules and Interval Certificates'),parts,knowledge,localIntroductions};
}

test('scheduling headings do not mix local rules with familiar background or duplicate the model across same-page parts', async t => {
  const cacheDir = await cacheFor(t);
  const result = schedulingResult();
  const handle = createPaperAgentHandler({cacheDir,runner:async ({directory,prompt,outputPath,schemaPath}) => {
    const source = JSON.parse(await fs.readFile(path.join(directory,'paper.json'),'utf8'));
    assert.deepEqual(source,schedulingSource);
    assert(prompt.includes(schedulingSource.units[1].text.split('\n').at(-1)));
    const schema = JSON.parse(await fs.readFile(schemaPath,'utf8'));
    for (const cards of Object.values(schema.properties.knowledge.properties)) assert(cards.items.required.includes('selfCheck'));
    assert(schema.$defs.selfCheck.anyOf.some(s => s.type === 'null'));
    await fs.writeFile(outputPath,JSON.stringify(result));
  }});
  const ready = await finish(handle,schedulingSource);
  assert.equal(ready.status,'ready');
  assert.deepEqual(ready.parts,result.parts);
  assert.deepEqual(ready.knowledge,result.knowledge);
  assert.deepEqual(ready.localIntroductions,result.localIntroductions);
  const reloaded = createPaperAgentHandler({cacheDir,runner:() => assert.fail('Already prepared')});
  assert.deepEqual(await request(reloaded,'GET',route+'/'+ready.key),ready);
});

test('preparation discards unsupported source phrases and accepts nullable review checks', async t => {
  const cacheDir = await cacheFor(t);
  const analyzed = schedulingResult();
  analyzed.parts[1].sourceAnchors = [...analyzed.parts[0].sourceAnchors];
  analyzed.parts[2].sourceAnchors = [{step:2,phrase:'This quotation was never printed.'}];
  analyzed.localIntroductions[0].sourceAnchors = [{step:2,phrase:'This argument does not use dispatch marks.'}];
  analyzed.knowledge.definitionGroups[0].selfCheck = null;
  const handle = createPaperAgentHandler({cacheDir,runner:async ({outputPath}) => fs.writeFile(outputPath,JSON.stringify(analyzed))});
  const ready = await finish(handle,schedulingSource);
  assert.equal(ready.status,'ready');
  assert(ready.parts.slice(0,3).every(p => !p.sourceAnchors));
  assert.equal(ready.localIntroductions[0].sourceAnchors,undefined);
  assert.equal(ready.knowledge.definitionGroups[0].selfCheck,undefined);
  assert.deepEqual(ready.parts[3],analyzed.parts[3]);
});

test('mixed headings, duplicate background terms and unusable self-checks fail fresh validation', async t => {
  const cacheDir = await cacheFor(t);
  const cases = [
    ['mixed heading', r => {r.knowledge.definitionGroups[0].title = 'Priority and dispatch eligibility';}],
    ['local scope explicitly placed on a card', r => {r.knowledge.definitionGroups[0].scope = 'local';}],
    ['paper-only term inside a standard group', r => {r.knowledge.definitionGroups[0].definitions[0].originPartId = 'job-model';}],
    ['duplicate background', r => {const g = r.knowledge.definitionGroups[0];
      r.knowledge.definitionGroups.push({...g,id:'model-again',title:'Processing windows',definitions:[{...g.definitions[1],term:'DEADLINE'}]});
      for (const p of r.parts) p.definitionGroupIds.push('model-again');}],
    ['unanswered self-check', r => {r.knowledge.techniques[0].selfCheck.answer = ''; }],
    ['invalid self-check type', r => {r.knowledge.definitionGroups[0].selfCheck = 'yes';}],
  ];
  for (const [name,mutate] of cases) {
    const analyzed = schedulingResult();
    mutate(analyzed);
    const handle = createPaperAgentHandler({cacheDir,runner:async ({outputPath}) => fs.writeFile(outputPath,JSON.stringify(analyzed))});
    assert.equal((await finish(handle,{...schedulingSource,sourceOpening:name})).status,'error',name);
  }
});

test('the first and second passes share a 128-part limit while a part can cite all 256 source units', async t => {
  const cacheDir = await cacheFor(t);
  const units = Array.from({length:256}, (_, i) => ({title:'Page ' + (i + 1),text:'A source unit in an extended argument.'}));
  const result = complete('An Extended Counting Argument');
  result.parts[0].sourceSteps = units.map((_,i) => i + 1);
  const run = createPaperAgentHandler({cacheDir,runner:async ({outputPath}) => fs.writeFile(outputPath,JSON.stringify(result))});
  const first = await finish(run,{units});
  assert.equal(first.status,'ready');
  assert.equal(first.parts[0].sourceSteps.at(-1),256);
  result.parts = Array.from({length:129},(_,i) => ({...result.parts[0],id:'subargument-'+i,sourceSteps:[i+1]}));
  assert.equal((await finish(run,{units,sourceOpening:'An overlong part manifest'})).status,'error');
});
