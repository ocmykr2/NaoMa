'use strict';
require('./test-support/editorial-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createPlanHandler}=require('./personalized-plan.cjs');

test('standard blackboard number sets admit both TeX spellings while positions and custom sets still need first-use evidence',async t=>{
  for (const [label,symbols,missing] of [
    ['single tokens',['\\mathbb R','\\mathbb R_{\\ge0}','\\mathbb N','\\mathbb Q','\\mathbb C','\\mathbb Z'],''],
    ['braces',['\\mathbb{R}','\\mathbb{R}_{\\ge0}'],''],
    ['dimension',['\\mathbb R^d'],'d'],
    ['custom set',['\\mathbb F'],'@mathbb:F'],
    ['italic parameter',['R'],'R'],
  ]) {
    const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'naoma-number-sets-'));
    t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
    const spans=symbols.map(s=>'\\('+s+'\\)'),paragraph='Consider coordinates in '+spans.join(' and ')+'.';
    const row={id:'coordinates',question:'What values can a coordinate take?',orientation:{introduction:'Choose the space for the coordinates.',
      notation:spans.map(symbol=>({symbol,meaning:'A space of allowable coordinates.'})),definitions:[],
      paragraphs:[paragraph],handoff:'',statement:null}};
    const body={title:'Coordinate domains',units:[{title:'Coordinates',text:paragraph}],analysis:{localIntroductions:[],
      parts:[{id:row.id,title:'Choose the coordinate space',summary:paragraph,sourceSteps:[1],techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:[]}],
      knowledge:{techniques:[],definitionGroups:[]}},readerKnowledge:{techniques:[],definitionGroups:[]}};
    const worker=async({outputPath})=>{
      let output;
      if (path.basename(outputPath)==='plan.json') output=row;
      else {
        assert.equal(path.basename(outputPath),'edited.json');
        output={id:row.id,introduction:row.orientation.introduction,paragraphs:[paragraph],handoff:'',formalAfter:0,referenceNotation:null,
          proseNotationCards:[],notationEvidence:[],definitionCorrections:[],sourceCheck:'Checked the domain of each coordinate against the original passage.',unresolved:''};
      }
      await fs.writeFile(outputPath,JSON.stringify({parts:[output]}));
    };
    const endpoint='/api/reading-plan',api=createPlanHandler({cacheDir,worker,waitForRecovery:async()=>{},
      readLocalJson:async req=>req.body,checkLocalRequest(){}});
    async function request(method,url){let result;await api({method,body},{writeHead(){},end(data){result=JSON.parse(data);}},url);return result;}
    let job=await request('POST',endpoint);
    for(let n=0;n<500 && job.status==='running';n++){await delay(10);job=await request('GET',endpoint+'/'+job.key);}
    if (missing) {
      assert.equal(job.status,'error',label);assert.equal(job.parts,undefined);
      assert.match(job.message,/first-use notation/);assert.ok(job.message.includes('Introduce '+missing+' where'),job.message);
    } else {
      assert.equal(job.status,'ready',job.message);assert.deepEqual(job.parts[0].orientation.paragraphs,[paragraph]);
    }
  }
});
