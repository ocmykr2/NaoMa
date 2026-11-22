'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler}=require('./personalized-plan.cjs');

test('recover real JSON escapes from a unique complete source span in drafts, edits and saved fields',async t=>{
  const endpoint='/api/reading-plan';
  const choose='\\(\\binom{4}{2}\\ne\\frac{3}{4}\\)';
  const halves='\\(\\tfrac{1}{2}+\\left(\\tfrac{1}{2}\\right)=1\\)';
  const angle='\\(\\theta\\)';
  const indent='\\(2+\n3=5\\)';
  const paragraphs=['Count the pairs to obtain '+choose+'.','Add the two halves using '+halves+'.','The second tally is '+indent+'.'];
  const question='Which term sets the angle '+angle+'?';
  // A worker that forgets to escape a backslash still emits valid JSON for
  // these five letters. The JSON parser consumes both the slash and letter.
  const corrupt=text=>text.replace(/\\[bfnrt](?=[a-z])/gu,escape=>JSON.parse('"'+escape+'"'));
  for (const mode of ['draft','editor','two witnesses','correction still ambiguous']) {
    const ambiguous=mode.includes('witnesses') || mode.includes('ambiguous');
    const source=[...paragraphs,question,...(ambiguous?['The literal typesetting is '+corrupt(angle)+'.']:[])].join(' ');
    const body={title:'Count the twigs',units:[{title:'Tally',text:source}],
      analysis:{parts:[{id:'tally',title:'Count two halves',summary:'Count the paired twigs.',sourceSteps:[1]}],
        localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
    const orientation={introduction:'Count two groups and compare the totals.',paragraphs,notation:[],definitions:[],handoff:'',statement:null};
    const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-json-math-'));
    t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
    const calls=[];
    const handle=createPlanHandler({cacheDir,readLocalJson:async req=>req.body,checkLocalRequest(){},waitForRecovery:async()=>{},
      worker:async({directory,outputPath})=>{
        const name=path.basename(outputPath);calls.push(name);
        let value;
        if(name==='plan.json') {
          value={parts:[{id:'tally',question:mode==='editor'?question:corrupt(question),orientation:{
            ...orientation,paragraphs:mode==='draft'?paragraphs.map(corrupt):paragraphs}}]};
        }else if(name==='format-fields.json'){
          const input=JSON.parse(await fs.readFile(path.join(directory,'format-fields-input.json'),'utf8'));
          assert.deepEqual(input.requestedChanges.map(row=>row.field),['question']);
          value={changes:[{field:'question',text:mode==='two witnesses'?question:corrupt(question)}]};
        }else{
          assert.equal(name,'edited.json');
          const {parts:[draft]}=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
          assert.equal(draft.question,question);
          assert.deepEqual(draft.orientation.paragraphs,paragraphs);
          value={parts:[{id:'tally',introduction:orientation.introduction,paragraphs:mode==='editor'?paragraphs.map(corrupt):paragraphs,
            handoff:'',formalAfter:0,referenceNotation:null,proseNotationCards:[],notationEvidence:[],definitionCorrections:[],
            sourceCheck:'Checked both counts and the two halves against the original tally.',unresolved:''}]};
        }
        await fs.writeFile(outputPath,JSON.stringify(value));
      }});
    async function request(method,route){
      let result;await handle({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},route);return result;
    }
    let job=await request('POST',endpoint);
    for(let n=0;n<500 && job.status==='running';n++){await delay(10);job=await request('GET',endpoint+'/'+job.key);}
    if(mode==='correction still ambiguous'){
      assert.equal(job.status,'error');assert.ok(!calls.includes('edited.json'));continue;
    }
    assert.equal(job.status,'ready',mode+': '+job.message);
    assert.deepEqual(calls,['plan.json',...(ambiguous?['format-fields.json']:[]),'edited.json']);
    assert.equal(job.parts[0].question,question);
    assert.deepEqual(job.parts[0].orientation.paragraphs,paragraphs);
  }
});
