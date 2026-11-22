const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {normalizeNotationReference,normalizeNotationEdition,buildNotationEdition,notationForPrompt,notationIssue,notationIssues,mentionsSymbol}=require('./notation-adaptation.cjs');

test('notation checks read mathematical identities and ignore typography and protected names',()=>{
  const scope=['setup'];
  const set={original:'I',preferred:'\\mathcal{J}',partIds:scope};
  const optimum={original:'\\mathrm{OPT}(I)',preferred:'\\pi(\\mathcal{J})',partIds:scope};
  const time={original:'T',preferred:'\\pi',partIds:scope};
  const release={original:'r_j',preferred:'a_j',partIds:scope};
  const edition={mappings:[set,optimum,time,release]};
  const issues=text=>notationIssues(edition,'setup',text);
  // Use the printed symbols in a bridge to their chosen equivalents.
  assert.deepEqual(issues('The paper writes \\(\\operatorname{OPT}(I)=T\\). Here it is \\(\\pi\\!\\left(\\mathcal J\\right)\\).'),[]);
  assert.deepEqual(issues('The job class is \\(\\mathcal I\\). A label reads \\(\\text{T}\\). Track \\(T_j+\\hat T+T^\\star\\).'),[]);
  assert.deepEqual(issues('Use \\(\\frac{\\operatorname{OPT}\\left(I\\right)}{T}\\) and \\(r_{j}^{2}\\).'),[set,optimum,time,release]);
  assert.deepEqual(issues('Compute \\(\\frac{T^2}{\\mathbf{I}}\\).'),[time]);
  assert.deepEqual(notationIssues(edition,'other','Take \\(T\\).'),[]);
  const uses='Compare \\(r_{j}^{2}\\) with \\(\\operatorname{OPT}(I)\\).';
  assert.ok(mentionsSymbol(uses,'r_j'));
  assert.ok(mentionsSymbol(uses,'\\mathrm{OPT}'));
  for(const other of ['r','r_i','\\mathrm{PT}','\\mathbf I'])assert.equal(mentionsSymbol(uses,other),false,other);
});

const targetQuote='H is the common deadline.';
const priorityQuote='X is a priority class.';
const refQuote='D denotes the common deadline.';
const units=[{step:1,text:targetQuote+' '+priorityQuote,page:4},{step:2,text:'A later section studies an independent model.',page:5}];
const reference={title:'A reference model',units:[{text:refQuote+' X denotes release time.',page:2}]};
const part={id:'window',title:'The time window',summary:'Identify when the job can start.',sourceSteps:[1]};
const input={context:{title:'A target model'},units,analysis:{parts:[part]}};
const map={concept:'The common deadline in time units.',original:'H',preferred:'D',partIds:['window'],sourceStep:1,sourceQuote:targetQuote,referenceStep:1,referenceQuote:refQuote};
const retained={concept:'Priority class',symbol:'X',partIds:['window'],sourceStep:1,sourceQuote:priorityQuote};
const mapping={mappings:[map],retained:[retained]};
const overview={paragraphs:['The common deadline limits the time available for each job.'],suggestions:[{question:'What happens at the deadline?',step:1}]};
const reading={id:'window',title:'The time window',sourceStep:1,sourceQuote:targetQuote,reading:'Every job in this group shares a deadline, written \\(D\\).'};
const reformulation={parts:[reading],overview,mappingIssue:''};
function worker(dispatch){
  const calls=[];
  return {calls,run:async job=>{
    const phase=path.basename(job.schemaPath);
    calls.push(phase);
    const response=await dispatch(phase,calls.length,job);
    await fs.writeFile(job.outputPath,JSON.stringify(response));
  }};
}

test('source-grounded edition preserves citations and restores scoped notation in later prompts',async()=>{
  const probe=worker(async (phase,count,job)=>{
    assert.equal(job.webSearch,false);
    const target=JSON.parse(await fs.readFile(path.join(job.directory,'target.json')));
    assert.equal(target.units[0].text,units[0].text);
    return phase.startsWith('notation-map')?mapping:reformulation;
  });
  const edition=await buildNotationEdition(input,reference,{worker:probe.run});
  assert.deepEqual(probe.calls,['notation-map-schema.json','notation-rewrite-0-schema.json']);
  assert.deepEqual(edition.parts,[reading]);
  assert.deepEqual(edition.overview,overview);
  assert.equal(edition.mappings[0].referenceQuote,refQuote);
  assert.deepEqual(normalizeNotationEdition(edition,{units,analysis:input.analysis,reference}),edition);
  assert.ok(!notationForPrompt(edition,'different').includes('common deadline in time units'));
  assert.ok(notationForPrompt(edition,'window').includes(reading.title));
  assert.throws(()=>normalizeNotationEdition({...edition,mappings:[{...map,referenceQuote:'Unrelated fabricated phrase.'}]},{units,reference}),/literal phrase/);
  assert.throws(()=>normalizeNotationEdition({...edition,mappings:[{...map,sourceStep:3}]},{units}),/passage number/);
  assert.throws(()=>normalizeNotationEdition({...edition,parts:[{...reading,sourceStep:2,sourceQuote:units[1].text}]},{units,analysis:input.analysis}),/assigned/);
  assert.equal(normalizeNotationReference(undefined),undefined);
  assert.throws(()=>normalizeNotationReference({title:'Just a title',units:[]}),/passages/);
  assert.deepEqual(normalizeNotationReference({...reference,id:'library-entry'}).units,[{step:1,text:reference.units[0].text,page:2}]);
});

test('notation spelling changes reserve the same object and recover the source wording without a worker retry',async()=>{
  const originalQuote='Record the deadline \\(d_{i}\\) of each task.';
  const proposedQuote=originalQuote.replace('d_{i}','d_i');
  const paper={...input,units:[{...units[0],text:originalQuote}]};
  const keep={...map,concept:'An individual deadline',original:'d_i',preferred:'d_{i}',sourceQuote:proposedQuote,referenceQuote:originalQuote};
  const document={...reference,units:[{text:originalQuote}]};
  const probe=worker(async phase=>phase.startsWith('notation-map')?{mappings:[keep,{...keep,original:'d_{i}'}],retained:[]}:
    {...reformulation,parts:[{...reading,sourceQuote:proposedQuote}]});
  const edition=await buildNotationEdition(paper,document,{worker:probe.run});
  assert.deepEqual(probe.calls,['notation-map-schema.json','notation-rewrite-0-schema.json']);
  assert.deepEqual(edition.mappings,[]);
  assert.equal(edition.parts[0].sourceQuote,originalQuote);
  const options={units:paper.units,analysis:paper.analysis,reference:document};
  const colliding={...keep,original:'u',preferred:'d_{i}'};
  assert.throws(()=>normalizeNotationEdition({...edition,mappings:[keep,{...keep,concept:'Arrival time'}]},options),e=>e.finding?.code==='notation-map-conflict');
  for(const mappings of [[keep,colliding],[colliding,keep]]){
    assert.throws(()=>normalizeNotationEdition({...edition,mappings},options),e=>e.finding?.code==='notation-map-conflict');
  }
  const distinct={...keep,preferred:'\\mathbf{d}_{i}'};
  assert.equal(normalizeNotationEdition({...edition,mappings:[distinct]},options).mappings.length,1);
  const wrong={...reading,sourceQuote:proposedQuote.replace('d_i','d_j')};
  assert.throws(()=>normalizeNotationEdition({...edition,parts:[wrong]},options),/literal phrase/);
  const check=(text,sourceQuote)=>normalizeNotationEdition({...edition,parts:[{...reading,sourceQuote}]},
    {...options,units:[{text}]});
  assert.throws(()=>check('The leaf has weight 10.','has weight 1'),/literal phrase/);
  assert.throws(()=>check(originalQuote+' '+proposedQuote,originalQuote),/literal phrase/);
  assert.equal(check(originalQuote+' '+originalQuote,originalQuote).parts[0].sourceQuote,originalQuote);
});

test('interrupted notation adaptation resumes completed parts and splits a repeatedly timing-out batch',async()=>{
  const parts=Array.from({length:8},(_,i)=>({...part,id:'p'+i}));
  const paper={...input,analysis:{parts}};
  let saved,offline=true;
  const snapshots=[],attempts=[];
  const probe=worker(async(phase,_n,job)=>{
    if(phase.startsWith('notation-map'))return {mappings:[],retained:[]};
    const rows=JSON.parse(job.prompt.match(/Assigned parts \(data\): ([^\n]+)/)[1]);
    attempts.push(rows.map(p=>p.id));
    if(rows[0].id==='p6' && rows.length===2)throw Error('Codex timed out.');
    if(rows[0].id==='p7' && offline)throw Error('Connection lost.');
    return {parts:rows.map(p=>({...reading,id:p.id})),overview:rows[0].id==='p0'?overview:null,mappingIssue:''};
  });
  const options=()=>({worker:probe.run,resume:saved,onCheckpoint:value=>{saved=structuredClone(value);},
    onProgress:(_phase,batch,done)=>snapshots.push([batch[0].id,done])});
  await assert.rejects(buildNotationEdition(paper,reference,options()),/Connection lost/);
  offline=false;
  const result=await buildNotationEdition(paper,reference,options());
  assert.deepEqual(result.parts.map(p=>p.id),parts.map(p=>p.id));
  assert.equal(probe.calls.filter(x=>x.startsWith('notation-map')).length,1);
  assert.deepEqual(attempts,[parts.slice(0,6).map(p=>p.id),['p6','p7'],['p6'],['p7'],['p7']]);
  assert.ok(snapshots.some(([id,done])=>id==='p7' && done===7));
});

test('an internal error mentioning a timeout does not initiate smaller notation batches',async()=>{
  const parts=[{...part,id:'first'},{...part,id:'second'}];
  const probe=worker(async phase=>{
    if(phase.startsWith('notation-map'))return {mappings:[],retained:[]};
    throw new TypeError('Unexpected undefined timeout setting');
  });
  await assert.rejects(buildNotationEdition({...input,analysis:{parts}},reference,{worker:probe.run}),TypeError);
  assert.deepEqual(probe.calls,['notation-map-schema.json','notation-rewrite-0-schema.json']);
});

test('reserved symbols, ungrounded passages and many-to-one changes are revised before use',async()=>{
  for(const bad of [
    {...mapping,mappings:[{...map,preferred:'X'}]},
    {...mapping,mappings:[{...map,referenceQuote:'Invented definition from another page.'}]},
    {...mapping,mappings:[map,{...map,concept:'Another quantity',original:'A'}]},
  ]){
    const probe=worker(async (phase,n)=>phase.startsWith('notation-locator')?{step:1,quote:refQuote,withdraw:false}:
      phase.startsWith('notation-map')?(n===1?bad:mapping):reformulation);
    const edition=await buildNotationEdition(input,reference,{worker:probe.run});
    assert.equal(probe.calls.length,3);
    assert.deepEqual(edition.mappings,[map]);
  }
});

test('a broken source locator is repaired in its own row without regenerating independently grounded changes',async()=>{
  const paper={...input,analysis:{parts:[part,{...part,id:'later',sourceSteps:[2]}]}};
  const secondRef={...reference,units:[...reference.units,{text:'B is the count in the second model.'}]};
  const later={...map,concept:'Count in the second model.',original:'A',preferred:'B',partIds:['later'],
    sourceStep:2,sourceQuote:'paraphrased instead of copied',referenceStep:2,referenceQuote:secondRef.units[1].text};
  const findings=[];
  const probe=worker(async(phase,_n,job)=>{
    if(phase.startsWith('notation-map'))return {...mapping,mappings:[map,later]};
    if(phase.startsWith('notation-locator')){
      assert.match(job.prompt,/mappings\.1\.sourceQuote/u);
      assert.ok(job.prompt.includes(later.sourceQuote));
      return {step:2,quote:units[1].text,withdraw:false};
    }
    return {...reformulation,parts:[reading,{...reading,id:'later',sourceStep:2,sourceQuote:units[1].text,reading:'Count the elements in the second model.'}]};
  });
  const edition=await buildNotationEdition(paper,secondRef,{worker:probe.run,onFinding:f=>findings.push(f)});
  assert.deepEqual(edition.mappings,[map,{...later,sourceQuote:units[1].text}]);
  assert.deepEqual(probe.calls,['notation-map-schema.json','notation-locator-schema.json','notation-rewrite-0-schema.json']);
  assert.deepEqual(findings,[{field:'mappings.1.sourceQuote',code:'notation-source-locator',action:'revise-notation'}]);
});

test('a withdrawn reference locator requires a new whole-map decision and accepts a reviewed zero-change edition',async()=>{
  const findings=[];
  const unsupported={mappings:[{...map,referenceQuote:'An unsupported correspondence.'}],retained:[retained]};
  const probe=worker(async(phase,n)=>{
    if(phase.startsWith('notation-map'))return n===1?unsupported:{mappings:[],retained:[]};
    if(phase.startsWith('notation-locator'))return {step:0,quote:'',withdraw:true};
    return {...reformulation,parts:[{...reading,reading:'The common deadline bounds every job in the group.'}]};
  });
  const result=await buildNotationEdition(input,reference,{worker:probe.run,onFinding:f=>findings.push(f)});
  assert.deepEqual(probe.calls,['notation-map-schema.json','notation-locator-schema.json','notation-map-schema.json','notation-rewrite-0-schema.json']);
  assert.deepEqual(result.mappings,[]);assert.equal(result.referenceTitle,reference.title);
  assert.ok(findings.every(f=>f.code==='notation-reference-locator' && f.field==='mappings.0.referenceQuote'));

  const broken=worker(async phase=>phase.startsWith('notation-locator')?{quote:'Not in either paper.',step:1,withdraw:false}:unsupported);
  await assert.rejects(buildNotationEdition(input,reference,{worker:broken.run}),e=>
    e.finding.field==='mappings.0.referenceQuote' && e.readerMessage.includes('notation reference') && !e.readerMessage.includes(map.concept));
  assert.equal(broken.calls.length,4);
});

test('PDF punctuation spacing recovers exact unique source text and cannot change a sign, word, subscript or punctuation',async()=>{
  const passage='Trace the curve to τ ; then rotate. Before T , the red arc bends. After distance T − ti , the arc ends.';
  const request={...input,units:[{...units[0],text:passage}]};
  const quote='to τ; then rotate. Before T, the red arc bends. After distance T − ti, the arc ends.';
  const accepted='to τ ; then rotate. Before T , the red arc bends. After distance T − ti , the arc ends.';
  const writer=worker(async phase=>phase.startsWith('notation-map')?{mappings:[],retained:[]}:
    {...reformulation,parts:[{...reading,sourceQuote:quote}]});
  const edition=await buildNotationEdition(request,reference,{worker:writer.run});
  assert.equal(edition.parts[0].sourceQuote,accepted);
  assert.ok(passage.includes(edition.parts[0].sourceQuote));
  assert.deepEqual(writer.calls,['notation-map-schema.json','notation-rewrite-0-schema.json']);
  for(const bad of [quote.replace('−','+'),quote.replace('ti','tj'),quote.replace(';',','),quote.replace('red','blue')]){
    assert.throws(()=>normalizeNotationEdition({...edition,parts:[{...edition.parts[0],sourceQuote:bad}]},{units:request.units,reference}),/literal phrase/);
  }
  assert.throws(()=>normalizeNotationEdition({...edition,parts:[{...edition.parts[0],sourceQuote:quote}]},
    {units:[{...units[0],text:passage+' '+passage}],reference}),/literal phrase/);
});

test('an independently discovered semantic mismatch reformulates the whole paper; recurring mismatch prevents publication',async()=>{
  const fault={...reformulation,mappingIssue:'The reference deadline measures an elapsed duration, whereas this deadline is an absolute time.'};
  const probe=worker(async (phase,n)=>phase.startsWith('notation-map')?(n===1?mapping:{mappings:[],retained:[]}):n===2?fault:{...reformulation,parts:[{...reading,reading:'Every job has the same absolute deadline, \\(H\\).'}]});
  const edition=await buildNotationEdition(input,reference,{worker:probe.run});
  assert.deepEqual(edition.mappings,[]);
  assert.equal(probe.calls.length,4);
  const faulty=worker(async phase=>phase.startsWith('notation-map')?mapping:fault);
  await assert.rejects(buildNotationEdition(input,reference,{worker:faulty.run}),/mismatch/);
});

test('the same glyph may be scoped to distinct concepts in disjoint parts',async()=>{
  const two={...input,analysis:{parts:[part,{...part,id:'later',sourceSteps:[2]}]}};
  const later={...map,concept:'Deadline in the second model.',partIds:['later'],original:'C',sourceStep:2,sourceQuote:units[1].text};
  const probe=worker(async phase=>phase.startsWith('notation-map')?{mappings:[map,later],retained:[]}:{...reformulation,parts:[reading,{...reading,id:'later',sourceStep:2,sourceQuote:units[1].text}]});
  const edition=await buildNotationEdition(two,reference,{worker:probe.run});
  assert.ok(!notationForPrompt(edition,'window').includes(later.concept));
  assert.equal(notationIssue(edition,'window','The deadline is \\(H\\).')?.preferred,'D');
  assert.equal(notationIssue(edition,'window','The deadline is \\(D\\), originally \\(H\\).'),null);
  assert.equal(notationIssue(edition,'later','The quantity \\(H\\) is fixed.'),null);
});

test('both original PDFs supply separately identified page images while the edition keeps only textual locators',async()=>{
  const bytes=Buffer.from('%PDF-reference-only');
  const pdf=Buffer.from('%PDF-target-only');
  const referenceDoc={...reference,pdfBase64:bytes.toString('base64')};
  const seen=[];
  const probe=worker(async (phase,n,job)=>{
    const material=await fs.readFile(path.join(job.directory,'reference.json'),'utf8');
    assert.ok(!material.includes(referenceDoc.pdfBase64));
    assert.ok(!job.prompt.includes(referenceDoc.pdfBase64));
    assert.deepEqual(job.imagePaths.map(x=>path.basename(x)),n===1?['target-4.png','target-5.png','reference-2.png']:['target-4.png','reference-2.png']);
    assert.match(job.prompt,/"paper":"reference","page":2/u);
    return phase.startsWith('notation-map')?mapping:reformulation;
  });
  const edition=await buildNotationEdition({...input,pdf},referenceDoc,{worker:probe.run,renderSourcePage:async(doc,page)=>{seen.push([doc.toString(),page]);return Buffer.from('test page');}});
  assert.deepEqual(seen,[['%PDF-target-only','4'],['%PDF-target-only','5'],['%PDF-reference-only','2']]);
  assert.ok(!JSON.stringify(edition).includes(referenceDoc.pdfBase64));
  assert.throws(()=>normalizeNotationReference({...reference,pdfBase64:'YmFk'}),/PDF/);
});

test('rewrite revises tool commentary before returning the overview',async()=>{
  const probe=worker(async (phase,n)=>phase.startsWith('notation-map')?mapping:n===2?{...reformulation,overview:{...overview,paragraphs:['Workspace access was blocked.']}}:reformulation);
  const edition=await buildNotationEdition(input,reference,{worker:probe.run});
  assert.deepEqual(probe.calls,['notation-map-schema.json','notation-rewrite-0-schema.json','notation-rewrite-0-schema.json']);
  assert.deepEqual(edition.overview,overview);
});
