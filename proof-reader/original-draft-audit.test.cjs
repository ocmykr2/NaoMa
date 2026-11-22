'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler}=require('./personalized-plan.cjs');
const {auditOriginalPages,retainsDeniedClaim}=require('./original-draft-audit.cjs');

const intro='Let \\(n\\) count the pigments available for each tile.';
const count='Two independently painted tiles give \\(n^2\\) ordered colorings.';
const orientation={introduction:intro,paragraphs:[count],definitions:[],statement:null,handoff:'',
  notation:[{symbol:'\\(n\\)',meaning:'Number of available pigments.'}]};
const part={id:'tiles',orientation};
const units=[{step:1,page:8,title:'Paint chart',text:'Figure 3: Two painted tiles.\nThe chart has one row for each pigment.'},
  {step:2,page:9,title:'Count the choices',text:'Each tile independently receives one pigment.\nThe chart in Figure 3 lists all ordered colorings.'}];
const justification='The row and column specify the independent colors of the two distinguishable tiles.';

function review(input) {
  const notationEvidence=[Object.keys(input.firstUseClauses)[0]];
  return {id:'tiles',status:'verified',explanation:justification,notationEvidence,
    checks:Object.entries(input.blocks).map(([block,text])=>({block,draftQuote:text,comparison:justification,
      witnesses:[{step:1,page:8,anchor:'s1L2',transcription:'[s1L2]'}]}))};
}
async function temp(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'naoma-original-audit-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  return dir;
}
function inline(prompt) {
  return JSON.parse(prompt.split('Immutable draft and cited sources: ')[1].split('\nCorrect this review issue:')[0]
    .split('\nReturn one complete review')[0]);
}
test('a whole-draft decision requires complete coverage and genuine locators even for typeset figures',async t=>{
  for (const mode of ['verified','cited conflict','cited paraphrase','duplicated locator','inconclusive','uncited conflict','wrong page','wrong block','missing block','bad response','fixed locator','no image']) {
    await t.test(mode,async t=>{
      const dir=await temp(t);
      let calls=0;
      const result=await auditOriginalPages({part,assigned:[units[1]],units,directory:dir,originalText:u=>u.text,
        pageImage:async page=>mode==='no image'?null:path.join(dir,page+'.png'),sourceSlotConflict:()=>false,
        worker:async({prompt,outputPath,webSearch,imagePaths})=>{
          calls++;
          assert.equal(webSearch,false);
          assert.deepEqual(imagePaths.map(f=>path.basename(f)),['9.png','8.png']);
          const input=inline(prompt);
          assert.ok(input.sources[1].text.includes('[s1L2]'));
          assert.deepEqual(input.blocks['paragraph 1'],count);
          const d=review(input),w=d.checks[0].witnesses[0];
          if (mode==='bad response') return fs.writeFile(outputPath,'{');
          if (['cited conflict','cited paraphrase','duplicated locator','uncited conflict'].includes(mode)) {
            d.status='contradicted';
            d.checks=d.checks.slice(0,1);
            d.checks[0].comparison='The assigned count includes the blank pigment, which the chart excludes.';
            if (mode==='cited paraphrase') w.transcription='The source excludes the blank pigment from the color count.';
            if (mode==='duplicated locator') w.transcription='[s1L2] The chart has one row for each pigment.';
          }
          if (mode==='inconclusive') {d.status='insufficient';d.checks=[];}
          if (mode==='uncited conflict' || (mode==='fixed locator' && calls===1)) w.anchor='made-up source phrase';
          if (mode==='fixed locator' && calls===2) assert.match(prompt,/Correct this review issue: .*for introduction/);
          if (mode==='wrong page') w.page=3;
          if (mode==='wrong block') d.checks[0].draftQuote=count;
          if (mode==='missing block') d.checks.pop();
          await fs.writeFile(outputPath,JSON.stringify(d));
        }});
      if (mode==='verified' || mode==='fixed locator') {
        assert.equal(result.sourceCheck,justification);
        assert.deepEqual(result.notationEvidence,[intro]);
      } else if (['cited conflict','cited paraphrase','duplicated locator'].includes(mode)) {
        assert.match(result.originalDraftIssue,/introduction, page 8 \(s1L2\).*blank pigment/s);
        assert.ok(result.originalDraftIssue.includes(intro));
        assert.deepEqual(result.originalDraftConflicts,[{block:'introduction',quote:intro}]);
      }
      else assert.deepEqual(result,{});
      assert.equal(calls,mode==='no image'?0:['verified','inconclusive','cited conflict','cited paraphrase','duplicated locator'].includes(mode)?1:2);
    });
  }
});

test('editing unrelated prose cannot clear a sourced denial for an unchanged assertion in its original context',()=>{
  const quote='Their average equals the threshold.';
  const original={...orientation,paragraphs:['The diagram labels both possible outcomes.', 'Both quantities measure the actual cost. '+quote]};
  const conflict=[{block:'paragraph 2',quote}];
  assert.equal(retainsDeniedClaim(original,{...original,paragraphs:['The diagram labels the red and blue outcomes.',original.paragraphs[1]]},conflict),true);
  assert.equal(retainsDeniedClaim(original,{...original,paragraphs:['The first paragraph introduces outcomes.','Both quantities are lower bounds. '+quote]},conflict),false);
  assert.equal(retainsDeniedClaim(original,{...original,paragraphs:[original.paragraphs[0],'Both values bound the cost from below. Their average is a lower bound.']},conflict),false);
});

test('normal preparation can publish the independently approved immutable PDF draft after repeated editorial corruption',async t=>{
  for (const mode of ['formula','formatting','saved formatting','bad first-use evidence']) await t.test(mode,async t=>{
    const cacheDir=await temp(t),paper={title:'Painting two tiles',units:units.map(({step,...u})=>u),
      analysis:{parts:[{id:'tiles',title:'Counting independent colors',summary:intro,sourceSteps:[2]}],
        localIntroductions:[],knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]},
      pdfBase64:Buffer.from('%PDF-1.7\npaint chart\n%%EOF').toString('base64')};
    const outputs=[];
    const worker=async({outputPath,prompt})=>{
      const type=path.basename(outputPath);
      outputs.push(type);
      if (mode==='saved formatting' && type==='edited.json' && outputs.filter(s=>s===type).length===2)
        throw new Error('Simulated shutdown before the corrective edit.');
      let answer;
      if (type==='plan.json') answer={parts:[{...part,question:'How many ways can the pair be painted?'}]};
      else if (type==='edited.json') answer={parts:[{id:'tiles',introduction:intro,
        paragraphs:[mode==='formula'?count.replace('n^2','n^5'):'The chart lists the \u001c colors.'],handoff:'',
        formalAfter:0,referenceNotation:null,definitionCorrections:[],proseNotationCards:[],notationEvidence:[intro],
        sourceCheck:justification,unresolved:''}]};
      else if (type==='proposal-bound-review.json') answer={sectionId:'tiles',supported:false,
        unresolved:'The figure does not show that many colorings.',verdicts:[]};
      else if (type==='original-draft-audit.json') {
        answer=review(inline(prompt));
        if (mode==='bad first-use evidence') answer.notationEvidence=['No corresponding original clause.'];
      } else assert.fail('Unexpected worker output '+type);
      await fs.writeFile(outputPath,JSON.stringify(answer));
    };
    const api=createPlanHandler({cacheDir,worker,renderSourcePage:async()=>Buffer.from('Painted tiles'),
      waitForRecovery:async()=>{},readLocalJson:async req=>req.body,checkLocalRequest(){}});
    const call=async(method,url)=>{
      let response;
      await api({method,body:paper},{writeHead(){},end(data){response=JSON.parse(data);}},url);
      return response;
    };
    let job=await call('POST','/api/reading-plan');
    for (let i=0;i<600 && job.status==='running';i++) {await delay(10);job=await call('GET','/api/reading-plan/'+job.key);}
    if (mode==='saved formatting') {
      assert.equal(job.status,'error');
      const before=outputs.length;
      job=await call('POST','/api/reading-plan');
      for (let i=0;i<600 && job.status==='running';i++) {await delay(10);job=await call('GET','/api/reading-plan/'+job.key);}
      assert.deepEqual(outputs.slice(before),['original-draft-audit.json']);
    }
    assert.ok(outputs.includes('original-draft-audit.json'),JSON.stringify({job,outputs}));
    if (mode==='bad first-use evidence') {assert.equal(job.status,'error');return;}
    assert.equal(job.status,'ready',job.message);
    assert.deepEqual(job.parts[0].orientation.paragraphs,[count]);
    assert.equal(job.parts[0].orientation.introduction,intro);
    assert.deepEqual(job.parts[0].orientation.notation,orientation.notation);
    assert.equal(outputs.filter(s=>s==='edited.json').length,2);
  });
});
