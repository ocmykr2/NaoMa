const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const program=readFileSync(path.join(__dirname,'reading-session.js'),'utf8');
const orientationProgram=readFileSync(path.join(__dirname,'part-orientation.js'),'utf8');
const {editorialRevision}=require('./part-orientation.js');
const key='document-hash';
const planEndpoint='/api/reading-plan', questionEndpoint='/api/paper-question';
const source=async()=>({title:'Pairing an interval',units:[
  {title:'Pair the interior',text:'An interior point has a partner.'},
  {title:'Add the endpoint',text:'The endpoint contributes once.'},
]});
const analysis={revision:'source-analysis-1',knowledge:{techniques:[],definitionGroups:[]},localIntroductions:[],
  parts:[{id:'pair',title:'Pair the points',summary:'Pair every interior point.',sourceSteps:[1]},
    {id:'end',title:'Add the endpoint',summary:'Include the endpoint once.',sourceSteps:[2]}]};
const unmarked={techniques:[],definitionGroups:[]};
const marked={techniques:[{name:'Involution',mechanism:'Pair points.',knownBridge:'Separate the endpoint.',sources:[]}],
  definitionGroups:[{title:'Interval',state:'partial',knownTerms:['Interior'],remainingTerms:['Endpoint']}]};
const clean=value=>JSON.parse(JSON.stringify(value));
const parts=analysis.parts.map(({id,title,sourceSteps})=>({id,title,sourceSteps,opening:title+'.',
  question:'What changes in '+title.toLowerCase()+'?'}));
const readyPlan=(id,body=parts)=>({status:'ready',key:id,parts:body});
const reply=(state,evidence)=>({status:'ready',answer:'The endpoint is counted once.',sourceStep:1,
  followups:['Where is the unmatched point?'],stageDecision:{state,evidence}});
function storage() {
  const values=new Map();
  return {getItem:k=>values.get(k) ?? null,setItem(k,v){values.set(k,v);}};
}
function app(respond,local=storage(),library,locks,network={}) {
  const calls=[];
  const changes=[];
  const listeners=new Map();
  const window={PAPER_LIBRARY:library,PAPER_REMOVAL:network.removal,navigator:{locks},setTimeout:network.schedule,
    addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:e=>changes.push(e.detail)};
  vm.runInNewContext(orientationProgram,{window});
  vm.runInNewContext(program,{window,crypto,TextEncoder,structuredClone,AbortSignal:network.AbortSignal,localStorage:local,sessionStorage:storage(),
    document:{hidden:false},location:{protocol:'http:'},CustomEvent:class {constructor(_,init){this.detail=init.detail;}},
    setTimeout:fn=>setImmediate(fn),fetch:async(url,args)=>{
      const request={method:args?.method || 'GET',url,body:args?.body ? JSON.parse(args.body) : null};
      calls.push(request);
      if (network.fetch) return network.fetch(request,args?.signal);
      const result=await respond(request);
      return {status:result.httpStatus || 200,ok:!result.httpStatus,json:async()=>structuredClone(result)};
    }});
  const api=window.READER_SESSION;
  return {api,calls,changes,local,storageEvent:()=>listeners.get('storage')({key:'proof.study.'+key,newValue:local.getItem('proof.study.'+key)}),
    session:()=>api.session(key),study:()=>api.session(key).study,
    plan:(readerKnowledge=unmarked,a=analysis)=>api.personalize(key,source,{analysis:a,readerKnowledge}),
    ask:(partId,question,options={})=>api.askPart(key,source,{partId,question,...options})};
}

test('a failed section keeps its service key and public check result for retry',async()=>{
  const section='/api/section-structure', jobKey='e'.repeat(64);
  const status={status:'error',failureStage:'formulating',failureCode:'locator',message:'A cited passage could not be located in the original section.'};
  const client=app(async({url})=>{
    if (url===planEndpoint) return readyPlan('test-plan');
    if (url===section) return {status:'running',key:jobKey};
    assert.equal(url,section+'/'+jobKey);
    return status;
  });
  await client.plan();
  await client.api.readStructure(key,source,client.study(),analysis,'pair');
  const failure=client.api.partGuide(client.study(),'pair');
  assert.equal(failure.key,jobKey);
  assert.equal(failure.failureCode,'locator');
  assert.equal(failure.message,status.message);
  assert.ok(client.api.sectionKeys(key).includes(jobKey));
});

test('a disconnected section waits and reconnects to the same explanation automatically',async()=>{
  let online=false,wake;
  const endpoint='/api/section-structure', jobKey='e'.repeat(64);
  const client=app(async({url})=>{
    if (url===planEndpoint) return readyPlan('resume-section');
    if (url===endpoint) return {status:'running',key:jobKey};
    assert.equal(url,endpoint+'/'+jobKey);
    return online?{status:'ready',key:jobKey,partId:'pair',modules:[{id:'pairing'}]}:{httpStatus:503,error:'Offline'};
  },storage(),undefined,undefined,{schedule:(fn,delay)=>{assert.ok(delay>=10000);wake=fn;}});
  await client.plan();const study=client.study(),guide=()=>client.api.partGuide(study,'pair');
  await client.api.readStructure(key,source,study,analysis,'pair');
  assert.equal(guide().status,'waiting-service');
  online=true;wake();await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(guide().status,'ready');
  assert.equal(client.calls.filter(c=>c.url===endpoint && c.method==='POST').length,1);
});

test('late research and tutor replies cannot write into a reimported copy after removal',async()=>{
  const local=storage(), started=Promise.withResolvers(), release=Promise.withResolvers();
  const asked=Promise.withResolvers(), answer=Promise.withResolvers();
  let epoch='';
  const run=app(async({url})=>{
    if (url===planEndpoint) return readyPlan('a'.repeat(64));
    if (url===questionEndpoint) {asked.resolve();return answer.promise;}
    if (url==='/api/techniques') {started.resolve();return release.promise;}
    throw Error('Unexpected endpoint '+url);
  },local,undefined,undefined,{removal:{generation:()=>epoch}});
  await run.plan();
  const pendingQuestion=run.ask('pair','How many endpoints remain?');
  const pendingResearch=run.api.research(key,source);
  await Promise.all([asked.promise,started.promise]);
  epoch='reimported';
  // A suspended tab can see the epoch only after its pending request returns.
  local.setItem('proof.tutor.'+key,'[]');
  run.api.setPreparation(key,false);
  const before=local.getItem('proof.research.'+key);
  release.resolve({status:'ready',key:'removed-research'});
  answer.resolve(reply('continue',''));
  await Promise.all([pendingResearch,pendingQuestion]);
  assert.equal(local.getItem('proof.research.'+key),before);
  assert.equal(local.getItem('proof.tutor.'+key),'[]');
  assert.equal(run.session().study.key,undefined);
  assert.equal(run.session().turns.length,0);
});

test('legacy removal evidence follows the original plan request and ignores stale outlines',async()=>{
  const planKey='a'.repeat(64),ref={id:'f'.repeat(64),title:'Reference notation',units:[{title:'First page',text:'Call the endpoint the pole.'}]};
  const snapshots=new Map(),library={savePreparation:(key,record)=>{snapshots.set(key,structuredClone(record));return Promise.resolve();},
    getPreparation:key=>Promise.resolve(snapshots.get(key))};
  const model={...analysis,displayTitle:'Paired endpoints'};
  const run=app(async()=>({...readyPlan(planKey),notationEdition:{revision:'notation',referenceTitle:ref.title,
    overview:{paragraphs:['Use the pole.']},parts:parts.map(p=>({id:p.id,reading:p.opening}))}}),storage(),library);
  await run.api.personalize(key,source,{analysis:model,readerKnowledge:marked,notationReference:ref});
  assert.equal(run.study().status,'ready',run.study().message);
  const [evidence]=await run.api.removalPlans(key,model);
  assert.equal(evidence.key,planKey);
  const actual=run.calls.find(c=>c.url===planEndpoint).body;
  for (const field of ['title','analysis','readerKnowledge','notationReference']) assert.deepEqual(clean(evidence[field]),actual[field]);
  assert.deepEqual(clean(await run.api.removalPlans(key,{...model,parts:model.parts.slice(0,1)})),[]);
});

test('a plan submission with a lost response and a stalled status body reconnects to the same generation',async()=>{
  const deadlines=[];
  const clock={timeout(ms){
    deadlines.push(ms);
    const controller=new AbortController();
    setImmediate(()=>controller.abort());
    return controller.signal;
  }};
  const stall=signal=>new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(Error('Request aborted')),{once:true}));
  let posts=0,gets=0;
  const run=app(undefined,storage(),null,null,{AbortSignal:clock,fetch:async(req,signal)=>{
    assert.ok(signal,'a local job request must have a transport deadline');
    if(req.method==='POST'){
      if(++posts===1)return stall(signal);
      return {ok:true,json:async()=>({status:'running',key:'same-job'})};
    }
    assert.equal(req.url,planEndpoint+'/same-job');
    if(++gets===1)return {ok:true,json:()=>stall(signal)};
    return {ok:true,json:async()=>readyPlan('same-job')};
  }});
  await run.plan(marked);
  assert.equal(run.study().status,'ready');
  assert.deepEqual(run.calls[0],run.calls[1]);
  assert.equal(posts,2);
  assert.equal(gets,2);
  assert.deepEqual(deadlines,[60000,60000,20000,20000]);
});

test('a completely unresponsive submission resumes automatically after a delayed reconnect',async()=>{
  let online=false,posts=0,wake;
  const clock={timeout(){const c=new AbortController();setImmediate(()=>c.abort());return c.signal;}};
  const run=app(undefined,storage(),null,null,{schedule:(fn,delay)=>{assert.ok(delay>=9000);wake=fn;},AbortSignal:clock,fetch:async(req,signal)=>{
    posts++;assert.equal(req.method,'POST');assert.ok(signal);
    if(online)return {ok:true,json:async()=>readyPlan('recovered')};
    return {ok:true,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Stalled body')),{once:true}))};
  }});
  await run.plan();
  assert.equal(run.study().status,'waiting-service');
  assert.equal(posts,2);
  online=true;
  wake();
  await new Promise(setImmediate);
  assert.equal(run.study().status,'ready');
  assert.equal(posts,3);
});

test('a reference creates a separate reading while original discussions remain available on switching back',async()=>{
  const reference={id:'f'.repeat(64),title:'Orbit-counting notes',units:[{title:'Notation',text:'An orbit contains all points reached by iteration.'}]};
  const edition={revision:'test-1',referenceTitle:reference.title,mappings:[],overview:{paragraphs:['Count points by orbits.']},
    parts:parts.map(p=>({id:p.id,reading:'Describe the orbit in this part.'}))};
  const snapshots=new Map(),local=storage();
  const library={savePreparation:async(k,v)=>snapshots.set(k,structuredClone(v)),getPreparation:async k=>snapshots.get(k)};
  let planCalls=0;
  const service=async({url,body})=>{
    if(url===planEndpoint){
      planCalls++;
      if(!body.notationReference)return readyPlan('original');
      assert.deepEqual(body.notationReference,{title:reference.title,units:reference.units});
      return {...readyPlan('orbits'),notationEdition:edition};
    }
    if(url==='/api/section-structure'){
      assert.deepEqual(body.notationEdition,edition);
      return {status:'ready',partId:'pair',modules:[{id:'pairs'}]};
    }
    assert.equal(url,questionEndpoint);
    return reply('continue','');
  };
  const client=app(service,local,library);
  await client.plan();
  await client.api.ask(key,source,{step:1,question:'Original letters?'});
  await client.ask('pair','Which point is fixed?');
  const refPlan=(runner,ref)=>runner.api.personalize(key,source,{analysis,readerKnowledge:unmarked,notationReference:ref});
  await refPlan(client,reference);
  assert.deepEqual(clean(client.study().notationReference),{title:reference.title,id:reference.id});
  assert.equal(client.api.visibleTurns(key).length,0);
  assert.ok(!local.getItem('proof.study.'+key).includes(reference.units[0].text));
  assert.deepEqual(clean(snapshots.get('notation-reference/'+reference.id).units),reference.units);
  await client.api.readStructure(key,source,client.study(),analysis,'pair');
  await client.ask('pair','What is an orbit?');
  assert.deepEqual(client.calls.at(-1).body.notationEdition,edition);
  await client.api.ask(key,source,{step:1,question:'Give me an example.'});
  assert.deepEqual(client.calls.at(-1).body.history,[]);
  assert.deepEqual(client.calls.at(-1).body.notationEdition,edition);
  assert.equal(client.api.visibleTurns(key).length,2);
  const reopened=app(service,local,library);
  await reopened.plan();
  assert.equal(reopened.study().key,'original');
  assert.equal(reopened.api.visibleTurns(key).length,2);
  await refPlan(reopened,{title:reference.title,id:reference.id});
  assert.equal(reopened.study().key,'orbits');
  assert.equal(reopened.api.visibleTurns(key).length,2);
  assert.equal(planCalls,2);
});

test('failed adaptation retries with saved reference evidence after reopening and cannot publish an original-only response',async()=>{
  const local=storage(), snapshots=new Map();
  const library={savePreparation:async(k,v)=>snapshots.set(k,structuredClone(v)),getPreparation:async k=>snapshots.get(k)};
  const ref={id:'1'.repeat(64),title:'Pairing notes',units:[{text:'Every point has a partner.'}]};
  const first=app(async()=>readyPlan('original-only'),local,library);
  await first.api.personalize(key,source,{analysis,readerKnowledge:unmarked,notationReference:ref});
  assert.equal(first.study().status,'error');
  const second=app(async({body})=>{
    assert.deepEqual(body.notationReference,{title:ref.title,units:ref.units});
    return {...readyPlan('adapted'),notationEdition:{referenceTitle:ref.title,overview:{paragraphs:['Count pairs.']},
      parts:parts.map(p=>({id:p.id,reading:'Count the pairs.'}))}};
  },local,library);
  await second.api.retryStudy(key,source,analysis);
  assert.equal(second.study().status,'ready');
  assert.equal(second.study().key,'adapted');
});

test('only a validated personalized plan opens questions and each turn receives current profile and part',async()=>{
  const started=Promise.withResolvers(), release=Promise.withResolvers();
  const run=app(async ({url,body})=>{
    if(url===planEndpoint){started.resolve();return release.promise;}
    if(url===questionEndpoint)return reply('continue','');
    throw Error('Unexpected '+url);
  });
  assert.equal(await run.ask('pair','Before starting?'),false);
  const preparing=run.plan();
  await started.promise;
  assert.equal(run.study().status,'starting');
  assert.equal(await run.ask('pair','While preparing?'),false);
  assert.equal(run.api.finishPart(key,'pair'),false);
  assert.deepEqual(run.calls[0].body.readerKnowledge,unmarked);
  assert.deepEqual(run.calls[0].body.analysis.parts,analysis.parts);
  assert.equal(run.calls[0].body.analysis.revision,analysis.revision);
  release.resolve(readyPlan('plan-A'));
  await preparing;
  assert.equal(run.study().version,1);
  assert.equal(run.study().analysisKey,analysis.revision);
  assert.equal(run.study().activeIndex,0);
  assert.equal(await run.ask('end','Skip ahead?'),false);
  await run.ask('pair','What changes for the endpoint?',{readerKnowledge:marked,stepSkills:['Involution']});
  const sent=run.calls.at(-1).body;
  assert.deepEqual(sent.readerKnowledge,marked);
  assert.deepEqual(sent.stepSkills,['Involution']);
  assert.deepEqual(sent.stage,{partId:'pair',title:parts[0].title,sourceSteps:[1],opening:parts[0].opening,question:parts[0].question});
  assert.equal(sent.scope,'step');
  assert.equal(sent.step,1);
  assert.deepEqual(clean(run.study().readerKnowledge),unmarked);
  assert.equal(run.study().activeIndex,0);
  const turn=run.session().turns[0];
  assert.equal(turn.studyKey,'plan-A');
  assert.equal(turn.partId,'pair');
  assert.equal(turn.answer,'The endpoint is counted once.');
  const malformed=app(async()=>readyPlan('bad',[parts[0]]));
  await malformed.plan();
  assert.equal(malformed.study().status,'error');
  assert.equal(await malformed.ask('pair','Unready?'),false);
});

test('one grounded decision archives one part; duplicates, pending and historical actions do not advance',async()=>{
  const local=storage(),polled=Promise.withResolvers(),release=Promise.withResolvers();
  const explanation='Each interior point appears twice, so the endpoint is added once.';
  const run=app(async({url,body})=>{
    if(url===planEndpoint)return readyPlan('plan-A');
    if(url===questionEndpoint && body.question===explanation)return {key:'turn-2',status:'running'};
    if(url===questionEndpoint)return reply('complete','Evidence from a different turn.');
    if(url===questionEndpoint+'/turn-2'){polled.resolve();return release.promise;}
    throw Error('Unexpected '+url);
  },local);
  await run.plan();
  await run.ask('pair','Please explain the endpoint.');
  assert.equal(run.study().activeIndex,0);
  const inFlight=run.ask('pair',explanation);
  await polled.promise;
  assert.equal(run.api.finishPart(key,'pair'),false);
  await run.ask('pair','Duplicate pending question.');
  assert.equal(run.calls.filter(c=>c.url===questionEndpoint).length,2);
  await Promise.all([run.api.resumeStudy(key,source,analysis),run.api.resumeStudy(key,source,analysis)]);
  release.resolve(reply('complete',explanation));
  await inFlight;
  assert.equal(run.study().activeIndex,1);
  const archived=run.study().completed[0];
  assert.equal(archived.partId,'pair');
  assert.equal(archived.turnId,run.session().turns[1].id);
  assert.equal(archived.evidence,explanation);
  assert.equal(archived.by,'tutor');
  assert.equal(run.calls.filter(c=>c.url===questionEndpoint+'/turn-2').length,1);
  assert.equal(await run.ask('pair','Attempt to update archived discussion.'),false);
  assert.equal(run.api.finishPart(key,'pair'),false);
  assert.equal(run.api.finishPart(key,'unrelated'),false);
  const reload=app(async req=>{throw Error('Unexpected request '+req.url);},local);
  await reload.api.restoreStudy(key);
  assert.equal(reload.study().activeIndex,1);
  assert.equal(reload.study().completed.length,1);
  assert.deepEqual(clean(reload.session().turns.filter(t=>t.studyKey==='plan-A').map(t=>t.question)),['Please explain the endpoint.',explanation]);
  assert.equal(reload.api.finishPart(key,'end'),true);
  assert.equal(reload.api.finishPart(key,'end'),false);
  assert.equal(await reload.ask('end','Already finished.'),false);
  assert.equal(reload.study().activeIndex,reload.study().parts.length);
  assert.equal(reload.study().completed[1].by,'reader');
  const closed=app(async()=>{throw Error('unexpected network');},local);
  await closed.api.restoreStudy(key);
  assert.equal(closed.study().completed.length,2);
  assert.equal(closed.study().activeIndex,2);
  assert.deepEqual(closed.calls,[]);
});

test('retailoring A/B/A restores the saved route and discussion, and a new analysis requires a new plan',async()=>{
  const local=storage();
  const run=app(async({url,body})=>{
    if(url===planEndpoint)return readyPlan(body.readerKnowledge.techniques.length?'plan-B':'plan-A');
    if(url===questionEndpoint)return reply('continue','');
    throw Error('Unexpected '+url);
  },local);
  await run.plan();
  await run.ask('pair','First branch question.');
  assert(run.api.finishPart(key,'pair'));
  await run.plan(marked);
  assert.equal(run.study().key,'plan-B');
  assert.equal(run.study().activeIndex,0);
  await run.ask('pair','Second branch question.');
  await run.plan();
  assert.equal(run.study().key,'plan-A');
  assert.equal(run.study().activeIndex,1);
  assert.equal(run.calls.filter(c=>c.url===planEndpoint).length,2);
  assert.deepEqual(clean(run.session().turns.map(t=>[t.studyKey,t.question])),
    [['plan-A','First branch question.'],['plan-B','Second branch question.']]);
  const changed={...analysis,revision:'source-analysis-2'};
  const reopened=app(async req=>{assert.equal(req.url,planEndpoint);return readyPlan('revised-plan-A');},local);
  await reopened.api.resumeStudy(key,source,changed);
  assert.equal(await reopened.ask('end','Before reviewing revised plan?'),false);
  await reopened.plan(unmarked,changed);
  assert.equal(reopened.study().analysisKey,changed.revision);
  assert.equal(reopened.study().key,'revised-plan-A');
  assert.equal(reopened.study().activeIndex,0);
  assert.equal(reopened.session().turns.length,2);
});

test('a stale plan answer cannot advance the currently active plan',async()=>{
  const acknowledged=Promise.withResolvers(),delayed=Promise.withResolvers();
  const run=app(async({url,body})=>{
    if(url===planEndpoint)return readyPlan(body.readerKnowledge.techniques.length?'plan-B':'plan-A');
    if(url===questionEndpoint){acknowledged.resolve();return delayed.promise;}
    throw Error('Unexpected '+url);
  });
  await run.plan();
  const evidence='I understand why the endpoint is the only fixed point.';
  const late=run.ask('pair',evidence);
  await acknowledged.promise;
  await run.plan(marked);
  delayed.resolve(reply('complete',evidence));
  await late;
  assert.equal(run.study().key,'plan-B');
  assert.deepEqual(clean(run.study().completed),[]);
  assert.equal(run.session().turns[0].studyKey,'plan-A');
  assert.equal(run.session().turns[0].answer,'The endpoint is counted once.');
  await run.plan();
  assert.equal(run.study().key,'plan-A');
  assert.equal(run.study().activeIndex,1);
  assert.equal(run.study().completed[0].turnId,run.session().turns[0].id);
  await run.plan(marked);
  assert.equal(run.study().activeIndex,0);
});

test('after a reload an expired reading-plan job is resubmitted with its saved profile',async()=>{
  const oldStore=storage(),oldPoll=Promise.withResolvers(),release=Promise.withResolvers();
  const first=app(async({url})=>{
    if(url===planEndpoint)return {status:'running',key:'expired'};
    if(url===planEndpoint+'/expired'){oldPoll.resolve();return release.promise;}
    throw Error('Unexpected '+url);
  },oldStore);
  const oldRequest=first.plan(marked);
  await oldPoll.promise;
  const restarted=storage();
  restarted.setItem('proof.study.'+key,oldStore.getItem('proof.study.'+key));
  // End the old VM's mock request after capturing its persisted in-flight state.
  release.resolve(readyPlan('expired'));
  await oldRequest;
  const current=app(async({url})=>{
    if(url===planEndpoint+'/expired')return {httpStatus:404,error:'The pending job expired.'};
    if(url===planEndpoint)return readyPlan('regenerated');
    throw Error('Unexpected '+url);
  },restarted);
  await current.api.resumeStudy(key,source,analysis);
  assert.equal(current.study().key,'regenerated');
  assert.equal(current.study().status,'ready');
  assert.deepEqual(current.calls.map(c=>c.method),['GET','POST']);
  assert.deepEqual(current.calls[1].body.readerKnowledge,marked);
});

test('temporary status outages retain progress and a connection wakeup checks the same job',async()=>{
  let posts=0,gets=0,online=false;
  const progress={stage:'editing',completedParts:1,totalParts:2,firstPart:2,lastPart:2,startedAt:Date.now()};
  const run=app(async({method})=>{
    if(method==='POST'){posts++;return {key:'working',status:'running',progress};}
    gets++;
    if(!online)return {httpStatus:503,error:'Offline'};
    return readyPlan('working');
  });
  await run.plan(marked);
  assert.equal(gets,3);
  assert.equal(run.study().status,'waiting-service');
  assert.equal(run.study().reconnect,true);
  assert.deepEqual(clean(run.study().progress),progress);
  online=true;
  await run.api.resumeStudy(key,source,analysis,{wake:true});
  assert.equal(run.study().status,'ready');
  assert.equal(run.study().progress,undefined);
  assert.equal(posts,1);
  assert.equal(gets,4);
});

test('cold opening a failed plan checks its exact saved result once without submitting another plan',async()=>{
  const reviewed={...analysis,displayTitle:'Pairing in a closed interval'};
  const saved=app(async({method,body})=>{
    if(method==='POST'){
      assert.equal(body.title,reviewed.displayTitle);
      return {key:'after-check',status:'running'};
    }
    return {key:'after-check',status:'error',message:'The earlier check failed.'};
  });
  await saved.plan(marked,reviewed);
  assert.equal(saved.study().status,'error');
  const record=saved.local.getItem('proof.study.'+key);
  for(const [response,expected] of [[readyPlan('after-check'),'ready'],[readyPlan('different-job'),'error'],[{httpStatus:404,error:'Expired'},'error']]){
    const local=storage();local.setItem('proof.study.'+key,record);
    const cold=app(async()=>response,local);
    await Promise.all([cold.api.resumeStudy(key,source,reviewed),cold.api.resumeStudy(key,source,reviewed)]);
    await cold.api.resumeStudy(key,source,reviewed);
    assert.deepEqual(cold.calls.map(r=>[r.method,r.url]),[['GET',planEndpoint+'/after-check']]);
    assert.equal(cold.study().status,expected);
    assert.deepEqual(clean(cold.study().readerKnowledge),marked);
  }
});

test('an immediately expired plan job retries once and repeated expiry reports a recoverable error',async()=>{
  for(const recovers of [true,false]){
    let submits=0;
    const run=app(async({url})=>{
      if(url===planEndpoint){
        submits++;
        return submits===2 && recovers ? readyPlan('live') : {status:'running',key:'expired-'+submits};
      }
      return {httpStatus:404,error:'Expired in this server process.'};
    });
    await run.plan();
    assert.equal(submits,2);
    assert.equal(run.study().status,recovers?'ready':'error');
    if(!recovers)assert.equal(await run.ask('pair','Unready?'),false);
  }
});

test('an unknown legacy failure stays visible after reload and never starts a new job',async()=>{
  for (const assigned of [true,false]) {
    const local=storage();
    local.setItem('proof.study.'+key,JSON.stringify({generation:'',selectedAt:1,savedAt:2,study:{status:'failed',analysisKey:analysis.revision,
      readerKnowledge:marked,message:'An unrecognized condition occurred.',...(assigned?{key:'old-job'}:{})},plans:{},turns:[]}));
    const reopened=app(async()=>({httpStatus:404,error:'No job remains.'}),local);
    await reopened.api.resumeStudy(key,source,analysis);
    assert.equal(reopened.study().status,'error');
    assert.equal(reopened.study().unexpected,true);
    assert.equal(reopened.study().failureCode,'unexpected-failure');
    assert.deepEqual(reopened.calls.map(c=>c.method),assigned?['GET']:[]);
    await reopened.api.resumeStudy(key,source,analysis);
    assert.equal(reopened.calls.filter(c=>c.method==='POST').length,0);
  }
});

test('two windows repair an older notation failure once using the exact saved reference and profile',async()=>{
  const local=storage(),snapshots=new Map(),lockQueue=new Map();
  const library={getPreparation:async id=>snapshots.get(id),savePreparation:async(id,record)=>snapshots.set(id,structuredClone(record))};
  const locks={request(name,task){const work=(lockQueue.get(name) || Promise.resolve()).then(task);lockQueue.set(name,work.catch(()=>{}));return work;}};
  const reference={id:'a'.repeat(64),title:'Pairing notation',units:[{title:'Conventions',text:'We denote the partner of v by q(v).'}]};
  const first=app(async()=>({key:'same-plan',status:'error',needsAction:true,actionRequired:'service',message:'Earlier service stopped.'}),local,library);
  await first.api.personalize(key,source,{analysis,readerKnowledge:marked,notationReference:reference});
  const old=JSON.parse(local.getItem('proof.study.'+key));
  old.study.status='failed'; old.study.message='The notation could not be adapted from the selected reference. Retry preparation or choose another reference paper.';
  delete old.study.needsAction; delete old.study.actionRequired;
  local.setItem('proof.study.'+key,JSON.stringify(old));
  snapshots.set('study/'+key,old);
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),posts=[];
  const result={...readyPlan('same-plan'),notationEdition:{referenceTitle:reference.title,overview:{paragraphs:['Pair each point.']},
    parts:parts.map(p=>({id:p.id,reading:p.opening}))}};
  const respond=async req=>{
    if (req.method==='GET') return {key:'same-plan',status:'error',message:'The notation could not be adapted.'};
    posts.push(req.body);entered.resolve();await release.promise;
    return result;
  };
  const left=app(respond,local,library,locks),right=app(respond,local,library,locks);
  const running=[left.api.resumeStudy(key,source,analysis),right.api.resumeStudy(key,source,analysis)];
  await entered.promise;release.resolve();await Promise.all(running);
  await Promise.all([left.api.refreshStudy(key),right.api.refreshStudy(key)]);
  assert.equal(posts.length,1);
  assert.deepEqual(posts[0],first.calls[0].body);
  for (const tab of [left,right]) {
    assert.equal(tab.study().status,'ready');
    assert.equal(tab.study().notationEdition.referenceTitle,reference.title);
    assert.deepEqual(clean(tab.study().readerKnowledge),marked);
  }
});

test('reopening after losing contact follows an existing job that is still preparing',async()=>{
  const local=storage();
  const first=app(async({method})=>method==='POST'?{status:'running',key:'still-working'}:{httpStatus:503,error:'Offline'},local);
  await first.plan();
  assert.equal(first.study().status,'waiting-service');
  let gets=0;
  const reopened=app(async({method,url})=>{
    assert.equal(method,'GET');
    assert.equal(url,planEndpoint+'/still-working');
    return ++gets===1 ? {status:'running',key:'still-working'} : readyPlan('still-working');
  },local);
  await Promise.all([reopened.api.resumeStudy(key,source,analysis,{wake:true}),reopened.api.resumeStudy(key,source,analysis,{wake:true})]);
  assert.equal(reopened.study().status,'ready');
  assert.equal(gets,2);
});

test('two sessions cannot complete an already archived part or overwrite its record',async()=>{
  const local=storage();
  const respond=async({url})=>{assert.equal(url,planEndpoint);return readyPlan('plan-A');};
  const first=app(respond,local);
  await first.plan();
  const stale=app(respond,local);
  await stale.api.restoreStudy(key);
  assert.equal(first.api.finishPart(key,'pair'),true);
  assert.equal(stale.api.finishPart(key,'pair'),false);
  assert.equal(await stale.ask('pair','Another question on the finished part.'),false);
  assert.equal(stale.calls.length,0);
  assert.equal(stale.api.finishPart(key,'end'),true);
  const reopened=app(respond,local);
  await reopened.api.restoreStudy(key);
  assert.equal(reopened.study().activeIndex,2);
  assert.deepEqual(clean(reopened.study().completed.map(c=>c.partId)),['pair','end']);
});

test('a late response from a stale tab preserves the newly selected plan and both conversations',async()=>{
  const local=storage(),started=Promise.withResolvers(),release=Promise.withResolvers();
  const evidence='Each pair contributes two except the fixed endpoint.';
  const first=app(async({url})=>{
    if(url===planEndpoint)return readyPlan('plan-A');
    if(url===questionEndpoint){started.resolve();return release.promise;}
    throw Error('Unexpected '+url);
  },local);
  await first.plan();
  const pending=first.ask('pair',evidence);
  await started.promise;
  const newer=app(async({url})=>url===planEndpoint?readyPlan('plan-B'):reply('continue',''),local);
  await newer.api.restoreStudy(key);
  await newer.plan(marked);
  await newer.ask('pair','Can you show me a new example in B?');
  release.resolve(reply('complete',evidence));
  await pending;
  const reopened=app(async req=>{throw Error('Unexpected regeneration '+req.url);},local);
  await reopened.api.restoreStudy(key);
  assert.equal(reopened.study().key,'plan-B');
  assert.equal(reopened.study().activeIndex,0);
  assert.equal(reopened.session().turns.filter(t=>t.status==='ready').length,2);
  await reopened.plan();
  assert.equal(reopened.study().key,'plan-A');
  assert.equal(reopened.study().activeIndex,1);
  assert.equal(reopened.study().completed.length,1);
  assert.deepEqual(reopened.calls,[]);
});

test('an exploration stays on the active part and the next ordinary exchange can complete it',async()=>{
  const local=storage();
  const run=app(async({url,body})=>url===planEndpoint ? readyPlan('plan-A') : reply('complete',body.question),local);
  const mode={mode:'example',target:''};
  assert.equal(await run.ask('pair','No active part yet.',{exploration:mode}),false);
  await run.plan();
  const text='I see why the fixed point needs a separate count.';
  await run.ask('pair',text,{exploration:mode});
  const first=run.calls.at(-1).body;
  assert.deepEqual(first.exploration,mode);
  assert.deepEqual(first.history,[]);
  assert.equal(first.stage.opening,parts[0].opening);
  assert.equal(run.study().activeIndex,0);
  assert.deepEqual(clean(run.session().turns[0].exploration),mode);
  const afterReload=app(async({body})=>reply('complete',body.question),local);
  await afterReload.api.restoreStudy(key);
  assert.equal(afterReload.study().activeIndex,0);
  const ordinary='Interior points form disjoint pairs, so the fixed point contributes once.';
  await afterReload.ask('pair',ordinary);
  const second=afterReload.calls.at(-1).body;
  assert.equal(second.exploration,undefined);
  assert.deepEqual(second.history,[{question:text,answer:run.session().turns[0].answer,exploration:mode}]);
  assert.equal(afterReload.study().activeIndex,1);
  assert.equal(afterReload.study().completed[0].evidence,ordinary);
  const archived=app(async()=>{throw Error('Unexpected archive request');},local);
  await archived.api.restoreStudy(key);
  assert.deepEqual(clean(archived.session().turns[0].exploration),mode);
  assert.equal(archived.study().activeIndex,1);
  assert.equal(await archived.ask('pair',text),false);
  assert.equal(archived.calls.length,0);
});

test('each exploration remains available after the plan finishes, with the archived sources, own history and unchanged completions',async()=>{
  const local=storage();
  const run=app(async({url,body})=>url===planEndpoint ? readyPlan('A') :
    {...reply('complete',body.question),answer:'Explanation of '+body.question,sourceStep:body.step},local);
  await run.plan(marked);
  const explore=(mode,target='')=>({exploration:{mode,target},studyKey:'A',analysis});
  assert.equal(await run.ask('end','A future example.',explore('example')),false);
  assert.equal(await run.ask('unknown','Outside the plan.',explore('example')),false);
  const initial='Why do we pair the interior points?';
  run.api.addPrepared(key,{studyKey:'A',partId:'pair',step:1,question:initial,answer:'This counts each pair together.'});
  assert(run.api.finishPart(key,'pair'));
  assert(run.api.finishPart(key,'end'));
  const completed=clean(run.study().completed);
  const choices=[['example','','Find a pair.'],['simplify','Only two interior points.','Simplify this argument.'],
    ['remove','The partner must be distinct.','Remove this condition.']];
  for(const [i,[mode,target,question]] of choices.entries()){
    assert.equal(await run.ask('pair',question,explore(mode,target)),true);
    const sent=run.calls.at(-1).body;
    assert.deepEqual(sent.exploration,{mode,target});
    assert.equal(sent.stage.partId,'pair');
    assert.equal(sent.stage.question,parts[0].question);
    assert.deepEqual(sent.stage.sourceSteps,[1]);
    assert.deepEqual(sent.readerKnowledge,marked);
    assert.deepEqual(sent.history.map(x=>x.question),[initial,...choices.slice(0,i).map(x=>x[2])]);
    assert.equal(run.study().activeIndex,2);
    assert.deepEqual(clean(run.study().completed),completed);
  }
  const again=app(async({body})=>({...reply('complete',body.question),sourceStep:2}),local);
  await again.api.restoreStudy(key);
  assert.deepEqual(clean(again.session().turns.slice(1).map(t=>[t.studyKey,t.partId,t.exploration.mode])),
    choices.map(([mode])=>['A','pair',mode]));
  assert.equal(await again.ask('end','Show the endpoint.',explore('example')),true);
  const last=again.calls.at(-1).body;
  assert.equal(last.stage.opening,parts[1].opening);
  assert.equal(last.step,2);
  assert.deepEqual(last.history,[]);
  assert.equal(again.session().turns.at(-1).partId,'end');
  assert.deepEqual(clean(again.study().completed),completed);
  for(const options of [{},{checkpoint:true},explore('unsupported'),{...explore('remove'),studyKey:'retired-plan'},
    {...explore('simplify'),analysis:{...analysis,revision:'different'}}]){
    assert.equal(await again.ask('pair','Wrong action or context.',options),false);
  }
  assert.equal(again.calls.length,1);
});

test('a pending active question and an archived exploration progress independently and deduplicate within the viewed part',async()=>{
  const activeSent=Promise.withResolvers(),activeAnswer=Promise.withResolvers();
  const archiveSent=Promise.withResolvers(),archiveAnswer=Promise.withResolvers();
  const run=app(async({url,body})=>{
    if(url===planEndpoint)return readyPlan('A');
    if(body.stage.partId==='end'){activeSent.resolve();return activeAnswer.promise;}
    archiveSent.resolve();return archiveAnswer.promise;
  });
  await run.plan();
  assert(run.api.finishPart(key,'pair'));
  const ordinary='Now I understand why the endpoint is counted once.';
  const active=run.ask('end',ordinary);
  await activeSent.promise;
  const mode={exploration:{mode:'example',target:'a pair of interior points'}};
  const archive=run.ask('pair','Revisit a pair.',mode);
  await archiveSent.promise;
  assert.equal(await run.ask('pair','A duplicate while waiting.',mode),false);
  assert.equal(await run.ask('end','A duplicate here too.',mode),false);
  assert.equal(run.calls.filter(c=>c.url===questionEndpoint).length,2);
  assert.equal(run.study().activeIndex,1);
  activeAnswer.resolve(reply('complete',ordinary));
  assert(await active);
  assert.equal(run.study().activeIndex,2);
  const completed=clean(run.study().completed);
  archiveAnswer.resolve(reply('complete','Revisit a pair.'));
  assert(await archive);
  assert.deepEqual(clean(run.study().completed),completed);
  assert.equal(run.study().activeIndex,2);
  assert.deepEqual(clean(run.session().turns.map(t=>[t.partId,t.stageDecision.state])),[['end','complete'],['pair','continue']]);
});

test('retry a failed archived exploration after reopening, preserving its original turn, target and source',async()=>{
  const local=storage();
  const run=app(async({url})=>url===planEndpoint ? readyPlan('A') : {httpStatus:503,error:'Unavailable'},local);
  await run.plan();
  assert(run.api.finishPart(key,'pair'));
  assert(run.api.finishPart(key,'end'));
  const question='What if there is no endpoint?',exploration={mode:'remove',target:'the endpoint'};
  assert(await run.ask('end',question,{exploration}));
  const id=run.session().turns[0].id;
  const next=app(async({body})=>({...reply('complete',body.question),sourceStep:2}),local);
  await next.api.restoreStudy(key);
  const failed=next.session().turns[0],newChoice={mode:'simplify',target:'discard this replacement'};
  assert.equal(await next.ask('pair',question,{retryTurn:failed}),false);
  assert.equal(await next.ask('end',question,{retryTurn:{...failed}}),false);
  assert.equal(next.calls.length,0);
  assert(await next.ask('end','Rewritten question',{retryTurn:failed,exploration:newChoice}));
  const body=next.calls[0].body;
  assert.equal(body.question,question);
  assert.equal(body.stage.partId,'end');
  assert.equal(body.step,2);
  assert.deepEqual(body.exploration,exploration);
  assert.deepEqual(body.history,[]);
  assert.deepEqual(clean(next.session().turns.map(t=>[t.id,t.status,t.partId])),[[id,'ready','end']]);
  assert.equal(await next.ask('end',question,{retryTurn:failed}),false);
  assert.equal(next.calls.length,1);
  assert.equal(next.study().activeIndex,2);
  assert.deepEqual(clean(next.study().completed),clean(run.study().completed));
});

test('retrying a saved failed exploration keeps its original mode, blank target and turn identity',async()=>{
  const local=storage();
  const first=app(async({url})=>url===planEndpoint?readyPlan('plan-A'):{httpStatus:503,error:'Temporary interruption'},local);
  await first.plan();
  const text='Inspect the selected assumption.',mode={mode:'remove',target:''};
  await first.ask('pair',text,{exploration:mode});
  const original=first.session().turns[0];
  assert.equal(original.status,'error');
  const next=app(async()=>reply('continue',''),local);
  await next.api.restoreStudy(key);
  const restored=next.session().turns[0];
  assert.deepEqual(clean(restored.exploration),mode);
  await next.ask('pair',restored.question,{retryTurn:restored});
  assert.deepEqual(next.calls[0].body.exploration,mode);
  assert.deepEqual(next.calls[0].body.history,[]);
  assert.equal(next.session().turns.length,1);
  assert.equal(next.session().turns[0].id,original.id);
  assert.equal(next.session().turns[0].status,'ready');
  assert.equal(next.study().activeIndex,0);
});

test('a bounded follow-up history keeps exploration metadata and the saved archive keeps every turn',async()=>{
  const local=storage(), modes=['example','simplify','remove'];
  const run=app(async({url})=>url===planEndpoint?readyPlan('plan-A'):reply('continue',''),local);
  await run.plan();
  const expected=[];
  for(let i=0;i<10;i++){
    const exploration={mode:modes[i%3],target:i%2?'Point '+i:''};
    const text='Explore inference '+i+'.';
    await run.ask('pair',text,{exploration});
    expected.push({question:text,answer:run.session().turns.at(-1).answer,exploration});
  }
  const reopened=app(async({body})=>reply('complete',body.question),local);
  await reopened.api.restoreStudy(key);
  await reopened.ask('pair','Each interior pair contributes exactly two.');
  assert.deepEqual(reopened.calls[0].body.history,expected.slice(-8));
  assert.equal(reopened.study().activeIndex,1);
  const archive=app(async()=>{throw Error('Unexpected archive request');},local);
  await archive.api.restoreStudy(key);
  const stored=archive.session().turns.filter(t=>t.partId==='pair');
  assert.equal(stored.length,11);
  assert.deepEqual(clean(stored.slice(0,10).map(t=>({question:t.question,answer:t.answer,exploration:t.exploration}))),expected);
});

test('reopening a legacy intuition discussion retains its wording, permits a new question and retries its failed question',async()=>{
  const local=storage();
  const firstText='Why choose a pairing of the interior points?';
  const failedText='How did the paper find this pairing?';
  const first=app(async({url,body})=>{
    if(url===planEndpoint)return readyPlan('plan-A');
    if(body.question===failedText)return {httpStatus:503,error:'Temporary interruption'};
    return {...reply('continue',''),answer:'The partner relation makes the leftover endpoint visible.'};
  },local);
  await first.plan();
  for(const text of [firstText,failedText])await first.ask('pair',text,{exploration:{mode:'example',target:'pairing of the interior'}});
  // Recreate a saved transcript from the release that offered the intuition control.
  for(const name of ['proof.tutor.'+key,'proof.study.'+key]){
    const data=JSON.parse(local.getItem(name));
    for(const turn of Array.isArray(data)?data:data.turns)turn.exploration.mode='intuition';
    local.setItem(name,JSON.stringify(data));
  }
  const next=app(async()=>reply('continue',''),local);
  await next.api.restoreStudy(key);
  const [historical,failed]=next.session().turns;
  assert.equal(historical.exploration.mode,'intuition');
  const expected={question:firstText,answer:historical.answer};
  const followup='What changes at the endpoint?';
  assert.equal(await next.ask('pair','Retired control.',{exploration:{mode:'intuition',target:'interior'}}),false);
  assert.equal(next.calls.length,0);
  await next.ask('pair',followup);
  assert.deepEqual(next.calls[0].body.history,[expected]);
  assert.equal(next.calls[0].body.exploration,undefined);
  assert.equal(historical.exploration.mode,'intuition');
  const id=failed.id;
  await next.ask('pair',failed.question,{retryTurn:failed});
  assert.equal(next.calls[1].body.question,failedText);
  assert.equal(next.calls[1].body.exploration,undefined);
  assert.deepEqual(next.calls[1].body.history,[expected]);
  assert.equal(next.session().turns.find(t=>t.id===id).status,'ready');
  assert.equal(next.session().turns.length,3);
});

test('checkpoint feedback persists in discussion and history and an incorrect complete verdict leaves control with the reader',async()=>{
  const local=storage();
  const proposed='Each point has a partner in the interior, so I understand the pairing.';
  const feedback='The pairing explains the interior contribution. Also check that its fixed endpoint is counted only once.';
  const run=app(async({url})=>url===planEndpoint?readyPlan('plan-A'):{...reply('complete',proposed),answer:feedback},local);
  assert.equal(await run.ask('pair',proposed,{checkpoint:true}),false);
  await run.plan();
  assert.equal(await run.ask('end',proposed,{checkpoint:true}),false);
  assert.equal(await run.ask('pair',proposed,{checkpoint:true,exploration:{mode:'example',target:'pairing'}}),false);
  await run.ask('pair',proposed,{checkpoint:true});
  const sent=run.calls.at(-1).body;
  assert.equal(sent.checkpoint,true);
  assert.equal(sent.question,proposed);
  assert.equal(sent.stage.question,parts[0].question);
  assert.equal(run.study().activeIndex,0);
  assert.equal(run.session().turns[0].checkpoint,true);
  assert.equal(run.session().turns[0].answer,feedback);
  const restored=app(async()=>reply('continue',''),local);
  await restored.api.restoreStudy(key);
  assert.equal(restored.study().activeIndex,0);
  assert.deepEqual(clean(restored.study().completed),[]);
  assert.equal(restored.session().turns[0].checkpoint,true);
  await restored.ask('pair','Does every point have a distinct partner?');
  const next=restored.calls.at(-1).body;
  assert.equal(next.checkpoint,undefined);
  assert.deepEqual(next.history,[{question:proposed,answer:feedback,checkpoint:true}]);
  assert.equal(restored.api.finishPart(key,'pair'),true);
  assert.equal(restored.study().completed[0].by,'reader');
  assert.equal(await restored.ask('pair',proposed,{checkpoint:true}),false);
});

test('failed checkpoint feedback can be skipped or retried on reopening with its original proposed answer',async()=>{
  const local=storage();
  const proposal='I count the two endpoints together.';
  const run=app(async({url})=>url===planEndpoint?readyPlan('plan-A'):{httpStatus:503,error:'Temporarily unavailable'},local);
  await run.plan();
  await run.ask('pair',proposal,{checkpoint:true});
  const failed=run.session().turns[0];
  assert.equal(failed.status,'error');
  assert.equal(failed.checkpoint,true);
  assert.equal(failed.checkpointQuestion,parts[0].question);
  const alternate=storage();
  for(const name of ['proof.study.'+key,'proof.tutor.'+key])alternate.setItem(name,local.getItem(name));
  const skip=app(async()=>{throw Error('Skipping must not call the tutor');},alternate);
  await skip.api.restoreStudy(key);
  assert.equal(skip.api.finishPart(key,'pair'),true);
  assert.equal(skip.study().activeIndex,1);
  assert.equal(skip.study().completed[0].by,'reader');
  assert.deepEqual(skip.calls,[]);
  const retry=app(async()=>({...reply('complete',proposal),answer:'Distinguish the paired points from the single fixed point.'}),local);
  await retry.api.restoreStudy(key);
  const saved=retry.session().turns[0];
  assert.equal(saved.checkpoint,true);
  assert.equal(saved.checkpointQuestion,parts[0].question);
  retry.study().parts[0].question='Which pairs survive a different choice of endpoints?';
  await retry.ask('pair',saved.question,{retryTurn:saved});
  assert.equal(retry.calls[0].body.checkpoint,true);
  assert.equal(retry.calls[0].body.question,proposal);
  assert.equal(retry.calls[0].body.stage.question,parts[0].question);
  assert.deepEqual(retry.calls[0].body.history,[]);
  assert.equal(retry.session().turns.length,1);
  assert.equal(retry.session().turns[0].id,failed.id);
  assert.equal(retry.session().turns[0].status,'ready');
  assert.equal(retry.study().activeIndex,0);
});

test('interrupted pre-key checkpoint feedback does not trap the reader on the part',async()=>{
  const local=storage(),started=Promise.withResolvers(),finish=Promise.withResolvers();
  const first=app(async({url})=>{
    if(url===planEndpoint)return readyPlan('plan-A');
    started.resolve(); return finish.promise;
  },local);
  await first.plan();
  const submitted='An interior point has the opposite point as its partner.';
  const pending=first.ask('pair',submitted,{checkpoint:true});
  await started.promise;
  const disk=storage();
  for(const name of ['proof.study.'+key,'proof.tutor.'+key])disk.setItem(name,local.getItem(name));
  // A reader may leave during feedback. The late verdict belongs to the archived part.
  assert.equal(first.api.finishPart(key,'pair'),true);
  finish.resolve(reply('complete',submitted));
  await pending;
  assert.equal(first.study().activeIndex,1);
  assert.equal(first.study().completed.length,1);
  assert.equal(first.study().completed[0].by,'reader');
  const recovered=app(async()=>{throw Error('Finishing must not resend the interrupted checkpoint');},disk);
  await recovered.api.restoreStudy(key);
  const interrupted=recovered.session().turns[0];
  assert.equal(interrupted.status,'error');
  assert.equal(interrupted.checkpoint,true);
  assert.equal(recovered.api.finishPart(key,'pair'),true);
  assert.equal(recovered.study().activeIndex,1);
  assert.equal(recovered.study().completed[0].by,'reader');
  assert.deepEqual(recovered.calls,[]);
});

test('explorations exclude optional checkpoint answers before capping the eight visible turns',async()=>{
  const run=app(async({url,body})=>url===planEndpoint?readyPlan('plan-A'):
    {...reply('continue',''),answer:'Reply to '+body.question});
  await run.plan();
  const blank={mode:'example',target:''};
  await run.ask('pair','First proposed solution.',{checkpoint:true});
  await run.ask('pair',parts[0].question);
  await run.ask('pair','Show the first move.',{exploration:blank});
  assert.deepEqual(run.calls.at(-1).body.history,[]);
  assert.equal(run.calls.at(-1).body.stage.opening,parts[0].opening);
  const visible=[];
  for(let i=1;i<=8;i++){
    const text='Explain the visible inference '+i+'.';
    await run.ask('pair',text);
    visible.push({question:text,answer:'Reply to '+text});
  }
  for(let i=1;i<=7;i++)await run.ask('pair','Proposed answer '+i+'.',{checkpoint:true});
  await run.ask('pair',parts[0].question);
  await run.ask('pair','Give me an example.',{exploration:blank});
  assert.deepEqual(run.calls.at(-1).body.history,visible);
  await run.ask('pair','I would like to revisit the earlier feedback.');
  const discussion=run.calls.at(-1).body.history;
  assert(discussion.some(turn=>turn.checkpoint===true));
  assert(discussion.some(turn=>turn.question===parts[0].question));
  assert(discussion.some(turn=>turn.exploration?.mode==='example'));
});

const orientations=[
  {introduction:'Pairing accounts for all points except the endpoint.',notation:[],definitions:[],paragraphs:['A pair contributes two interior points.'],
    handoff:'The endpoint is outside these pairs.',statement:null},
  {introduction:'The fixed endpoint is the final term in the count.',notation:[],definitions:[],paragraphs:['The endpoint adds one to the paired count.'],
    handoff:'Together the two counts give the size of the interval.',
    statement:{kind:'Lemma',label:'Lemma 2',text:'The endpoint contributes once.'}},
];
const orientationResult=(job='orientation-1',values=orientations)=>({key:job,status:'ready',mode:'orientation',editorialRevision,
  parts:parts.map((p,i)=>({id:p.id,orientation:values[i]}))});
const enrich=(run,opts={})=>run.api.ensureOrientation(key,source,analysis,opts);

test('profiles with the previous edition upgrade without resuming retired jobs or losing discussion',async()=>{
  const previous={purpose:'Count all points.',takeaway:'Each interior pair contributes two.',handoff:'Next add the endpoint.',statement:null};
  for(const status of ['ready','error','running']){
    const saved=app(async({url})=>url===questionEndpoint ? reply('continue','') :
      readyPlan('old',parts.map(part=>({...part,orientation:previous}))));
    await saved.plan(marked);
    await saved.ask('pair','Which point is unpaired?');
    saved.api.finishPart(key,'pair');
    const disk=JSON.parse(saved.local.getItem('proof.study.'+key));
    for(const slot of [disk.study,disk.plans.old]) slot.orientationJob={status,key:'outdated',generation:5};
    saved.local.setItem('proof.study.'+key,JSON.stringify(disk));
    const upgraded=app(async({method,body})=>{
      assert.equal(method,'POST');
      assert.deepEqual(body.readerKnowledge,marked);
      assert.equal(body.existingSections,undefined);
      return orientationResult('new-section-edition');
    },saved.local);
    await enrich(upgraded);
    assert.deepEqual(upgraded.calls.map(c=>c.url),[planEndpoint]);
    assert.deepEqual(clean(upgraded.study().parts.map(p=>p.orientation)),orientations);
    assert.equal(upgraded.study().activeIndex,1);
    assert.equal(upgraded.session().turns[0].question,'Which point is unpaired?');
  }
});

test('a full plan or explicitly reviewed bundle of the current edition reaches the tutor without another worker request',async()=>{
  for(const curated of [false,true]){
    const oriented=parts.map((part,i)=>({...part,orientation:orientations[i]}));
    const prepared=curated ? {...analysis,editorialRevision,parts:analysis.parts.map((part,i)=>({...part,orientation:orientations[i]}))} : analysis;
    const run=app(async({url})=>url===planEndpoint ?
      (curated ? readyPlan('plan-A') : {...readyPlan('plan-A',oriented),editorialRevision}) : reply('continue',''));
    await run.plan(marked,prepared);
    await run.api.ensureOrientation(key,source,prepared);
    await run.api.ensureOrientation(key,source,prepared,{retry:true});
    assert.equal(run.calls.length,1);
    assert.equal(run.study().orientationJob.status,'ready');
    assert.equal(run.study().editorialRevision,editorialRevision);
    assert.equal(run.api.needsEditorialReview(run.study()),false);
    assert.deepEqual(clean(run.study().parts.map(p=>p.orientation)),orientations);
    await run.ask('pair','Which points have partners?');
    assert.deepEqual(run.calls[1].body.stage.orientation,orientations[0]);
    assert.equal(run.calls[1].body.stage.opening,orientations[0].paragraphs[0]);
  }
});

test('unreviewed rich sections stay readable on failure and are replaced only by the current editorial revision',async()=>{
  const draft=orientations.map(o=>({...o,introduction:'Previously saved explanation. '+o.introduction}));
  const edited=orientations.map(o=>({...o,introduction:'Edited introduction. '+o.introduction,...(o.statement?{formalAfter:1}:{})}));
  const held=Promise.withResolvers(),replace=Promise.withResolvers();
  let submissions=0;
  const run=app(async({url,body})=>{
    if(url===questionEndpoint)return reply('continue','');
    if(!body.mode)return {...readyPlan('old-rich',parts.map((p,i)=>({...p,orientation:draft[i]}))),editorialRevision:'proof-craft-46f6f6b1-v1'};
    assert.deepEqual(body.existingSections,parts.map(({id},i)=>({id,orientation:draft[i]})));
    assert.deepEqual(body.existingOpenings,parts.map(({id,opening})=>({id,opening})));
    assert.deepEqual(body.readerKnowledge,marked);
    if(++submissions===1){held.resolve();return replace.promise;}
    const reviewed=orientationResult('review',edited);
    return {...reviewed,parts:reviewed.parts.reverse(),editorialSkill:{name:'naoma-editor',sha256:'fixture'}};
  });
  await run.plan(marked);
  await run.ask('pair','Which points have partners?');
  assert(run.api.finishPart(key,'pair'));
  const before=clean(run.study()),turns=clean(run.session().turns);
  assert(run.api.needsEditorialReview(run.study()));
  run.study().orientationJob={status:'running',format:3,key:'retired-job'};
  const updating=enrich(run);
  await held.promise;
  assert.equal(run.study().status,'ready');
  assert.equal(run.study().orientationJob.format,4);
  assert.equal(run.study().orientationJob.status,'starting');
  assert.deepEqual(clean(run.study().parts.map(p=>p.orientation)),draft);
  replace.resolve({...orientationResult('outdated',edited),editorialRevision:'another-edition'});
  await updating;
  assert.equal(run.study().orientationJob.status,'error');
  assert(run.api.needsEditorialReview(run.study()));
  assert.deepEqual(clean(run.study().parts.map(p=>p.orientation)),draft);
  await enrich(run);
  assert.equal(submissions,1);
  await enrich(run,{retry:true});
  assert.equal(run.study().editorialRevision,editorialRevision);
  assert.equal(run.study().editorialSkill.name,'naoma-editor');
  assert.deepEqual(clean(run.study().parts.map(p=>p.orientation)),edited);
  assert.equal(run.api.needsEditorialReview(run.study()),false);
  assert.deepEqual(clean(run.study().parts.map(({orientation,...part})=>part)),before.parts.map(({orientation,...part})=>part));
  assert.deepEqual(clean(run.study().completed),before.completed);
  assert.deepEqual(clean(run.session().turns),turns);
  const reopened=app(async()=>{throw Error('No second review needed');},run.local);
  await enrich(reopened);
  assert.equal(reopened.study().editorialRevision,editorialRevision);
  assert.equal(reopened.study().key,before.key);
  assert.equal(reopened.study().activeIndex,before.activeIndex);
  assert.deepEqual(reopened.calls,[]);
});

test('unreviewed bundled prior sections are supplied to the editorial worker and remain readable until the review returns',async()=>{
  const submitted=Promise.withResolvers(),release=Promise.withResolvers();
  const bundled={...analysis,parts:analysis.parts.map((p,i)=>({...p,orientation:orientations[i]}))};
  const run=app(async({body})=>{
    if(body.mode!=='orientation')return readyPlan('bundle-plan');
    assert.deepEqual(body.existingSections,bundled.parts.map(({id,orientation})=>({id,orientation})));
    submitted.resolve();return release.promise;
  });
  await run.plan(unmarked,bundled);
  const review=run.api.ensureOrientation(key,source,bundled);
  await submitted.promise;
  assert.equal(run.study().editorialRevision,undefined);
  assert(run.api.needsEditorialReview(run.study()));
  assert.deepEqual(clean(run.study().parts.map(p=>p.orientation)),orientations);
  const reviewed=orientations.map(o=>({...o,handoff:'An edited connection to the proof.'}));
  release.resolve(orientationResult('reviewed-bundle',reviewed));
  await review;
  assert.equal(run.study().editorialRevision,editorialRevision);
  assert.deepEqual(clean(run.study().parts.map(p=>p.orientation)),reviewed);
});

test('a stale tab saving progress adopts the reviewed text and keeps its own completion record',async()=>{
  const local=storage(),unreviewed=parts.map((part,i)=>({...part,orientation:orientations[i]}));
  const earlier=app(async()=>readyPlan('original',unreviewed),local);
  await earlier.plan();
  const stale=app(async()=>{throw Error('No worker required for reader completion');},local);
  await stale.api.restoreStudy(key);
  const reviewed=orientations.map(o=>({...o,introduction:'Fresh edition: '+o.introduction}));
  const editor=app(async()=>orientationResult('review',reviewed),local);
  await enrich(editor);
  assert.equal(stale.study().editorialRevision,undefined);
  assert(stale.api.finishPart(key,'pair'));
  const restored=app(async()=>{throw Error('Unexpected duplicate review');},local);
  await enrich(restored);
  assert.equal(restored.study().editorialRevision,editorialRevision);
  assert.deepEqual(clean(restored.study().parts.map(p=>p.orientation)),reviewed);
  assert.equal(restored.study().activeIndex,1);
  assert.equal(restored.study().completed[0].partId,'pair');
  assert.deepEqual(restored.calls,[]);
});

test('background enrichment uses the original plan/profile and merges only orientation by stable part ID',async()=>{
  const posted=Promise.withResolvers(),done=Promise.withResolvers();
  const run=app(async({url,body})=>{
    if(url===questionEndpoint)return reply('continue','');
    if(body?.mode==='orientation'){posted.resolve();return done.promise;}
    return readyPlan('old-plan');
  });
  await run.plan(marked);
  await run.ask('pair','Why are pairs disjoint?');
  run.api.finishPart(key,'pair');
  const original=clean(run.study()),turns=clean(run.session().turns);
  const first=enrich(run);
  await posted.promise;
  const second=enrich(run);
  assert.equal(run.study().status,'ready');
  assert.equal(run.study().activeIndex,1);
  const payload=run.calls.at(-1).body;
  assert.deepEqual(payload.readerKnowledge,marked);
  assert.deepEqual(payload.units,(await source()).units);
  assert.deepEqual(payload.analysis.parts,analysis.parts);
  assert.equal(payload.analysis.revision,analysis.revision);
  assert.deepEqual(payload.existingOpenings,parts.map(({id,opening})=>({id,opening})));
  const result=orientationResult();
  // The saved plan remains authoritative even if the server returns extra fields or a different order.
  result.parts.reverse().forEach(part=>Object.assign(part,{title:'A different title',question:'A changed check?',opening:'Different explanation.'}));
  done.resolve(result);
  await Promise.all([first,second]);
  assert.equal(run.calls.filter(r=>r.body?.mode==='orientation').length,1);
  assert.equal(run.study().key,original.key);
  assert.equal(run.study().orientationJob.status,'ready');
  assert.deepEqual(clean(run.study().parts.map(p=>p.orientation)),orientations);
  assert.deepEqual(clean(run.study().parts.map(({orientation,...part})=>part)),original.parts);
  assert.deepEqual(clean(run.study().readerKnowledge),original.readerKnowledge);
  assert.deepEqual(clean(run.study().completed),original.completed);
  assert.deepEqual(clean(run.session().turns),turns);
  const reopened=app(async()=>{throw Error('Unexpected worker');},run.local);
  await enrich(reopened);
  assert.deepEqual(reopened.calls,[]);
  assert.equal(reopened.study().activeIndex,1);
  assert.deepEqual(clean(reopened.study().parts.map(p=>p.orientation)),orientations);
});

test('an in-flight orientation job resumes with its saved server key, and incomplete results need explicit retry',async()=>{
  const polling=Promise.withResolvers(),release=Promise.withResolvers();
  const first=app(async({url,body})=>{
    if(body?.mode==='orientation')return {key:'pending',status:'running'};
    if(url===planEndpoint+'/pending'){polling.resolve();return release.promise;}
    return readyPlan('original');
  });
  await first.plan();
  const pending=enrich(first);
  await polling.promise;
  const local=storage();
  local.setItem('proof.study.'+key,first.local.getItem('proof.study.'+key));
  release.resolve(orientationResult('pending'));
  await pending;
  const bad=orientationResult('pending');
  bad.parts[1].orientation={...orientations[1],handoff:'',statement:{kind:'Unsupported',text:'Invalid statement'}};
  const interrupted=app(async req=>{assert.equal(req.method,'GET');return bad;},local);
  await enrich(interrupted);
  assert.deepEqual(interrupted.calls.map(r=>r.url),[planEndpoint+'/pending']);
  assert.equal(interrupted.study().status,'ready');
  assert.equal(interrupted.study().orientationJob.status,'error');
  assert.ok(interrupted.study().orientationJob.message);
  assert.ok(interrupted.study().parts.every(part=>!part.orientation));
  await enrich(interrupted);
  assert.equal(interrupted.calls.length,1);
  const retried=app(async({body})=>{assert.equal(body.mode,'orientation');return orientationResult('succeeded');},local);
  await enrich(retried);
  assert.equal(retried.calls.length,0,'an error must stay retryable across reloads');
  await Promise.all([enrich(retried,{retry:true}),enrich(retried,{retry:true})]);
  assert.equal(retried.calls.length,1);
  assert.equal(retried.study().orientationJob.status,'ready');
  assert.equal(retried.study().key,'original');
});

test('late enrichment from another tab only updates its own saved plan and revision',async()=>{
  const local=storage(),posted=Promise.withResolvers(),release=Promise.withResolvers();
  const earlier=app(async({body})=>{
    if(body?.mode==='orientation'){posted.resolve();return release.promise;}
    return readyPlan('A');
  },local);
  await earlier.plan();
  const oldRun=enrich(earlier);
  await posted.promise;
  const forB=orientations.map(value=>({...value,introduction:'An explanation for a reader who knows involutions.'}));
  const later=app(async({url,body})=>{
    if(body?.mode==='orientation')return orientationResult('job-B',forB);
    return url===questionEndpoint ? reply('continue','') : readyPlan('B');
  },local);
  await later.api.restoreStudy(key);
  await later.plan(marked);
  await later.ask('pair','Can the endpoint have a partner?');
  assert.equal(later.api.finishPart(key,'pair'),true);
  await enrich(later);
  release.resolve(orientationResult('job-A'));
  await oldRun;
  const reopened=app(async()=>{throw Error('Unexpected request while reopening earlier plans');},local);
  await reopened.api.restoreStudy(key);
  assert.equal(reopened.study().key,'B');
  assert.equal(reopened.study().activeIndex,1);
  assert.deepEqual(clean(reopened.study().parts.map(p=>p.orientation)),forB);
  assert.deepEqual(clean(reopened.session().turns.map(t=>t.studyKey)),['B']);
  await reopened.plan();
  assert.equal(reopened.study().key,'A');
  assert.equal(reopened.study().activeIndex,0);
  assert.deepEqual(clean(reopened.study().parts.map(p=>p.orientation)),orientations);
  await reopened.api.ensureOrientation(key,source,{...analysis,revision:'unrelated'});
  assert.deepEqual(reopened.calls,[]);
});

test('interruption before a job ID and an expired job restore from the original saved source and choices',async()=>{
  for(const withId of [false,true]){
    const interrupted=Promise.withResolvers(),release=Promise.withResolvers();
    const snapshots=new Map();
    const library={savePreparation:async(k,value)=>snapshots.set(k,structuredClone(value)),
      getPreparation:async k=>structuredClone(snapshots.get(k))};
    const run=app(async({url,body})=>{
      if(body?.mode==='orientation' && withId)return {status:'running',key:'expired'};
      if(body?.mode==='orientation' || url.endsWith('/expired')){interrupted.resolve();return release.promise;}
      return readyPlan('old-plan');
    },storage(),library);
    await run.plan(marked);
    assert.equal(run.api.finishPart(key,'pair'),true);
    const job=enrich(run);
    await interrupted.promise;
    const saved=structuredClone(snapshots.get('study/'+key));
    release.resolve(orientationResult(withId?'expired':'finished'));
    await job;
    const cold=app(async({method,body})=>{
      if(method==='GET')return {httpStatus:404,error:'Server job expired.'};
      assert.equal(body.mode,'orientation');
      assert.deepEqual(body.readerKnowledge,marked);
      assert.deepEqual(body.units,(await source()).units);
      return orientationResult('recovered');
    },storage(),{getPreparation:async()=>structuredClone(saved)});
    await enrich(cold);
    assert.deepEqual(cold.calls.map(c=>c.method),withId?['GET','POST']:['POST']);
    assert.equal(cold.study().orientationJob.status,'ready');
    assert.equal(cold.study().key,'old-plan');
    assert.equal(cold.study().activeIndex,1);
    await enrich(cold);
    assert.equal(cold.calls.filter(c=>c.method==='POST').length,1);
  }
});

test('a stale tab cannot attach old introductions to a different revision even if a plan key is reused',async()=>{
  const local=storage(),posted=Promise.withResolvers(),release=Promise.withResolvers();
  const stale=app(async({body})=>{
    if(body.mode==='orientation'){posted.resolve();return release.promise;}
    return readyPlan('same-id');
  },local);
  await stale.plan();
  const oldRequest=enrich(stale);
  await posted.promise;
  const revised={...analysis,revision:'source-analysis-2'};
  const next=app(async()=>readyPlan('same-id'),local);
  await next.plan(unmarked,revised);
  await next.api.ensureOrientation(key,source,analysis);
  assert.equal(next.calls.length,1,'the previous revision must not generate introductions for the new revision');
  release.resolve(orientationResult());
  await oldRequest;
  const restored=app(async()=>{throw Error('Unexpected worker');},local);
  await restored.api.restoreStudy(key);
  assert.equal(restored.study().analysisKey,revised.revision);
  assert.ok(restored.study().parts.every(p=>!p.orientation));
  assert.deepEqual(restored.calls,[]);
});

test('two live tabs opening the same incomplete plan issue only one request while its job ID is still pending',async()=>{
  const local=storage(),pendingLocks=new Map(),posted=Promise.withResolvers(),release=Promise.withResolvers();
  const locks={request(name,work) {
    const run=(pendingLocks.get(name) || Promise.resolve()).then(work);
    pendingLocks.set(name,run.catch(()=>{}));
    return run;
  }};
  const started=app(async({body})=>{
    if(body.mode==='orientation'){posted.resolve();return release.promise;}
    return readyPlan('original');
  },local,undefined,locks);
  await started.plan();
  const other=app(async()=>{throw Error('A second tab must reuse the running request');},local,undefined,locks);
  const inFlight=enrich(started);
  await posted.promise;
  const joined=enrich(other);
  await new Promise(setImmediate);
  assert.deepEqual(other.calls,[]);
  release.resolve(orientationResult('both'));
  await Promise.all([inFlight,joined]);
  assert.deepEqual(other.calls,[]);
  assert.deepEqual(clean(other.study().parts.map(p=>p.orientation)),orientations);
});
