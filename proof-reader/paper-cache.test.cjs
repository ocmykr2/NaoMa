'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {Readable}=require('node:stream');
const {createPaperCache}=require('./paper-cache.cjs');
const {createClearPaperHandler}=require('./clear-paper.cjs');
const {createPaperAgentHandler,normalizeInput,preparationAssets}=require('./paper-agent.cjs');
const {createPlanHandler,readingPlanKey}=require('./personalized-plan.cjs');
const {createSectionGuideHandler,sectionRequest}=require('./section-guides.cjs');
const {createQuestionHandler}=require('./ask-paper.cjs');

const unit={title:'Pairs',text:'Each pair contributes two points.'};
const source=n=>({title:'Pair counting',units:[unit],pdfBase64:Buffer.from('%PDF-1.7\n'+n+'\n%%EOF').toString('base64')});
const section={studyKey:'base',analysisKey:'research',stage:{partId:'count',title:'Count pairs',sourceSteps:[1],
  opening:'Count both items.',question:'How large is a pair?'},readerKnowledge:{techniques:[],definitionGroups:[]}};
const plan={analysis:{parts:[{id:'count',title:'Count pairs',summary:'Count all points in the pair.',sourceSteps:[1]}],
  localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:section.readerKnowledge};
const guide={partId:'count',goal:'Count points.',overview:'A pair has two points.',
  modules:[{id:'m',title:'Count',claim:'There are two points.',assumptions:[],dependsOn:[],explanation:'Count both.',sourceStep:1,sourceQuote:unit.text}]};
async function scratch(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-forget-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('reader-forget-'));
    await fs.rm(root,{recursive:true,force:true,maxRetries:3});});
  return root;
}
function service(root,generate=async()=>guide,worker) {
  const registry=createPaperCache(path.join(root,'papers'));
  const base={paperCache:registry,readLocalJson:async r=>r.body,checkLocalRequest() {},worker};
  const analysisHandler=createPaperAgentHandler({...base,runner:worker,cacheDir:path.join(root,'analysis')});
  const planHandler=createPlanHandler({...base,cacheDir:path.join(root,'plan')});
  const sectionHandler=createSectionGuideHandler({...base,generate,cacheDir:path.join(root,'section')});
  const tutor=createQuestionHandler(base);
  const clear=createClearPaperHandler(base);
  async function send(handler,method,route,body) {
    let out;
    const req=Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),
      {method,body,socket:{localPort:8794},headers:{host:'127.0.0.1:8794','content-type':'application/json'}});
    await handler(req,{writeHead(){},setHeader(){},end(s){out=JSON.parse(s);}},route);
    return out;
  }
  return {registry,clear:body=>send(clear,'POST','/api/paper-cache/clear',body),
    analysis:body=>send(analysisHandler,'POST','/api/techniques',body),
    readAnalysis:key=>send(analysisHandler,'GET','/api/techniques/'+key),
    plan:body=>send(planHandler,'POST','/api/reading-plan',body),
    section:body=>send(sectionHandler,'POST','/api/section-structure',body),
    read:key=>send(sectionHandler,'GET','/api/section-structure/'+key),
    readPlan:key=>send(planHandler,'GET','/api/reading-plan/'+key),
    ask:body=>send(tutor,'POST','/api/paper-question',body),answer:key=>send(tutor,'GET','/api/paper-question/'+key)};
}
async function finished(get) {
  for(let i=0;i<200;i++) {const r=await get();if(r.status!=='running') return r;await delay(10);}
  throw Error('Job did not settle.');
}
test('clearing a paper removes its derived caches, checkpoints and memory across a restart',async t=>{
  const root=await scratch(t),api=service(root),a=source('alpha'),b=source('beta');
  async function seed(paper) {
    const analysis=(await preparationAssets(normalizeInput(paper))).key, oldPlan=await readingPlanKey({...paper,...plan});
    const files=[['analysis',analysis+'.json'],...['.json','.checkpoint','.diagnostics'].map(s=>['plan',oldPlan+s])];
    for(const [dir,file] of files){await fs.mkdir(path.join(root,dir),{recursive:true});await fs.writeFile(path.join(root,dir,file),'legacy');}
    const structure=await api.section({...paper,...section});
    assert.equal((await finished(()=>api.read(structure.key))).status,'ready');
    return {analysis,oldPlan,section:structure.key,files};
  }
  const first=await seed(a),other=await seed(b);
  const body={source:a,analysisKeys:[other.analysis],planKeys:[other.oldPlan],sectionKeys:[other.section],
    legacyPlans:[{key:first.oldPlan,...plan},{...plan,...b,key:other.oldPlan}]};
  assert.deepEqual(await api.clear(body),{cleared:true});
  for(const [dir,name] of first.files) await assert.rejects(fs.stat(path.join(root,dir,name)),{code:'ENOENT'});
  for(const [dir,name] of other.files) assert.equal(await fs.readFile(path.join(root,dir,name),'utf8'),'legacy');
  await assert.rejects(api.read(first.section),e=>e.status===404);
  assert.equal((await api.read(other.section)).status,'ready');
  const cold=service(root);
  const newJob=await cold.section({...a,...section});
  assert.notEqual(newJob.key,first.section);
  assert.equal(newJob.status,'running');
  await finished(()=>cold.read(newJob.key));
  assert.equal((await cold.section({...b,...section})).key,other.section);
  await cold.clear({source:a});
  await assert.rejects(cold.read(newJob.key),e=>e.status===404);
});

test('a scoped clear cannot race an active section or tutor and forgets transient results',async t=>{
  const root=await scratch(t),release=Promise.withResolvers(),entered=Promise.withResolvers(),a=source('a'),b=source('b');
  const tutorRelease=Promise.withResolvers(),api=service(root,async()=>{entered.resolve();await release.promise;return guide;},
    async()=>{await tutorRelease.promise;throw Error('Stopped worker');});
  const task=await api.section({...a,...section});
  await entered.promise;
  await assert.rejects(api.clear({source:a}),e=>e.status===409);
  await api.clear({source:b});
  release.resolve();
  await finished(()=>api.read(task.key));
  const question=await api.ask({...a,step:1,question:'What is a pair?'});
  await assert.rejects(api.clear({source:a}),e=>e.status===409);
  tutorRelease.resolve();
  await finished(()=>api.answer(question.key));
  await api.clear({source:a});
  await assert.rejects(api.answer(question.key),e=>e.status===404);
  await assert.rejects(api.read(task.key),e=>e.status===404);
});

test('original text identity isolates equal extracted passages and rejects a mismatched hash',async t=>{
  const root=await scratch(t),api=service(root);
  function text(sourceText) {return {title:'Pairs',units:[unit],sourceText,paperId:createHash('sha256').update(sourceText).digest('hex')};}
  const a=text(unit.text+'\n'),b=text(unit.text+'\r\n');
  const one=await api.section({...a,...section}),two=await api.section({...b,...section});
  assert.notEqual(one.key,two.key);
  await finished(()=>api.read(one.key));await finished(()=>api.read(two.key));
  await assert.rejects(api.clear({source:{...a,paperId:b.paperId}}),e=>e.status===400);
  await api.clear({source:a});
  assert.equal((await api.read(two.key)).status,'ready');
  await assert.rejects(api.read(one.key),e=>e.status===404);
});

test('source-only imports remain removable when a long scan exceeds both preparation limits',async t=>{
  const root=await scratch(t),api=service(root);
  const scan={...source('long scan'),units:Array.from({length:2001},(_,i)=>({title:'Page '+(i+1),page:i+1,text:''}))};
  await assert.rejects(api.section({...scan,...section}),e=>e.status===400);
  assert.throws(()=>normalizeInput(scan),e=>e.status===400);
  assert.deepEqual(await api.clear({source:scan}),{cleared:true});
  const imageOnly={...source('image-only'),units:[{title:'First page',page:1,text:''}]};
  assert.deepEqual(await api.clear({source:imageOnly}),{cleared:true});
});

test('re-uploading the same PDF starts new analysis and plan jobs after clearing',async t=>{
  const root=await scratch(t),p=source('repeat'),calls=[];
  const worker=async job=>{calls.push(path.basename(job.outputPath));throw Object.assign(Error('The quota is exhausted.'),{workerCode:'quota'});};
  async function start(api) {
    const analysis=await api.analysis(p);
    assert.equal(analysis.status,'running');
    await finished(()=>api.readAnalysis(analysis.key));
    const reading=await api.plan({...p,...plan});
    assert.equal(reading.status,'running');
    await finished(()=>api.readPlan(reading.key));
    return [analysis.key,reading.key];
  }
  const first=service(root,undefined,worker),old=await start(first);
  const count=calls.length;
  assert.ok(count>=2);
  await first.clear({source:p});
  const cold=service(root,undefined,worker);
  const next=await start(cold);
  assert.notEqual(next[0],old[0]);assert.notEqual(next[1],old[1]);
  assert.equal(calls.length,2*count);
});
