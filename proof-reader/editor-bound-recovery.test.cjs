'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler,readingPlanKey}=require('./personalized-plan.cjs');
const {planCheckpoints}=require('./plan-checkpoints.cjs');

async function runPlan(cacheDir,body,worker) {
  const endpoint='/api/reading-plan';
  const api=createPlanHandler({cacheDir,worker,waitForRecovery:async()=>{},readLocalJson:async req=>req.body,checkLocalRequest(){}});
  async function request(method,url) {
    let result;
    await api({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},url);
    return result;
  }
  let job=await request('POST',endpoint);
  for(let n=0;n<500 && job.status==='running';n++) {
    await delay(10);
    job=await request('GET',endpoint+'/'+job.key);
  }
  return {job,trace:await request('GET',endpoint+'/'+job.key+'/diagnostics')};
}

test('a persistent bound-changing edit requires a fresh source audit to publish the unchanged draft',async t=>{
  const quote='For the four leaves, adding the two pairs gives \\(2+2=4\\).';
  const introduction='Count the leaves by pairing them first.';
  const rows=['pair','total'].map(id=>({id,question:'How many leaves remain?',
    orientation:{introduction,paragraphs:[id==='total'?quote:'A pair contains two leaves.'],
      notation:[],definitions:[],handoff:'',statement:null}}));
  const parts=rows.map((row,i)=>({id:row.id,title:i?'Count the four leaves':'Pair the leaves',
    summary:introduction,sourceSteps:[i+1],techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[]}));
  const corrected=quote+' Each leaf occurs in only one pair.';
  const cases=[
    {scenario:'confirmed',expectedAudits:1,expectedText:quote},
    {scenario:'equivalent typesetting',expectedAudits:1,expectedText:quote},
    {scenario:'ambiguous source wording',expectedAudits:2},
    {scenario:'changed cited expression',expectedAudits:2},
    {scenario:'wrong alternate',expectedAudits:2},
    {scenario:'declined',expectedAudits:1,declined:true},
    {scenario:'unchanged after decline',expectedAudits:1,declined:true},
    {scenario:'only spelling after decline',expectedAudits:1,declined:true},
    {scenario:'corrected after decline',expectedAudits:1,declined:true,expectedText:corrected},
    {scenario:'other page',expectedAudits:2},
    {scenario:'truncated quote',expectedAudits:2},
    {scenario:'new bound after unusable citation',expectedAudits:3,expectedText:quote},
    {scenario:'interrupted audit',expectedAudits:2,expectedText:quote},
    {scenario:'no printed alternative',expectedAudits:0},
  ];
  for(const {scenario,expectedAudits,declined,expectedText} of cases){
    const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-bound-audit-'));
    t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
    const body={title:'Pair four leaves',units:[{title:'Pairs',text:'A pair contains two leaves.'},
      {title:'Total',text:quote}],analysis:{parts,localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},
      readerKnowledge:{techniques:[],definitionGroups:[]}};
    if(scenario==='no printed alternative') body.units[1].text='Two disjoint pairs contain all four leaves.';
    if(scenario==='ambiguous source wording') body.units[1].text+=' '+quote.replace('\\(2+2=4\\)','\\[2 + 2 = 4\\]');
    let audits=0,edits=0,peerReviews=0,drafts=0;
    const worker=async({directory,schemaPath,outputPath})=>{
      let result;
      if(path.basename(outputPath)==='plan.json'){drafts++;result=rows;}
      else {
        assert.equal(path.basename(outputPath),'edited.json');
        const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
        if(schema.properties.parts.items.required.includes('supported')){
          audits++;
          if (scenario==='interrupted audit' && audits===1) {
            throw Object.assign(new Error('Connection lost.'),{workerCode:'network'});
          }
          const truncated=scenario==='truncated quote' || (scenario==='new bound after unusable citation' && audits<=2);
          let sourceQuote=truncated?quote.slice(0,-3):quote;
          let originalBound='2+2=4';
          if (scenario==='equivalent typesetting') {
            sourceQuote=quote.replace('two pairs','two  pairs').replace('\\(2+2=4\\)','\\[2 + 2 = 4\\]');
            originalBound='\\(2\\, + 2 = 4\\)';
          }
          if (scenario==='changed cited expression') sourceQuote=quote.replace('2+2=4','2+2>4');
          if (scenario==='wrong alternate') originalBound='2+2>4';
          result=[{id:'total',supported:!declined,sourceStep:scenario==='other page'?1:2,
            originalBound,sourceQuote,
            sourceCheck:'The original source counts two disjoint pairs and includes all four leaves.',
            unresolved:'',formalAfter:0,notationEvidence:[]}];
        } else {
          edits++;
          const {parts:assigned}=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
          if(assigned.some(row=>row.id==='pair'))peerReviews++;
          const changedBound=audits && (scenario==='declined' || scenario==='new bound after unusable citation')?'2+2=6':'2+2=5';
          let edited=quote.replace('2+2=4',changedBound);
          if (audits && scenario==='unchanged after decline') edited=quote;
          if (audits && scenario==='only spelling after decline') edited=quote.replace('\\(2+2=4\\)','\\[2 + 2 = 4\\]');
          if (audits && scenario==='corrected after decline') edited=corrected;
          result=assigned.map(({id,orientation:o})=>({id,introduction:o.introduction,
            paragraphs:id==='total'?[edited]:o.paragraphs,handoff:'',formalAfter:0,
            referenceNotation:null,proseNotationCards:[],notationEvidence:[],definitionCorrections:[],
            sourceCheck:'Compared the claimed total with the text about leaves.',unresolved:''}));
        }
      }
      await fs.writeFile(outputPath,JSON.stringify({parts:result}));
    };
    const {job,trace}=await runPlan(cacheDir,body,worker);
    assert.equal(audits,expectedAudits,scenario);
    assert.equal(edits,['confirmed','equivalent typesetting','interrupted audit','no printed alternative'].includes(scenario)?2:3,scenario);
    assert.equal(trace.events.filter(e=>e.event==='retry' && e.action==='review-section').length,edits-1);
    assert.ok(!trace.events.some(e=>e.event==='retry' && e.action==='verify-bound'));
    assert.equal(drafts,1);assert.equal(peerReviews,1);
    if(expectedText){
      assert.equal(job.status,'ready',job.message);
      assert.deepEqual(job.parts[1].orientation.paragraphs,[expectedText]);
    }else{
      assert.equal(job.status,'error',scenario);
      assert.match(job.message,['unchanged after decline','only spelling after decline'].includes(scenario)?/unchanged draft/:/changed a mathematical bound/);
      assert.equal(job.parts,undefined);
    }
    if(scenario==='no printed alternative'){
      const before=edits;
      const cold=await runPlan(cacheDir,body,worker);
      assert.equal(cold.job.status,'error');
      assert.equal(edits-before,1,'an explicit retry rechecks locally and sends only one targeted correction');
      assert.equal(drafts,1);assert.equal(peerReviews,1);
    }
  }
});

test('spelling changes of a rejected bound do not reopen a completed source audit',async t=>{
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-source-receipt-'));
  t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  const body={title:'Scale an exponential',units:[{title:'Lower bound',text:'The lower bound exp(2) > 4 follows from the exponential series.'}],
    analysis:{parts:[{id:'lower',title:'Bound the scale',summary:'Use the first three terms.',sourceSteps:[1]}],
      localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
  let drafts=0,edits=0,audits=0;
  const worker=async({schemaPath,outputPath})=>{
    const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
    let row={id:'lower',question:'Why does the sum exceed four?',orientation:{
      introduction:'The first three terms already exceed four.',paragraphs:['The exponential satisfies \\(\\exp 2>4\\).'],
      definitions:[],notation:[],statement:null,handoff:''}};
    if(path.basename(outputPath)==='plan.json') drafts++;
    else if(schema.properties.parts.items.required.includes('originalBound')){
      audits++;
      row={id:'lower',supported:true,sourceStep:1,sourceQuote:'Missing from the assigned page.',originalBound:'\\exp2>4',
        notationEvidence:[],formalAfter:0,unresolved:'',sourceCheck:'Tried to locate the complete strict bound.'};
    } else {
      // The first corrective model response still has the wrong equality.
      // After its source audit it changes only the spelling of exp(2).
      edits++;
      const changed=audits?'\\operatorname{exp}(2)=4':'\\exp 2=4';
      row={id:'lower',introduction:row.orientation.introduction,paragraphs:['The exponential satisfies \\('+changed+'\\).'],
        handoff:'',formalAfter:0,notationEvidence:[],referenceNotation:null,definitionCorrections:[],proseNotationCards:[],
        unresolved:'',sourceCheck:'Compared the exponential at two with four.'};
    }
    await fs.writeFile(outputPath,JSON.stringify({parts:[row]}));
  };
  const {job,trace}=await runPlan(cacheDir,body,worker);
  assert.equal(job.status,'error',job.message);
  assert.deepEqual({drafts,edits,audits},{drafts:1,edits:3,audits:2});
  assert.deepEqual(trace.events.filter(e=>e.event==='retry').map(e=>e.action),['review-section','repair-bound-citation','review-section']);
  const cold=await runPlan(cacheDir,body,worker);
  assert.equal(cold.job.status,'error',cold.job.message);
  assert.deepEqual({drafts,edits,audits},{drafts:1,edits:4,audits:2});
});

test('a cosmetic rewrite of an unsupported numbered claim does not consume another correction',async t=>{
  const text='Pair the tiles to obtain \\(2+2=4\\).';
  const body={title:'Pair the tiles',units:[{title:'Pairs',text}],analysis:{
    parts:[{id:'tiles',title:'Count the tiles',summary:text,sourceSteps:[1]}],
    localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
  for(const newContent of [false,true]){
    const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-numbered-claim-'));
    t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
    let edits=0;
    const {job,trace}=await runPlan(cacheDir,body,async({outputPath})=>{
      const orientation={introduction:'Count four tiles in two pairs.',paragraphs:[text],
        definitions:[],notation:[],statement:null,handoff:''};
      let row={id:'tiles',question:'How many tiles are there?',orientation};
      if(path.basename(outputPath)==='edited.json'){
        edits++;
        let changed='Theorem 91 gives the tile’s count as \\(2+2=4\\).';
        if(edits>1) changed="Theorem 91 gives the tile's   count as \\[2 + 2 = 4\\].";
        if(newContent && edits===2) changed+=' Both pairs have the same size.';
        if(newContent && edits===3) changed=text;
        row={id:'tiles',introduction:orientation.introduction,paragraphs:[changed],handoff:'',formalAfter:0,
          referenceNotation:null,proseNotationCards:[],notationEvidence:[],definitionCorrections:[],
          unresolved:'',sourceCheck:edits===1?'Checked the original count of tiles.':'Compared the two pairs with the source.'};
        if(edits>1) row=Object.fromEntries(Object.entries(row).reverse());
      }
      await fs.writeFile(outputPath,JSON.stringify({parts:[row]}));
    });
    assert.equal(edits,newContent?3:2);
    assert.equal(trace.events.filter(e=>e.event==='retry' && e.action==='review-section').length,edits-1);
    assert.equal(job.status,newContent?'ready':'error',job.message);
    if(newContent) assert.deepEqual(job.parts[0].orientation.paragraphs,[text]);
    else assert.match(job.message,/unsupported numbered result/u);
  }
});

test('a cold batch keeps the pending finding and gives an unseen sibling its own first correction',async t=>{
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-mixed-edits-'));
  t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  const text='List the three distinct colors and count each one once.';
  const parts=['list','count'].map(id=>({id,title:'Count colors '+id,summary:text,sourceSteps:[1]}));
  const body={title:'Count distinct colors',units:[{title:'Colors',text}],analysis:{parts,
    localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
  const grounded=parts.map(({id,title,sourceSteps})=>({id,title,sourceSteps,opening:text,question:'How many colors are there?',
    orientation:{introduction:text,paragraphs:[text],definitions:[],notation:[],statement:null,handoff:''}}));
  const editor=id=>({id,introduction:text,paragraphs:[text],handoff:'',formalAfter:0,referenceNotation:null,
    notationEvidence:[],definitionCorrections:[],proseNotationCards:[],unresolved:'',sourceCheck:'Checked the complete list of three distinct colors.'});
  const wrong='Theorem 45 asserts there are only two colors.';
  const key=await readingPlanKey(body);
  await planCheckpoints(cacheDir,key,100000).save(new Map([[0,{grounded,reviewed:[],
    editNotes:[{id:'list',proposal:{...editor('list'),paragraphs:[wrong]},reason:'Editorial review introduced an unsupported numbered result (theorem 45).'}]}]]));
  const revisions=[];
  const {job}=await runPlan(cacheDir,body,async({directory,outputPath})=>{
    assert.equal(path.basename(outputPath),'edited.json');
    const {parts:input}=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
    const notes=JSON.parse(await fs.readFile(path.join(directory,'editor-revisions.json'),'utf8'));
    revisions.push([input.map(p=>p.id),notes.map(n=>n.id)]);
    const output=input.map(({id})=>{
      const row=editor(id);
      if(id==='count' && revisions.length===1) row.paragraphs=[wrong];
      return row;
    });
    await fs.writeFile(outputPath,JSON.stringify({parts:output}));
  });
  assert.equal(job.status,'ready',job.message);
  assert.deepEqual(revisions,[[['list','count'],['list']],[['count'],['count']]]);
});
