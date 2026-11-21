'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler}=require('./personalized-plan.cjs');

test('a downstream definition can use its declared origin after a fresh full-card check',async t=>{
  const title='Striped distance',definition='The striped distance counts striped edges on the unique path between two sites.';
  const application='The striped distance stays the same when the path is reversed.';
  const anchor='striped edges on the unique path';
  for (const scenario of ['declared','text source','undeclared','changed definition']) {
    const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'naoma-prior-definition-'));
    t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
    const body={title:'Distances on colored trees',pdfBase64:Buffer.from('%PDF-1.7\nexample\n%%EOF').toString('base64'),
      units:[{page:1,title:'Distance',text:definition},{page:2,title:'Reversal',text:application}],
      analysis:{knowledge:{techniques:[],definitionGroups:[]},localIntroductions:[{id:'distance',kind:'definition',title,
        meaning:definition,originPartId:'setup',sourceAnchors:[{step:1,phrase:anchor}]}],
        parts:['setup','reverse'].map((id,i)=>({id,title:i?'Reverse a path':'Define its length',summary:i?application:definition,
          sourceSteps:[i+1],techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:i && scenario!=='undeclared'?['distance']:[]}))},
      readerKnowledge:{techniques:[],definitionGroups:[]}};
    if (scenario==='text source') delete body.pdfBase64;
    const origin={name:title,text:definition,intuition:'',sourceStep:1,sourceQuote:definition,dependsOn:[]};
    const later={...origin,sourceStep:2,sourceQuote:application+' \\(1=1\\)',
      text:scenario==='changed definition'?definition.replace('counts striped','counts unstriped'):definition};
    const rows=[origin,later].map((card,i)=>({id:body.analysis.parts[i].id,question:'What is counted along the path?',
      orientation:{introduction:i?'Consider the path from the other endpoint.':'Assign a length to a path.',
        paragraphs:[i?application:definition],definitions:[card],notation:[],handoff:'',statement:null}}));
    let originChecks=0,fallback=0;
    async function worker({directory,outputPath,prompt,imagePaths}) {
      let output;
      switch (path.basename(outputPath)) {
        case 'plan.json': output={parts:rows};break;
        case 'definition-grounding.json':{
          const material=JSON.parse(prompt.split('\n\n').at(-1));
          const checks=material.map(c=>{
            if (scenario==='text source') assert.equal(imagePaths.length,0);
            else assert.ok(imagePaths.some(p=>path.basename(p)==='page-'+c.step+'.png'));
            if (c.locator===anchor) {assert.equal(c.step,1);originChecks++;}
            const verified=c.step===1 && c.candidate===definition;
            const evidence=c.step===1?definition:application;
            return {id:c.id,verified,anchor:evidence,sourceDefinition:evidence,comparison:verified?
              'The cited defining passage counts the striped edges of the unique path.':'This passage does not establish the proposed definition in full.'};
          });
          output={checks};break;
        }
        case 'definition-recovery.json':{
          const file=JSON.parse(await fs.readFile(path.join(directory,'definition-recovery-input.json'),'utf8'));
          if (scenario==='changed definition') {
            assert.equal(file.targets[0].declaredOrigin.originPartId,'setup');
            assert.ok(imagePaths.some(p=>path.basename(p)==='page-1.png'));
          } else assert.equal(file.targets[0].declaredOrigin,undefined);
          fallback++;output={parts:[{id:'reverse',definitions:[]}]};break;
        }
        case 'edited.json':{
          const input=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
          output={parts:input.parts.map(({id,orientation:o})=>({id,introduction:o.introduction,paragraphs:o.paragraphs,
            handoff:'',formalAfter:0,sourceCheck:'Compared the definition and its application to the assigned original source.',
            definitionCorrections:[],referenceNotation:null,proseNotationCards:[],notationEvidence:[],unresolved:''}))};break;
        }
        default:assert.fail('Unexpected worker output '+path.basename(outputPath));
      }
      await fs.writeFile(outputPath,JSON.stringify(output));
    }
    const endpoint='/api/reading-plan',api=createPlanHandler({cacheDir,worker,renderSourcePage:async()=>Buffer.from('page'),
      waitForRecovery:async()=>{},readLocalJson:async req=>req.body,checkLocalRequest(){}});
    async function request(method,url){let result;await api({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},url);return result;}
    let job=await request('POST',endpoint);
    for (let n=0;n<500 && job.status==='running';n++){await delay(10);job=await request('GET',endpoint+'/'+job.key);}
    if (scenario==='declared' || scenario==='text source') {
      assert.equal(job.status,'ready',job.message);
      assert.equal(originChecks,1);assert.equal(fallback,0);
      assert.deepEqual(job.parts[1].sourceSteps,[2]);assert.deepEqual(job.parts[1].orientation.paragraphs,[application]);
      assert.equal(job.parts[1].orientation.definitions[0].text,definition);
    } else {
      assert.equal(job.status,'error',scenario);assert.equal(job.parts,undefined);assert.ok(fallback>0);
      assert.equal(originChecks,scenario==='undeclared'?0:1);
    }
  }
});
