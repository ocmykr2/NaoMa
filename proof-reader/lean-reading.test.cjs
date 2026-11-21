const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {checkLeanStructure,explainLeanStructure,generateLeanReading}=require('./lean-reading.cjs');

const quote='The two groups jointly contain at least five jobs.';
const input={units:[{step:1,page:4,title:'A counting contradiction',text:quote+' Two machines can hold at most four of them.'}],context:{
  title:'A capacity bound',scope:'step',step:1,history:[],stepSkills:[],question:'Why do the jobs not fit?',
  stage:{partId:'count',title:'Compare demand and capacity',sourceSteps:[1],opening:'Count the distinct jobs.',
    localPrerequisites:[{id:'capacity',kind:'lemma',originPartId:'packing',title:'Packing limit',meaning:'Each machine fits two jobs.'}]}}};
const open={id:'count-jobs',title:'Count the jobs',claim:quote,assumptions:[],dependsOn:[],priorPartIds:[],sourceStep:1,sourceQuote:quote,
  scope:'The two groups are taken from the schedule.',formal:null};
const close={id:'compare',title:'Compare with capacity',claim:'Five jobs exceed four available places.',
  assumptions:['The counts apply to the same jobs.'],dependsOn:['count-jobs'],priorPartIds:['packing'],sourceStep:1,
  sourceQuote:'Two machines can hold at most four of them.',scope:'The numerical comparison uses the demand and capacity established above.',
  formal:{variables:[],hypotheses:[],conclusion:'(5 : Nat) > 4',tactic:'decide'}};
const structure={goal:'Find where the five jobs would go.',modules:[open,close]};
const explanations={overview:'The proof counts the jobs, then bounds the places they could occupy.',
  modules:[{id:open.id,explanation:'The two groups force five distinct jobs into the schedule.',modelingIssue:''},
    {id:close.id,explanation:'With four places available, even the fifth job already exceeds the capacity.',modelingIssue:''}]};
const unproved={status:'unproved',version:'fixture',source:'arithmetic goal',detail:'unsolved goal',axioms:[]};

test('an empty worker result during formulation retries before checking the real proposition',async()=>{
  const calls=[];
  const guide=await generateLeanReading(input,{verify:async p=>{calls.push('verify');assert.deepEqual(p,close.formal);return unproved;},
    worker:async({schemaPath,outputPath,requireOutput})=>{
      assert.ok(requireOutput);
      const phase=path.basename(schemaPath).split('-')[0];calls.push(phase);
      if (calls.length===1) return;
      await fs.writeFile(outputPath,JSON.stringify(phase==='formulation'?structure:explanations));
    }});
  assert.deepEqual(calls,['formulation','formulation','verify','explanation']);
  assert.equal(guide.modules[1].verification.status,'unproved');
});

test('the writer receives actual receipts only after checking; reader prose preserves the paper dependencies',async()=>{
  const sequence=[];
  const out=await generateLeanReading(input,{
    verify:async p=>{sequence.push('checker');assert.deepEqual(p,close.formal);return unproved;},
    worker:async ({prompt,schemaPath,outputPath,webSearch})=>{
      assert.equal(webSearch,false);assert.ok(prompt.includes(quote));
      const phase=path.basename(schemaPath).split('-')[0];sequence.push(phase);
      if(phase==='formulation')await fs.writeFile(outputPath,JSON.stringify({...structure,modules:[open,{...close,verification:{status:'verified'}}]}));
      else {
        assert.ok(prompt.includes('"status":"unproved"'));assert.ok(prompt.includes('"status":"unformalized"'));
        await fs.writeFile(outputPath,JSON.stringify(explanations));
      }
    }});
  assert.deepEqual(sequence,['formulation','checker','explanation']);
  assert.equal(out.modules[1].verification.status,'unproved');
  assert.equal(out.modules[1].sourcePage,4);
  assert.deepEqual(out.modules[1].dependsOn,[open.id]);assert.deepEqual(out.modules[1].priorPartIds,['packing']);
  assert.equal(out.modules[1].explanation,explanations.modules[1].explanation);
});

test('validation rejects crossed source steps, circular dependencies, arbitrary origins, and hidden assumptions before checking',async()=>{
  const unexpected=()=>assert.fail('Verifier must not see an invalid graph.');
  for(const change of [{sourceStep:2},{sourceQuote:'A sentence from another paper.'},{id:open.id},{dependsOn:[close.id]},
    {priorPartIds:['unrelated-section']},{sourceQuote:''},{assumptions:[],formal:{...close.formal,hypotheses:[{name:'fits',expression:'True'}]}},
    {claim:'The Lean kernel verified this inequality.'}]){
    await assert.rejects(()=>checkLeanStructure(input,{...structure,modules:[open,{...close,...change}]},{verify:unexpected}));
  }
  const scanned={...input,units:[{...input.units[0],text:''}]};
  const checked=await checkLeanStructure(scanned,{goal:structure.goal,modules:[{...open,sourceQuote:''}]},{visualSteps:[1],verify:unexpected});
  assert.equal(checked.modules[0].sourcePage,4);
});

test('a source-correspondence mismatch cannot publish a formally checked claim as support for the paper',async()=>{
  const checked=await checkLeanStructure(input,structure,{verify:async()=>({...unproved,status:'verified'})});
  assert.throws(()=>explainLeanStructure(checked,{...explanations,modules:[explanations.modules[0],
    {...explanations.modules[1],modelingIssue:'The selected instance uses a stronger load bound.'}]}),/disagrees with the paper/);
  assert.equal(checked.modules[1].verification.status,'verified');
  assert.throws(()=>explainLeanStructure(checked,{...explanations,overview:'The proof assistant verified this.'}));
  assert.throws(()=>explainLeanStructure(checked,{...explanations,modules:explanations.modules.toReversed()}));
});

test('a checked but misrepresented claim and its dependent step are rebuilt from the original passage before publication',async()=>{
  for(const persistentMismatch of [false,true]){
    const conclusions=[], review=[];
    let proposals=0;
    const pending=generateLeanReading(input,{
      verify:async p=>{conclusions.push(p.conclusion);return {...unproved,status:'verified'};},
      worker:async({schemaPath,prompt,outputPath})=>{
        const phase=path.basename(schemaPath).split('-')[0];
        if(phase==='formulation'){
          proposals++;
          if (proposals>1) assert.ok(prompt.includes('stronger bound than the source'));
          const claim=proposals===1?'Every input has exactly five jobs.':open.claim;
          const formal=proposals===1?{...close.formal,conclusion:'5 = 5'}:close.formal;
          await fs.writeFile(outputPath,JSON.stringify({...structure,modules:[{...open,claim},{...close,formal}]}));
        }else{
          review.push(phase);
          const issue=proposals===1 || persistentMismatch?'A stronger bound than the source is assumed.':'';
          await fs.writeFile(outputPath,JSON.stringify({...explanations,modules:[
            {...explanations.modules[0],modelingIssue:issue},explanations.modules[1]]}));
        }
      }
    });
    if(persistentMismatch)await assert.rejects(pending,/disagrees with the paper/);
    else{
      const published=await pending;
      assert.equal(published.modules[0].claim,open.claim);
      assert.equal(published.modules[1].formal.conclusion,close.formal.conclusion);
    }
    assert.deepEqual(conclusions,['5 = 5',close.formal.conclusion]);assert.equal(review.length,2);
  }
});

test('a bad source quotation is repaired before the proposition is checked; a writer repair never reruns the checker',async()=>{
  const counts={formulation:0,explanation:0,check:0};
  await generateLeanReading(input,{
    verify:async()=>{counts.check++;return unproved;},
    worker:async ({schemaPath,outputPath})=>{
      const phase=path.basename(schemaPath).split('-')[0];counts[phase]++;
      const draft=phase==='formulation'?
        (counts.formulation===1?{...structure,modules:[{...open,sourceQuote:'Fabricated quotation.'},close]}:structure):
        (counts.explanation===1?{...explanations,overview:'Lean verified the argument.'}:{text:explanations.overview,modelingIssue:''});
      await fs.writeFile(outputPath,JSON.stringify(draft));
    }});
  assert.deepEqual(counts,{formulation:2,explanation:2,check:1});
});

test('private field diagnostics distinguish length, malformed math, process terms and invisible characters',async()=>{
  const checked=await checkLeanStructure(input,structure,{verify:async()=>unproved});
  for(const [value,issue,detail] of [
    [' ','empty','nonempty'],['a'.repeat(3201),'length','3201'],
    ['There are \\(x jobs.','math-delimiter','unmatched'],
    ['The \\(x\x0b\\ge 1\\) jobs remain.','control','U+000B'],
    ['The \\(\\href{x}{y}\\) jobs remain.','unsupported-tex','href'],
    ['The \\(\\) jobs remain.','malformed-formula','empty'],
    ['The **remaining jobs** fit.','markdown','Markdown'],
    ['The <b>jobs</b> fit.','html','HTML'],
    ['The proof assistant completed this.','internal-language','proof assistant']
  ]){
    assert.throws(()=>explainLeanStructure(checked,{...explanations,modules:[explanations.modules[0],
      {...explanations.modules[1],explanation:value}]}),e=>
      e.workerCode==='format' && e.issue===issue && e.message.includes(detail) &&
      e.message.includes('modules[1].explanation') && e.message.includes(close.id));
  }
});

test('field repair edits only the offending explanation, preserves siblings and stops on repeated failure',async()=>{
  for(const recover of [true,false]) {
    const calls=[];
    const broken=String.raw`There are \ge four places.`;
    const pending=generateLeanReading(input,{verify:async()=>{calls.push('verify');return unproved;},
      worker:async({outputPath,prompt})=>{
        const phase=path.basename(outputPath,'.json');calls.push(phase);
        let reply;
        if(phase==='formulation') reply=structure;
        else if(phase==='explanation') reply={...explanations,modules:[explanations.modules[0],{...explanations.modules[1],explanation:broken}]};
        else {
          assert.equal(phase,'explanation-field');
          for(const term of ['modules[1].explanation','\\\\ge',close.id,'Private field diagnostic',quote]) assert.ok(prompt.includes(term),term);
          reply={text:recover?explanations.modules[1].explanation:broken,modelingIssue:''};
        }
        await fs.writeFile(outputPath,JSON.stringify(reply));
      }});
    if(recover) {
      const guide=await pending;
      assert.deepEqual(guide.modules.map(row=>row.explanation),explanations.modules.map(row=>row.explanation));
    } else await assert.rejects(pending,e=>e.workerCode==='format' && e.issue==='math-delimiter');
    assert.deepEqual(calls,['formulation','verify','explanation','explanation-field',...recover?[]:['explanation-field']]);
  }
});

test('a saved raw formulation is validated and checked again; a source mismatch clears it',async()=>{
  for(const invalidSource of [false,true]){
    const calls=[],saves=[];
    await generateLeanReading(input,{
      loadDraft:async()=>({...structure,modules:[{...open,sourceQuote:invalidSource?'quotation from another source':quote},close]}),
      saveDraft:async draft=>saves.push(draft),verify:async()=>{calls.push('verify');return unproved;},
      worker:async({outputPath})=>{
        const phase=path.basename(outputPath,'.json');calls.push(phase);
        await fs.writeFile(outputPath,JSON.stringify(phase==='formulation'?structure:explanations));
      }});
    assert.deepEqual(calls,[...invalidSource?['formulation']:[],'verify','explanation']);
    assert.deepEqual(saves,[...invalidSource?[null]:[],structure]);
  }
});

test('the structured reading uses adapted symbols in both writing passes and exact original symbols in its source passage',async()=>{
  const {notationRevision}=require('./notation-adaptation.cjs');
  const source='The combined demand N is at least five jobs. The two machines can hold four.';
  const sourceQuote='The combined demand N is at least five jobs.';
  const notationEdition={revision:notationRevision,referenceTitle:'A queueing convention',
    mappings:[{concept:'combined job demand',original:'N',preferred:'Q',partIds:['count'],sourceStep:1,sourceQuote,
      referenceStep:1,referenceQuote:'Q is the combined job demand.'}],
    parts:[{id:'count',title:'Bound the combined demand',reading:'Compare the demand \\(Q\\) with four places.',sourceStep:1,sourceQuote}],
    overview:{paragraphs:['Five jobs need room.','Only four places are available.'],suggestions:[{question:'How large is the demand?',step:1}]}};
  const paper={context:{...input.context,notationEdition},units:[{...input.units[0],text:source}]};
  const phrase='The demand \\(Q\\) exceeds the four available places.';
  const row={...open,claim:phrase,assumptions:['There are at least five jobs.'],sourceQuote,scope:'Count jobs.',formal:close.formal};
  const stages=[];
  const guide=await generateLeanReading(paper,{
    verify:async proposition=>{stages.push('check');assert.deepEqual(proposition,close.formal);return unproved;},
    worker:async({prompt,schemaPath,outputPath})=>{
      const phase=path.basename(schemaPath).split('-')[0];
      stages.push(phase);
      assert.ok(prompt.includes(notationEdition.referenceTitle));
      assert.ok(prompt.includes(sourceQuote));
      const first=stages.filter(s=>s===phase).length===1;
      const spelling=first?'The demand \\(N\\) exceeds the four available places.':phrase;
      await fs.writeFile(outputPath,JSON.stringify(phase==='formulation'?{goal:'Compare the demand with capacity.',modules:[{...row,claim:spelling}]}:
        {overview:'Count the available places.',modules:[{id:row.id,explanation:spelling,modelingIssue:''}]}));
    }
  });
  assert.deepEqual(stages,['formulation','formulation','check','explanation','explanation']);
  assert.equal(guide.modules[0].claim,phrase);
  assert.equal(guide.modules[0].sourceQuote,sourceQuote);
});
