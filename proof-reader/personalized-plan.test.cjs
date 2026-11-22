const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const test = require('node:test');
const editorialFixture = require('./test-support/editorial-fixture.cjs');
const {createPlanHandler} = require('./personalized-plan.cjs');
const {prepareRequest} = require('./ask-paper.cjs');
const {editorialRevision} = require('./part-orientation.js');
const {notationRevision} = require('./notation-adaptation.cjs');

const endpoint = '/api/reading-plan';
const analysis = {
  preparationVersion: 2, displayTitle:'Counting a closed interval by pairing',
  parts: [
    {id:'pairing',title:'Construct the pairing',summary:'Pair the interior points and keep the endpoint.',
      sourceSteps:[1,2],techniqueIds:['pairing-method'],definitionGroupIds:['interval-language'],localPrerequisiteIds:[]},
    {id:'total',title:'Count with the endpoint',summary:'Apply the endpoint lemma before counting the pairs.',
      sourceSteps:[2],techniqueIds:['pairing-method'],definitionGroupIds:['interval-language'],localPrerequisiteIds:['endpoint-lemma']},
  ],
  localIntroductions:[{id:'endpoint-lemma',kind:'lemma',title:'Endpoint lemma',meaning:'One endpoint remains after pairing.',
    originPartId:'pairing'}],
  knowledge:{techniques:[{id:'pairing-method',name:'Double counting',mechanism:'Count the same set two ways.'}],
    definitionGroups:[{id:'interval-language',title:'Interval terms',definitions:[
      {term:'Closed interval',meaning:'Both endpoints belong to the interval.'},
      {term:'Fixed point',meaning:'The pairing sends this point to itself.'},
    ]}]},
};
const fixedPointQuote='A fixed point is a point that the pairing maps to itself.';
const orbitQuote='An orbit is the set of points reached by repeatedly applying the pairing.';
const singletonQuote='A singleton orbit is an orbit containing exactly one point.';
const source = {
  title:analysis.displayTitle, units:[
    {title:'Pair construction',text:'Lemma 2.1. The involution fixes the endpoint and pairs every interior point with a distinct partner.',page:1},
    {title:'The remaining endpoint',text:['By Lemma 2.1, the endpoint supplies the one fixed point. Add one to the pair total.',
      fixedPointQuote,orbitQuote,singletonQuote].join(' '),page:2},
  ],
};
const readerKnowledge = {techniques:[{name:'Double counting',mechanism:'Count the same objects twice.',
  knownBridge:'Apply the familiar count after removing the fixed point.',sources:[]}],
  definitionGroups:[{title:'Interval terms',state:'partial',knownTerms:['Closed interval'],remainingTerms:['Fixed point']}]};
const requestBody = {...source, analysis, readerKnowledge};
const previousOrientations=[
  {purpose:'Separate paired points from a fixed endpoint.',takeaway:'The endpoint is the only unpaired point.',
    handoff:'Keep that endpoint for the count.',statement:{kind:'Lemma',label:'Lemma 2.1',
      text:'The involution fixes the endpoint and pairs every interior point with a distinct partner.'}},
  {purpose:'Count the whole interval.',takeaway:'Add one point to the count of the pairs.',
    handoff:'The argument now counts the whole set.',statement:null},
];
const previousOpenings=[
  'Use your familiar pairing argument on the interior. The fixed endpoint still needs a separate count.',
  'The endpoint lemma from the first part leaves exactly one point outside the pairs.',
];
const generated = [
  {id:'pairing',question:'Which point is left over by the pairing?',
    orientation:{introduction:'Pairing reduces the count to the interior pairs and one endpoint.',
      notation:[{symbol:String.raw`\(e\)`,meaning:'The unpaired endpoint.'}],
      definitions:[{name:'Fixed point',text:'A point mapped to itself.',intuition:'Its partner is the point you started from.'}],
      paragraphs:['An involution returns each point to its starting position after two applications.',
        String.raw`Each interior point has a distinct partner. Only the endpoint \(e\) is fixed.`],
      handoff:'Keep the unpaired endpoint in view as you start counting.',statement:null}},
  {id:'total',question:'Why does the endpoint contribute exactly once?',
    orientation:{introduction:'The endpoint lemma leaves exactly one point outside the pairs.',notation:[],definitions:[],
      paragraphs:['Count two points for each pair and add the endpoint once.'],handoff:'',statement:null}},
];
const fixedPointEvidence={sourceStep:2,sourceQuote:fixedPointQuote,dependsOn:[]};
const authored=generated.map(part=>({...part,orientation:{...part.orientation,
  definitions:part.orientation.definitions.map(definition=>({...definition,...fixedPointEvidence}))}}));

async function cache(t) {
  const root=path.resolve(os.tmpdir());
  const dir=await fs.mkdtemp(path.join(root,'proof-reader-plan-test-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(dir)), root);
    assert(path.basename(dir).startsWith('proof-reader-plan-test-'));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  return dir;
}

function asEditorialRows(parts) {
  return parts.map(({id,orientation:{introduction,paragraphs,handoff,definitions,statement,formalAfter=0}})=>({id,introduction,paragraphs,handoff,
    formalAfter,referenceNotation:null,proseNotationCards:[],notationEvidence:[introduction,...paragraphs,...definitions.flatMap(d=>[d.name,d.text,d.intuition]),
      statement?.text,handoff].filter(s=>s && /\\[([]/u.test(s)),definitionCorrections:[],
    sourceCheck:'I checked the hypotheses and resulting conclusion against the original assigned passages.',unresolved:''}));
}

function client(cacheDir, worker, renderSourcePage, edit=async (_job,input)=>asEditorialRows(input.parts)) {
  const routeWorker=async job=>{
    if (path.basename(job.outputPath)!=='edited.json') return worker(job);
    const input=JSON.parse(await fs.readFile(path.join(job.directory,'editor-input.json'),'utf8'));
    const parts=await edit(job,input);
    await fs.writeFile(job.outputPath,JSON.stringify({parts}));
  };
  const handle=createPlanHandler({cacheDir,worker:routeWorker,renderSourcePage,waitForRecovery:async()=>{},
    readLocalJson:async req=>req.body,checkLocalRequest(){}});
  async function request(method,url,body) {
    let code,result;
    await handle({method,body},{writeHead(status){code=status;},end(data){result=JSON.parse(data);}},url);
    assert.equal(code,result.status==='running'?202:200);
    return result;
  }
  return {
    post:body=>request('POST',endpoint,body),
    get:key=>request('GET',endpoint+'/'+key),
    async finish(job) {
      const until=Date.now()+5000;
      while(job.status==='running' && Date.now()<until){
        await delay(10);
        job=await request('GET',endpoint+'/'+job.key);
      }
      assert.notEqual(job.status,'running','the mock worker did not settle');
      return job;
    },
  };
}

test('an opted-in plan finishes its grounded notation edition before drafting and reuses it across retries and restarts',async t=>{
  const cacheDir=await cache(t);
  const body=structuredClone(requestBody);
  const sourceQuote='Denote the unpaired endpoint by e.';
  const referenceQuote='Write z for the unique unpaired endpoint.';
  const printed='Lemma 2.2. The unpaired endpoint \\(e\\) is a fixed point.';
  body.units[0].text+='\n'+sourceQuote+'\n'+printed+'\nProof. The endpoint maps to itself.';
  const referencePdf=Buffer.from('%PDF-1.7\nprivate-reference-fixture\n%%EOF').toString('base64');
  body.notationReference={title:'Second pairing paper',units:[{title:'Conventions',text:referenceQuote}],pdfBase64:referencePdf};
  const started=Promise.withResolvers(),release=Promise.withResolvers();
  const edition={revision:notationRevision,referenceTitle:body.notationReference.title,
    mappings:[{original:'e',preferred:'z',concept:'the unique endpoint left unpaired',partIds:['pairing'],sourceStep:1,sourceQuote,referenceStep:1,referenceQuote}],
    overview:{paragraphs:['The pairing leaves one endpoint.'],suggestions:[{question:'What remains after forming the pairs?',step:1}]},
    parts:[{id:'pairing',title:'Pair the other points',reading:'The unpaired endpoint is \\(z\\).',sourceStep:1,sourceQuote},
      {id:'total',title:'Count the pairs and the endpoint',reading:'Add the unpaired endpoint to the pair total.',sourceStep:2,sourceQuote:fixedPointQuote}]};
  const stages=[];
  const before=client(cacheDir,async({directory,outputPath})=>{
    if (path.basename(outputPath)==='notation-map.json') {
      stages.push('map');
      const input=JSON.parse(await fs.readFile(path.join(directory,'target.json'),'utf8'));
      const reference=JSON.parse(await fs.readFile(path.join(directory,'reference.json'),'utf8'));
      assert.equal(input.units[0].text,body.units[0].text);
      assert.equal(reference.units[0].text,referenceQuote);
      assert.ok(!JSON.stringify(reference).includes(referencePdf));
      started.resolve();await release.promise;
      return fs.writeFile(outputPath,JSON.stringify({mappings:edition.mappings,retained:[]}));
    }
    if (path.basename(outputPath)==='notation-rewrite-0.json') {
      stages.push('rewrite');
      if (stages.filter(stage=>stage==='rewrite').length===1) return; // The CLI exited before creating its result.
      return fs.writeFile(outputPath,JSON.stringify({parts:edition.parts,overview:edition.overview,mappingIssue:''}));
    }
    stages.push('draft');
    throw Error('The Codex account reached a usage limit.');
  });
  const launched=await before.post(body);
  await started.promise;
  const pending=await before.get(launched.key);
  assert.equal(pending.progress.stage,'adapting-notation');
  assert.equal(pending.parts,undefined);
  assert.equal(pending.notationEdition,undefined);
  assert.deepEqual(stages,['map']);
  release.resolve();
  assert.equal((await before.finish(launched)).status,'error');
  assert.deepEqual(stages,['map','rewrite','rewrite','draft']);
  const revised=JSON.parse(JSON.stringify(authored).replaceAll('\\\\(e\\\\)','\\\\(z\\\\)'));
  revised[0].question='What happens to the endpoint \\(z\\)?';
  revised[0].orientation.introduction='The pairing leaves one endpoint, which we call \\(z\\). The printed lemma calls this same endpoint \\(e\\).';
  revised[0].orientation.notation.push({symbol:'\\(e\\)',meaning:'The original name of the unpaired endpoint in the printed lemma.'});
  revised[0].orientation.statement={kind:'Lemma',label:'Lemma 2.2',text:printed.slice('Lemma 2.2. '.length),sourceStep:1,sourceQuote:printed};
  const drafts=[];
  let repairSucceeds=false;
  const answerDraft=async({prompt,outputPath,directory})=>{
    assert.ok(!prompt.includes(referencePdf));
    assert.equal(JSON.parse(await fs.readFile(path.join(directory,'source.json'),'utf8'))[0].text,body.units[0].text);
    const name=path.basename(outputPath);
    drafts.push(name);
    if (name==='notation-fields.json') {
      const input=JSON.parse(await fs.readFile(path.join(directory,'notation-fields-input.json'),'utf8'));
      assert.equal(input.draft.id,'pairing');
      assert.equal(input.draft.question,'What happens to the endpoint \\(e\\)?');
      assert.deepEqual(input.requestedChanges.map(c=>[c.field,c.text]),[['question',input.draft.question]]);
      assert.equal(input.requestedChanges[0].mappings[0].concept,edition.mappings[0].concept);
      assert.ok(prompt.includes(JSON.stringify(input.draft.question)));
      return fs.writeFile(outputPath,JSON.stringify({changes:[{field:'question',text:repairSucceeds?revised[0].question:input.draft.question}]}));
    }
    assert.equal(name,'plan.json');
    assert.ok(prompt.includes(edition.parts[0].reading.replaceAll('\\','\\\\')));
    const output=structuredClone(revised);
    output[0].question='What happens to the endpoint \\(e\\)?';
    await fs.writeFile(outputPath,JSON.stringify({parts:output}));
  };
  const edit=async({prompt},input)=>{
    assert.ok(prompt.includes('the unique endpoint left unpaired'));
    assert.deepEqual(input.parts.map(p=>p.question),revised.map(p=>p.question));
    assert.deepEqual(input.parts[1].orientation,revised[1].orientation);
    return asEditorialRows(input.parts);
  };
  const resumed=client(cacheDir,answerDraft,undefined,edit);
  const pendingRepair=await resumed.finish(await resumed.post(body));
  assert.equal(pendingRepair.status,'error');
  assert.match(pendingRepair.message,/Construct the pairing/);
  assert.deepEqual(drafts,['plan.json','notation-fields.json','notation-fields.json']);
  repairSucceeds=true;
  const restarted=client(cacheDir,answerDraft,undefined,edit);
  const ready=await restarted.finish(await restarted.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(drafts,['plan.json','notation-fields.json','notation-fields.json','notation-fields.json'],'resuming the correction uses only the affected field');
  assert.equal(ready.parts[0].question,revised[0].question);
  assert.equal(ready.parts[0].orientation.statement.text,printed.slice('Lemma 2.2. '.length));
  assert.equal(ready.notationEdition.mappings[0].preferred,'z');
  assert.ok(!JSON.stringify(ready).includes(referencePdf));
  assert.ok(!(await fs.readFile(path.join(cacheDir,ready.key+'.json'),'utf8')).includes(referencePdf));
  assert.deepEqual(ready.notationEdition.overview,edition.overview);
  const cold=client(cacheDir,()=>assert.fail('recomputed a complete plan'));
  assert.deepEqual(await cold.post(body),ready);
  assert.deepEqual(await cold.get(ready.key),ready);
  let orientationDrafts=0;
  const upgrade=client(cacheDir,async ({outputPath,prompt})=>{
    assert.equal(path.basename(outputPath),'plan.json','reuse the finished plan’s notation edition for its orientation');
    assert.ok(prompt.includes('the unique endpoint left unpaired'));
    orientationDrafts++;
    await fs.writeFile(outputPath,JSON.stringify({parts:revised.map(({id,orientation})=>({id,orientation}))}));
  });
  const upgraded=await upgrade.finish(await upgrade.post({...body,mode:'orientation',
    existingOpenings:ready.parts.map(({id,opening})=>({id,opening}))}));
  assert.equal(upgraded.status,'ready',upgraded.message);
  assert.equal(orientationDrafts,1);
  assert.deepEqual(upgraded.notationEdition,ready.notationEdition);
  assert.equal(upgraded.parts[0].question,undefined);
  await assert.rejects(()=>cold.post({...body,notationReference:{title:'Title alone'}}),{status:400});
  const plain={...body,notationReference:undefined};
  const {readingPlanKey}=require('./personalized-plan.cjs');
  assert.notEqual(await readingPlanKey(plain),ready.key);
  const changed={...body,notationReference:{title:body.notationReference.title,units:[{text:'Write u for the unique unpaired endpoint.'}]}};
  assert.notEqual(await readingPlanKey(changed),ready.key);
  const otherPdf=Buffer.from('%PDF-1.7\nanother-reference-fixture\n%%EOF').toString('base64');
  assert.notEqual(await readingPlanKey({...body,notationReference:{...body.notationReference,pdfBase64:otherPdf}}),ready.key);
  assert.equal(await readingPlanKey({...body,notationReference:{...body.notationReference,id:'another-local-copy'}}),ready.key);
});

test('one personalized pass sees the checked profile and complete source; identical requests survive handler restart',async t=>{
  const cacheDir=await cache(t);
  const seen=[];
  const started=Promise.withResolvers();
  const release=Promise.withResolvers();
  const api=client(cacheDir,async ({directory,outputPath,schemaPath,prompt,webSearch})=>{
    const data=async filename=>JSON.parse(await fs.readFile(path.join(directory,filename),'utf8'));
    const [catalog,choices,units,batch,schema]=await Promise.all([data('analysis.json'),data('choices.json'),data('source.json'),
      data('batch.json'),fs.readFile(schemaPath,'utf8').then(JSON.parse)]);
    seen.push({catalog,choices,units,batch,schema,prompt,webSearch});
    started.resolve();
    await release.promise;
    await fs.writeFile(outputPath,JSON.stringify({parts:authored.map(row=>({...row,title:'Worker-supplied title',sourceSteps:[999]}))}));
  });
  const first=await api.post(requestBody);
  const received=await Promise.race([started.promise.then(()=>true),delay(5000,false,{ref:false})]);
  assert.ok(received,'the mock worker did not receive the request');
  assert.equal(first.status,'running');
  assert.match(first.key,/^[a-f0-9]{64}$/);
  assert.equal((await api.post(structuredClone(requestBody))).key,first.key);
  const writing=await api.get(first.key);
  assert.equal(writing.status,'running');
  assert.equal(writing.progress.stage,'drafting');
  assert.deepEqual([writing.progress.firstPart,writing.progress.lastPart,writing.progress.completedParts,writing.progress.totalParts],[1,2,0,2]);
  assert.ok(writing.progress.startedAt>0 && writing.progress.updatedAt>=writing.progress.startedAt);
  assert.equal(writing.progress.reviewStartPart,0);
  assert.ok(writing.progress.reviewStartedAt>=writing.progress.startedAt);
  assert.ok(writing.progress.phaseStartedAt>=writing.progress.reviewStartedAt);
  assert.equal((await api.get(first.key)).progress.phaseStartedAt,writing.progress.phaseStartedAt);
  assert.deepEqual((await api.post(structuredClone(requestBody))).progress,writing.progress);
  assert.equal(seen.length,1);
  release.resolve();
  const ready=await api.finish(first);
  assert.equal(ready.status,'ready');
  assert.deepEqual(ready.progress,{stage:'ready',completedParts:2,totalParts:2,firstPart:null,lastPart:null});
  assert.deepEqual(ready.parts,generated.map((row,i)=>({...row,title:analysis.parts[i].title,sourceSteps:analysis.parts[i].sourceSteps,
    opening:row.orientation.paragraphs.join('\n\n')})));
  assert.deepEqual(seen[0].catalog.localIntroductions,analysis.localIntroductions);
  assert.equal(seen[0].catalog.parts[1].localPrerequisiteIds[0],'endpoint-lemma');
  assert.deepEqual(seen[0].choices,readerKnowledge);
  assert.deepEqual(seen[0].batch.definitionGroups[0].terms.map(({term,familiarity})=>[term,familiarity]),
    [['Closed interval','known'],['Fixed point','unconfirmed']]);
  assert.equal(seen[0].batch.localIntroductions[0].originPartId,'pairing');
  assert.deepEqual(seen[0].units,source.units.map((unit,i)=>({step:i+1,...unit})));
  assert.match(seen[0].prompt,/Double counting/);
  const sectionSchema=seen[0].schema.properties.parts.items.properties.orientation;
  assert.deepEqual([...sectionSchema.required].sort(),['introduction','notation','definitions','paragraphs','handoff','statement'].sort());
  assert.deepEqual([...sectionSchema.properties.notation.items.required].sort(),['meaning','symbol']);
  const definitionFields=sectionSchema.properties.definitions.items.required;
  assert.ok(['name','text','sourceStep','sourceQuote','dependsOn'].every(field=>definitionFields.includes(field)));
  assert.equal(sectionSchema.properties.paragraphs.items.type,'string');
  for (const field of ['introduction','notation','definitions','paragraphs','handoff']) assert.match(seen[0].prompt,new RegExp(field,'i'));
  assert.match(seen[0].prompt,/previously introduced symbols[\s\S]{0,130}(?:known|familiar)/i);
  assert.match(seen[0].prompt,/dependenc(?:y|ies)[ -]first|prerequisite[\s\S]{0,80}before/i);
  assert.match(seen[0].prompt,/defining text[^.]{0,100}all defining conditions and formulas/i);
  assert.match(seen[0].prompt,/condition[^.]{0,100}proof branch[^.]{0,100}(?:bound|estimate)[^.]{0,100}proof paragraphs/i);
  assert.match(seen[0].prompt,/theorem/i);
  assert.equal(seen[0].webSearch,false);
  let repeated=0;
  const restored=client(cacheDir,async()=>{repeated++;throw Error('unexpected regeneration');});
  assert.deepEqual(await restored.get(first.key),ready);
  assert.deepEqual(await restored.post(requestBody),ready);
  assert.equal(repeated,0);
  const changed=structuredClone(requestBody);
  changed.readerKnowledge.definitionGroups[0]={title:'Interval terms',state:'known',knownTerms:['Closed interval','Fixed point'],remainingTerms:[]};
  const second=await api.finish(await api.post(changed));
  assert.equal(second.status,'ready');
  assert.notEqual(second.key,first.key);
  assert.deepEqual(seen[1].choices,changed.readerKnowledge);
  const differentSource=structuredClone(changed);
  differentSource.units[0].text += ' Each interior pair has two distinct members.';
  const third=await api.finish(await api.post(differentSource));
  assert.equal(third.status,'ready');
  assert.notEqual(third.key,second.key);
  const anotherRevision={...requestBody,analysis:{...analysis,revision:'revised-extraction'}};
  const revised=await api.finish(await api.post(anotherRevision));
  assert.equal(revised.status,'ready');
  assert.notEqual(revised.key,first.key);
});

test('a restarted service resumes the unfinished review and only serves the finished plan',async t=>{
  const cacheDir=await cache(t);
  const draft=({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:authored}));
  const first=client(cacheDir,draft,undefined,async (_job,input)=>{
    if (input.parts.length>1) throw Error('The paper agent timed out.');
    if (input.parts[0].id===authored[1].id) throw Error('The Codex account reached a usage limit.');
    return asEditorialRows(input.parts);
  });
  const failed=await first.finish(await first.post(requestBody));
  assert.equal(failed.status,'error');
  const checkpoint=path.join(cacheDir,failed.key+'.checkpoint');
  assert.ok((await fs.stat(checkpoint)).size>0);
  const reviewed=[];
  const restarted=client(cacheDir,()=>assert.fail('restarted a verified draft'),undefined,async (_job,input)=>{
    reviewed.push(...input.parts.map(p=>p.id));
    return asEditorialRows(input.parts);
  });
  await assert.rejects(()=>restarted.get(failed.key),{status:404});
  const ready=await restarted.finish(await restarted.post(requestBody));
  assert.equal(ready.status,'ready');
  assert.deepEqual(ready.parts.map(p=>p.id),authored.map(p=>p.id));
  assert.deepEqual(reviewed,[authored[1].id]);
  assert.deepEqual((await restarted.get(failed.key)).parts,ready.parts);
  assert.deepEqual((await first.get(failed.key)).parts,ready.parts);
  await assert.rejects(()=>fs.stat(checkpoint),{code:'ENOENT'});
});

test('drafts and completed visual source checks survive a worker interruption before grounding finishes',async t=>{
  const cacheDir=await cache(t);
  const pdf=Buffer.from('%PDF-1.7\nPairing test\n%%EOF'),raster=Buffer.from('The endpoint lemma on page two.');
  const ids=['first','second','third','fourth'];
  const body={...requestBody,pdfBase64:pdf.toString('base64'),units:[{title:'Pairing',text:'Page 2',page:2}],
    analysis:{...analysis,localIntroductions:[],parts:ids.map(id=>({id,title:'Pairing '+id,summary:'Identify the unpaired endpoint.',
      sourceSteps:[1],techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[]}))}};
  const statement=previousOrientations[0].statement;
  const raw={...statement,sourceStep:1,sourceQuote:statement.label+'. '+statement.text};
  let drafts=0,interrupt=true;
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),checks=[];
  const worker=async ({outputPath,prompt})=>{
    if (path.basename(outputPath)!=='verification.json') {
      drafts++;
      return fs.writeFile(outputPath,JSON.stringify({parts:ids.map(id=>({...authored[1],id,
        orientation:{...authored[1].orientation,statement:raw}}))}));
    }
    const targets=JSON.parse(prompt.split('Candidates: ').at(-1)).map(row=>row.id);
    checks.push(targets);
    if (checks.length===1) { entered.resolve(); await release.promise; }
    if (interrupt && targets.includes(ids[3])) throw new Error('The paper worker stopped during source review.');
    await fs.writeFile(outputPath,JSON.stringify({checks:targets.map(id=>({id,verified:id!==ids[1],label:statement.label,
      sourceText:statement.text,comparison:'The printed hypothesis and conclusion agree with the candidate.'}))}));
  };
  const first=client(cacheDir,worker,async ()=>raster);
  const active=await first.post(body);
  await entered.promise;
  try {
    const state=JSON.parse(await fs.readFile(path.join(cacheDir,active.key+'.checkpoint'),'utf8'));
    assert.deepEqual(new Map(state.batches).get(0).drafts.map(p=>p.id),ids);
    assert.equal((await first.get(active.key)).status,'running');
  } finally {release.resolve();}
  assert.equal((await first.finish(active)).status,'error');
  assert.deepEqual(checks,[ids.slice(0,3),ids.slice(3)]);
  assert.equal((await fs.readdir(cacheDir)).includes(active.key+'.json'),false);
  interrupt=false;
  const restarted=client(cacheDir,worker,async ()=>raster);
  const ready=await restarted.finish(await restarted.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(checks,[ids.slice(0,3),ids.slice(3),ids.slice(3)]);
  assert.equal(drafts,1);
  assert.deepEqual(ready.parts.map(p=>p.orientation.statement),[statement,null,statement,statement]);
});

test('a single preparation replaces only structurally invalid sections and keeps their valid siblings',async t=>{
  const cacheDir=await cache(t);
  let drafts=0;
  const requested=[];
  const worker=async ({outputPath,directory})=>{
    drafts++;
    const ids=JSON.parse(await fs.readFile(path.join(directory,'batch.json'),'utf8')).parts.map(p=>p.id);
    requested.push(ids);
    const parts=structuredClone(authored.filter(p=>ids.includes(p.id)));
    if (drafts===1) parts[1].orientation.paragraphs=[];
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  };
  const api=client(cacheDir,worker);
  const ready=await api.finish(await api.post(requestBody));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(drafts,2);
  assert.deepEqual(requested,[['pairing','total'],['total']]);
  assert.deepEqual(ready.parts.map(p=>p.question),authored.map(p=>p.question));
  assert.deepEqual(ready.parts[0].orientation,generated[0].orientation);
});

test('a stray NUL before a complete self-check formula can be removed without redrafting the section',async t=>{
  const body=structuredClone(requestBody),cacheDir=await cache(t);
  const cases=[
    ['Why does \u0000\\(|A|<m\\) imply that a place is free?',true],
    ['\u0000\\[|A|<m\\] Which places remain?',true],
    ['Which wo\u0000rd belongs here?',false],
    ['Which word\u0000\\(A\\) belongs here?',false],
    ['Where does \\(A \u0000\\le B\\) hold?',false],
    ['Why does \u0000\\(A<B hold?',false],
    ['Why does \u0000\\(\\unknowncommand{A}\\) hold?',false],
    ['Why does \u0000\\(A\\) satisfy \\(\\unknowncommand{B}\\)?',false],
  ];
  let question,drafts=0,repairs=0;
  const api=client(cacheDir,async ({outputPath})=>{
    if (path.basename(outputPath)==='format-fields.json') {
      repairs++;
      return fs.writeFile(outputPath,JSON.stringify({changes:[{field:'question',text:question}]}));
    }
    drafts++;
    const rows=structuredClone(authored);
    rows[0].question=question;
    return fs.writeFile(outputPath,JSON.stringify({parts:rows}));
  });
  for (const [index,[text,accepted]] of cases.entries()) {
    question=text; drafts=repairs=0; body.analysis.revision='math boundary '+index;
    const result=await api.finish(await api.post(body));
    assert.equal(drafts,1);
    if (accepted) {
      assert.equal(repairs,0);
      assert.equal(result.status,'ready',result.message);
      assert.equal(result.parts[0].question,text.replace('\u0000',''));
    } else {
      assert.equal(result.status,'error');
      assert.equal(repairs,2,'recovery retries the damaged field and stops if it is still invalid');
      const history=new Map(JSON.parse(await fs.readFile(path.join(cacheDir,result.key+'.checkpoint'),'utf8')).batches);
      assert.equal(history.get(0).drafts[0].question,text);
    }
  }
});

test('a legacy formatting failure reuses a uniquely matched source formula and the other saved drafts',async t=>{
  const body=structuredClone(requestBody),cacheDir=await cache(t),rows=structuredClone(authored);
  const line='The endpoint satisfies \\(e\\ge 0\\).';
  body.units[1].text+=' '+line;
  rows[0].orientation.paragraphs.push(line.replace('e\\ge','e\u000b\\ge'));
  const key=await require('./personalized-plan.cjs').readingPlanKey(body);
  await require('./plan-checkpoints.cjs').planCheckpoints(cacheDir,key,1e7).save(new Map([[0,{drafts:rows,
    replace:[{id:rows[0].id,reason:'Incomplete personalized reading plan: use clean prose and delimited math.'}]}]]));
  let extra=0;
  const api=client(cacheDir,async()=>{extra++;throw Error('The source already supplies the exact complete formula.');});
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(ready.parts[0].orientation.paragraphs.at(-1),line);
  assert.equal(ready.parts[1].question,rows[1].question);
  assert.equal(extra,0);
});

test('an unmatched corrupted draft can repair just its affected field within the same preparation',async t=>{
  const body=structuredClone(requestBody),cacheDir=await cache(t),rows=structuredClone(authored);
  body.units[1].text+=' The endpoint has nonnegative coordinate.';
  const line='The endpoint therefore satisfies \\(e\\ge 0\\).';
  rows[0].orientation.paragraphs.push(line.replace('e\\ge','e\u000b\\ge'));
  const index=rows[0].orientation.paragraphs.length-1;
  let calls=0,repairs=0;
  const api=client(cacheDir,async({directory,outputPath})=>{
    if (path.basename(outputPath)==='format-fields.json') {
      repairs++;
      const input=JSON.parse(await fs.readFile(path.join(directory,'format-fields-input.json'),'utf8'));
      assert.equal(input.part.id,rows[0].id);
      assert.deepEqual(input.requestedChanges.map(x=>[x.field,x.invalidCharacter]),[['paragraphs.'+index,'U+000B']]);
      return fs.writeFile(outputPath,JSON.stringify({changes:[{field:'paragraphs.'+index,text:line}]}));
    }
    calls++;
    await fs.writeFile(outputPath,JSON.stringify({parts:rows}));
  });
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(calls,1);
  assert.equal(repairs,1);
  assert.deepEqual(ready.parts[0].orientation.paragraphs,[...rows[0].orientation.paragraphs.slice(0,-1),line]);
  assert.deepEqual(ready.parts[1].orientation.paragraphs,rows[1].orientation.paragraphs);
});

test('an unmatched definition exposes its section and the number of saved drafts',async t=>{
  const rows=structuredClone(authored);
  rows[0].orientation.definitions[0].sourceQuote='A fixed point is any point between two adjacent orbits.';
  const api=client(await cache(t),async ({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:rows})));
  const failed=await api.finish(await api.post(requestBody));
  assert.equal(failed.status,'error');
  assert.deepEqual(failed.progress.sourceDefinitions,[{part:1,name:'Fixed point'}]);
  assert.equal(failed.progress.draftedParts,2);
  assert.equal(failed.progress.completedParts,0);
});

test('exhausted source evidence defers only dependent parts, then a cold retry publishes the whole ordered plan',async t=>{
  const cacheDir=await cache(t),ids=['setup','origin','consumer','separate','uses-separate','indirect','late-independent'];
  const refs=[[],[],['origin-result'],[],['separate-result'],['consumer-result'],[]];
  const body={...requestBody,analysis:{...analysis,parts:ids.map((id,i)=>({
    id,title:'Argument '+id,summary:'Count the fixed endpoint once.',sourceSteps:[2],
    techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:refs[i],
  })),localIntroductions:['origin','consumer','separate'].map(id=>({
    id:id+'-result',originPartId:id,kind:'lemma',title:'Result for '+id,meaning:'An endpoint stays fixed.',
  }))}};
  let corrected=false,alsoSeparate=false;
  const drafting=[],repairing=[],reviewing=[];
  function row(id) {
    const hasDefinition=id==='origin' || (alsoSeparate && id==='separate');
    const part=structuredClone(hasDefinition?authored[0]:authored[1]);
    part.id=id;
    if (hasDefinition && !corrected) part.orientation.definitions[0].sourceQuote='An unsupported quotation for the fixed endpoint.';
    return part;
  }
  const worker=async ({directory,outputPath,prompt})=>{
    let contents;
    if (path.basename(outputPath)==='definition-recovery.json') {
      contents={parts:[{id:'origin',definitions:[]}]};
    } else if (prompt.includes('The original drafts are in drafts.json.')) {
      const targets=JSON.parse(await fs.readFile(path.join(directory,'drafts.json'),'utf8'));
      repairing.push(targets.map(t=>t.id));
      contents={parts:targets.map(t=>row(t.id))};
    } else {
      const batch=JSON.parse(await fs.readFile(path.join(directory,'batch.json'),'utf8')).parts;
      drafting.push(batch.map(p=>p.id));
      contents={parts:batch.map(p=>row(p.id))};
    }
    await fs.writeFile(outputPath,JSON.stringify(contents));
  };
  const edit=async (_job,input)=>{
    reviewing.push(input.parts.map(p=>p.id));return asEditorialRows(input.parts);
  };
  const first=client(cacheDir,worker,undefined,edit);
  const failed=await first.finish(await first.post(body));
  assert.equal(failed.status,'error',failed.message);
  assert.deepEqual(failed.progress.blockedParts,[2]);
  assert.deepEqual(failed.progress.waitingParts,[3,6]);
  assert.deepEqual([failed.progress.firstPart,failed.progress.lastPart],[2,2]);
  assert.deepEqual([failed.progress.draftedParts,failed.progress.completedParts],[6,4]);
  assert.deepEqual(drafting,[ids.slice(0,5),['late-independent']]);
  assert.deepEqual(reviewing,[['setup'],['separate','uses-separate'],['late-independent']]);
  const history=new Map(JSON.parse(await fs.readFile(path.join(cacheDir,failed.key+'.checkpoint'),'utf8')).batches);
  assert.deepEqual(history.get(1).unverifiedDefinitions,['Fixed point']);
  assert.deepEqual(history.get(2).drafts.map(p=>p.id),['consumer']);
  assert.equal(failed.parts,undefined);
  await assert.rejects(fs.stat(path.join(cacheDir,failed.key+'.json')),{code:'ENOENT'});
  drafting.length=0;repairing.length=0;reviewing.length=0;
  const unresolved=client(cacheDir,worker,undefined,edit);
  const again=await unresolved.finish(await unresolved.post(body));
  assert.equal(again.status,'error');
  assert.deepEqual(again.progress.blockedParts,[2]);
  assert.deepEqual(again.progress.waitingParts,[3,6]);
  assert.deepEqual(drafting,[]);assert.deepEqual(reviewing,[]);
  assert.deepEqual(repairing,[['origin'],['origin']],'both recovery passes operate on the same unverified prerequisite');
  corrected=true;drafting.length=0;repairing.length=0;reviewing.length=0;
  const cold=client(cacheDir,worker,undefined,edit);
  const ready=await cold.finish(await cold.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(ready.parts.map(p=>p.id),ids);
  assert.deepEqual(drafting,[['indirect']],'only the previously undrafted dependent needs new prose');
  assert.deepEqual(repairing,[['origin']]);
  assert.deepEqual(reviewing,[['origin'],['consumer'],['indirect']]);
  corrected=false;alsoSeparate=true;
  const multiple=client(await cache(t),worker,undefined,edit);
  const two=await multiple.finish(await multiple.post(body));
  assert.equal(two.status,'error');
  assert.deepEqual(two.progress.blockedParts,[2,4]);
  assert.deepEqual(two.progress.waitingParts,[3,5,6]);
  assert.deepEqual(two.progress.sourceDefinitions.map(d=>d.part),[2,4]);
  assert.equal(two.progress.completedParts,2);
  alsoSeparate=false;
  const legacy=structuredClone(body);
  delete legacy.analysis.parts.at(-1).localPrerequisiteIds;
  const old=client(await cache(t),worker,undefined,edit);
  const unknown=await old.finish(await old.post(legacy));
  assert.equal(unknown.key,failed.key,'legacy dependency detection must preserve the existing plan address');
  assert.deepEqual(unknown.progress.waitingParts,[3,6,7],'a missing legacy list supplies no evidence of independence');
  assert.equal(unknown.progress.completedParts,3);
});

test('an incomplete source repair preserves corrected siblings and retries just the remaining notation gap',async t=>{
  const cacheDir=await cache(t),body=structuredClone(requestBody),rows=structuredClone(authored);
  const symbol='\\(w\\)',sentence='Let '+symbol+' denote the weight of the remaining endpoint.';
  rows[1].orientation.introduction=sentence; body.units[1].text+=' '+sentence;
  const entry={symbol,meaning:'The weight of the remaining endpoint.'};
  const calls=[];
  let retry=false;
  const worker=async ({directory,outputPath,prompt})=>{
    const repair=prompt.includes('The original drafts are in drafts.json.');
    if (!repair) {
      calls.push('draft');
      const parts=structuredClone(rows); parts[0].orientation.notation=[];
      return fs.writeFile(outputPath,JSON.stringify({parts}));
    }
    const targets=JSON.parse(await fs.readFile(path.join(directory,'drafts.json'),'utf8'));
    calls.push(targets.map(t=>t.id));
    const parts=targets.map(({id})=>structuredClone(rows.find(p=>p.id===id)));
    const first=parts.find(p=>p.id==='pairing');
    if (first) first.orientation.definitions=[];
    if (retry) {
      assert.match(targets[0].reason,/notation w/);
      parts[0].orientation.notation=[entry];
    }
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  };
  const first=client(cacheDir,worker);
  const failed=await first.finish(await first.post(body));
  assert.equal(failed.status,'error');
  assert.match(failed.message,/Count with the endpoint.*notation w/);
  assert.equal(failed.progress.draftedParts,2);
  assert.equal(failed.progress.completedParts,1);
  const state=JSON.parse(await fs.readFile(path.join(cacheDir,failed.key+'.checkpoint'),'utf8'));
  const held=new Map(state.batches);
  assert.deepEqual(held.get(0).edited.map(p=>p.id),['pairing']);
  assert.deepEqual(held.get(1).drafts.map(p=>p.id),['total']);
  retry=true;
  const cold=client(cacheDir,worker);
  const ready=await cold.finish(await cold.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(calls,['draft',['pairing','total'],['total'],['total'],['total']]);
  assert.deepEqual(ready.parts[1].orientation.notation,[entry]);
});

test('a draft timeout reduces the work before retry and preserves wider completed checkpoints after a restart',async t=>{
  const cacheDir=await cache(t);
  const ids=Array.from({length:8},(_,i)=>'case-'+i);
  const body={...requestBody,analysis:{...analysis,localIntroductions:[],parts:ids.map(id=>({
    id,title:'Count the pairs in '+id,summary:'The endpoint contributes once.',sourceSteps:[2],
    techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[],
  }))}};
  const requests=[];
  let quota=true;
  const worker=async ({directory,outputPath})=>{
    const rows=JSON.parse(await fs.readFile(path.join(directory,'batch.json'),'utf8')).parts;
    requests.push(rows.map(p=>p.id));
    if(rows[0].id===ids[5] && rows.length>1) throw Error('The paper agent timed out.');
    if(quota && rows[0].id===ids[6]) throw Error('The Codex account reached a usage limit.');
    await fs.writeFile(outputPath,JSON.stringify({parts:rows.map(p=>({...authored[1],id:p.id}))}));
  };
  const first=client(cacheDir,worker);
  const failure=await first.finish(await first.post(body));
  assert.equal(failure.status,'error');
  assert.match(failure.message,/usage limit/i);
  assert.deepEqual(requests,[ids.slice(0,5),ids.slice(5),ids.slice(5,7),[ids[5]],[ids[6]]]);
  quota=false;
  requests.length=0;
  const restarted=client(cacheDir,worker);
  const ready=await restarted.finish(await restarted.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(requests,[[ids[6]],[ids[7]]]);
  assert.deepEqual(ready.parts.map(p=>p.id),ids);
});

test('a slow editorial group narrows past the first split and checks each remaining section once',async t=>{
  const cacheDir=await cache(t);
  const ids=['case-a','case-b','case-c','case-d','case-e'];
  const body={...requestBody,analysis:{...analysis,localIntroductions:[],parts:ids.map(id=>({
    id,title:'Count the pairs in '+id,summary:'The endpoint contributes once.',sourceSteps:[2],
    techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[],
  }))}};
  const attempted=[];
  const api=client(cacheDir,({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:ids.map(id=>({...authored[1],id}))})),
    undefined,async (_job,input)=>{
      attempted.push(input.parts.map(p=>p.id));
      if(input.parts.length>1) throw Error('The paper agent timed out.');
      return asEditorialRows(input.parts);
    });
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(attempted,[ids,ids.slice(0,3),ids.slice(0,2),...ids.map(id=>[id])]);
  assert.deepEqual(ready.parts.map(p=>p.id),ids);
});

test('a timed-out editorial batch splits once, keeps verified parts, and reports a later worker failure on the affected part',async t=>{
  const cacheDir=await cache(t),held=Promise.withResolvers(),release=Promise.withResolvers();
  let drafts=0,failSecond=true;
  const reviewed=[];
  const api=client(cacheDir,async ({outputPath})=>{
    drafts++;
    await fs.writeFile(outputPath,JSON.stringify({parts:authored}));
  },undefined,async (_job,input)=>{
    const ids=input.parts.map(p=>p.id);
    reviewed.push(ids);
    if (ids.length===2) throw Error('The paper agent timed out.');
    if (ids[0]===authored[1].id && failSecond) {
      held.resolve();
      await release.promise;
      throw Error('The Codex account reached a usage limit.');
    }
    return asEditorialRows(input.parts);
  });
  const first=await api.post(requestBody);
  await held.promise;
  const editing=await api.get(first.key);
  assert.equal(editing.progress.stage,'editing');
  assert.deepEqual([editing.progress.completedParts,editing.progress.totalParts,editing.progress.firstPart,editing.progress.lastPart],[1,2,2,2]);
  assert.equal(editing.parts,undefined);
  release.resolve();
  const failed=await api.finish(first);
  assert.equal(failed.status,'error');
  assert.match(failed.message,/usage limit/i);
  assert.deepEqual(failed.progress,editing.progress);
  assert.equal(await fs.stat(path.join(cacheDir,failed.key+'.json')).catch(()=>null),null);
  failSecond=false;
  const retry=await api.post(requestBody);
  assert.equal(retry.progress.completedParts,1);
  assert.equal((await api.finish(retry)).status,'ready');
  assert.equal(drafts,1);
  assert.deepEqual(reviewed,[[authored[0].id,authored[1].id],[authored[0].id],[authored[1].id],[authored[1].id]]);
});

test('a reader-installed editorial skill is staged for the worker and gets a distinct cache identity',async t=>{
  const dir=await cache(t);
  const root=path.join(dir,'editor');
  await fs.mkdir(path.join(root,'references'),{recursive:true});
  const names=['SKILL.md','REFERENCE.md','references/halmos-exposition.md','references/finite-reductions.md'];
  const contents=names.map(name=>'Local test guidance for '+name+'.');
  await Promise.all(names.map((filename,i)=>fs.writeFile(path.join(root,filename),contents[i])));
  const previous=process.env.NAOMA_PROOF_CRAFT_DIR;
  t.after(()=>{if(previous===undefined)delete process.env.NAOMA_PROOF_CRAFT_DIR;else process.env.NAOMA_PROOF_CRAFT_DIR=previous;});
  const {readingPlanKey}=require('./personalized-plan.cjs');
  const baseline=await readingPlanKey(requestBody);
  process.env.NAOMA_PROOF_CRAFT_DIR=root;
  const customized=await readingPlanKey(requestBody);
  assert.notEqual(customized,baseline);
  const api=client(dir,({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:authored})),undefined,async(job,input)=>{
    assert.ok(job.prompt.includes('proof-craft'));
    for (const [i,name] of names.entries()) {
      assert.ok(job.prompt.includes(contents[i]));
      assert.equal(await fs.readFile(path.join(job.directory,'skills','proof-craft',name),'utf8'),contents[i]);
    }
    return asEditorialRows(input.parts);
  });
  const ready=await api.finish(await api.post(requestBody));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(ready.key,customized);
});

test('every newly generated batch is edited against the original paper before its sections are cached',async t=>{
  const cacheDir=await cache(t);
  const parts=Array.from({length:13},(_,i)=>({id:'part-'+(i+1),title:'Count the endpoint in case '+(i+1),
    summary:'Account separately for the fixed endpoint.',sourceSteps:[i+1],techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[]}));
  const units=parts.map((p,i)=>({title:p.title,text:'In case '+(i+1)+
    ', the interior points come in pairs. The endpoint contributes one more point.',page:i+1}));
  const body={title:'Counting by pairing',units,readerKnowledge:{techniques:[],definitionGroups:[]},
    analysis:{preparationVersion:2,displayTitle:'Counting by pairing',parts,localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}}};
  const draft={introduction:'Count the pairs and then count the endpoint.',notation:[],definitions:[],
    paragraphs:['The points other than the endpoint occur in pairs. The endpoint counts once.'],handoff:'',statement:null};
  const rewrite='Set the endpoint aside. Each remaining pair contributes two points. Restore the endpoint to add the final point.';
  const question='Why does the endpoint contribute once?';
  const skillFiles=[];
  const hash=createHash('sha256');
  for (const name of editorialFixture.names) {
    const relative=path.join('skills','proof-craft',name);
    const contents=await fs.readFile(path.join(editorialFixture.directory,name),'utf8');
    skillFiles.push({relative,contents});
    hash.update(name).update('\0').update(contents.replace(/\r\n/g,'\n')).update('\0');
  }
  const digest=hash.digest('hex');
  const sequence=[];
  const api=client(cacheDir,async ({directory,schemaPath,outputPath})=>{
    const batch=JSON.parse(await fs.readFile(path.join(directory,'batch.json'),'utf8'));
    const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
    const full=schema.properties.parts.items.required.includes('question');
    sequence.push(['draft',batch.parts.map(p=>p.id)]);
    const rows=batch.parts.map(({id})=>({id,orientation:draft,...(full?{question}:{})}));
    await fs.writeFile(outputPath,JSON.stringify({parts:rows}));
  },undefined,async (job,input)=>{
    const ids=input.parts.map(p=>p.id);
    sequence.push(['edit',ids]);
    assert.equal(path.basename(job.schemaPath),'editor-schema.json');
    assert.equal(job.webSearch,false);
    assert.match(job.prompt,/proof-craft/i);
    for (const {relative,contents} of skillFiles) {
      assert.equal(await fs.readFile(path.join(job.directory,relative),'utf8'),contents,relative);
      assert.ok(job.prompt.includes(contents),relative+' must be available to the editor in full');
    }
    const read=async name=>JSON.parse(await fs.readFile(path.join(job.directory,name),'utf8'));
    const [batch,evidence,schema]=await Promise.all([read('batch.json'),read('source.json'),read('editor-schema.json')]);
    assert.deepEqual(batch.parts.map(p=>p.id),ids);
    assert.deepEqual(evidence,units.map((u,i)=>({step:i+1,...u})));
    const editShape=schema.properties.parts.items;
    assert.deepEqual(editShape.required.toSorted(),['definitionCorrections','formalAfter','handoff','id','introduction','notationEvidence','paragraphs','proseNotationCards','referenceNotation','sourceCheck','unresolved']);
    assert.ok(editShape.properties.definitionCorrections);
    assert.equal(schema.properties.parts.items.additionalProperties,false);
    for (const part of input.parts) assert.deepEqual(part.orientation,draft);
    return asEditorialRows(input.parts).map(row=>({...row,paragraphs:[rewrite]}));
  });
  const completed=[];
  for (const mode of ['plan','orientation']) {
    sequence.length=0;
    const ready=await api.finish(await api.post({...body,mode}));
    assert.equal(ready.status,'ready',ready.message);
    assert.equal(ready.editorialRevision,editorialRevision);
    assert.equal(ready.editorialSkillDigest,digest);
    const batches=sequence.filter(([operation])=>operation==='draft').map(([,ids])=>ids);
    assert.ok(batches.length>1);
    assert.deepEqual(batches.flat(),parts.map(p=>p.id));
    assert.deepEqual(sequence,batches.flatMap(ids=>[['draft',ids],['edit',ids]]));
    assert.deepEqual(ready.parts.map(p=>p.id),parts.map(p=>p.id));
    for (const part of ready.parts) {
      assert.deepEqual(part.orientation,{...draft,paragraphs:[rewrite]});
      assert.equal(part.question,mode==='plan'?question:undefined);
      assert.equal(part.opening,mode==='plan'?rewrite:undefined);
    }
    assert.doesNotMatch(JSON.stringify(ready),/sourceCheck|notationEvidence|referenceNotation|unresolved/);
    completed.push(ready);
  }
  assert.notEqual(completed[0].key,completed[1].key);
  assert.equal(completed[0].editorialSkillDigest,completed[1].editorialSkillDigest);
  const unexpected=async()=>{throw Error('Cached sections unexpectedly called the worker');};
  const fresh=client(cacheDir,unexpected,undefined,unexpected);
  for (const [i,mode] of ['plan','orientation'].entries()) {
    assert.deepEqual(await fresh.get(completed[i].key),completed[i]);
    assert.deepEqual(await fresh.post({...body,mode}),completed[i]);
  }
});

test('large editorial batches split between whole sections and keep every draft, source passage and skill inline',async t=>{
  const cacheDir=await cache(t);
  function passage(label,budget) {
    const sentence='Each interior pair contributes two points to the count. ';
    return label+'. '+sentence.repeat(Math.floor((budget-2*label.length-20)/sentence.length))+'End of '+label+'.';
  }
  const parts=['left','middle','oversized'].map((id,i)=>({id,title:'Case '+id,summary:'Count the interior pairs and the endpoint.',
    sourceSteps:[i+1],techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[]}));
  const units=parts.map(p=>({title:p.title,text:'Original passage for '+p.id+'. Removing the fixed endpoint leaves pairs.'}));
  const drafts=new Map(parts.map(({id})=>[id,{introduction:'Treat the endpoint separately in the '+id+' case.',
    paragraphs:Array.from({length:16},(_,i)=>passage(id+' argument '+(i+1),3400)),handoff:'Complete the '+id+' count.',
    definitions:[],statement:null,notation:id==='oversized'?Array.from({length:60},(_,i)=>({symbol:'Family '+(i+1),
      meaning:passage('Glossary entry '+(i+1),950)})):[]}]));
  assert.ok(JSON.stringify(drafts.get('left')).length<96000 && JSON.stringify(drafts.get('middle')).length<96000);
  assert.ok(JSON.stringify([drafts.get('left'),drafts.get('middle')]).length>96000);
  assert.ok(JSON.stringify(drafts.get('oversized')).length>96000);
  const body={title:'Three pairing cases',units,readerKnowledge:{techniques:[],definitionGroups:[]},
    analysis:{preparationVersion:2,displayTitle:'Three pairing cases',parts,localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}}};
  const guidance=await Promise.all(editorialFixture.names.map(name=>fs.readFile(path.join(editorialFixture.directory,name),'utf8')));
  const groundGroups=[],reviews=[];
  const api=client(cacheDir,async ({directory,outputPath})=>{
    const batch=JSON.parse(await fs.readFile(path.join(directory,'batch.json'),'utf8'));
    const ids=batch.parts.map(p=>p.id);
    groundGroups.push(ids);
    await fs.writeFile(outputPath,JSON.stringify({parts:ids.map(id=>({id,orientation:drafts.get(id),question:'Which point remains?'}))}));
  },undefined,async (job,input)=>{
    reviews.push({prompt:job.prompt,input});
    return asEditorialRows(input.parts);
  });
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.ok(groundGroups.length<reviews.length,'the editor subdivides a generation batch');
  assert.deepEqual(reviews.flatMap(({input})=>input.parts.map(p=>p.id)),parts.map(p=>p.id));
  assert.deepEqual(ready.parts.map(p=>p.id),parts.map(p=>p.id));
  for (const {input,prompt} of reviews) {
    if (input.parts.length>1) assert.ok(JSON.stringify(input).length<=96000);
    for (const skillText of guidance) assert.ok(prompt.includes(skillText),'the complete editorial guidance is in this prompt');
    for (const part of input.parts) {
      const expected=drafts.get(part.id);
      assert.deepEqual(part.orientation,expected);
      assert.ok(prompt.includes(units[part.sourceSteps[0]-1].text),part.id+' source passage');
      for (const text of [expected.introduction,...expected.paragraphs,...expected.notation.map(n=>n.meaning),expected.handoff]) {
        assert.ok(prompt.includes(text),part.id+' draft text missing from its editorial prompt: '+text.slice(0,32));
      }
      if (part.id==='oversized') assert.equal(input.parts.length,1,'an indivisible section keeps its original id and all of its content');
    }
  }
});

test('a saved section retains its prose for editing; only a verified matching source cache can replace a new grounding pass',async t=>{
  const cacheDir=await cache(t);
  // Reproduce the source-bound v4 cache identity used before the editorial pass existed.
  const original=prepareRequest({...requestBody,stage:undefined,scope:'paper',step:0,history:[],mathFormat:'latex',
    known:[],readPapers:[],stepSkills:[],question:'Prepare the ordered parts of this paper.'});
  const version='personalized-parts-4-sections';
  const oldAnalysis={revision:'',parts:analysis.parts,localIntroductions:analysis.localIntroductions,knowledge:analysis.knowledge};
  const key=createHash('sha256').update(version).update(JSON.stringify(original.context)).update(JSON.stringify(original.units))
    .update(JSON.stringify(oldAnalysis)).update('[]').digest('hex');
  const old={version,key,parts:generated.map((p,i)=>({...p,title:analysis.parts[i].title,sourceSteps:analysis.parts[i].sourceSteps,
    opening:p.orientation.paragraphs.join('\n\n')}))};
  old.parts[0].orientation={...old.parts[0].orientation,statement:previousOrientations[0].statement};
  const saved=JSON.stringify(old);
  const oldPath=path.join(cacheDir,key+'.json');
  await fs.writeFile(oldPath,saved);
  const existingSections=old.parts.map(({id,orientation})=>({id,orientation:structuredClone(orientation)}));
  existingSections[0].orientation.introduction='Separate the unpaired endpoint before counting.';
  existingSections[0].orientation.paragraphs=['Start with the endpoint and then count each interior pair once.'];
  existingSections[0].orientation.handoff='Use that single endpoint when you total the pairs.';
  const upgrade={...requestBody,mode:'orientation',existingSections};
  const events=[];
  let interrupt=true,reviewed;
  const api=client(cacheDir,async ({outputPath})=>{
    events.push('ground');
    await fs.writeFile(outputPath,JSON.stringify({parts:authored.map(({id,orientation})=>({id,orientation}))}));
  },undefined,async (_job,input)=>{
    events.push('edit');
    reviewed=structuredClone(input.parts);
    if (interrupt) throw Error('Interrupted editorial review');
    return asEditorialRows(input.parts);
  });
  assert.deepEqual((await api.get(key)).parts,old.parts);
  const interrupted=await api.finish(await api.post(upgrade));
  assert.equal(interrupted.status,'error');
  assert.deepEqual(events,['edit']);
  interrupt=false;
  const trusted=await api.finish(await api.post(upgrade));
  assert.equal(trusted.status,'ready',trusted.message);
  assert.equal(trusted.key,interrupted.key);
  assert.deepEqual(events,['edit','edit']);
  assert.deepEqual(trusted.parts,existingSections);
  assert.equal(trusted.editorialRevision,editorialRevision);

  for (const reason of ['changed notation and definitions','tampered immutable statement','different original text']) {
    const candidate=structuredClone(upgrade);
    if (reason==='tampered immutable statement') candidate.existingSections[0].orientation.statement={kind:'Lemma',label:'Lemma 99',text:'Every endpoint vanishes.'};
    else if (reason==='different original text') candidate.units[0].text+=' The pairing is its own inverse.';
    else {
      candidate.existingSections[0].orientation.notation=[];
      candidate.existingSections[0].orientation.definitions=[];
    }
    events.length=0;
    const recovered=await api.finish(await api.post(candidate));
    assert.equal(recovered.status,'ready',reason);
    assert.deepEqual(events,['ground','edit'],reason);
    const expected=structuredClone(existingSections);
    // The fresh mock worker omits the lemma. Only an unchanged previously verified statement can survive that omission.
    if (reason!=='changed notation and definitions') expected[0].orientation.statement=null;
    assert.deepEqual(reviewed[0].orientation,expected[0].orientation,reason);
    assert.deepEqual(recovered.parts,expected);
    assert.notEqual(recovered.key,trusted.key);
  }
  assert.equal(await fs.readFile(oldPath,'utf8'),saved);
});

test('an incomplete or unresolved editorial review cannot publish the draft and a corrected review retries the same job',async t=>{
  const cacheDir=await cache(t);
  const body=structuredClone(requestBody),drafts=structuredClone(authored);
  const handoff=String.raw`The count is \(2m+1\), so \(2m+1\ge 1\).`;
  body.units[1].text+=' Let m count the pairs. '+handoff;
  drafts[1].orientation.notation=[{symbol:String.raw`\(m\)`,meaning:'The number of interior pairs.'}];
  drafts[1].orientation.handoff=handoff;
  let outcome,groundings=0;
  const editBatches=[];
  const api=client(cacheDir,async ({outputPath})=>{
    groundings++;
    await fs.writeFile(outputPath,JSON.stringify({parts:drafts}));
  },undefined,async (_job,input)=>{
    editBatches.push(input.parts.map(p=>p.id));
    const rows=asEditorialRows(input.parts);
    switch (outcome) {
      case 'interrupted': throw Error('Editorial worker interrupted');
      case 'incomplete': return rows.filter(p=>p.id!=='total');
      case 'reordered': return rows.toReversed();
      case 'unchecked': return rows.map(p=>p.id==='pairing'?{...p,sourceCheck:'  '}:p);
      case 'vacuous check': return rows.map(p=>p.id==='total'?{...p,sourceCheck:'OK'}:p);
      case 'unresolved': return rows.map(p=>p.id==='total'?{...p,unresolved:'The endpoint count needs source confirmation.'}:p);
      case 'fabricated claim': return rows.map(p=>p.id==='pairing'?{...p,paragraphs:['Theorem 99. Every endpoint has weight zero.']}:p);
      case 'arithmetic sign change': return rows.map(p=>p.id==='total'?{...p,handoff:handoff.replace('2m+1','2m-1')}:p);
      case 'comparison reversal': return rows.map(p=>p.id==='total'?{...p,handoff:handoff.replace('\\ge','\\le')}:p);
      case 'corrupt TeX escape': return rows.map(p=>p.id==='total'?{...p,paragraphs:[...p.paragraphs,'The sum is (\u001cx).']}:p);
      default: return rows;
    }
  });
  const failures=['interrupted','incomplete','reordered','unchecked','vacuous check','unresolved','fabricated claim','arithmetic sign change','comparison reversal','corrupt TeX escape'];
  for (const scenario of failures) {
    outcome=scenario;
    body.analysis.revision=scenario;
    groundings=0; editBatches.length=0;
    const result=await api.finish(await api.post(body));
    if (scenario==='reordered') {
      assert.equal(result.status,'ready',result.message);
      assert.deepEqual(editBatches.slice(-2),[['pairing'],['total']]);
      assert.deepEqual(result.parts.map(p=>[p.id,p.question]),authored.map(p=>[p.id,p.question]));
      assert.equal(groundings,1);
      continue;
    }
    assert.equal(result.status,'error',scenario);
    if (scenario==='corrupt TeX escape') {
      assert.match(result.message,/paragraph 2\. At character 13/);
      assert.ok(result.message.includes('\\u001c'));
    }
    assert.equal(Object.hasOwn(result,'parts'),false);
    assert.equal((await fs.readdir(cacheDir)).includes(result.key+'.json'),false);
    if (scenario==='interrupted') assert.equal(editBatches.length,1,'an unclassified failure is surfaced immediately');
    else assert.ok(editBatches.length>=2 && editBatches.length<=6,scenario+' should stop reviewing when the same problem persists after recovery');
    outcome='complete';
    const ready=await api.finish(await api.post(body));
    assert.equal(ready.status,'ready',ready.message);
    assert.equal(ready.key,result.key);
    assert.deepEqual(ready.parts.map(p=>p.question),authored.map(p=>p.question));
    assert.equal(groundings,1,'a rejected editorial pass retries from the already grounded original sections');
  }
});

test('a worker disconnect during review retries the same grounded section and retains its recovery message',async t=>{
  const cacheDir=await cache(t),body=structuredClone(requestBody);
  let attempts=0,disconnect=true,groundings=0;
  const ids=[];
  const api=client(cacheDir,async ({outputPath})=>{
    groundings++;
    await fs.writeFile(outputPath,JSON.stringify({parts:authored}));
  },undefined,async (_job,input)=>{
    attempts++;
    ids.push(input.parts.map(p=>p.id));
    if (disconnect) throw Object.assign(new Error('The local Codex worker could not reach its service. Check the connection and retry.'),{workerCode:'network'});
    return asEditorialRows(input.parts);
  });
  const failed=await api.finish(await api.post(body));
  assert.equal(failed.status,'error');
  assert.match(failed.message,/could not reach its service/iu);
  assert.equal(attempts,6,'the initial pair of calls is followed by four independent connection probes');
  for (const target of ids) assert.deepEqual(target,['pairing','total']);
  disconnect=false;
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready');
  assert.equal(attempts,7);
  assert.equal(groundings,1);
});

test('a rejected claim gets a targeted editorial revision from the grounded text after a cold retry',async t=>{
  const cacheDir=await cache(t),ids=['first','middle','last'];
  const body={...requestBody,analysis:{...analysis,localIntroductions:[],parts:ids.map(id=>({...analysis.parts[1],id,
    title:'Counting '+id,localPrerequisiteIds:[]}))}};
  const wrong='Theorem 99. Every paired point is its own partner.';
  const draft=async ({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:ids.map(id=>({...authored[1],id}))}));
  const attempts=[];
  let interrupted=true;
  const editor=async ({directory,prompt},input)=>{
    attempts.push(input.parts.map(p=>p.id));
    const rows=asEditorialRows(input.parts);
    if (input.parts.length===3) return rows.map(p=>p.id==='middle'?{...p,paragraphs:[wrong]}:p);
    const [note]=JSON.parse(await fs.readFile(path.join(directory,'editor-revisions.json'),'utf8'));
    assert.equal(note.id,'middle');
    assert.match(note.reason,/unsupported numbered result \(theorem 99\)/i);
    assert.deepEqual(note.proposal.paragraphs,[wrong]);
    assert.ok(prompt.includes(note.reason));
    assert.deepEqual(input.parts[0].orientation.paragraphs,authored[1].orientation.paragraphs);
    if (interrupted) throw Error('Codex connection interrupted during revision.');
    return rows;
  };
  const first=client(cacheDir,draft,undefined,editor);
  const failed=await first.finish(await first.post(body));
  assert.equal(failed.status,'error');
  const state=JSON.parse(await fs.readFile(path.join(cacheDir,failed.key+'.checkpoint'),'utf8'));
  const saved=new Map(state.batches).get(0);
  assert.deepEqual(saved.reviewed.map(p=>p.id),['first','last']);
  assert.deepEqual(saved.editNotes.map(n=>n.id),['middle']);
  assert.equal((await fs.readdir(cacheDir)).includes(failed.key+'.json'),false);
  interrupted=false;
  const resumed=client(cacheDir,()=>assert.fail('regenerated grounded text'),undefined,editor);
  const ready=await resumed.finish(await resumed.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(ready.parts.map(p=>p.id),ids);
  assert.deepEqual(attempts[0],ids);
  assert.equal(attempts.length,7,'only the rejected claim receives the initial revision, four probes, and the final revision');
  for (const scope of attempts.slice(1)) assert.deepEqual(scope,['middle']);
  assert.doesNotMatch(JSON.stringify(ready),/Theorem 99/);
});

test('a damaged TeX span and its first-use quote need one complete matching grounded formula',async t=>{
  const body=structuredClone(requestBody),draft=structuredClone(authored);
  const gamma='\\(\\gamma\\)',nul=String.fromCharCode(0),separator=String.fromCharCode(28);
  const formula='\\(l_i\\ge(\\gamma-\\Delta_i)/(1+\\eta_i)\\)';
  const intro='Let '+gamma+' denote the comparison gap.';
  const terms=[['l_i','the length of the interval'],['\\Delta_i','the loss in this interval'],['\\eta_i','the scaling error']];
  const named=terms.map(([symbol,meaning])=>'Write \\('+symbol+'\\) for '+meaning+'.').join(' ');
  const paragraph='The interval length satisfies '+formula+'.';
  Object.assign(draft[1].orientation,{introduction:intro,paragraphs:[named,paragraph],
    notation:[[gamma,'The comparison gap.'],...terms.map(([s,m])=>['\\('+s+'\\)',m])].map(([symbol,meaning])=>({symbol,meaning}))});
  body.units[1].text+=' '+intro+' '+named+' '+paragraph;
  let damaged,attempts;
  const api=client(await cache(t),({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:draft})),
    undefined,async (_job,input)=>asEditorialRows(input.parts).map(row=>{
      if (row.id!=='total') return row;
      attempts++;
      const damage=s=>s.replace(formula,damaged).replace(gamma,'\\('+nul+'\\gamma\\)');
      return {...row,introduction:damage(row.introduction),paragraphs:row.paragraphs.map(damage),notationEvidence:row.notationEvidence.map(damage)};
    }));
  for (const [index,candidate] of [
    formula.replace('\\gamma',nul+'\\gamma'),formula.replace('\\ge',separator+'ge'),
    formula.replace('\\gamma',nul+'\\gamma').replace('1+','2+'),formula.replace('\\Delta_i',separator+'hat\\Delta_i'),
    formula.replace('\\ge',separator+'ge'),
  ].entries()) {
    if (index===4) draft[1].orientation.notation[0].meaning+=' An alternative literal expression is '+formula.replace('\\ge','ge')+'.';
    damaged=candidate; attempts=0; body.analysis.revision='control recovery '+index;
    const result=await api.finish(await api.post(body));
    if (index<2) {
      assert.equal(result.status,'ready',result.message);
      assert.equal(attempts,1);
      assert.equal(result.parts[1].orientation.introduction,intro);
      assert.deepEqual(result.parts[1].orientation.paragraphs,[named,paragraph]);
    } else {
      assert.equal(result.status,'error');
      assert.match(result.message,/unsupported formatting in paragraph 2/);
    }
  }
});

test('a previously rejected editorial proposal can pass on restart without another worker call',async t=>{
  const cacheDir=await cache(t),body=structuredClone(requestBody),rows=structuredClone(authored);
  const broken=String.fromCharCode(28)+'le';
  const line='The endpoint bound is \\(e\\le 1\\).';
  rows[0].orientation.paragraphs.push(line);
  body.units[1].text+=' '+line;
  const first=client(cacheDir,({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:rows})),undefined,
    async (_job,input)=>asEditorialRows(input.parts).map(p=>p.id==='pairing'?{...p,unresolved:'The interval argument is unfinished.'}:p));
  const failed=await first.finish(await first.post(body));
  assert.equal(failed.status,'error');
  const {planCheckpoints}=require('./plan-checkpoints.cjs');
  const cacheState=planCheckpoints(cacheDir,failed.key,128*1024*1024),history=await cacheState.load();
  const saved=history.get(0),note=saved.editNotes[0];
  assert.deepEqual(saved.reviewed.map(p=>p.id),['total']);
  // Simulate the on-disk proposal from the former checker, including its original damaged bytes.
  note.reason='Proof Craft review returned unsupported formatting.';
  note.proposal.unresolved='';
  note.proposal.paragraphs=note.proposal.paragraphs.map(p=>p.replace('\\le',broken));
  note.proposal.notationEvidence=note.proposal.notationEvidence.map(p=>p.replace('\\le',broken));
  await cacheState.save(history);
  let called=0;
  const unexpected=()=>{called++;throw Error('The recovered proposal must be checked locally.');};
  const cold=client(cacheDir,unexpected,undefined,unexpected);
  const ready=await cold.finish(await cold.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(called,0);
  assert.equal(ready.parts[0].orientation.paragraphs.at(-1),line);
});

test('a previous Proof Craft edition gets contextual prose before its verified lemma and an individually mapped lookup',async t=>{
  const cacheDir=await cache(t),body=structuredClone(requestBody);
  const formula=String.raw`The total is \(2m+d\).`;
  const statement={kind:'Lemma',label:'Lemma 2.1',text:formula};
  const pair=String.raw`Each interior pair contributes two points. Let \(m\) count these pairs.`;
  const fixed=String.raw`The remaining points are fixed by the involution. Let \(d\) count those fixed points.`;
  const name=String.raw`\(m,d,n\)`;
  body.units[0].text=pair+' '+fixed+' In the notation table n stands for the total. Lemma 2.1. '+formula;
  const previous=generated.map((p,i)=>({...p,title:analysis.parts[i].title,sourceSteps:analysis.parts[i].sourceSteps,
    opening:'Count the interior points and the fixed points.',
    orientation:i===1?p.orientation:{introduction:'Count a finite set by grouping its points.',notation:[
      {symbol:name,meaning:'The number of pairs, the number of fixed points, and the total.'}],
      definitions:[],statement,paragraphs:[formula],handoff:''}}));
  const original=prepareRequest({...body,stage:undefined,scope:'paper',step:0,history:[],mathFormat:'latex',
    known:[],readPapers:[],stepSkills:[],question:'Prepare the ordered parts of this paper.'});
  const prior='personalized-parts-5-proof-craft',revision='proof-craft-46f6f6b1-v1';
  const hash=createHash('sha256');
  for (const filename of editorialFixture.names) {
    const content=await fs.readFile(path.join(editorialFixture.directory,filename),'utf8');
    hash.update(filename).update('\0').update(content.replace(/\r\n/gu,'\n')).update('\0');
  }
  const digest=hash.digest('hex');
  const oldAnalysis={revision:'',parts:analysis.parts,localIntroductions:analysis.localIntroductions,knowledge:analysis.knowledge};
  const key=createHash('sha256').update(prior).update('\0'+revision+'\0'+digest+'\0').update(JSON.stringify(original.context))
    .update(JSON.stringify(original.units)).update(JSON.stringify(oldAnalysis)).update('[]').digest('hex');
  await fs.writeFile(path.join(cacheDir,key+'.json'),JSON.stringify({version:prior,key,editorialRevision:revision,editorialSkillDigest:digest,parts:previous}));
  const rows=[{symbol:String.raw`\(m\)`,meaning:'The number of paired orbits.'},{symbol:String.raw`\(d\)`,meaning:'The number of fixed points.'}];
  const calls=[];
  const api=client(cacheDir,async()=>{assert.fail('The previous source-matched formal material is already grounded.');},
    undefined,async (job,input)=>{
      calls.push(input.parts.map(p=>p.id));
      assert.match(job.prompt,/first use/i);
      assert.match(job.prompt,/reference closed/i);
      return asEditorialRows(input.parts).map(row=>row.id==='total'?row:{...row,
        formalAfter:calls.length===1?0:2,referenceNotation:rows,notationEvidence:[pair,fixed],
        paragraphs:[pair,fixed,'Each pair contributes twice and each fixed point once.']});
    });
  const old=await api.get(key);
  assert.equal(old.editorialRevision,revision);
  const ready=await api.finish(await api.post({...body,mode:'orientation',existingSections:previous.map(({id,orientation})=>({id,orientation}))}));
  assert.equal(ready.status,'ready',ready.message);
  assert.deepEqual(calls,[['pairing','total'],['pairing']],'only the section with a premature lemma needed another pass');
  assert.notEqual(ready.editorialRevision,revision);
  assert.deepEqual(ready.parts[0].orientation.statement,statement);
  assert.deepEqual(ready.parts[0].orientation.notation,rows);
  assert.equal(ready.parts[0].orientation.formalAfter,2);
  assert.deepEqual(ready.parts[0].orientation.paragraphs.slice(0,2),[pair,fixed]);
  assert.equal((await api.get(key)).parts[0].orientation.notation[0].symbol,name);
  assert.deepEqual((await api.get(ready.key)).parts,ready.parts);
});

test('a decorated edge mass needs its own notation and a missing entry repairs only the affected part',async t=>{
  const cacheDir=await cache(t),body=structuredClone(requestBody),rows=structuredClone(authored);
  const symbol=String.raw`\(\bar x_{ij}\)`,entry={symbol,meaning:'Average assignment from job j to machine i.'};
  const sentence='Call the average mass sent from job to machine '+symbol+'.';
  body.units[1].text+=' The average mass from job j to machine i is its average assignment over all offsets.';
  rows[1].orientation={...rows[1].orientation,notation:[entry],paragraphs:[sentence]};
  let drafts=0;
  const edits=[];
  const api=client(cacheDir,async({outputPath})=>{
    drafts++;
    await fs.writeFile(outputPath,JSON.stringify({parts:rows}));
  },undefined,async(_job,input)=>{
    edits.push(input.parts.map(p=>p.id));
    return asEditorialRows(input.parts).map(p=>p.id==='total'?{...p,referenceNotation:edits.length===1?[]:[entry]}:p);
  });
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(drafts,1);
  assert.deepEqual(edits,[['pairing','total'],['total']]);
  assert.deepEqual(ready.parts[1].orientation.notation,[entry]);
});

test('a glossary, naked equation, formula transition and later explanation are not first-use evidence',async t=>{
  const cacheDir=await cache(t),body=structuredClone(requestBody);
  const fixture=structuredClone(authored);
  const name=String.raw`\(e\)`,equation=String.raw`\(e=0\)`;
  const context='The left endpoint '+name+' is mapped to itself.';
  const convention='Visit the pairs in first-in, first-out (FIFO) order.';
  body.units[0].text+=' The endpoint of the interval is denoted e and has coordinate zero here.';
  body.units[0].text+=' '+convention;
  fixture[0].orientation.introduction='Only one point can be its own partner.';
  fixture[0].orientation.notation=[{symbol:name,meaning:'The left endpoint.'}];
  fixture[0].orientation.paragraphs=[context];
  let prose,quotes,reference,reviewCalls=0;
  const api=client(cacheDir,async({outputPath})=>{await fs.writeFile(outputPath,JSON.stringify({parts:fixture}));},
    undefined,async(_job,input)=>{
      reviewCalls++;
      return asEditorialRows(input.parts).map(row=>row.id==='pairing'?{...row,paragraphs:prose,notationEvidence:quotes,referenceNotation:reference}:row);
    });
  const tuple=String.raw`\(e,m\)`;
  for (const scenario of [
    {words:[context],evidence:['The left endpoint.']},
    {words:[context,convention],evidence:[convention]},
    {words:[context,convention],evidence:[context,'FIFO visits the newest pair first.']},
    {words:[equation,context],evidence:[equation]},
    {words:['Substituting gives '+equation+'.',context],evidence:['Substituting gives '+equation+'.']},
    {words:['We obtain '+equation+'. '+context],evidence:['We obtain '+equation+'. '+context]},
    {words:['Compare '+equation+'.',context],evidence:[context]},
    {words:[context],evidence:[context],lookup:[{symbol:tuple,meaning:'The fixed endpoint and the number of pairs.'}]},
  ]) {
    prose=scenario.words; quotes=scenario.evidence; reference=scenario.lookup || null; reviewCalls=0;
    const failed=await api.finish(await api.post(body));
    assert.equal(failed.status,'error',prose.join(' '));
    assert.ok(reviewCalls>=2 && reviewCalls<=4,'targeted review and recovery stop after bounded attempts');
    assert.equal((await fs.readdir(cacheDir)).includes(failed.key+'.json'),false);
  }
  prose=[context,convention]; quotes=[convention,context]; reference=[{symbol:tuple,meaning:String.raw`\(e\) is the fixed endpoint. \(m\) counts the pairs.`}]; reviewCalls=0;
  const final=await api.finish(await api.post(body));
  assert.equal(final.status,'ready',final.message);
  assert.equal(reviewCalls,1);
  assert.deepEqual(final.parts[0].orientation.notation,reference,'a clearly mapped conventional pair can stay together');
});

test('temporary cost labels are introduced in prose while a genuine formal definition can introduce its own symbol',async t=>{
  const cacheDir=await cache(t),body=structuredClone(requestBody),drafts=structuredClone(authored);
  const alias='Write C(h) for the immediate cost, T(h) for the optimal cost, and F(h) for the formal score.';
  const defining='Definition 2 (Formal score). The formal score is the excess cost over the optimal search.';
  const lead=String.raw`The iteration count \(h\) counts the search passes.`;
  const immediate=String.raw`A sequential scan incurs the immediate cost \(C(h)\).`;
  const optimal=String.raw`The shortest search path attains the optimal cost \(T(h)\).`;
  const formal=String.raw`The formal score \(F(h)\) is the excess cost over the optimal search.`;
  const makeCard=(name,text,sourceQuote)=>({name,text,sourceStep:1,sourceQuote,dependsOn:[]});
  body.units[0].text+=' '+lead+' '+alias+' '+defining;
  body.analysis.localIntroductions.push({id:'score',kind:'definition',title:'Formal score',meaning:formal,originPartId:'pairing'});
  drafts[0].orientation={introduction:lead,notation:[['h','The iteration count.'],['C(h)','The cost of a sequential scan.'],
    ['T(h)','The shortest search cost.'],['F(h)','The score.']].map(([symbol,meaning])=>({symbol:'\\('+symbol+'\\)',meaning})),
    definitions:[makeCard('Immediate cost',immediate,alias),makeCard('Optimal cost',optimal,alias),makeCard('Formal score',formal,defining)],
    statement:null,paragraphs:['Compare the two searches at the same iteration count.'],handoff:''};
  let strategy='ordinary',attempts=0;
  const api=client(cacheDir,async({outputPath})=>{await fs.writeFile(outputPath,JSON.stringify({parts:drafts}));},
    undefined,async (job,input)=>{
      attempts++;
      const eligible=JSON.parse(job.prompt.split('Eligible notation-only cards by part (paper explicitly assigns these local names): ')[1].split('\n\n')[0]);
      assert.deepEqual(Object.keys(eligible.pairing),['Immediate cost','Optimal cost']);
      return asEditorialRows(input.parts).map(row=>{
        if (row.id!=='pairing' || (attempts===1 && strategy==='ordinary')) return row;
        return {...row,paragraphs:[immediate,optimal,...row.paragraphs],formalAfter:2,notationEvidence:[lead,immediate,optimal,formal],
          proseNotationCards:strategy==='ordinary'?['Immediate cost','Optimal cost']:['Formal score']};
      });
    });
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(attempts,2,'the cluster of routine label cards triggers an editorial repair');
  assert.deepEqual(ready.parts[0].orientation.definitions.map(d=>d.name),['Formal score']);
  assert.deepEqual(ready.parts[0].orientation.paragraphs.slice(0,2),[immediate,optimal]);
  strategy='remove formal'; attempts=0; body.analysis.revision='protect formal';
  const failed=await api.finish(await api.post(body));
  assert.equal(failed.status,'error');
  assert.equal((await fs.readdir(cacheDir)).includes(failed.key+'.json'),false);
});

test('missing, reordered and replaced parts cannot open a plan; a corrected retry completes the same job',async t=>{
  const cacheDir=await cache(t);
  const outputs=[
    [authored[0]],
    [authored[1],authored[0]],
    [authored[0],{...authored[1],id:'wrong-origin'}],
    [authored[0],{...authored[1],question:'   '}],
    authored,
  ];
  let output;
  const api=client(cacheDir,async ({outputPath})=>{await fs.writeFile(outputPath,JSON.stringify({parts:output}));});
  let expectedKey;
  for(let attempt=0;attempt<4;attempt++){
    output=outputs[attempt];
    const job=await api.finish(await api.post(requestBody));
    expectedKey ??= job.key;
    assert.equal(job.key,expectedKey);
    assert.equal(job.status,'error');
    assert.equal(Object.hasOwn(job,'parts'),false);
    assert.equal((await api.get(job.key)).status,'error');
  }
  output=outputs.at(-1);
  const ready=await api.finish(await api.post(requestBody));
  assert.equal(ready.key,expectedKey);
  assert.equal(ready.status,'ready');
  assert.deepEqual(ready.parts.map(p=>p.id),['pairing','total']);
  assert.deepEqual((await api.get(expectedKey)).parts,ready.parts);
});

test('new plans require a bounded section for every part; the final handoff and definition intuition can be omitted',async t=>{
  const cacheDir=await cache(t);
  const section=generated[1].orientation;
  const symbol={symbol:'e',meaning:'The unpaired endpoint.'};
  const definition={name:'Fixed point',text:'A point mapped to itself.',...fixedPointEvidence};
  const invalid=[undefined,null,{},
    previousOrientations[1],{...section,introduction:'   '},{...section,introduction:'a'.repeat(1201)},
    {...section,notation:null},{...section,notation:Array(65).fill(symbol)},
    {...section,notation:[{...symbol,symbol:'s'.repeat(351)}]},{...section,notation:[{...symbol,meaning:'a'.repeat(1001)}]},
    {...section,definitions:undefined},{...section,definitions:Array(17).fill(definition)},
    {...section,definitions:[{...definition,name:'n'.repeat(251)}]},{...section,definitions:[{...definition,text:'d'.repeat(3001)}]},
    {...section,definitions:[{...definition,intuition:'i'.repeat(901)}]},
    {...section,paragraphs:[]},{...section,paragraphs:[' \t ']},{...section,paragraphs:Array(17).fill('A paragraph.')},
    {...section,paragraphs:['p'.repeat(3501)]},{...section,handoff:'x'.repeat(801)},
    {...section,statement:undefined},
    {...section,statement:{kind:'Definition',label:'Definition 1',text:'A point is fixed when it maps to itself.'}},
    {...section,statement:{kind:'Lemma',label:3,text:'Every pair has two points.'}},
  ];
  let current;
  const api=client(cacheDir,async ({outputPath})=>{
    const parts=[authored[0],{...authored[1],orientation:current}];
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  });
  const keys=[];
  for (const candidate of invalid) {
    current=candidate;
    const result=await api.finish(await api.post(requestBody));
    assert.equal(result.status,'error',JSON.stringify(candidate));
    assert.equal(Object.hasOwn(result,'parts'),false);
    keys.push(result.key);
  }
  current={...section,definitions:[definition]};
  delete current.handoff;
  const ready=await api.finish(await api.post(requestBody));
  assert.equal(ready.status,'ready');
  assert.deepEqual(ready.parts[0].orientation,generated[0].orientation);
  assert.equal(ready.parts[1].orientation.handoff,'');
  assert.equal(ready.parts[1].orientation.definitions[0].name,definition.name);
  assert.equal(ready.parts[1].orientation.definitions[0].text,definition.text);
  assert.ok(!ready.parts[1].orientation.definitions[0].intuition);
  assert.deepEqual([...new Set(keys)],[ready.key]);
});

test('definition cards need local source evidence and appear after their own prerequisites',async t=>{
  const cacheDir=await cache(t);
  const orbit={name:'Orbit',text:'The points reached by repeatedly applying the pairing.',
    sourceStep:2,sourceQuote:orbitQuote,dependsOn:[]};
  const singleton={name:'Singleton orbit',text:'An orbit with exactly one point.',
    sourceStep:2,sourceQuote:singletonQuote,dependsOn:['Orbit']};
  const fixed=authored[0].orientation.definitions[0];
  let definitions;
  const api=client(cacheDir,async ({outputPath})=>{
    const section={...authored[1].orientation,definitions};
    const first={...authored[0],orientation:{...authored[0].orientation,definitions:[]}};
    await fs.writeFile(outputPath,JSON.stringify({parts:[first,{...authored[1],orientation:section}]}));
  });
  for (const broken of [
    [{...orbit,sourceStep:undefined}], [{...orbit,sourceStep:1}], [{...orbit,sourceQuote:'An orbit contains imaginary points.'}],
    [{name:'Spectral radius',text:'The largest absolute eigenvalue of a matrix.',sourceStep:2,sourceQuote:fixedPointQuote,dependsOn:[]}],
    [{...orbit,dependsOn:['Singleton orbit']},singleton],
  ]) {
    definitions=broken;
    const failed=await api.finish(await api.post(requestBody));
    assert.equal(failed.status,'error');
    assert.equal(Object.hasOwn(failed,'parts'),false);
  }
  definitions=[singleton,orbit,fixed];
  const ready=await api.finish(await api.post(requestBody));
  assert.equal(ready.status,'ready',ready.message);
  const cards=ready.parts[1].orientation.definitions;
  const names=cards.map(card=>card.name);
  assert.ok(names.indexOf('Orbit')<names.indexOf('Singleton orbit'));
  assert.equal(cards.length,3);
  assert.ok(cards.every(d=>d.claimSource===undefined),'unrelated replacement topics must not inherit a shared heading from an earlier draft');
  assert.equal(cards.find(card=>card.name===fixed.name).intuition,fixed.intuition);
  assert.doesNotMatch(JSON.stringify(ready),/sourceQuote|sourceStep"|dependsOn/);
  assert.deepEqual((await api.get(ready.key)).parts[1].orientation.definitions,cards);
});

test('PDF definitions with re-typeset mathematics require independent page evidence and survive a cold retry',async t=>{
  const body=structuredClone(requestBody);
  body.pdfBase64=Buffer.from('%PDF-1.7\noriginal pages\n%%EOF').toString('base64');
  const original='For the analysis, write\n     x = max ui ,      y = min ui ,     d = x-y.\n             i                  i\n'+
    'Inspect each interval. Take the least integer greater than 7β.';
  const fake='The reader suggests a cutoff of fourteen.';
  body.units[1].text='Original manuscript page 2\n\n'+body.units[1].text+'\n'+original+'\n\nReading guide for this step\n\n'+fake;
  const factors={name:'Sample range',text:'Subtract the smallest observation from the largest.',sourceStep:2,
    sourceQuote:'For the analysis, write \\[ x=\\max_i u_i,\\quad y=\\min_i u_i,\\quad d=x-y. \\]',intuition:'',dependsOn:[]};
  const threshold={name:'Integer cutoff',text:'Take the least integer greater than 7 times the width.',
    sourceStep:2,sourceQuote:'Inspect each interval. Take the least integer greater than \\(7\\beta\\).',intuition:'',dependsOn:[]};
  for (const scenario of ['verified','literal lead-in','altered coefficient','guide anchor','wrong source page','unrenderable PDF']) {
    const dir=await cache(t),draft=structuredClone(authored);
    draft[1].orientation.definitions=[factors,scenario==='altered coefficient'?{...threshold,text:threshold.text.replace('7','14')}:threshold];
    if (scenario==='literal lead-in') draft[1].orientation.definitions[0]={
      ...factors,sourceQuote:'For the analysis, write',text:factors.text+' This range is at least \\(0\\).'};
    if (scenario==='wrong source page') draft[1].orientation.definitions[1]={...threshold,sourceStep:1};
    let pageChecks=0,editorCalls=0,editedTarget=false;
    async function worker(job){
      if (path.basename(job.outputPath)!=='definition-grounding.json') {
        await fs.writeFile(job.outputPath,JSON.stringify({parts:draft}));
        return;
      }
      pageChecks++;
      const material=JSON.parse(job.prompt.split('\n\n').at(-1));
      assert.ok(!material.some(c=>c.extractedText.includes(fake)));
      assert.ok(job.imagePaths.every(p=>/page-[12]\.png$/u.test(p)));
      const checks=material.map(c=>{
        const isThreshold=c.term===threshold.name;
        const anchor=isThreshold?'Inspect each interval.':'For the analysis, write';
        return {id:c.id,anchor:isThreshold && scenario==='guide anchor'?fake:anchor,
          sourceDefinition:isThreshold?'The least integer greater than seven times the interval width.':'The difference between the largest and smallest observations.',
          comparison:'I compared the extremum, coefficient and conditions in the proposed definition with the original page.',
          verified:!(isThreshold && c.candidate.includes('14'))};
      });
      await fs.writeFile(job.outputPath,JSON.stringify({checks}));
    }
    const render=async(_pdf,p)=>{if(scenario==='unrenderable PDF')throw Error('No page image');return Buffer.from('page '+p);};
    const edit=async(_job,input)=>{
      editorCalls++;
      editedTarget ||= input.parts.some(p=>p.id==='total');
      if (['verified','literal lead-in'].includes(scenario) && editorCalls===1) throw Error('The Codex account reached a usage limit.');
      return asEditorialRows(input.parts);
    };
    let api=client(dir,worker,render,edit);
    const first=await api.finish(await api.post(body));
    assert.equal(first.status,'error',scenario);
    if (['verified','literal lead-in'].includes(scenario)) {
      api=client(dir,worker,render,edit);
      const ready=await api.finish(await api.post(body));
      assert.equal(ready.status,'ready',ready.message);
      assert.equal(pageChecks,1,'both definitions share the page check and it is retained on restart');
      assert.deepEqual(ready.parts[1].orientation.definitions.map(d=>d.name),[factors.name,threshold.name]);
    } else {
      assert.equal(editedTarget,false,'the unsupported definition must not be published');
      if (scenario==='unrenderable PDF') assert.equal(pageChecks,0);
    }
  }
});

test('a verified PDF definition receipt is reusable only for the same claim, locator, part and page',async t=>{
  const body=structuredClone(requestBody),rows=structuredClone(authored),dir=await cache(t);
  const anchor='Read the marked radius from the following display.';
  body.pdfBase64=Buffer.from('%PDF-1.7\nRadius fixture\n%%EOF').toString('base64');
  body.units[1].text+='\n'+anchor;
  const card={name:'Marked radius',text:'The marked radius equals \\(2^{3}\\).',intuition:'',dependsOn:[],
    sourceStep:2,sourceQuote:'Read the marked radius \\(d_{i}\\) from the display.'};
  rows[1].orientation.definitions=[card];
  const claim={kind:'Lemma',label:'Lemma 4',text:'The marked radius is at least \\(1\\).',sourceStep:2};
  claim.sourceQuote=claim.label+'. '+claim.text;
  body.units[1].text+='\n'+claim.sourceQuote;
  const initial=structuredClone(rows);initial[1].orientation.statement=claim;
  const render=async()=>Buffer.from('radius drawing');
  let originalChecks=0;
  const first=client(dir,async job=>{
    const file=path.basename(job.outputPath);
    if(file==='verification.json')throw Error('The Codex account reached a usage limit.');
    if(file!=='definition-grounding.json')return fs.writeFile(job.outputPath,JSON.stringify({parts:initial}));
    const [item]=JSON.parse(job.prompt.split('\n\n').at(-1));
    originalChecks++;
    return fs.writeFile(job.outputPath,JSON.stringify({checks:[{id:item.id,anchor,verified:true,sourceDefinition:card.text,
      comparison:'The printed display has the same base, exponent, and marked radius.'}]}));
  },render);
  const interrupted=await first.finish(await first.post(body));
  assert.equal(interrupted.status,'error');assert.equal(originalChecks,1);
  const {planCheckpoints}=require('./plan-checkpoints.cjs');
  const original=await planCheckpoints(dir,interrupted.key,1e7).load();
  const receipt=original.get(0).sourceChecks.find(c=>c.kind==='definition' && c.name===card.name);
  assert.equal(receipt.verified,true);
  const alias={...card,text:card.text.replace('2^{3}','2^3'),sourceQuote:card.sourceQuote.replace('d_{i}','d_i')};
  const legacy={...receipt};delete legacy.claimKey;delete legacy.locatorKey;
  for(const [name,saved,candidate,expected] of [
    ['equivalent claim and locator',receipt,alias,0],
    ['changed exponent',receipt,{...alias,text:alias.text.replace('2^3','2^4')},1],
    ['changed locator',receipt,{...alias,sourceQuote:alias.sourceQuote.replace('d_i','d_j')},1],
    ['different part',{...receipt,part:'pairing'},alias,1],
    ['different page',{...receipt,page:99},alias,1],
    ['different step',{...receipt,sourceStep:1},alias,1],
    ['anchor absent',{...receipt,sourceAnchor:'The missing radius caption.'},alias,1],
    ['legacy exact fingerprint',legacy,card,0],
    ['legacy receipt without equivalent-claim evidence',legacy,alias,1],
  ]){
    const working=await cache(t),draft=structuredClone(rows);
    draft[1].orientation.definitions=[candidate];
    await planCheckpoints(working,interrupted.key,1e7).save(new Map([[0,{drafts:draft,sourceChecks:[saved]}]]));
    let calls=0;
    const cold=client(working,async job=>{
      assert.equal(path.basename(job.outputPath),'definition-grounding.json');
      calls++;throw Error('The Codex account reached a usage limit.');
    },render);
    const result=await cold.finish(await cold.post(body));
    assert.equal(calls,expected,name);assert.equal(result.status,expected?'error':'ready',name+' '+(result.message||''));
  }
});

test('a rejected grouped definition cannot pass by changing its locator and can be split across original pages',async t=>{
  const dir=await cache(t),body=structuredClone(requestBody);
  body.pdfBase64=Buffer.from('%PDF-1.7\nmass definitions\n%%EOF').toString('base64');
  body.units[1].page=4;
  const rounded='In a polynomial sum, the linear coefficient is the sum of the separate linear coefficients.';
  const actual='In a polynomial sum, the constant coefficient is the sum of the separate constant coefficients.';
  body.units[0].text+='\n'+actual;
  body.units[1].text+='\n'+rounded+' We compare the linear coefficient with the constant coefficient.';
  const group={name:'Linear and constant coefficients',sourceStep:2,text:rounded+' '+actual,
    sourceQuote:'The linear coefficient \\(M\\) is the sum of linear coefficients.',intuition:'',dependsOn:[]};
  const privateReason='Only linear coefficient is defined on page 4. The comparison mentions the constant coefficient but never defines its summands.';
  const draft=structuredClone(authored),revised=structuredClone(authored[1]);
  draft[1].orientation.definitions=[group];
  draft[0].orientation.definitions[0].claimSource={group:'Forged source',step:1,page:99};
  const checks=[],feedbacks=[];
  let split=false,initial=true,ordinaryRepairs=0;
  const worker=async job=>{
    if (path.basename(job.outputPath)==='definition-grounding.json') {
      const candidates=JSON.parse(job.prompt.split('\n\n').at(-1));
      checks.push(candidates.map(c=>[c.term,c.page,c.locator]));
      const verdicts=candidates.map(c=>{
        const valid=(c.term==='Constant coefficient' && c.page===1) || (c.term==='Linear coefficient' && c.page===4);
        const quote=c.page===1?actual:rounded;
        return {id:c.id,anchor:quote,sourceDefinition:quote,verified:valid,
          comparison:valid?'The cited page defines the full quantity with the stated coefficients and polynomials.':privateReason};
      });
      await fs.writeFile(job.outputPath,JSON.stringify({checks:verdicts}));
      return;
    }
    if (initial) {initial=false;await fs.writeFile(job.outputPath,JSON.stringify({parts:draft}));return;}
    if (path.basename(job.outputPath)==='definition-recovery.json') {
      const recovery=JSON.parse(await fs.readFile(path.join(job.directory,'definition-recovery-input.json'),'utf8'));
      feedbacks.push(recovery.targets[0].sourceFeedback?.comparison);
      if (!split) throw Error('The Codex account reached a usage limit.');
      const definitions=[
        {name:'Linear coefficient',text:rounded,sourceStep:2,sourceQuote:rounded,intuition:'',dependsOn:[]},
        {name:'Constant coefficient',text:actual,sourceStep:1,sourceQuote:actual,intuition:'',dependsOn:[]},
      ];
      await fs.writeFile(job.outputPath,JSON.stringify({parts:[{id:'total',definitions}]}));
      return;
    }
    const outstanding=JSON.parse(await fs.readFile(path.join(job.directory,'drafts.json'),'utf8'));
    ordinaryRepairs++;
    feedbacks.push(outstanding[0].sourceFeedback?.comparison);
    revised.orientation.definitions=[{...group,sourceQuote:rounded}];
    await fs.writeFile(job.outputPath,JSON.stringify({parts:[revised]}));
  };
  const render=async()=>Buffer.from('rendered source page');
  let api=client(dir,worker,render);
  const failed=await api.finish(await api.post(body));
  assert.equal(failed.status,'error');
  assert.ok(!JSON.stringify(failed).includes(privateReason));
  assert.equal(feedbacks[0],privateReason);
  assert.deepEqual(checks,[[[group.name,4,group.sourceQuote]]],'the shorter locator cannot override the failed claim or delay source-first recovery');
  split=true;
  api=client(dir,worker,render);
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.ok(feedbacks.every(s=>s===privateReason),'cold retry receives the persisted, precise rejection');
  assert.equal(ordinaryRepairs,1,'cold retry jumps straight to the interrupted source-first recovery');
  assert.deepEqual(checks.at(-1),[['Linear coefficient',4,rounded],['Constant coefficient',1,actual]]);
  assert.deepEqual(ready.parts[1].orientation.definitions.map(d=>d.text),[rounded,actual]);
  const expectedSources=[{group:group.name,step:2,page:4},{group:group.name,step:1,page:1}];
  assert.deepEqual(ready.parts[1].orientation.definitions.map(d=>d.claimSource),expectedSources);
  assert.equal(ready.parts[0].orientation.definitions[0].claimSource,undefined);
  const cold=client(dir,async()=>{throw Error('A published plan should load from disk');});
  assert.deepEqual((await cold.get(ready.key)).parts[1].orientation.definitions.map(d=>d.claimSource),expectedSources);
});

test('a long section retains full paragraphs while its compatibility opening ends at a paragraph boundary',async t=>{
  const cacheDir=await cache(t);
  const paragraphs=['Pair each interior point. '.repeat(118).trim(),'Add the fixed endpoint. '.repeat(123).trim()];
  assert.ok(paragraphs.join('\n\n').length>4000);
  const api=client(cacheDir,async ({outputPath})=>{
    const first={...authored[0],orientation:{...authored[0].orientation,paragraphs}};
    await fs.writeFile(outputPath,JSON.stringify({parts:[first,authored[1]]}));
  });
  const ready=await api.finish(await api.post(requestBody));
  assert.equal(ready.status,'ready');
  assert.deepEqual(ready.parts[0].orientation.paragraphs,paragraphs);
  assert.equal(ready.parts[0].opening,paragraphs[0]);
});

test('same-page locator churn moves to source-first recovery and stronger evidence is independently checked',async t=>{
  const body=structuredClone(requestBody),draft=structuredClone(authored);
  body.pdfBase64=Buffer.from('%PDF-1.7\nnearby similar definitions\n%%EOF').toString('base64');
  const first='The provisional load is the sum of the linear coefficients.';
  const second='The final load is the sum of the constant coefficients.';
  body.units[1].text+='\n'+first+'\n'+second;
  const original={name:'Final load',text:second,sourceStep:2,sourceQuote:'The provisional load is \\(L\\).',intuition:'Compare with \\(2^{3}\\).',dependsOn:[]};
  draft[1].orientation.definitions=[original];
  for (const paraphrase of [false,true]) {
    const order=[],anchors=[];
    let calls=0;
    const proposal={...original,sourceQuote:first,intuition:'Compare with \\(2^3\\).',
      text:paraphrase?'Sum the constant coefficients to obtain the final load.':'The final load is the sum of the  constant coefficients.'};
    const api=client(await cache(t),async job=>{
      const file=path.basename(job.outputPath);
      let output;
      if (file==='definition-grounding.json') {
        const [entry]=JSON.parse(job.prompt.split('\n\n').at(-1));
        const verified=entry.locator===second;
        order.push('verify');anchors.push(entry.locator);
        output={checks:[{id:entry.id,anchor:verified?second:first,sourceDefinition:verified?second:first,verified,
          comparison:verified?'The second clause defines the final load from its constant coefficients.':'The first clause refers only to provisional load and linear coefficients.'}]};
      } else if (file==='definition-recovery.json') {
        order.push('source-first');
        output={parts:[{id:'total',definitions:[{...proposal,sourceQuote:second}]}]};
      } else {
        const replacement=++calls>1;
        order.push(replacement?'revise':'draft');
        output={parts:replacement?[{...draft[1],orientation:{...draft[1].orientation,definitions:[proposal]}}]:draft};
      }
      await fs.writeFile(job.outputPath,JSON.stringify(output));
    },async()=>Buffer.from('original page'));
    const ready=await api.finish(await api.post(body));
    assert.equal(ready.status,'ready',ready.message);
    assert.deepEqual(order,paraphrase?['draft','verify','revise','verify','source-first','verify']:
      ['draft','verify','revise','source-first','verify']);
    assert.deepEqual(anchors,paraphrase?[original.sourceQuote,first,second]:[original.sourceQuote,second]);
    assert.equal(ready.parts[1].orientation.definitions[0].text,proposal.text);
  }
});

test('source-first recovery repairs two original cards exposed in succession in a single request',async t=>{
  const rows=structuredClone(authored);
  const originals=[
    {name:'Orbit',text:orbitQuote,sourceQuote:orbitQuote,sourceStep:2,dependsOn:[],intuition:''},
    {name:'Singleton orbit',text:singletonQuote,sourceQuote:singletonQuote,sourceStep:2,dependsOn:['Orbit'],intuition:''},
  ];
  rows[1].orientation.definitions=originals.map(d=>({...d,sourceQuote:'Neither of these clauses appears in the source.'}));
  for (const scenario of ['correct both','repeat first','substitute unknown name']) {
    const recovered=[];
    const api=client(await cache(t),async job=>{
      const filename=path.basename(job.outputPath);
      let output={parts:rows};
      if (filename==='definition-recovery.json') {
        const {targets}=JSON.parse(await fs.readFile(path.join(job.directory,'definition-recovery-input.json'),'utf8'));
        assert.equal(targets.length,1);
        assert.equal(targets[0].id,'total');
        const card=targets[0].card;
        recovered.push(card.name);
        assert.ok(recovered.length<=originals.length);
        const replacement=scenario==='correct both'?originals.find(d=>d.name===card.name):
          scenario==='repeat first'?card:{...card,name:'Unprinted condition'};
        output={parts:[{id:'total',definitions:[replacement]}]};
      } else if (filename==='definition-grounding.json') {
        const candidates=JSON.parse(job.prompt.split('\n\n').at(-1));
        output={checks:candidates.map(c=>{
          const verified=c.extractedText.includes(c.candidate);
          return {id:c.id,anchor:verified?c.candidate:'',sourceDefinition:verified?c.candidate:'',verified,
            comparison:verified?'The original passage states this definition.':'The cited clause does not support this definition.'};
        })};
      } else assert.equal(filename,'plan.json');
      await fs.writeFile(job.outputPath,JSON.stringify(output));
    });
    const result=await api.finish(await api.post(requestBody));
    if (scenario==='correct both') {
      assert.equal(result.status,'ready',result.message);
      assert.deepEqual(recovered,originals.map(d=>d.name));
      assert.deepEqual(result.parts[1].orientation.definitions.map(d=>[d.name,d.text]),originals.map(d=>[d.name,d.text]));
    } else {
      assert.equal(result.status,'error',scenario);
      assert.deepEqual(recovered,['Orbit','Orbit']);
      assert.equal(result.parts,undefined);
    }
  }
});

test('the first successful field repair can split a definition and preserves a dependent sibling',async t=>{
  const body=structuredClone(requestBody),rows=structuredClone(authored);
  body.units[0].text+=' '+orbitQuote;
  const common={sourceStep:2,dependsOn:[],intuition:''};
  const group='Orbits and fixed points';
  const sibling={...common,name:'Singleton orbit',text:singletonQuote,sourceQuote:singletonQuote,dependsOn:[group]};
  rows[1].orientation.definitions=[
    {...common,name:group,text:orbitQuote+' '+fixedPointQuote,sourceQuote:'An unprinted explanation of both notions.'},sibling];
  const cards=[{...common,name:'Orbit',text:orbitQuote,sourceQuote:orbitQuote,sourceStep:1},
    {...common,name:'Fixed point',text:fixedPointQuote,sourceQuote:fixedPointQuote}];
  const verified=[];
  let repairs=0;
  const api=client(await cache(t),async job=>{
    let output;
    const filename=path.basename(job.outputPath);
    if (filename==='definition-grounding.json') {
      const candidates=JSON.parse(job.prompt.split('\n\n').at(-1));
      output={checks:candidates.map(c=>{
        assert.ok(c.extractedText.includes(c.candidate));
        verified.push(c.term);
        return {id:c.id,anchor:c.candidate,sourceDefinition:c.candidate,verified:true,
          comparison:'The passage gives the defining condition for this specific object.'};
      })};
    } else if (filename==='plan.json' && job.prompt.includes('Repair only the notation rows')) {
      repairs++;
      output={parts:[{...rows[1],orientation:{...rows[1].orientation,definitions:[...cards,
        {...sibling,text:'The sibling definition would be overwritten.'}]}}]};
    } else {
      assert.equal(filename,'plan.json','the ordinary repair should resolve both source links');
      output={parts:rows};
    }
    await fs.writeFile(job.outputPath,JSON.stringify(output));
  });
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready',ready.message);
  assert.equal(repairs,1);
  assert.deepEqual(verified,cards.map(c=>c.name));
  const definitions=ready.parts[1].orientation.definitions;
  assert.deepEqual(definitions.map(c=>c.name),['Orbit','Fixed point','Singleton orbit']);
  assert.deepEqual(definitions.slice(0,2).map(d=>d.claimSource),[{group,step:1,page:1},{group,step:2,page:2}]);
  assert.equal(definitions[2].text,singletonQuote);
  assert.equal(definitions[2].claimSource,undefined);
});

test('recovered claim origins require their own source text and stay bound to corrected definitions',async t=>{
  const body=structuredClone(requestBody),rows=structuredClone(authored);
  body.units.forEach(u=>delete u.page);
  const group='Two polynomial coefficients';
  const original='Constant coefficient is the sum of the constant coefficients of the input polynomials.';
  const rounded='Linear coefficient is the sum of the linear coefficients of the input polynomials.';
  body.units[0].text+='\n'+original;
  body.units[1].text+='\n'+rounded;
  const cards=[
    {name:'Linear coefficient',text:rounded,sourceQuote:rounded,intuition:'',sourceStep:2,dependsOn:[]},
    {name:'Constant coefficient',text:original,sourceQuote:original,intuition:'',sourceStep:1,dependsOn:[]},
  ];
  rows[1].orientation.definitions=[{name:group,text:rounded+' '+original,
    sourceQuote:'Combine the pairs of coefficients as follows.',dependsOn:[],sourceStep:2,intuition:''}];
  for (const scenario of ['verified','wrong source','unsourced editorial change']) {
    const reviewed=[];
    const api=client(await cache(t),async job=>{
      const filename=path.basename(job.outputPath);
      let output={parts:rows};
      if (filename==='definition-recovery.json') {
        const split=structuredClone(cards);
        if (scenario==='wrong source') Object.assign(split[1],{sourceStep:2,sourceQuote:rounded});
        output={parts:[{id:'total',definitions:split}]};
      } else if (filename==='definition-grounding.json') {
        assert.deepEqual(job.imagePaths,[]);
        const candidates=JSON.parse(job.prompt.split('\n\n').at(-1));
        output={checks:candidates.map(c=>{
          reviewed.push(c.term);
          const verified=c.extractedText.includes(c.candidate);
          return {id:c.id,anchor:verified?c.candidate:rounded,sourceDefinition:verified?c.candidate:rounded,verified,
            comparison:verified?'The cited original text gives this exact definition.':'This text defines the linear coefficients, and does not define the constant coefficients.'};
        })};
      } else if (filename==='definition-review.json') {
        output={checks:[{id:cards[1].name,label:cards[1].name,verified:false,sourceText:rounded,
          comparison:'The edited interpretation of the constant coefficient is not supported by this original passage.'}]};
      }
      await fs.writeFile(job.outputPath,JSON.stringify(output));
    },undefined,async(_job,input)=>asEditorialRows(input.parts).map(r=>{
      if (r.id!=='total') return r;
      const correction={...cards[1],claimSource:{group:'Incorrect group',step:2,page:99}};
      if (scenario==='unsourced editorial change') Object.assign(correction,{sourceStep:2,sourceQuote:rounded});
      return {...r,definitionCorrections:[correction]};
    }));
    const result=await api.finish(await api.post(body));
    assert.deepEqual(reviewed,scenario==='wrong source'?[...cards.map(c=>c.name),group]:cards.map(c=>c.name));
    if (scenario==='verified') {
      assert.equal(result.status,'ready',result.message);
      assert.deepEqual(result.parts[1].orientation.definitions.map(d=>d.claimSource),[{group,step:2},{group,step:1}]);
    } else {
      assert.equal(result.status,'error',scenario);
      assert.equal(result.parts,undefined);
    }
  }
});

test('a required local introduction can span its own verified definition cards',async t=>{
  const arrival='An arrival releases one job into the system.';
  const departure='A departure occurs when a job finishes.';
  const queue='A queue contains the pending jobs.';
  const card=(name,text,sourceStep)=>({name,text,sourceStep,sourceQuote:text,intuition:'',dependsOn:[]});
  for (const scenario of ['complete','missing constituent','unrelated group','descriptive']) {
    const body=structuredClone(requestBody),rows=structuredClone(authored);
    const title=scenario==='descriptive'?'Two polynomial coefficients':'Arrivals and departures';
    const claims=scenario==='descriptive'?[
      card('Constant coefficient','To obtain the constant coefficient of a polynomial sum, add the constant coefficients of the components.',1),
      card('Linear coefficient','To obtain the linear coefficient of a polynomial sum, add the linear coefficients of the components.',2),
    ]:[card('Arrivals',arrival,1),card('Departures',departure,2)];
    body.analysis.localIntroductions.push({id:'local-pair',kind:'definition',title,
      meaning:claims.map(c=>c.text).join(' '),originPartId:'total'});
    body.units[0].text+=' '+claims[0].text;
    body.units[1].text+=' '+claims[1].text+' '+queue;
    const group=scenario==='unrelated group'?'Polynomial terms':title;
    rows[1].orientation.definitions=[{...card(group,claims.map(c=>c.text).join(' ')+' '+queue,2),
      sourceQuote:'An unsupported combined locator.'}];
    const split=scenario==='missing constituent'?[claims[0],card('Queue',queue,2)]:claims;
    const checked=[];
    const api=client(await cache(t),async job=>{
      const filename=path.basename(job.outputPath);
      let output={parts:rows};
      if (filename==='definition-recovery.json') {
        output={parts:[{id:'total',definitions:split}]};
      } else if (filename==='definition-grounding.json') {
        const candidates=JSON.parse(job.prompt.split('\n\n').at(-1));
        output={checks:candidates.map(c=>{
          assert.ok(c.extractedText.includes(c.candidate));
          checked.push(c.term);
          return {id:c.id,anchor:c.candidate,sourceDefinition:c.candidate,verified:true,
            comparison:'The cited text states the complete defining condition for this event.'};
        })};
      }
      await fs.writeFile(job.outputPath,JSON.stringify(output));
    });
    const result=await api.finish(await api.post(body));
    assert.deepEqual(checked,split.map(c=>c.name),scenario+' '+result.message);
    if (scenario==='complete' || scenario==='descriptive') {
      assert.equal(result.status,'ready',result.message);
      assert.deepEqual(result.parts[1].orientation.definitions.map(d=>d.claimSource),
        [{group:title,step:1,page:1},{group:title,step:2,page:2}]);
    } else {
      assert.equal(result.status,'error',scenario);
      assert.match(result.message,new RegExp(group,'i'));
      assert.equal(result.parts,undefined);
    }
  }
});

test('an editorial correction with a typeset PDF locator uses the original page',async t=>{
  const body=structuredClone(requestBody),draft=structuredClone(authored);
  body.pdfBase64=Buffer.from('%PDF-1.7\nthreshold\n%%EOF').toString('base64');
  const locator='The cutoff is the least integer';
  body.units[1].text+='\n'+locator+' greater than 7β.';
  const initial={name:'Threshold',text:'The cutoff is an integer.',sourceStep:2,sourceQuote:locator,intuition:'',dependsOn:[]};
  draft[1].orientation.definitions=[initial];
  const corrected={name:initial.name,text:'The cutoff is the least integer greater than seven times the interval width.',
    sourceStep:2,sourceQuote:locator+' greater than \\(7\\beta\\).',intuition:''};
  const dir=await cache(t);
  let checks=0;
  const api=client(dir,async job=>{
    if (path.basename(job.outputPath)==='definition-grounding.json') {
      checks++;
      const [entry]=JSON.parse(job.prompt.split('\n\n').at(-1));
      assert.match(job.imagePaths[0],/page-2\.png$/u);
      await fs.writeFile(job.outputPath,JSON.stringify({checks:[{id:entry.id,verified:true,anchor:locator,
        sourceDefinition:'The least integer greater than 7β.',
        comparison:'The minimum over integers and its strict lower bound match the printed definition.'}]}));
    } else await fs.writeFile(job.outputPath,JSON.stringify({parts:draft}));
  },async()=>Buffer.from('rendered page'),async(_job,input)=>asEditorialRows(input.parts).map(
    p=>p.id==='total'?{...p,definitionCorrections:[corrected]}:p));
  const result=await api.finish(await api.post(body));
  assert.equal(result.status,'ready',result.message);
  assert.equal(result.parts[1].orientation.definitions[0].text,corrected.text);
  assert.equal(checks,1);
});

test('a qualifying threshold supplied only as intuition is repaired into the sourced formal definition',async t=>{
  const cacheDir=await cache(t);
  const body=structuredClone(requestBody);
  const sourceQuote='A heavy endpoint is a fixed endpoint whose weight is at least 8.';
  body.units[1].text+='\n'+sourceQuote;
  const draft={name:'Heavy endpoint',text:'A heavy endpoint is a fixed endpoint.',
    intuition:'This name applies only when the weight is at least 8.',sourceStep:2,sourceQuote,dependsOn:[]};
  const formal={name:draft.name,text:sourceQuote,intuition:'The weight threshold singles out the endpoints to count separately.'};
  let calls=0,repairs;
  const api=client(cacheDir,async ({directory,outputPath})=>{
    const firstPass=++calls===1;
    if (!firstPass) repairs=JSON.parse(await fs.readFile(path.join(directory,'drafts.json'),'utf8'));
    const definition=firstPass?draft:{...draft,...formal};
    const total={...authored[1],orientation:{...authored[1].orientation,definitions:[definition]}};
    await fs.writeFile(outputPath,JSON.stringify({parts:firstPass?[authored[0],total]:[total]}));
  });
  const ready=await api.finish(await api.post(body));
  assert.equal(ready.status,'ready');
  assert.equal(calls,2);
  assert.deepEqual(repairs.map(d=>d.id),['total']);
  assert.match(repairs[0].reason,/formal text for Heavy endpoint/i);
  assert.deepEqual(ready.parts[1].orientation.definitions,[formal]);
  assert.deepEqual((await api.get(ready.key)).parts[1].orientation.definitions,[formal]);
});

test('the editor can restore a defining clause from the paper without turning a sufficient condition into the definition',async t=>{
  const cacheDir=await cache(t);
  const body=structuredClone(requestBody);
  const defining='A heavy endpoint is a fixed point whose weight is at least 8.';
  const scaled='A heavy endpoint is a fixed point whose weight equals \\(R\\).';
  const sufficient='Every fixed point of weight at least 16 is a heavy endpoint.';
  const proposition={kind:'Proposition',label:'Proposition 3',text:'A heavy endpoint has weight at least 8.'};
  const declaration=proposition.label+'. '+proposition.text;
  body.units[1].text+='\n'+defining+' '+sufficient+'\n'+scaled+'\n'+declaration;
  const mistaken={name:'Heavy endpoint',text:'A fixed point whose weight is at least 16.',intuition:'Such points pass the test.',
    sourceStep:2,sourceQuote:sufficient,dependsOn:['Fixed point']};
  const corrected={name:mistaken.name,text:defining,intuition:'The threshold determines which fixed points qualify.'};
  const fixed=authored[0].orientation.definitions[0];
  const rows=[authored[0],{...authored[1],orientation:{...authored[1].orientation,definitions:[mistaken,fixed],
    statement:{...proposition,sourceStep:2,sourceQuote:declaration}}}];
  let correction,extraChecks=0,editorDraft;
  const api=client(cacheDir,async ({outputPath,schemaPath,prompt})=>{
    const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
    if (schema.required.includes('checks')) {
      extraChecks++;
      assert.ok(prompt.includes(defining) && prompt.includes(sufficient));
      const check={id:mistaken.name,label:mistaken.name,verified:false,sourceText:defining,
        comparison:'The paper defines membership at 8. Weight 16 is sufficient; it is not necessary.'};
      await fs.writeFile(outputPath,JSON.stringify({checks:[check]}));
      return;
    }
    await fs.writeFile(outputPath,JSON.stringify({parts:rows}));
  },undefined,async (_job,input)=>{
    editorDraft=input.parts.find(p=>p.id==='total');
    return asEditorialRows(input.parts).map(p=>p.id==='total'?{...p,definitionCorrections:[correction]}:p);
  });
  for (const invalid of [
    {...corrected,sourceStep:2,sourceQuote:'All fixed points of every weight are heavy endpoints.'},
    {...corrected,name:'An invented class',sourceStep:2,sourceQuote:defining},
    {...corrected,text:'A fixed point whose weight is at least 42.',sourceStep:2,sourceQuote:defining},
    {...corrected,text:sufficient,sourceStep:2,sourceQuote:sufficient},
    {...corrected,text:'A heavy endpoint is a fixed point',sourceStep:2,sourceQuote:defining},
    {...corrected,text:scaled.replace('R','r'),sourceStep:2,sourceQuote:scaled},
  ]) {
    correction=invalid;
    const rejected=await api.finish(await api.post(body));
    assert.equal(rejected.status,'error',JSON.stringify(invalid));
    assert.equal(Object.hasOwn(rejected,'parts'),false);
  }
  extraChecks=0;
  correction={...corrected,sourceStep:2,sourceQuote:defining};
  const reviewed=await api.finish(await api.post(body));
  assert.equal(reviewed.status,'ready',reviewed.message);
  assert.equal(extraChecks,0,'a literal defining clause in the assigned original passage needs no visual check');
  assert.deepEqual(editorDraft.orientation.definitions.map(d=>d.name),['Fixed point','Heavy endpoint']);
  assert.equal(editorDraft.orientation.definitions[1].text,mistaken.text);
  const part=reviewed.parts[1];
  assert.deepEqual(part.orientation.definitions,[generated[0].orientation.definitions[0],corrected]);
  assert.deepEqual(part.orientation.statement,proposition);
  assert.equal(part.title,analysis.parts[1].title);
  assert.equal(part.question,authored[1].question);
  assert.deepEqual((await api.get(reviewed.key)).parts,reviewed.parts);
});

test('a single targeted repair supplies missing notation and paper-local definitions without rewriting the section',async t=>{
  const cacheDir=await cache(t);
  const body=structuredClone(requestBody);
  const quote='The job size of a job is the total processing time it requires.';
  const claim=String.raw`Job \(j\) completes after receiving \(p_j\) units of service.`;
  const printed='Lemma 3.1. '+claim;
  body.units[1].text+='\n'+quote+'\n'+printed;
  body.analysis.knowledge.definitionGroups.push({id:'job-language',title:'Job terminology',definitions:[{term:'Job size',meaning:quote}]});
  body.analysis.parts[1].definitionGroupIds.push('job-language');
  body.analysis.localIntroductions.push({id:'job-size',kind:'definition',originPartId:'total',title:'Job size',meaning:quote,
    sourceAnchors:[{step:2,phrase:quote}]});
  body.readerKnowledge.definitionGroups.push({title:'Job terminology',state:'known',knownTerms:['Job size'],remainingTerms:[]});
  const job={symbol:String.raw`\(j\)`,meaning:'The index of the job.'};
  const size={symbol:String.raw`\(p_j\)`,meaning:'The processing time required by the indexed job.'};
  const unrelated={symbol:String.raw`\(m\)`,meaning:'The number of jobs.'};
  const definition={name:'Job size',text:quote,sourceStep:2,sourceQuote:quote,dependsOn:[]};
  const formal={kind:'Lemma',label:'Lemma 3.1',text:claim};
  const covered={...authored[1].orientation,notation:[job,size],definitions:[definition],
    paragraphs:['Track the service accumulated by the job until it reaches its required size.'],
    statement:{...formal,sourceStep:2,sourceQuote:printed}};
  const scenarios=[
    {name:'empty glossary',section:{...covered,notation:[]}},
    {name:'wrong glossary in a proof paragraph',section:{...covered,notation:[job,unrelated],statement:null,paragraphs:[claim]}},
    {name:'missing definition at its declared origin',section:{...covered,definitions:[]}},
    {name:'upgrade only the existing sections',mode:'orientation',section:{...covered,notation:[]}},
  ];
  let current,repairSection,responses=0;
  const calls=[];
  const api=client(cacheDir,async ({directory,schemaPath,outputPath})=>{
    const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
    const repair=responses++>0;
    const targets=repair?JSON.parse(await fs.readFile(path.join(directory,'drafts.json'),'utf8')):[];
    calls.push({schema,targets});
    const rows=repair?[{id:'total',question:'A replacement question?',orientation:{...repairSection,
      introduction:'A replacement introduction.',handoff:'A replacement handoff.',paragraphs:['A different derivation.'],statement:null}}]:
      [authored[0],{...authored[1],orientation:current}];
    const parts=schema.properties.parts.items.required.includes('question')?rows:rows.map(({id,orientation})=>({id,orientation}));
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  });
  for (const scenario of scenarios) {
    current=scenario.section; repairSection=covered; responses=0; calls.length=0;
    body.analysis.revision=scenario.name;
    const ready=await api.finish(await api.post({...body,mode:scenario.mode}));
    assert.equal(ready.status,'ready',scenario.name);
    assert.equal(calls.length,2,scenario.name);
    assert.deepEqual(calls[1].schema,calls[0].schema);
    assert.deepEqual(calls[1].targets.map(target=>target.id),['total']);
    const missingDefinition=!current.definitions.length;
    assert.match(calls[1].targets[0].reason,missingDefinition?/Job size/:/p_\{?j/);
    assert.equal(calls[0].schema.properties.parts.items.required.includes('question'),scenario.mode!=='orientation');
    const section=ready.parts[1].orientation;
    assert.deepEqual(section.notation,[job,size]);
    assert.equal(section.definitions[0].name,'Job size');
    assert.deepEqual(section.paragraphs,current.paragraphs);
    assert.equal(section.introduction,current.introduction);
    assert.equal(section.handoff,current.handoff);
    assert.deepEqual(section.statement,current.statement?formal:null);
    assert.equal(ready.parts[1].question,scenario.mode==='orientation'?undefined:authored[1].question);
    assert.deepEqual(ready.parts[0].orientation,generated[0].orientation);
  }
  current=scenarios[1].section; repairSection=current; responses=0; calls.length=0;
  body.analysis.revision='repeated omission';
  const failed=await api.finish(await api.post(body));
  assert.equal(failed.status,'error');
  assert.equal(Object.hasOwn(failed,'parts'),false);
  assert.equal(calls.length,3,'stop after a targeted repair and one recovery without progress');
  assert.deepEqual(calls.slice(1).map(call=>call.targets.map(target=>target.id)),[['total'],['total']]);
  assert.equal((await fs.readdir(cacheDir)).includes(failed.key+'.json'),false);
  current=covered; responses=0; calls.length=0;
  const retry=await api.finish(await api.post(body));
  assert.equal(retry.status,'ready');
  assert.equal(retry.key,failed.key);
  assert.equal(calls.length,1);
});

test('integrals distinguish paper-specific symbols from their dummy variable, Euler’s number and stated units',async t=>{
  const cacheDir=await cache(t);
  const notation=[{symbol:String.raw`\(T\)`,meaning:'The end of the observation period.'},
    {symbol:String.raw`\(f\)`,meaning:'The incoming mass per unit of time.'}];
  const section={introduction:'Accumulate the incoming mass, discounting later arrivals.',notation,definitions:[],
    paragraphs:[String.raw`Elapsed time is measured in unit intervals, and mass in kilograms. The total incoming mass is \(\int_0^T f(t)\,dt\). Scaling the discount gives \(\int_0^T 1.5e^{-t}f(t)\,dt\), which can be compared with a reference mass of \(1\,\mathrm{kg}\).`],
    handoff:'',statement:null};
  const sourcePart={id:'mass',title:'Accumulate the mass',summary:section.introduction,sourceSteps:[1],
    techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[]};
  const body={title:'A discounted mass integral',units:[{title:sourcePart.title,text:section.paragraphs[0],page:1}],
    analysis:{preparationVersion:2,displayTitle:'A discounted mass integral',parts:[sourcePart],localIntroductions:[],
      knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
  let calls=0,initial=notation,repairReasons=[];
  const api=client(cacheDir,async ({directory,outputPath})=>{
    calls++;
    if (calls>1) repairReasons=JSON.parse(await fs.readFile(path.join(directory,'drafts.json'),'utf8')).map(d=>d.reason);
    const orientation={...section,notation:calls===1?initial:notation};
    await fs.writeFile(outputPath,JSON.stringify({parts:[{id:'mass',question:'Which arrivals receive the most weight?',orientation}]}));
  });
  const complete=await api.finish(await api.post(body));
  assert.equal(complete.status,'ready',repairReasons.join('\n'));
  assert.equal(calls,1,'the standard differential, exponential and units need no notation repair');
  assert.deepEqual(complete.parts[0].orientation.notation,notation);
  calls=0; initial=notation.slice(1);
  const omitted=await api.finish(await api.post({...body,analysis:{...body.analysis,revision:'missing endpoint'}}));
  assert.equal(omitted.status,'ready');
  assert.equal(calls,2,'the genuine integration endpoint still needs a notation row');
  assert.deepEqual(omitted.parts[0].orientation.notation,notation);
  calls=0; initial=notation;
  section.paragraphs.push(String.raw`A marked edge \(e\) is paired with the initial edge \(e_0\). The total edge mass is \(\mathrm{EDGE}\).`);
  body.units[0].text+=' '+section.paragraphs.at(-1);
  const edges=await api.finish(await api.post({...body,analysis:{...body.analysis,revision:'missing edge symbols'}}));
  assert.equal(edges.status,'error');
  assert.match(repairReasons.join(' '),/Explain the section notation e, e_0, EDGE/);
});

test('review verifies worked decimal substitutions without waiving an unrelated or changed bound',async t=>{
  const body=structuredClone(requestBody);
  const draft=structuredClone(authored);
  const lead='Let \\(P\\) be the size of a cell.';
  const paragraph='The cutoff uses the scale \\(1.25P\\). The example starts from a size of \\(.42\\).';
  Object.assign(draft[1].orientation,{introduction:lead,paragraphs:[paragraph],notation:[{symbol:'\\(P\\)',meaning:'The size of the cell.'}]});
  body.units[1].text+=' The cutoff uses the scale 1.25P. Consider a cell of size .42.';
  const valid='At \\(P=.42\\), the product \\(1.25P\\) equals \\(.525\\).';
  let illustration,repairs;
  const api=client(await cache(t),async ({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:draft})),
    undefined,async (_job,input)=>{
      const editing=asEditorialRows(input.parts);
      const row=editing.find(r=>r.id==='total');
      if (row) {
        repairs++;
        row.paragraphs.push(repairs===1?illustration:valid);
      }
      return editing;
    });
  for (const [index,example] of [valid,valid.replace('525','526'),valid+' The guaranteed bound is \\(.525\\).',
    valid.replace('1.25P','1.26P').replace('525','5292'),
    'At a boundary of size \\(.42\\), the unrounded cutoff is \\(.525\\).'].entries()) {
    repairs=0; illustration=example;
    body.analysis.revision='worked substitution '+index;
    const ready=await api.finish(await api.post(body));
    assert.equal(ready.status,'ready',ready.error);
    assert.equal(ready.parts[1].orientation.paragraphs.at(-1),valid);
    assert.equal(repairs,index===0?1:2);
  }
});

test('a printed minus sign grounds a distinct boundary case only for the complete expression in the assigned passage',async t=>{
  const body=structuredClone(requestBody),draft=structuredClone(authored);
  const introduction='A row of tiles has length \\(n\\). Number its positions from zero and write \\(i\\) for the selected position.';
  const inside='There is another tile to the right when \\(i<n-1\\).';
  const boundary='At the final tile, \\(i=n-1\\), the row ends.';
  Object.assign(draft[1].orientation,{introduction,paragraphs:[inside],notation:[
    {symbol:'\\(n\\)',meaning:'The number of tiles in the row.'},{symbol:'\\(i\\)',meaning:'The tile position.'}]});
  const unit=body.units[1].text;
  // An equation on a different page may concern a different indexing scheme.
  body.units[0].text+=' For the other row, i=n-1.';
  let attempts=0;
  const api=client(await cache(t),job=>fs.writeFile(job.outputPath,JSON.stringify({parts:draft})),undefined,
    async (_job,input)=>asEditorialRows(input.parts.map(p=>{
      if (p.id!=='total') return p;
      attempts++;
      return {...p,orientation:{...p.orientation,paragraphs:attempts===1?[inside,boundary]:[inside]}};
    })));
  for (const printed of ['i = n − 1','i = n − 10','i < n − 1','i = n + 1','i = n − 1 + 4','i = n − 1.5','vi = n − 1']) {
    body.units[1].text=unit+' The endpoint satisfies '+printed+'.';
    attempts=0;
    const result=await api.finish(await api.post(body));
    assert.equal(result.status,'ready',result.message);
    const supported=printed==='i = n − 1';
    assert.deepEqual(result.parts[1].orientation.paragraphs,supported?[inside,boundary]:[inside],printed);
    assert.equal(attempts,supported?1:2,printed);
  }
});

test('a grounded integer product may reorder its factors while preserving the entire bound',async t=>{
  const body=structuredClone(requestBody),draft=structuredClone(authored);
  const expression=(left,tail)=>'The combined constant satisfies \\('+left+'='+tail+'\\).';
  const original=expression('2\\cdot37\\cdot2','148\\le150');
  const reordered=expression('37\\cdot2\\cdot2','148\\le150');
  draft[1].orientation.paragraphs=[original];
  body.units[1].text+=' Two factors of two and the factor 37 give a coefficient below one hundred fifty.';
  let candidate,attempts;
  const api=client(await cache(t),job=>fs.writeFile(job.outputPath,JSON.stringify({parts:draft})),undefined,
    async (_job,input)=>asEditorialRows(input.parts.map(p=>{
      if (p.id!=='total') return p;
      attempts++;
      return {...p,orientation:{...p.orientation,paragraphs:[attempts===1?candidate:reordered]}};
    })));
  const variations=[reordered,expression('37\\cdot2\\cdot37','148\\le150'),expression('37\\cdot2','148\\le150'),
    expression('74\\cdot2','148\\le150'),
    expression('37\\cdot2\\cdot2','148\\ge150'),expression('37\\cdot2\\cdot2','149\\le150')];
  for (const [index,edit] of variations.entries()) {
    candidate=edit; attempts=0; body.analysis.revision='closed product '+index;
    const plan=await api.finish(await api.post(body));
    assert.equal(plan.status,'ready',plan.message);
    assert.deepEqual(plan.parts[1].orientation.paragraphs,[reordered]);
    assert.equal(attempts,index===0?1:2);
  }
});

test('adjacent uppercase factors retain their separate meanings in a product',async t=>{
  const body=structuredClone(requestBody);
  const draft=structuredClone(authored);
  const lead='The number of rows is \\(N\\), each row has width \\(R\\), and the height is \\(K\\).';
  const paragraph='The area of one row is \\(RK\\). The total area is \\(NRK\\).';
  const notation=['N','R','K'].map((letter,i)=>({symbol:'\\('+letter+'\\)',meaning:['The number of rows.','The row width.','The row height.'][i]}));
  Object.assign(draft[1].orientation,{introduction:lead,paragraphs:[paragraph],notation});
  body.units[1].text+=' '+lead+' '+paragraph;
  let edits=0,operator=false;
  const api=client(await cache(t),async ({outputPath})=>fs.writeFile(outputPath,JSON.stringify({parts:draft})),
    undefined,async (_job,input)=>{
      const editing=asEditorialRows(input.parts);
      const row=editing.find(r=>r.id==='total');
      if (row && ++edits===1 && operator) row.paragraphs=[paragraph.replace('NRK','\\operatorname{NRK}')];
      return editing;
    });
  for (const named of [false,true]) {
    operator=named; edits=0; body.analysis.revision='capital factors '+String(named);
    const ready=await api.finish(await api.post(body));
    assert.equal(ready.status,'ready',ready.error);
    assert.equal(edits,named?2:1,'an unintroduced upright operator still needs a correction');
    assert.equal(ready.parts[1].orientation.paragraphs[0],paragraph);
  }
});

test('a signed interval endpoint can be named separately while a changed inequality still needs review',async t=>{
  const body=structuredClone(requestBody),draft=structuredClone(authored);
  const lead='A job of size \\(x\\) belongs to the closed size interval \\([p_i^-,p_i^+]\\).';
  const upper='Use the upper endpoint \\(p_i^+\\) to bound the size by \\(x\\le p_i^+\\).';
  const lower='Call its lower endpoint \\(p_i^-\\).';
  const correct=[lower,upper],wrong=[lower,upper.replace('x\\le p_i^+','x\\le p_i^-')];
  Object.assign(draft[1].orientation,{introduction:lead,paragraphs:[upper],notation:[
    {symbol:'\\(x\\)',meaning:'The job size.'},
    {symbol:'\\(p_i^-\\)',meaning:'The lower endpoint of interval number i.'},
    {symbol:'\\(p_i^+\\)',meaning:'The upper endpoint of interval number i.'},
  ]});
  body.units[1].text+=' The job size lies between the lower and upper endpoints of its interval.';
  let attempts,changeBound;
  const api=client(await cache(t),job=>fs.writeFile(job.outputPath,JSON.stringify({parts:draft})),undefined,
    async (_job,input)=>asEditorialRows(input.parts.map(p=>{
      if (p.id!=='total') return p;
      attempts++;
      return {...p,orientation:{...p.orientation,paragraphs:changeBound && attempts===1?wrong:correct}};
    })));
  for (const changed of [false,true]) {
    attempts=0;changeBound=changed;body.analysis.revision='signed endpoints '+changed;
    const plan=await api.finish(await api.post(body));
    assert.equal(plan.status,'ready',plan.message);
    assert.deepEqual(plan.parts[1].orientation.paragraphs,correct);
    assert.equal(attempts,changed?2:1);
  }
});

test('a logarithm owns its base when it follows a coefficient',async t=>{
  const body=structuredClone(requestBody),draft=structuredClone(authored);
  const lead='Write \\(\\Lambda\\) for the decay rate and \\(b\\) for the base-dependent input.';
  const good='The logarithmic term in the estimate is \\(2\\Lambda\\log_2 b\\).';
  const wrong=good.replace('\\Lambda\\log','\\Lambda_2\\log');
  Object.assign(draft[1].orientation,{introduction:lead,paragraphs:[good],notation:[
    {symbol:'\\(\\Lambda\\)',meaning:'The decay rate.'}, {symbol:'\\(b\\)',meaning:'The input to the logarithm.'}
  ]});
  let changed,edits;
  const api=client(await cache(t),job=>fs.writeFile(job.outputPath,JSON.stringify({parts:draft})),undefined,
    async (_job,input)=>asEditorialRows(input.parts.map(p=>{
      if (p.id!=='total') return p;
      edits++;
      return {...p,orientation:{...p.orientation,paragraphs:[changed && edits===1?wrong:good]}};
    })));
  for (const actualSubscript of [false,true]) {
    edits=0;changed=actualSubscript;body.analysis.revision='logarithm base '+changed;
    const plan=await api.finish(await api.post(body));
    assert.equal(plan.status,'ready',plan.message);
    assert.equal(plan.parts[1].orientation.paragraphs[0],good);
    assert.equal(edits,changed?2:1);
  }
});

test('a formal statement needs its own declaration and actual claim in an assigned source unit',async t=>{
  const cacheDir=await cache(t);
  const claim='The involution fixes the endpoint and pairs every interior point with a distinct partner.';
  const statement={kind:'Lemma',label:'Lemma 2.1',text:claim};
  const declared={...statement,sourceStep:1,sourceQuote:source.units[0].text};
  const condition=' This conclusion holds only when the number of points is odd.';
  const conditionalClaim={...statement,text:claim+condition};
  const lengthClaim='The path has length \\(2^{3}\\) after the final turn.';
  const lengthVariant=lengthClaim.replace('2^{3}','2^3');
  const lengthStatement={...statement,text:lengthVariant};
  const lengthQuote='Lemma 2.1. '+lengthVariant;
  let candidates=[];
  const api=client(cacheDir,async ({outputPath})=>{
    const parts=authored.map((part,i)=>({...part,orientation:{...part.orientation,statement:candidates[i]}}));
    await fs.writeFile(outputPath,JSON.stringify({parts}));
  });
  const cases=[
    {first:declared,second:declared,expected:statement,reason:'the second part does not contain original source unit 1'},
    {first:{...lengthStatement,sourceStep:1,sourceQuote:lengthQuote},second:null,
      firstUnit:'Lemma 2.1. '+lengthClaim,expected:lengthStatement,reason:'different brace spellings identify the same declared quantity'},
    {first:{...lengthStatement,text:lengthVariant.replace('2^3','2^4'),sourceStep:1,sourceQuote:lengthQuote},second:null,
      firstUnit:'Lemma 2.1. '+lengthClaim,expected:null,reason:'a different exponent changes the declared quantity'},
    {first:statement,second:null,expected:null,reason:'the model supplied no supporting excerpt'},
    {first:{...declared,sourceQuote:'Lemma 2.1. Every imaginable map fixes the endpoint.'},second:null,
      expected:null,reason:'the excerpt is absent from the source'},
    {first:{...declared,sourceQuote:'Lemma 2.1.'},second:null,expected:null,reason:'a label by itself cannot support the claim'},
    {first:{...declared,sourceStep:2,sourceQuote:source.units[1].text},second:null,
      expected:null,reason:'By Lemma 2.1 cites a declaration made elsewhere'},
    {first:declared,second:null,firstUnit:'Proof of '+source.units[0].text,
      expected:null,reason:'a proof heading is not the declaration'},
    {first:declared,second:null,firstUnit:source.units[0].text+' Provided that the underlying interval has odd size.',
      expected:null,reason:'the quotation stops before a stated hypothesis'},
    {first:declared,second:null,firstUnit:source.units[0].text+condition,
      expected:null,reason:'the last sentence of the declaration restricts its conclusion'},
    {first:{...conditionalClaim,sourceStep:1,sourceQuote:source.units[0].text+condition},second:null,
      firstUnit:source.units[0].text+condition+'\nProof. Pair the interior points.',
      expected:conditionalClaim,reason:'the complete qualified declaration ends where its proof begins'},
    {first:{...declared,label:'Lemma 2.10'},second:null,expected:null,reason:'the printed number differs'},
    {first:{...declared,kind:'Theorem',label:'Theorem 2.1'},second:null,expected:null,reason:'the printed kind differs'},
    {first:{...declared,text:'The involution never fixes the endpoint and pairs every interior point with a distinct partner.'},
      second:null,expected:null,reason:'the rewritten text reverses a conclusion in the quoted declaration'},
  ];
  for (const [index,example] of cases.entries()) {
    candidates=[example.first,example.second];
    const units=example.firstUnit?[{...source.units[0],text:example.firstUnit},source.units[1]]:source.units;
    const body={...requestBody,units,analysis:{...analysis,revision:'evidence-'+index}};
    const job=await api.finish(await api.post(body));
    assert.equal(job.status,'ready',example.reason+' '+(job.message||job.error||''));
    assert.deepEqual(job.parts.map(p=>p.orientation.statement),[example.expected,null],example.reason);
    assert.doesNotMatch(JSON.stringify(job),/sourceQuote|sourceStep"/);
    assert.deepEqual((await api.get(job.key)).parts,job.parts);
  }

  for (const [kind,label] of [['Theorem','Theorem 4'],['Proposition','Proposition 2.3'],['Corollary','']]) {
    const text=(label || kind)+'. '+claim;
    const expected={kind,label,text:claim};
    candidates=[{...expected,sourceStep:1,sourceQuote:text},null];
    const units=[{...source.units[0],text},source.units[1]];
    const job=await api.finish(await api.post({...requestBody,units}));
    assert.equal(job.status,'ready');
    assert.deepEqual(job.parts[0].orientation.statement,expected);
  }
});

test('an independent visual transcription verifies statements on raster-only and scrambled source pages',async t=>{
  const cacheDir=await cache(t);
  const pdf=Buffer.from('%PDF-1.7\nRectangle test\n%%EOF'),pageImage=Buffer.from('The rectangle lemma on page two.');
  const label='Lemma 1 (Enclosed rectangle)';
  const text='Suppose a rectangle has height v and width u, with u > 3 and v > 5. Its area exceeds 3v, and its width divided by its height exceeds 3/v.';
  const formatted=String.raw`Suppose a rectangle has height \(v\) and width \(u\), with \(u>3\) and \(v>5\). Its area exceeds \(3v\), and its width divided by its height exceeds \(3/v\).`;
  const damaged=label+'. Suppose a rectangle has height v and width u,\nwith u 3 and v 5. Its area exceeds 3 v, and its width divided by its height exceeds 3 v.';
  const units=[{title:'Enclosed rectangle',text:'Page 2',page:2},{title:'Comparison',text:'3',page:3}];
  const body={...requestBody,title:'Rectangle estimates',units,pdfBase64:pdf.toString('base64')};
  const notation=[['u','The rectangle width.'],['v','The rectangle height.']]
    .map(([symbol,meaning])=>({symbol:String.raw`\(${symbol}\)`,meaning}));
  const calls=[];
  let statement,check,quoteBody,editorInput;
  const api=client(cacheDir,async ({schemaPath,imagePaths,outputPath})=>{
    const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
    const images=await Promise.all(imagePaths.map(file=>fs.readFile(file)));
    assert.deepEqual(images,[pageImage]);
    if (schema.required.includes('checks')) {
      calls.push('verify');
      await fs.writeFile(outputPath,JSON.stringify({checks:[check]}));
    } else {
      calls.push('generate');
      const parts=authored.map((row,i)=>({...row,orientation:{...row.orientation,notation:[...row.orientation.notation,...notation],definitions:[],
        statement:{...statement,sourceStep:i+1,sourceQuote:label+'. '+quoteBody}}}));
      await fs.writeFile(outputPath,JSON.stringify({parts}));
    }
  },async (bytes,page)=>{
    assert.deepEqual(bytes,pdf);
    if (Number(page)!==2) throw Error('No raster for this page');
    return pageImage;
  },async (job,input)=>{
    assert.deepEqual(await fs.readFile(path.join(job.directory,'original.pdf')),pdf);
    assert.deepEqual(await Promise.all(job.imagePaths.map(file=>fs.readFile(file))),[pageImage]);
    editorInput=input.parts;
    return asEditorialRows(input.parts);
  });
  const withoutHypothesis=formatted.replace(String.raw` and \(v>5\)`, '');
  const wrongPower=formatted.replace('3v','3v^{2}');
  const changedPowers=formatted.replace('3v','3v^{2}').replace('3/v','3/v^{3}');
  const swappedPowers=formatted.replace('3v','3v^{3}').replace('3/v','3/v^{2}');
  const changedGrouping=formatted.replace('3/v','3v');
  const natural=formatted.replace('3v','3\\ln u');
  const naturalAlias=formatted.replace('3v','3\\operatorname{ln}(u)');
  const paraphrase=formatted.replace('a rectangle has height','the rectangle has height')
    .replace('Its area exceeds','Its area is greater than');
  const cases=[
    {source:'Page 2',candidate:text,transcription:text,verdict:true,accept:true},
    {source:damaged,candidate:formatted,transcription:formatted,verdict:true,accept:true},
    {source:damaged,candidate:formatted,transcription:formatted,verdict:false,accept:false},
    {source:damaged,candidate:withoutHypothesis,transcription:formatted,verdict:true,accept:false,canRejectEarly:true},
    {source:damaged,candidate:formatted,transcription:withoutHypothesis,verdict:true,accept:false},
    {source:label+'. '+wrongPower,quote:wrongPower,candidate:wrongPower,transcription:formatted,verdict:false,accept:false},
    {source:damaged,candidate:changedPowers,transcription:swappedPowers,verdict:true,accept:false},
    {source:damaged,candidate:changedGrouping,transcription:formatted,verdict:true,accept:false},
    {source:damaged,candidate:natural,transcription:naturalAlias,verdict:true,accept:true},
    {source:damaged,candidate:natural,transcription:naturalAlias.replace('{ln}','{log}'),verdict:true,accept:false},
    {source:damaged,candidate:paraphrase,transcription:formatted,verdict:true,accept:true},
  ];
  for (const [index,c] of cases.entries()) {
    statement={kind:'Lemma',label,text:c.candidate};
    quoteBody=c.quote ?? text;
    check={id:'pairing',label,verified:c.verdict,sourceText:c.transcription,comparison:c.verdict?
      'The heading, both dimension hypotheses and both lower bounds match the original page.':
      'The final lower bound could not be confirmed from the page.'};
    const currentUnits=[{...units[0],text:c.source},units[1]];
    const ready=await api.finish(await api.post({...body,units:currentUnits,analysis:{...analysis,revision:'visual-'+index}}));
    assert.equal(ready.status,'ready');
    assert.deepEqual(ready.parts.map(part=>part.orientation.statement),[c.accept?statement:null,null],
      `visual verification case ${index+1}: ${c.candidate} / ${c.transcription}`);
    assert.deepEqual(editorInput.map(part=>part.orientation.statement),[c.accept?statement:null,null]);
    const observed=calls.splice(0);
    if (!c.canRejectEarly || observed.length>1) assert.deepEqual(observed,['generate','verify']);
    else assert.deepEqual(observed,['generate']);
    assert.deepEqual((await api.get(ready.key)).parts,ready.parts);
  }
});

test('an orientation-only upgrade leaves the old full plan intact and has its own durable cache',async t=>{
  const cacheDir=await cache(t);
  const legacyParts=generated.map(({id,question},i)=>({id,opening:previousOpenings[i],question,
    title:analysis.parts[i].title,sourceSteps:analysis.parts[i].sourceSteps}));
  const legacyKey='b'.repeat(64);
  const legacyPath=path.join(cacheDir,legacyKey+'.json');
  const legacyFile=JSON.stringify({version:'personalized-parts-2',key:legacyKey,parts:legacyParts});
  await fs.writeFile(legacyPath,legacyFile);
  const archivedFull=legacyParts.map((part,i)=>({...part,orientation:previousOrientations[i]}));
  const archivedOrientations=archivedFull.map(({id,orientation})=>({id,orientation}));
  const orientationParts=generated.map(({id,orientation})=>({id,orientation}));
  const previousSections=legacyParts.map((part,i)=>({...part,orientation:generated[i].orientation,
    opening:generated[i].orientation.paragraphs.join('\n\n')}));
  const older=[
    {version:'personalized-parts-3-orientation',key:'c'.repeat(64),parts:archivedFull},
    {version:'orientation-only-1',key:'d'.repeat(64),parts:archivedOrientations},
    {version:'personalized-parts-4-sections',key:'e'.repeat(64),parts:previousSections},
    {version:'orientation-only-2-sections',key:'f'.repeat(64),parts:orientationParts},
  ];
  await Promise.all(older.map(data=>fs.writeFile(path.join(cacheDir,data.key+'.json'),JSON.stringify(data))));
  const authoredOrientations=authored.map(({id,orientation})=>({id,orientation}));
  const release=Promise.withResolvers();
  const requiredFields=[];
  const workerInputs=[];
  let payload=authoredOrientations,runs=0;
  const api=client(cacheDir,async ({directory,outputPath,schemaPath,prompt})=>{
    runs++;
    const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
    requiredFields.push(schema.properties.parts.items.required);
    const files=(await fs.readdir(directory)).filter(name=>name.endsWith('.json') && name!=='schema.json');
    const inputs=await Promise.all(files.map(name=>fs.readFile(path.join(directory,name),'utf8')));
    workerInputs.push([prompt,...inputs].join('\n'));
    await release.promise;
    await fs.writeFile(outputPath,JSON.stringify({parts:payload}));
  });
  const legacy=await api.get(legacyKey);
  assert.equal(legacy.status,'ready');
  assert.deepEqual(legacy.parts,legacyParts);
  for (const saved of older) {
    const previous=await api.get(saved.key);
    assert.equal(previous.status,'ready');
    assert.deepEqual(previous.parts,saved.parts);
    assert.equal(Object.hasOwn(previous,'editorialRevision'),false);
    assert.equal(Object.hasOwn(previous,'editorialSkillDigest'),false);
  }
  const existingOpenings=legacyParts.map(({id,opening})=>({id,opening}));
  const upgrade={...requestBody,mode:'orientation',existingOpenings};
  const first=await api.post(upgrade);
  assert.equal(first.status,'running');
  assert.equal((await api.post(structuredClone(upgrade))).key,first.key);
  release.resolve();
  const completed=await api.finish(first);
  assert.equal(completed.status,'ready');
  assert.deepEqual(completed.parts,orientationParts);
  assert.notEqual(completed.key,legacyKey);
  assert.equal(await fs.readFile(legacyPath,'utf8'),legacyFile);
  const cold=client(cacheDir,async()=>{throw Error('Unexpected regeneration after upgrade');});
  assert.deepEqual(await cold.get(legacyKey),legacy);
  for (const saved of older) {
    assert.deepEqual((await cold.get(saved.key)).parts,saved.parts);
    assert.equal(await fs.readFile(path.join(cacheDir,saved.key+'.json'),'utf8'),JSON.stringify(saved));
  }
  assert.deepEqual(await cold.get(completed.key),completed);
  assert.deepEqual(await cold.post(upgrade),completed);
  assert.equal(runs,1);
  payload=authored;
  const full=await api.finish(await api.post(requestBody));
  assert.equal(full.status,'ready');
  assert.notEqual(full.key,completed.key);
  assert.notEqual(full.key,legacyKey);
  const persisted=async key=>JSON.parse(await fs.readFile(path.join(cacheDir,key+'.json'),'utf8'));
  assert.equal((await persisted(full.key)).version,'personalized-parts-6-inline-notation');
  assert.equal((await persisted(completed.key)).version,'orientation-only-4-inline-notation');
  assert.equal((await persisted(full.key)).editorialRevision,editorialRevision);
  assert.equal((await persisted(completed.key)).editorialSkillDigest,completed.editorialSkillDigest);
  assert.equal(full.parts[0].question,generated[0].question);
  assert.equal(runs,2);
  assert.ok(requiredFields[0].includes('orientation'));
  assert.ok(!requiredFields[0].includes('opening') && !requiredFields[0].includes('question'));
  assert.deepEqual([...requiredFields[1]].sort(),['id','orientation','question']);
  for (const saved of existingOpenings) assert.ok(workerInputs[0].includes(saved.opening));

  payload=authoredOrientations;
  const altered=structuredClone(upgrade);
  altered.existingOpenings[1].opening='Count pairs first, then account for the remaining endpoint.';
  const changed=await api.finish(await api.post(altered));
  assert.equal(changed.status,'ready');
  assert.notEqual(changed.key,completed.key);
  assert.ok(workerInputs[2].includes(altered.existingOpenings[1].opening));
  const noOpenings=await api.finish(await api.post({...requestBody,mode:'orientation'}));
  assert.equal(noOpenings.status,'ready');
  assert.deepEqual(noOpenings.parts,orientationParts);
  assert.notEqual(noOpenings.key,full.key);
});

test('invalid first-pass source references are rejected before a personalized question is generated',async t=>{
  const cacheDir=await cache(t);
  let runs=0;
  const api=client(cacheDir,async()=>{runs++;});
  const copy=structuredClone(requestBody);
  copy.analysis.parts[1].sourceSteps=[3];
  await assert.rejects(()=>api.post(copy),{status:400});
  const dangling=structuredClone(requestBody);
  dangling.analysis.parts[1].localPrerequisiteIds=['invented-lemma'];
  await assert.rejects(()=>api.post(dangling),{status:400});
  const later=structuredClone(requestBody);
  later.analysis.localIntroductions[0].originPartId='total';
  await assert.rejects(()=>api.post(later),{status:400});
  await assert.rejects(()=>api.post({...requestBody,readerKnowledge:undefined}),{status:400});
  await assert.rejects(()=>api.post({...requestBody,analysis:{...analysis,parts:[]}}),{status:400});
  const openings=generated.map(({id},i)=>({id,opening:previousOpenings[i]}));
  await assert.rejects(()=>api.post({...requestBody,mode:'unrecognized'}),{status:400});
  await assert.rejects(()=>api.post({...requestBody,existingOpenings:openings}),{status:400});
  for (const invalid of [[],openings.toReversed(),[{...openings[0],opening:'  '},openings[1]]]) {
    await assert.rejects(()=>api.post({...requestBody,mode:'orientation',existingOpenings:invalid}),{status:400});
  }
  const sections=generated.map(({id,orientation})=>({id,orientation}));
  await assert.rejects(()=>api.post({...requestBody,existingSections:sections}),{status:400});
  for (const invalid of [sections.toReversed(),sections.slice(0,1),[{...sections[0],orientation:{}},sections[1]]]) {
    await assert.rejects(()=>api.post({...requestBody,mode:'orientation',existingSections:invalid}),{status:400});
  }
  assert.equal(runs,0);
});
