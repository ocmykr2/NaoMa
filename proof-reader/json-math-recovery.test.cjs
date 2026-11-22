'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler}=require('./personalized-plan.cjs');

async function runPlan(t,body,worker) {
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-math-recovery-'));
  t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  const handle=createPlanHandler({cacheDir,readLocalJson:async req=>req.body,checkLocalRequest(){},waitForRecovery:async()=>{},worker});
  const endpoint='/api/reading-plan';
  async function request(method,route) {
    let result;await handle({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},route);return result;
  }
  let job=await request('POST',endpoint);
  for (let n=0;n<500 && job.status==='running';n++) {await delay(10);job=await request('GET',endpoint+'/'+job.key);}
  return job;
}

test('one stray NUL before a grounded chain comparison repairs locally without guessing its operands',async t=>{
  const source='The running length obeys \\(0\\le L(t)\\) and \\(L(t)\\le9\\) throughout the walk.';
  const right='The length stays in the range \\(0\\le L(t)\\le9\\).';
  const damaged=right.replace(')\\le9',')\0\\le9');
  const intro='Write \\(t\\) for the elapsed time. Write \\(L\\) for the length as a function of time.';
  const notation=[{symbol:'\\(t\\)',meaning:'The elapsed time.'},{symbol:'\\(L\\)',meaning:'The length as a function of time.'}];
  for (const [scenario,text,needsField] of [
    ['draft',damaged,false],
    ['editor',damaged,false],
    ['changed endpoint',damaged.replace('9','8'),true],
    ['different comparison',damaged.replace('\0\\le9','\0<9'),true],
    ['matching operand is only a suffix',damaged.replace('L(t)','5+L(t)'),true],
    ['control inside an identifier',right.replace('L(t)','L\0(t)'),true],
    ['nested comparison',damaged.replace('L(t)','(L(t)').replace('9\\)','9)\\)'),true],
    ['second control in the span',damaged.replace('0\\le','0\0\\le'),true],
  ]) {
    const body={title:'Measuring a walk',units:[{title:'Lengths',text:source}],analysis:{
      parts:[{id:'range',title:'Bound the running length',summary:'Combine the two bounds on length.',sourceSteps:[1]}],
      localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
    const calls=[];
    const result=await runPlan(t,body,async ({directory,outputPath})=>{
      const name=path.basename(outputPath);calls.push(name);
      let value;
      if (name==='plan.json') {
        value={parts:[{id:'range',question:'What bounds the length?',orientation:{introduction:intro,
          paragraphs:[scenario==='editor'?source:text],notation,definitions:[],handoff:'',statement:null}}]};
      } else if (name==='format-fields.json') {
        value={changes:[{field:'paragraphs.0',text:right}]};
      } else {
        assert.equal(name,'edited.json');
        const {parts:[draft]}=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
        if (scenario!=='editor') assert.deepEqual(draft.orientation.paragraphs,[right],scenario);
        value={parts:[{id:'range',introduction:draft.orientation.introduction,paragraphs:[scenario==='editor'?text:right],
          handoff:'',formalAfter:0,referenceNotation:null,proseNotationCards:[],notationEvidence:[intro],definitionCorrections:[],
          sourceCheck:'Compared the upper and lower limits in the assigned passage.',unresolved:''}]};
      }
      await fs.writeFile(outputPath,JSON.stringify(value));
    });
    assert.equal(result.status,'ready',scenario+': '+result.message);
    assert.deepEqual(result.parts[0].orientation.paragraphs,[right],scenario);
    assert.deepEqual(calls,['plan.json',...(needsField?['format-fields.json']:[]),'edited.json'],scenario);
  }
});

test('recover real JSON escapes from a unique complete source span in drafts, edits and saved fields',async t=>{
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
    const calls=[];
    const job=await runPlan(t,body,async({directory,outputPath})=>{
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
    });
    if(mode==='correction still ambiguous'){
      assert.equal(job.status,'error');assert.ok(!calls.includes('edited.json'));continue;
    }
    assert.equal(job.status,'ready',mode+': '+job.message);
    assert.deepEqual(calls,['plan.json',...(ambiguous?['format-fields.json']:[]),'edited.json']);
    assert.equal(job.parts[0].question,question);
    assert.deepEqual(job.parts[0].orientation.paragraphs,paragraphs);
  }
});

test('restore a mistyped final set fence only against an exact complete formula',async t=>{
  const set='\\(\\{2,4\\}\\)',display='\\[\\{2,4\\}\\]',count='\\(2\\)';
  const source='The even labels form '+set+'. The number of labels is '+count+'.';
  const paragraph='Read '+count+' labels from '+set+'.';
  const damage=s=>s.replace(/\\\}(\\[)\]])/u,'$1$1');
  for (const [scenario,passage,proposed,expected,needsPatch] of [
    ['draft',source,damage(paragraph),paragraph,false],
    ['editor',source,damage(paragraph),paragraph,false],
    ['display',source+' Display the labels as '+display+'.',damage(display),display,false],
    ['changed number',source,damage(paragraph.replace('2,4','2,5')),paragraph,true],
    ['no complete formula','There are two even labels.',damage(paragraph),paragraph,true],
    ['both complete and shorter',source+' A separate open fence is \\(\\{2,4\\).',damage(paragraph),paragraph,true],
    ['adjacent formulas',source,'Use \\(\\{2\\)\\(4\\)\\).',paragraph,true],
    ['extra set opener',source,damage(paragraph.replace('2,4','\\{2,4')),paragraph,true],
  ]) {
    const body={title:'Even labels',units:[{title:'Labels',text:passage}],analysis:{
      parts:[{id:'labels',title:'List the even labels',summary:'Read the labels from the set.',sourceSteps:[1]}],
      localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
    const calls=[];
    const job=await runPlan(t,body,async({directory,outputPath})=>{
      const name=path.basename(outputPath);calls.push(name);
      let output;
      if (name==='plan.json') {
        output={parts:[{id:'labels',question:'Which labels occur?',orientation:{
          introduction:'The labels come in pairs.',paragraphs:[scenario==='editor'?'List the two even labels.':proposed],
          notation:[],definitions:[],handoff:'',statement:null}}]};
      } else if (name==='format-fields.json') {
        const input=JSON.parse(await fs.readFile(path.join(directory,'format-fields-input.json'),'utf8'));
        assert.deepEqual(input.requestedChanges.map(change=>[change.field,change.text]),[['paragraphs.0',proposed]],scenario);
        output={changes:[{field:'paragraphs.0',text:expected}]};
      } else {
        assert.equal(name,'edited.json');
        const {parts:[draft]}=JSON.parse(await fs.readFile(path.join(directory,'editor-input.json'),'utf8'));
        if (scenario!=='editor') assert.deepEqual(draft.orientation.paragraphs,[expected],scenario);
        output={parts:[{id:'labels',introduction:draft.orientation.introduction,paragraphs:[scenario==='editor'?proposed:expected],
          handoff:'',formalAfter:0,referenceNotation:null,proseNotationCards:[],notationEvidence:[],definitionCorrections:[],
          sourceCheck:'Checked each label and the final count against the passage.',unresolved:''}]};
      }
      await fs.writeFile(outputPath,JSON.stringify(output));
    });
    assert.equal(job.status,'ready',scenario+': '+job.message);
    assert.deepEqual(job.parts[0].orientation.paragraphs,[expected],scenario);
    assert.deepEqual(calls,['plan.json',...(needsPatch?['format-fields.json']:[]),'edited.json'],scenario);
  }
});
