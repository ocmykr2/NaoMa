'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler,readingPlanKey}=require('./personalized-plan.cjs');
const {planCheckpoints}=require('./plan-checkpoints.cjs');
const {hasCompleteFormula,matchingAnchors,sourceExcerpts}=require('./proposal-page-evidence.cjs');

test('visual transcriptions retain complete formula roles when read from a list or equation',()=>{
  assert.ok(hasCompleteFormula('\\(f=(a,-b,c)\\)','-b'));
  assert.ok(hasCompleteFormula('\\(z=1/X=Y\\)','1/X'));
  assert.ok(hasCompleteFormula('\\(x=y, p=q\\)','p=q'));
  assert.ok(hasCompleteFormula('\\(u \\geq 1\\)','u≥1'));
  for (const [text,candidate] of [['(a,-b,c)','b'],['x^{-3}','3'],['f(x,y)','y'],
    ['(a,(x,y),z)','y'],['x+y','x'],['(a,b)(c,d)','c'],['q\\ge2','2'],
    ['\\begin{cases}a,&k=2\\\\b,&k=3\\end{cases}','3']]) {
    assert.equal(hasCompleteFormula('\\('+text+'\\)',candidate),false,text);
  }
});

test('an adjacent caption must independently identify the same local passage or diagram',()=>{
  const text='Figure 3. Cross sections of the blue frame. Each cross section contains one color.';
  assert.ok(matchingAnchors(text,'Figure 3 shows the blue frame at its widest point.','Each cross section contains one color,'));
  assert.equal(matchingAnchors(text,'Figure 4 shows a different frame.','Each cross section contains one color.'),null);
  const distant=text+' unrelated'.repeat(120)+' Figure 4. The red frame.';
  assert.equal(matchingAnchors(distant,'Figure 4 shows a different frame.','Each cross section contains one color.'),null);
  const long='prefix '.repeat(18000)+'Selected source phrase.'+'suffix '.repeat(18000);
  const excerpt=sourceExcerpts([{step:5,page:8,text:long}],[{step:5,phrase:'Selected source phrase.'}])[0];
  assert.equal(excerpt.page,8);
  assert.ok(excerpt.passages.some(p=>p.includes('Selected source phrase.')));
  assert.ok(excerpt.passages.join('').length<72000);
});

const anchor='The blue frame has one layer for each axis.';
const base='Let \\(R\\) be the number of cells along one edge of the frame.';
const notation=[{symbol:'\\(R\\)',meaning:'Number of cells along one edge of the frame.'}];
const draft='A square frame has \\(R^{2}\\) cells.';
const paragraphs=['A cubic frame has \\(R^{3}\\) cells.','Filling all \\(R^{3}\\) cells exhausts the frame.'];
const paper={title:'Counting frames',units:[{title:'Square frames',text:'The flat frame is outlined first.',page:4},
  {title:'Cubic frames',text:anchor+' The cell count in this row is R 3.',page:5}],
  analysis:{parts:[{id:'cube',title:'Count the cells',summary:base,sourceSteps:[2]}],localIntroductions:[],
    knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]},
  pdfBase64:Buffer.from('%PDF-1.7\nCounting frames\n%%EOF').toString('base64')};

async function run(body,cacheDir,worker,renderSourcePage) {
  const api=createPlanHandler({cacheDir,worker,renderSourcePage,waitForRecovery:async()=>{},
    readLocalJson:async req=>req.body,checkLocalRequest(){}});
  const call=async(method,url)=>{
    let result;
    await api({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},url);
    return result;
  };
  let job=await call('POST','/api/reading-plan');
  for (let i=0;i<800 && job.status==='running';i++) {
    await delay(10);
    job=await call('GET','/api/reading-plan/'+job.key);
  }
  return job;
}

test('the independent PDF verifier binds every proposed occurrence to the assigned page before another rewrite',async t=>{
  for (const scenario of ['printed','derived','missing occurrence','duplicate occurrence','wrong expression','wrong step',
    'wrong page','detached anchor','missing premise','ambiguous anchor','declined','malformed','network','unexpected',
    'persist decline','changed context','incomplete notation','unavailable image','seven pages','corrected citation',
    'contradicted after anchor','contradicted before anchor','printed list entry','curated commentary']) {
    await t.test(scenario,async t=>{
      const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-page-equations-'));
      t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
      const body=structuredClone(paper);
      if (scenario==='ambiguous anchor') body.units[1].text+=' '+anchor;
      if (scenario==='contradicted after anchor') body.units[1].text=anchor+' The cubic row has \\(R^{7}\\) cells.';
      if (scenario==='contradicted before anchor') body.units[1].text='The cubic row has \\(R^{7}\\) cells. '+anchor;
      if (scenario==='curated commentary') {
        body.units[1].text='Original manuscript page 5\n\nThe blue frame is drawn here.\n\nReading guide for this step\n\n'+anchor+' The cubic row has \\(R^{3}\\) cells.';
      }
      if (scenario==='seven pages') {
        body.units.unshift(...Array.from({length:5},(_,i)=>({title:'Earlier frame '+i,text:'Earlier frame types.',page:10+i})));
        body.analysis.parts[0].sourceSteps=[1,2,3,4,5,6,7];
      }
      const key=await readingPlanKey(body),checkpoints=planCheckpoints(cacheDir,key,100000);
      let drafts=0,edits=0,audits=0;
      const render=async(_pdf,page)=>{
        if (scenario==='unavailable image') throw new Error('Page unavailable.');
        return Buffer.from('Frame figure '+page);
      };
      const persistent=scenario==='persist decline';
      const successful=['printed','derived','network','changed context','seven pages','corrected citation','printed list entry'].includes(scenario);
      const worker=async({directory,schemaPath,outputPath,imagePaths,prompt})=>{
        let out;
        switch (path.basename(outputPath)) {
        case 'original-draft-audit.json':
          out={id:'cube',status:'insufficient',explanation:'The original comparison could not be established.',checks:[],notationEvidence:[]};
          break;
        case 'plan.json':
          drafts++;
          out={parts:[{id:'cube',question:'How many cells does a frame contain?',orientation:{introduction:base,
            paragraphs:[draft],notation,definitions:[],statement:null,handoff:''}}]};
          break;
        case 'edited.json': {
          edits++;
          if (edits>1) {
            const [note]=JSON.parse(await fs.readFile(path.join(directory,'editor-revisions.json'),'utf8'));
            assert.ok(!Object.hasOwn(note,'proposalPageAudits'));
            if (scenario==='declined' || scenario==='changed context') assert.match(note.proposedBoundIssue,/binding is unclear/u);
          }
          let proposed=edits===1 || persistent || scenario==='changed context'?paragraphs:[draft];
          if (scenario==='changed context' && edits>1) proposed=[paragraphs[0]+' This counts the full cube.',paragraphs[1]];
          out={parts:[{id:'cube',introduction:base,paragraphs:proposed,handoff:'',formalAfter:0,
            referenceNotation:null,definitionCorrections:[],proseNotationCards:[],
            notationEvidence:scenario==='incomplete notation' && edits===1?[]:[base],
            sourceCheck:'Compared the frame dimensions with the count on its source page.',unresolved:''}]};
          break;
        }
        case 'proposal-bound-review.json': {
          audits++;
          const schema=JSON.parse(await fs.readFile(schemaPath,'utf8'));
          assert.deepEqual(schema.required,['sectionId','supported','unresolved','verdicts']);
          if (scenario==='curated commentary') {
            assert.ok(prompt.includes('The blue frame is drawn here.'));
            assert.ok(!prompt.includes(anchor));
          } else assert.ok(prompt.includes(JSON.stringify(body.units.at(-1).text)));
          assert.equal(imagePaths.length,scenario==='seven pages'?7:1);
          assert.equal(await fs.readFile(imagePaths.at(-1),'utf8'),'Frame figure 5');
          const {sourceSteps,occurrences,blocks}=JSON.parse(prompt.split('Immutable verification input: ')[1]);
          assert.deepEqual(sourceSteps.at(-1),{step:scenario==='seven pages'?7:2,page:5});
          if (audits===1) assert.equal(occurrences.length,2);
          assert.equal(new Set(occurrences.map(o=>o.occurrence)).size,occurrences.length);
          if (scenario==='corrected citation' && audits===2) {
            assert.equal(occurrences.length,1);
            assert.ok(prompt.includes(occurrences[0].occurrence+' — The exact expression or occurrence is missing.'));
          }
          for (const o of occurrences) assert.ok(blocks[o.block].includes('\\('+o.expression+'\\)'));
          const pending=(await checkpoints.load()).get(0).editNotes[0];
          assert.deepEqual(pending.proposal.paragraphs,blocks.slice(1,-1));
          if (scenario==='network' && audits===1) throw Object.assign(new Error('Connection lost.'),{workerCode:'network'});
          if (scenario==='unexpected') throw new TypeError('Unexpected parser defect');
          if (scenario==='malformed') {await fs.writeFile(outputPath,'invalid');return;}
          const derived=scenario==='derived' || scenario==='missing premise';
          out={sectionId:'cube',supported:true,unresolved:'',verdicts:occurrences.map(o=>{
            const formula=derived?'R^{2}R':scenario==='printed list entry'?'(R,R^{2},R^{3})':'R^{3}';
            return {occurrence:o.occurrence,expression:o.expression,mode:derived?'derived':'printed',
              witnesses:[{step:sourceSteps.at(-1).step,page:5,anchor,transcription:anchor+' The cubic row has \\('+formula+'\\) cells.',sourceFormula:formula}],
              binding:'The row counts all cells in the same cubic frame.',
              applicability:'Each axis of the cubic frame has the same side length.',
              derivation:derived?'The layer product \\(R^{2}R\\) has three factors, giving \\(R^{3}\\).':''};
          })};
          const first=out.verdicts[0];
          if (scenario==='contradicted before anchor') first.witnesses[0].transcription='The cubic row has \\(R^{3}\\) cells. '+anchor;
          if (scenario==='missing occurrence' || (scenario==='corrected citation' && audits===1)) out.verdicts.pop();
          if (scenario==='duplicate occurrence') out.verdicts[1]=first;
          if (scenario==='wrong expression') first.expression='R^{9}';
          if (scenario==='wrong step') first.witnesses[0].step=1;
          if (scenario==='wrong page') first.witnesses[0].page=4;
          if (scenario==='detached anchor') first.witnesses[0].transcription='The cubic row has \\(R^{3}\\) cells.';
          if (scenario==='missing premise') first.derivation='The count is obviously \\(R^{3}\\).';
          if (scenario==='declined' || persistent || (scenario==='changed context' && audits===1)) {
            out.supported=false;out.unresolved='The binding is unclear at the second occurrence.';
          }
          break;
        }
        default:assert.fail('Unexpected worker task '+path.basename(outputPath));
        }
        await fs.writeFile(outputPath,JSON.stringify(out));
      };
      const result=await run(body,cacheDir,worker,render);
      assert.equal(drafts,1,JSON.stringify(result));
      if (scenario==='unexpected') {
        assert.equal(result.unexpected,true,result.message);
        assert.equal(edits,1);
        return;
      }
      const repaired=['network','changed context','missing occurrence','duplicate occurrence','wrong expression','wrong step',
        'wrong page','detached anchor','missing premise','ambiguous anchor','malformed','corrected citation',
        'contradicted after anchor','contradicted before anchor','curated commentary'].includes(scenario);
      assert.equal(audits,scenario==='unavailable image'?0:repaired?2:1,result.message);
      if (persistent) {
        assert.equal(result.status,'error',result.message);
        assert.equal((await checkpoints.load()).get(0).editNotes[0].proposalPageAudits.length,1);
        const cold=await run(body,cacheDir,worker,render);
        assert.equal(cold.status,'error');
        assert.equal(audits,1,'an identical rejected proposal was resent');
      } else {
        assert.equal(result.status,'ready',result.message);
        assert.equal(edits,successful && scenario!=='changed context'?1:2);
        if (scenario==='changed context') assert.match(result.parts[0].orientation.paragraphs[0],/full cube/u);
        else assert.deepEqual(result.parts[0].orientation.paragraphs,successful?paragraphs:[draft]);
      }
    });
  }
});
