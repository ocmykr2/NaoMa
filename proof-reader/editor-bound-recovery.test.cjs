'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler}=require('./personalized-plan.cjs');

test('a persistent bound-changing edit requires a fresh source audit to publish the unchanged draft',async t=>{
  const endpoint='/api/reading-plan';
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
    {scenario:'declined',expectedAudits:1,declined:true},
    {scenario:'unchanged after decline',expectedAudits:1,declined:true},
    {scenario:'corrected after decline',expectedAudits:1,declined:true,expectedText:corrected},
    {scenario:'other page',expectedAudits:2},
    {scenario:'truncated quote',expectedAudits:2},
    {scenario:'new bound after unusable citation',expectedAudits:3,expectedText:quote},
    {scenario:'interrupted audit',expectedAudits:2,expectedText:quote},
  ];
  for(const {scenario,expectedAudits,declined,expectedText} of cases){
    const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-bound-audit-'));
    t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
    const body={title:'Pair four leaves',units:[{title:'Pairs',text:'A pair contains two leaves.'},
      {title:'Total',text:quote}],analysis:{parts,localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},
      readerKnowledge:{techniques:[],definitionGroups:[]}};
    let audits=0,peerReviews=0,drafts=0;
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
          result=[{id:'total',supported:!declined,sourceStep:scenario==='other page'?1:2,
            originalBound:'2+2=4',sourceQuote:truncated?quote.slice(0,-3):quote,
            sourceCheck:'The original source counts two disjoint pairs and includes all four leaves.',
            unresolved:'',formalAfter:0,notationEvidence:[]}];
        } else {
          const {parts:assigned}=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
          if(assigned.some(row=>row.id==='pair'))peerReviews++;
          const changedBound=audits && (scenario==='declined' || scenario==='new bound after unusable citation')?'2+2=6':'2+2=5';
          let edited=quote.replace('2+2=4',changedBound);
          if (audits && scenario==='unchanged after decline') edited=quote;
          if (audits && scenario==='corrected after decline') edited=corrected;
          result=assigned.map(({id,orientation:o})=>({id,introduction:o.introduction,
            paragraphs:id==='total'?[edited]:o.paragraphs,handoff:'',formalAfter:0,
            referenceNotation:null,proseNotationCards:[],notationEvidence:[],definitionCorrections:[],
            sourceCheck:'Compared the claimed total with the text about leaves.',unresolved:''}));
        }
      }
      await fs.writeFile(outputPath,JSON.stringify({parts:result}));
    };
    const api=createPlanHandler({cacheDir,worker,waitForRecovery:async()=>{},readLocalJson:async req=>req.body,checkLocalRequest(){}});
    async function request(method,url){
      let result;await api({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},url);return result;
    }
    let job=await request('POST',endpoint);
    for(let n=0;n<500 && job.status==='running';n++){await delay(10);job=await request('GET',endpoint+'/'+job.key);}
    assert.equal(audits,expectedAudits,scenario);
    assert.equal(drafts,1);assert.equal(peerReviews,1);
    if(expectedText){
      assert.equal(job.status,'ready',job.message);
      assert.deepEqual(job.parts[1].orientation.paragraphs,[expectedText]);
    }else{
      assert.equal(job.status,'error',scenario);
      assert.match(job.message,scenario==='unchanged after decline'?/unchanged draft/:/changed a mathematical bound/);
      assert.equal(job.parts,undefined);
    }
  }
});
