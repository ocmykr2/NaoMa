const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createSectionGuideHandler}=require('./section-guides.cjs');

test('an opened section reuses its checked reading across restarts and exposes only mathematical content', async t=>{
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-section-test-'));
  t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  const endpoint='/api/section-structure';
  const body={title:'Pairs and a fixed point',studyKey:'first-plan',analysisKey:'paper-revision',units:[{title:'Pairs',text:'Each pair contributes two points.'}],
    readerKnowledge:{techniques:[],definitionGroups:[]},stage:{partId:'pairs',title:'Count the pairs',sourceSteps:[1],opening:'Count the items.',question:'How large is a pair?'}};
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  let calls=0;
  const generator=async ({context})=>{
    calls++;entered.resolve();await release.promise;
    return {partId:context.stage.partId,goal:'Count the points.',overview:'Each pair contains two points.',
      modules:[{id:'count',title:'Count a single pair',claim:'A pair contains two points.',assumptions:[],dependsOn:[],scope:'Internal model scope',
        explanation:'Put a finger on each of the two points.',sourceStep:1,sourceQuote:'Each pair contributes two points.',
        formal:{variables:[]},verification:{status:'verified',source:'theorem private_code',detail:'private diagnostic'}}]};
  };
  function service(generate){
    const route=createSectionGuideHandler({generate,cacheDir,readLocalJson:async r=>r.body,checkLocalRequest(){}});
    return async(method,url,payload)=>{let data;await route({method,body:payload},{writeHead(){},end:s=>data=JSON.parse(s)},url);return data;};
  }
  const send=service(generator);
  const first=await send('POST',endpoint,body);
  await entered.promise;
  assert.equal(first.status,'running');
  assert.deepEqual(await send('POST',endpoint,body),first);
  release.resolve();
  let out;
  for(let i=0;i<300;i++){out=await send('GET',endpoint+'/'+first.key);if(out.status!=='running')break;await delay(10);}
  assert.equal(out.status,'ready');assert.equal(out.modules[0].explanation,'Put a finger on each of the two points.');
  for(const name of ['formal','verification','scope'])assert.equal(Object.hasOwn(out.modules[0],name),false);
  assert.doesNotMatch(JSON.stringify(out),/private_code|private diagnostic/);
  assert.equal(calls,1);
  const fresh=service(()=>assert.fail('recomputed a completed section'));
  assert.deepEqual(await fresh('POST',endpoint,{...body,title:'Initial import label'}),out);
  const another=await send('POST',endpoint,{...body,studyKey:'another-plan'});
  assert.notEqual(another.key,first.key);
  for(let i=0;i<300 && (await send('GET',endpoint+'/'+another.key)).status==='running';i++)await delay(10);
});

test('a stopped section reports its stage and a safe reason without disclosing source excerpts',async t=>{
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-section-test-'));
  t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  const endpoint='/api/section-structure',stage={partId:'pairs',title:'Count the pairs',sourceSteps:[1],opening:'Group the objects.',question:'How many?'};
  const body={title:'Finite pairs',studyKey:'first',analysisKey:'analysis',units:[{title:'Counting',text:'Each pair has two objects.'}],stage};
  const api=createSectionGuideHandler({cacheDir,readLocalJson:async r=>r.body,checkLocalRequest(){},
    generate:async (_input,{onStage})=>{
      onStage('formulating');throw Object.assign(Error('Use a contiguous phrase copied from the original source at step 1. PRIVATE MATERIAL'),{workerCode:'locator'});
    }});
  async function request(method,url) {
    let result;await api({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},url);
    return result;
  }
  const started=await request('POST',endpoint);
  let failed;
  for(let i=0;i<100;i++){failed=await request('GET',endpoint+'/'+started.key);if(failed.status!=='running')break;await delay(10);}
  assert.equal(failed.status,'error');
  assert.equal(failed.failureStage,'formulating');
  assert.equal(failed.failureCode,'locator');
  assert.equal(failed.actionRequired,'review');
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE|compiler|Lean/);
  assert.match(failed.message,/original section/);
});

test('a retry can recheck its private formulation across restarts and removal clears it',async t=>{
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-section-draft-'));
  t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  const endpoint='/api/section-structure';
  const body={title:'Finite pairs',studyKey:'first',analysisKey:'analysis',units:[{title:'Counting',text:'Each pair has two objects.'}],
    stage:{partId:'pairs',title:'Count the pairs',sourceSteps:[1],opening:'Group the objects.',question:'How many?'}};
  const draft={goal:'Count the objects.',modules:[{id:'count',title:'Count a pair',claim:'A pair has two objects.',dependsOn:[],priorPartIds:[],
    assumptions:[],scope:'One pair.',sourceStep:1,sourceQuote:'Each pair has two objects.',formal:null}]};
  function service(generate) {
    let adapter;
    const paperCache={adapter:(_,value)=>{adapter=value;},submit:(_,_input,key,fn)=>fn(key)};
    const api=createSectionGuideHandler({cacheDir,paperCache,generate,readLocalJson:async r=>r.body,checkLocalRequest(){}});
    async function request(method,url,body) {
      let result;await api({method,body},{writeHead(){},end(s){result=JSON.parse(s);}},url);return result;
    }
    return {get:key=>request('GET',endpoint+'/'+key),remove:key=>adapter.remove(key),async run(body) {
      let job=await request('POST',endpoint,body);
      for(let i=0;i<300 && job.status==='running';i++) {
        await delay(10);job=await request('GET',endpoint+'/'+job.key);
      }
      return job;
    }};
  }
  const failed=service(async(_input,{onStage,loadDraft,saveDraft,feedback})=>{
    assert.equal(feedback,undefined);
      assert.equal(await loadDraft(),null);
      await saveDraft({...draft,modules:[{...draft.modules[0],verification:{status:'verified',source:'internal'}}]});
      assert.equal(await loadDraft(),null);
      await saveDraft(draft);
    onStage('explaining');throw new SyntaxError('private explanation failure');
  });
  const first=await failed.run(body);
  assert.equal(first.status,'error');assert.doesNotMatch(JSON.stringify(first),/internal|Count the objects/);
  assert.equal(first.unexpected,true);assert.equal(first.failureCode,'unexpected-failure');
  assert.equal(first.failureStage,'explaining');
  const different=await failed.run({...body,studyKey:'second'});
  assert.equal(different.status,'error');assert.notEqual(different.key,first.key);
  const restarted=service(async(input,{loadDraft,saveDraft})=>{
    const restored=await loadDraft();
    assert.deepEqual(restored,draft);
    await saveDraft(null);
    assert.equal(await loadDraft(),null);
    await saveDraft(restored);
    return {...restored,partId:input.context.stage.partId,overview:'Two objects form each pair.',
      modules:restored.modules.map(row=>({...row,explanation:'Count both objects.'}))};
  });
  assert.deepEqual(await restarted.get(first.key),first);
  const ready=await restarted.run(body);
  assert.equal(ready.status,'ready');assert.equal(ready.key,first.key);
  assert.deepEqual((await fs.readdir(cacheDir)).sort(),[first.key+'.json',different.key+'.formulation',different.key+'.fault'].sort());
  await restarted.remove(different.key);
  await restarted.remove(first.key);
  assert.deepEqual(await fs.readdir(cacheDir),[]);
});

test('one section submission automatically corrects a rejected source locator and exposes the saved explanation',async t=>{
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-section-recovery-'));
  t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  const endpoint='/api/section-structure';
  const body={title:'Counting',studyKey:'one',analysisKey:'analysis',units:[{title:'Counting',text:'A pair contains two points.'}],
    stage:{partId:'pairs',title:'Count pairs',sourceSteps:[1],opening:'Count both points.',question:'How many?'}};
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  let calls=0;
  const route=createSectionGuideHandler({cacheDir,readLocalJson:async r=>r.body,checkLocalRequest(){},
    async generate(input,{feedback,onStage}) {
      calls++;onStage('formulating');
      if (!feedback) throw Object.assign(Error('Use a contiguous phrase copied from the original source at step 1.'),{workerCode:'locator'});
      assert.equal(feedback.code,'locator');assert.match(feedback.detail,/step 1/);
      entered.resolve();await release.promise;
      const quote=input.units[0].text;
      return {partId:'pairs',goal:'Count two points.',overview:quote,modules:[{id:'count',title:'Count a pair',claim:quote,
        assumptions:[],dependsOn:[],sourceStep:1,sourceQuote:quote,explanation:'Count the two points.'}]};
    }});
  async function request(method,url) {
    let result;await route({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},url);return result;
  }
  const first=await request('POST',endpoint);
  await entered.promise;
  const repairing=await request('GET',endpoint+'/'+first.key);
  assert.equal(repairing.status,'running');assert.equal(repairing.progress.recovery.action,'review-section');
  release.resolve();
  let observed;
  for(let i=0;i<150;i++){observed=await request('GET',endpoint+'/'+first.key);if(observed.status!=='running')break;await delay(10);}
  assert.equal(observed.status,'ready');assert.equal(observed.key,first.key);assert.equal(calls,2);
  assert.equal(observed.modules[0].sourceQuote,body.units[0].text);
});
