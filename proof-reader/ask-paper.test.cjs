const assert = require('node:assert/strict');
const {readFile, writeFile} = require('node:fs/promises');
const {setTimeout: delay} = require('node:timers/promises');
const test = require('node:test');
const {createQuestionHandler, prepareRequest, containsMarkup} = require('./ask-paper.cjs');

test('a decoded control cannot hide a damaged relation inside display math', () => {
  const intact = String.raw`The bound is \[W/m\le W_0/m+1.04NRK.\]`;
  const damaged = intact.replace('\\le', '\u001cle');
  assert.equal(containsMarkup(intact, 'latex'), false);
  assert.equal(containsMarkup(damaged, 'latex'), true);
  assert.equal(containsMarkup('Two paragraphs.\r\n\r\nAn indented line.\tThe end.', 'latex'), false);
});

const question = {
  title: 'A repaired counting argument', step: 1, stepSkills: ['Endpoint substitution'],
  question: 'Why is the silver cutoff needed for endpoint substitution?',
  units: [{title: 'Closing the interval', text: 'Endpoint substitution requires the silver cutoff.'}],
};
const padded = (label, size) => (label + ' ').padEnd(size, '界');

function fullManifest() {
  const techniques = Array.from({length: 12}, (_, i) => ({
    name: i === 11 ? 'Endpoint substitution' : 'Background method ' + i,
    mechanism: padded('The complete mechanism ' + i, 2000),
    knownBridge: padded('The complete local argument ' + i, 2000), sources: ['ABC21'],
  }));
  const definitionGroups = Array.from({length: 16}, (_, i) => {
    const terms = Array.from({length: 24}, (_, j) => padded(
      i === 15 && j === 23 ? 'Silver cutoff' : 'Term ' + i + '.' + j, 300));
    return i === 15 ? {title: 'Boundary conditions', state: 'partial', knownTerms: terms.slice(0, 23), remainingTerms: terms.slice(23)}
      : {title: 'Group ' + i, state: 'known', knownTerms: terms, remainingTerms: []};
  });
  return {techniques, definitionGroups};
}

function tutor(worker) {
  const prompts = [];
  const finished = new Map();
  const endpoint = '/api/paper-question';
  const handle = createQuestionHandler({
    checkLocalRequest() {}, readLocalJson: req => req.body,
    worker: worker || (async ({prompt, outputPath}) => {
      prompts.push(JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1)));
      await writeFile(outputPath, JSON.stringify({unit: 1, answer: 'The cutoff closes the interval.',
        followups: ['Which endpoint is included?'], discussedSkill: 'Endpoint substitution'}));
    }),
  });
  async function request(method, url, body) {
    let response;
    await handle({method, body}, {writeHead() {}, end: s => { response = JSON.parse(s); }}, url);
    return response;
  }
  return {prompts, finished, async ask(body) {
    let job = await request('POST', endpoint, body);
    for (let i = 0; i < 200 && job.status === 'running'; i++) {
      await delay(10);
      job = await request('GET', endpoint + '/' + job.key);
    }
    assert.equal(job.status, 'ready');
    finished.set(job.key, job);
    return job.key;
  }};
}

test('small reader profiles and older requests reach the worker unchanged', async () => {
  const {ask, prompts} = tutor();
  await ask(question);
  assert.equal(prompts[0].readerKnowledge, undefined);
  const readerKnowledge = {techniques: [], definitionGroups: [
    {title: 'Boundary conditions', state: 'partial', knownTerms: [], remainingTerms: ['Cutoff']},
  ]};
  await ask({...question, readerKnowledge});
  assert.deepEqual(prompts[1].readerKnowledge, readerKnowledge);
});

test('the complete maximum-size generated catalog is accepted, ranked for the prompt and used for caching', async () => {
  const {ask, prompts} = tutor();
  const readerKnowledge = fullManifest();
  const request = {...question, readerKnowledge};
  assert(Buffer.byteLength(JSON.stringify(readerKnowledge)) > 128 * 1024);
  assert.deepEqual(prepareRequest(request).context.readerKnowledge, readerKnowledge);
  const first = await ask(request);
  const selected = prompts[0].readerKnowledge;
  assert.equal(selected.excerpt, true);
  assert(Buffer.byteLength(JSON.stringify(selected)) <= 32 * 1024);
  assert.deepEqual(selected.techniques[0], readerKnowledge.techniques.at(-1));
  const boundary = selected.definitionGroups.find(g => g.title === 'Boundary conditions');
  assert.deepEqual(boundary.remainingTerms, readerKnowledge.definitionGroups.at(-1).remainingTerms);
  for (const group of selected.definitionGroups) {
    const original = readerKnowledge.definitionGroups.find(g => g.title === group.title);
    assert.equal(group.state, original.state);
    for (const field of ['knownTerms', 'remainingTerms']) {
      assert(group[field].every(term => original[field].includes(term)));
    }
  }
  assert.equal(await ask(request), first);
  const unseen = readerKnowledge.definitionGroups[0].knownTerms.find(t => !selected.definitionGroups
    .find(g => g.title === 'Group 0').knownTerms.includes(t));
  assert(unseen);
  const updated = structuredClone(readerKnowledge);
  updated.definitionGroups[0].state = 'partial';
  updated.definitionGroups[0].knownTerms = updated.definitionGroups[0].knownTerms.filter(t => t !== unseen);
  updated.definitionGroups[0].remainingTerms = [unseen];
  assert.notEqual(await ask({...question, readerKnowledge: updated}), first);
});

test('oversized hand-built requests still obey field and aggregate limits', () => {
  const terms = prefix => Array.from({length: 80}, (_, i) => padded(prefix + i, 300));
  const groups = Array.from({length: 48}, (_, i) => ({
    title: 'Group ' + i, state: 'partial', knownTerms: terms('chosen'), remainingTerms: terms('remaining'),
  }));
  assert.throws(() => prepareRequest({...question, readerKnowledge: {definitionGroups: groups}}), {status: 413});
  assert.throws(() => prepareRequest({...question, readerKnowledge: {techniques: [{name: 'x'.repeat(301)}]}}), {status: 400});
});

const stage = {partId: 'closing', title: 'Closing the interval', opening: 'Replace the endpoint by the silver cutoff.',
  question: 'What makes this substitution valid?', sourceSteps: [1]};

test('the tutor receives the same notation, definitions, argument and theorem as the reading page', () => {
  const orientation = {introduction:'Identify the endpoint kept in the count.',notation:[{symbol:'b',meaning:'The right endpoint.'}],
    definitions:[{name:'Closed interval',text:'The interval contains both endpoints.'}],paragraphs:['The cutoff includes the endpoint once.'],
    handoff:'The remaining sum can now include the endpoint once.',
    statement:{kind:'Lemma',label:'Lemma 1',text:'If the interval is closed, its right endpoint belongs to the interval.'}};
  const input = {...question,stage:{...stage,orientation}};
  assert.deepEqual(prepareRequest(input).context.stage.orientation,orientation);
  const withLead={...orientation,formalAfter:1};
  assert.deepEqual(prepareRequest({...input,stage:{...stage,orientation:withLead}}).context.stage.orientation,withLead);
  for(const count of [-1,0.5,2,'1',null]) {
    assert.throws(()=>prepareRequest({...input,stage:{...stage,orientation:{...orientation,formalAfter:count}}}),{status:400});
  }
  assert.equal(prepareRequest(input).context.stage.opening,orientation.paragraphs[0]);
  assert.throws(() => prepareRequest({...input,stage:{...stage,orientation:{...orientation,statement:{kind:'Lemma',label:'Lemma 1'}}}}),{status:400});
  assert.throws(() => prepareRequest({...input,stage:{...stage,orientation:{...orientation,notation:[{symbol:'b'}]}}}),{status:400});
});

test('a question about one symbol in a long notation list retains its meaning and the complete section', async () => {
  const orientation={introduction:'Compare all cutoffs.',notation:Array.from({length:64},(_,i)=>({
    symbol:'x_'+i,meaning:(i===63?'Silver cutoff, ':'Cutoff, ')+'a bounded coordinate. '.repeat(32)
  })),definitions:[],paragraphs:Array.from({length:10},(_,i)=>'Paragraph '+i+'. '+(i===0||i===8?'Silver cutoff. ':'')+'A bounded coordinate. '.repeat(130).trimEnd()),
    handoff:'',statement:{kind:'Lemma',label:'Lemma 1',text:'The cutoff closes the interval.'},formalAfter:7};
  let shown,full;
  const worker=tutor(async({prompt,outputPath,directory})=>{
    shown=JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1)).stage;
    full=JSON.parse(await readFile(require('node:path').join(directory,'study-part.json'),'utf8')).orientation;
    await writeFile(outputPath,JSON.stringify({unit:1,answer:'This is the last allowed coordinate.',followups:['Does the interval include the cutoff?'],
      discussedSkill:'',stageDecision:{state:'continue',evidence:''}}));
  });
  await worker.ask({...question,stage:{...stage,orientation},question:'How is the silver cutoff x_63 defined?'});
  assert.equal(shown.excerpt,true);
  assert.ok(shown.orientation.notation.some(n=>n.symbol==='x_63'));
  assert.ok(shown.orientation.paragraphs.length<full.paragraphs.length);
  assert.equal(shown.orientation.formalAfter,shown.orientation.paragraphs.filter(p=>full.paragraphs.indexOf(p)<full.formalAfter).length);
  assert.equal(full.notation.length,64);
  assert.deepEqual(full.paragraphs,orientation.paragraphs);
});

test('a study part requires valid, original source indices and step scope', () => {
  const prepared = prepareRequest({...question, stage});
  assert.deepEqual(prepared.context.stage, stage);
  const anchor={step:1,phrase:'requires the silver cutoff'};
  assert.deepEqual(prepareRequest({...question,stage:{...stage,sourceAnchors:[anchor]}}).context.stage.sourceAnchors,[anchor]);
  for (const change of [{scope:'paper'}, {stage:null}, {stage:{...stage,opening:''}},
    {stage:{...stage,sourceSteps:[]}}, {stage:{...stage,sourceSteps:[2]}}, {stage:{...stage,sourceSteps:[1,1]}},
    {stage:{...stage,sourceAnchors:[{step:1,phrase:'absent quotation'}]}},{stage:{...stage,sourceAnchors:[{...anchor,step:2}]}}]) {
    assert.throws(() => prepareRequest({...question,stage,...change}), {status:400});
  }
});

test('only substantiated completion advances a part; ordinary Q&A retains its existing shape', async () => {
  const cases = [
    ['I understand why the substitution keeps the boundary closed.', 'I understand why the substitution keeps the boundary closed.', 'complete'],
    ['Every replaced endpoint is still included because the bound is closed.', 'the bound is closed', 'complete'],
    ['I can now explain why the endpoint stays in the interval: the bound is closed.', 'the bound is closed', 'complete'],
    ['I understand that inequality, but can you give an example?', 'I understand that inequality', 'continue'],
    ['I understand the substitution but I would like another example.', 'I understand the substitution', 'continue'],
    ['Show me a worked example of the cutoff.', 'a worked example', 'continue'],
    ['How does endpoint substitution work', 'endpoint substitution', 'continue'],
    ['okay', 'okay', 'continue'],
    ['能不能举个最小的例子', '最小的例子', 'continue'],
    ['This part still needs thought.', 'I understand the argument now.', 'continue'],
    [stage.question, stage.question, 'continue'],
  ];
  const run = tutor(async ({prompt, outputPath, schemaPath}) => {
    const data = JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1));
    const outputSchema = JSON.parse(await readFile(schemaPath));
    assert.equal(outputSchema.required.includes('stageDecision'), !!data.stage);
    if (data.stage) {
      assert.deepEqual(data.stage, stage);
      assert.match(prompt, /exact contiguous quote from the latest reader message/);
    }
    await writeFile(outputPath, JSON.stringify({unit:1,answer:'The endpoints agree.',followups:['Where is the boundary?'], discussedSkill:'',
      stageDecision:{state:'complete',evidence:cases.find(([message])=>message === data.question)?.[1] || ''}}));
  });
  for (const [message,evidence,state] of cases) {
    const id = await run.ask({...question,stage,question:message,history:[{question:'Earlier',answer:'I understand the argument now.'}]});
    assert.deepEqual(run.finished.get(id).stageDecision,{state,evidence:state === 'complete' ? evidence : ''});
  }
  const regular = await run.ask(question);
  assert.equal(Object.hasOwn(run.finished.get(regular),'stageDecision'),false);
});

test('format repair cannot promote a continue decision to complete', async () => {
  let calls = 0;
  const message = 'The numerator remains unchanged at the boundary.';
  const run = tutor(async ({outputPath}) => {
    const initial = ++calls === 1;
    await writeFile(outputPath,JSON.stringify({unit:1,answer:initial ? '**Boundary.**' : 'Boundary.', followups:['Did it move?'],
      discussedSkill:'',stageDecision:{state:initial ? 'continue' : 'complete',evidence:initial ? '' : message}}));
  });
  const key = await run.ask({...question,question:message,stage});
  assert.equal(calls,2);
  assert.deepEqual(run.finished.get(key).stageDecision,{state:'continue',evidence:''});
});

test('large local prerequisites keep the requested earlier result and its origin with a bounded prompt',async()=>{
  const localPrerequisites=Array.from({length:512},(_,i)=>({id:'introduction-'+i,kind:'lemma',
    title:i===511?'Silver cutoff':'Earlier fact '+i,meaning:padded('A bound on the prior set.',2000),
    originPartId:'construction',originTitle:'Constructing the interval'}));
  const input={...question,stage:{...stage,localPrerequisites}};
  const run=tutor(async({prompt,outputPath,directory})=>{
    const projected=JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1)).stage;
    assert.equal(projected.excerpt,true);
    assert(projected.localPrerequisites.length<=24);
    assert(Buffer.byteLength(JSON.stringify(projected.localPrerequisites))<=32*1024);
    assert.deepEqual(projected.localPrerequisites.find(p=>p.id==='introduction-511'),localPrerequisites.at(-1));
    const full=JSON.parse(await readFile(directory+'/study-part.json','utf8'));
    assert.deepEqual(full.localPrerequisites,localPrerequisites);
    await writeFile(outputPath,JSON.stringify({unit:1,answer:'Its earlier bound supplies the endpoint.',followups:['Which bound?'],
      discussedSkill:'',stageDecision:{state:'continue',evidence:''}}));
  });
  await run.ask(input);
  for(const invalid of [
    [{...localPrerequisites[0],kind:'reference'}],
    [{...localPrerequisites[0],originPartId:stage.partId}],
    [{...localPrerequisites[0],meaning:'M'.repeat(2001)}],
    [...localPrerequisites,localPrerequisites[0]],
  ])assert.throws(()=>prepareRequest({...question,stage:{...stage,localPrerequisites:invalid}}),{status:400});
});

test('exploration modes require an active study part and a bounded target, including an intentionally empty target',()=>{
  for(const mode of ['example','simplify','remove']){
    for(const [raw,expected] of [['   ',''],['  cutoff at the endpoint  ','cutoff at the endpoint'],['x'.repeat(1000),'x'.repeat(1000)]]){
      const data=prepareRequest({...question,stage,exploration:{mode,target:raw}}).context;
      assert.deepEqual(data.exploration,{mode,target:expected});
    }
  }
  for(const exploration of [null,[],{mode:'proof',target:'x'},{mode:'intuition',target:'the cutoff'},{target:'x'},{mode:'example'},
    {mode:'remove',target:null},{mode:'simplify',target:3},{mode:'example',target:'x'.repeat(1001)}]){
    assert.throws(()=>prepareRequest({...question,stage,exploration}),{status:400});
  }
  const exploration={mode:'example',target:'cutoff'};
  assert.throws(()=>prepareRequest({...question,exploration}),{status:400});
  assert.throws(()=>prepareRequest({...question,scope:'paper',step:0,exploration}),{status:400});
});

test('each distinct exploration has its own cached response and keeps the part active even for a positive worker verdict',async()=>{
  const message='I understand why the substitution includes the endpoint.';
  const captured=[];
  const run=tutor(async({prompt,outputPath})=>{
    const data=JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1));
    captured.push({data,prompt});
    await writeFile(outputPath,JSON.stringify({answer:'The endpoint remains in the interval.',unit:1,
      discussedSkill:'',followups:['What if the interval were open?'],stageDecision:{state:'complete',evidence:message}}));
  });
  const request={...question,stage,question:message};
  const options=[{mode:'example',target:'boundary'},{mode:'simplify',target:'boundary'},
    {mode:'remove',target:'boundary'},{mode:'example',target:'involution'},{mode:'example',target:''}];
  const keys=[];
  for(const exploration of options){
    const id=await run.ask({...request,exploration});
    keys.push(id);
    assert.deepEqual(captured.at(-1).data.exploration,exploration);
    assert.deepEqual(run.finished.get(id).stageDecision,{state:'continue',evidence:''});
  }
  assert.equal(new Set(keys).size,options.length);
  assert.equal(await run.ask({...request,exploration:{mode:'example',target:'   '}}),keys.at(-1));
  assert.equal(captured.length,options.length);
  const previous={question:'How is that endpoint handled?',answer:'It stays in the closed interval.',exploration:options.at(-1)};
  const blankFollowup=await run.ask({...request,history:[previous],exploration:options.at(-1)});
  assert.deepEqual(run.finished.get(blankFollowup).stageDecision,{state:'continue',evidence:''});
  const {data,prompt}=captured.at(-1);
  assert.deepEqual(data.history,[previous]);
  assert.equal(data.stage.opening,stage.opening);
  const instructions=prompt.slice(0,prompt.indexOf('Source units (JSON):'));
  assert.match(instructions,/(?:latest|last|most recent|previous|preceding|prior)\s+(?:[\w’'-]+\s+){0,3}(?:answer|reply|response|explanation)\b/i);
  assert.match(instructions,/\bopening\b/i);
  const ordinary=await run.ask({...request,history:[previous]});
  assert.deepEqual(captured.at(-1).data.history,[previous]);
  assert.equal(captured.at(-1).data.exploration,undefined);
  assert.deepEqual(run.finished.get(ordinary).stageDecision,{state:'complete',evidence:message});
});

test('simplifying a packing question preserves the comparison model and carries its solved restriction into follow-up discussion',async()=>{
  const unit={title:'Packing an arriving sequence',text:'Items arrive one by one. Place each item in a bin of capacity one before seeing the next item. The objective is to minimize the number of nonempty bins. Compare with an offline packing that knows the whole sequence.'};
  const part={partId:'pack-items',title:unit.title,opening:unit.text,question:'Which sequences make the packing comparison easier?',sourceSteps:[1]};
  const target='Minimize the number of bins when each item occupies half a bin.';
  const exploration={mode:'simplify',target};
  const specialCase='Fill the current bin with two consecutive items before opening the next bin. For n items this uses the ceiling of n divided by two bins. Every bin holds at most two items, so the offline optimum needs at least as many bins. When item sizes vary, choices about which remaining spaces to fill can affect later arrivals.';
  const run=tutor(async({prompt,outputPath})=>{
    const data=JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1));
    if(data.exploration){
      assert.deepEqual(data.exploration,exploration);
      const rules=prompt.slice(0,prompt.indexOf('Source units (JSON):'));
      for(const requirement of [
        /restricted (?:version|class|family|case)[^.]*same (?:question|target|problem)/i,
        /(?:honor|use|follow)[^.]*proposed restriction/i,
        /(?:solve|derive)[^.]*restricted class/i,
        /algorithm[^.]*every (?:allowed|admissible) input[^.]*(?:guarantee|correct)/i,
        /(?:proof|mathematical) question[^.]*derivation/i,
        /(?:preserve|keep)[^.]*objective[^.]*comparison model[^.]*online information/i,
        /first (?:extra )?(?:difficulty|obstacle)[^.]*(?:lifted|removed|relaxed)/i,
      ])assert.match(rules,requirement);
      assert(prompt.includes('before seeing the next item'));
      assert(prompt.includes('offline packing that knows the whole sequence'));
    }else{
      assert.deepEqual(data.history,[{question:target,answer:specialCase,exploration}]);
    }
    await writeFile(outputPath,JSON.stringify({unit:1,answer:data.exploration?specialCase:'The capacity lower bound used the fact that all items occupy half a bin.',
      discussedSkill:'',followups:['Which lower bound changes first?'],stageDecision:{state:'continue',evidence:''}}));
  });
  const request={...question,title:'Packing half-size items',units:[unit],stage:part,question:target,exploration};
  const first=await run.ask(request);
  const result=run.finished.get(first);
  assert.equal(result.answer,specialCase);
  assert.equal(result.sourceStep,1);
  const next=await run.ask({...request,exploration:undefined,question:'Where does the lower bound first change?',
    history:[{question:target,answer:result.answer,exploration}]});
  assert.equal(run.finished.get(next).sourceStep,1);
});

test('old intuition answers remain usable as ordinary history without claiming a solved special case',()=>{
  const old={question:'Why choose the cutoff?',answer:'It makes the boundary visible.'};
  const current={question:'Solve the restricted interval.',answer:'One endpoint remains.',
    exploration:{mode:'simplify',target:'equal intervals'}};
  const legacy={...old,exploration:{mode:'intuition',target:'the boundary'}};
  const req={...question,stage,history:[legacy,current]};
  assert.deepEqual(prepareRequest(req).context.history,[old,current]);
  assert.deepEqual(legacy.exploration,{mode:'intuition',target:'the boundary'});
  assert.throws(()=>prepareRequest({...req,exploration:legacy.exploration}),{status:400});
});

test('simplifying a counting subclaim in a scheduling proof asks for its conditional implication and respects derived sets',async()=>{
  const premise='At the same observation event, U and P partition the resident jobs into unstarted and partially served jobs. Combined resident weight exceeds 15h/16. Each job weighs at most h/16. To derive a contradiction, suppose the unstarted weight is at most 7h/8.';
  const target='Restrict the counting subclaim to at most one partial job.';
  const consequence='Conditionally, the partial weight is at most h/16, so the unstarted weight exceeds 15h/16 minus h/16, or 7h/8. This contradicts the assumed upper bound. Both groups come from one event; the calculation does not construct a schedule realizing the assumptions. With more partial jobs, a bound on their combined weight is needed.';
  const run=tutor(async({prompt,outputPath})=>{
    const session=JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1));
    assert.deepEqual(session.exploration,{mode:'simplify',target});
    const rules=prompt.slice(0,prompt.indexOf('Source units (JSON):'));
    for(const requirement of [
      /(?:counting|proof) subclaim[^.]*inequality or implication/i,
      /contradiction[^.]*hypothesis[^.]*conditional conclusion/i,
      /dependencies between derived sets/i,
      /(?:check|verify)[^.]*hypotheses[^.]*before claiming[^.]*(?:feasible input|execution)/i,
      /(?:realizability|feasibility)[^.]*conditional/i,
    ])assert.match(rules,requirement);
    assert(prompt.includes(premise));
    await writeFile(outputPath,JSON.stringify({unit:1,answer:consequence,discussedSkill:'',
      followups:['When can two partial jobs coexist?'],stageDecision:{state:'continue',evidence:''}}));
  });
  const id=await run.ask({...question,title:'A snapshot in a scheduling proof',units:[{title:'Counting residents',text:premise}],
    stage:{...stage,title:'Counting residents',opening:premise},question:target,exploration:{mode:'simplify',target}});
  assert.equal(run.finished.get(id).answer,consequence);
  assert.equal(run.finished.get(id).sourceStep,1);
});

test('a checkpoint grades the reader’s proposed reasoning against this part’s own question without advancing it',async()=>{
  const part={partId:'exchange',title:'Substitute the first activity',sourceSteps:[1],
    opening:'After cleanup the greedy first activity releases the machine no later than the optimal first activity.',
    question:'What keeps the next activity feasible after swapping the first one?'};
  const sourceText='Let O and G denote the old and new first activities. Their release-ready times satisfy a_G ≤ a_O. The next activity starts at or after a_O, so it starts at or after a_G.';
  const proposed='The next activity starts after the old ready time, and the new ready time is no later.';
  const feedback='Your comparison is in the right direction. More precisely, the next activity can start exactly at the old ready time as well.';
  const body={...question,stage:part,question:proposed,units:[{title:part.title,text:sourceText}]};
  const checkpoint={...body,checkpoint:true};
  assert.equal(prepareRequest(checkpoint).context.checkpoint,true);
  assert.deepEqual(prepareRequest({...body,checkpoint:false}).context,prepareRequest(body).context);
  for(const invalid of [{...question,checkpoint:true},{...question,scope:'paper',step:0,checkpoint:true},
    {...body,checkpoint:'true'}, {...body,checkpoint:{answer:proposed}},
    {...checkpoint,exploration:{mode:'simplify',target:''}}]){
    assert.throws(()=>prepareRequest(invalid),{status:400});
  }
  const captured=[];
  const run=tutor(async({prompt,outputPath})=>{
    const data=JSON.parse(prompt.split('Session data (JSON):\n\n').at(-1));
    captured.push(data);
    if(data.checkpoint){
      assert.equal(data.stage.question,part.question);
      assert.equal(data.question,proposed);
      const rules=prompt.split('\n\n').find(block=>/checkpoint/i.test(block) && /proposed answer|attempted answer/i.test(block)) || '';
      assert.match(rules,/stage\.question/);
      assert.match(rules,/valid inference|correct (?:idea|step|reasoning)/i);
      assert.match(rules,/(?:feedback|respond to (?:the|their|the reader.s) reasoning)/i);
      assert.match(rules,/(?:brief|concise|short)/i);
      assert.match(rules,/(?:gap|mistake|incorrect|missing|correction|improve)/i);
      assert(prompt.includes(sourceText));
    }else if(data.history.some(exchange=>exchange.checkpoint)){
      assert.match(prompt,/earlier exchanges marked checkpoint[^.]*reader.s own proposed answer[^.]*tutor.s feedback/i);
    }
    await writeFile(outputPath,JSON.stringify({unit:1,answer:data.checkpoint?feedback:'The next start can equal the old ready time.',
      discussedSkill:'',followups:data.checkpoint?[]:['What if the two ready times agree?'],stageDecision:{state:'complete',evidence:data.question}}));
  });
  const id=await run.ask(checkpoint);
  assert.equal(run.finished.get(id).answer,feedback);
  assert.deepEqual(run.finished.get(id).followups,[]);
  assert.deepEqual(run.finished.get(id).stageDecision,{state:'continue',evidence:''});
  assert.equal(await run.ask(checkpoint),id);
  const regular=await run.ask(body);
  assert.notEqual(regular,id);
  assert.equal(captured.at(-1).checkpoint,undefined);
  assert.deepEqual(run.finished.get(regular).stageDecision,{state:'complete',evidence:proposed});
  const history=[{checkpoint:true,question:proposed,answer:feedback}];
  await run.ask({...body,question:'Could the two activities meet exactly?',history});
  assert.deepEqual(captured.at(-1).history,history);
});

test('an exploration uses visible discussion for its target and ordinary feedback follow-ups keep complete history',async()=>{
  const visible={question:'Why introduce the cutoff?',answer:'The cutoff restricts the interval to feasible starts.'};
  const feedback={question:'I think the cutoff keeps the endpoint.',answer:'Check which endpoint is included.',checkpoint:true};
  const legacy={question:stage.question,answer:'An earlier optional quiz discussed a different boundary.'};
  const history=[visible,feedback,legacy];
  const run=tutor();
  const body={...question,stage,history};
  for(const target of ['', 'the cutoff']){
    await run.ask({...body,exploration:{mode:'simplify',target}});
    assert.deepEqual(run.prompts.at(-1).history,[visible]);
  }
  await run.ask({...body,history:[feedback,legacy],exploration:{mode:'example',target:''}});
  assert.deepEqual(run.prompts.at(-1).history,[]);
  assert.equal(run.prompts.at(-1).stage.opening,stage.opening);
  await run.ask(body);
  assert.deepEqual(run.prompts.at(-1).history,history);
  await run.ask({...body,checkpoint:true});
  assert.deepEqual(run.prompts.at(-1).history,history);
});

test('ordinary answers hide copies of the optional checkpoint even when it was the only suggested follow-up',async()=>{
  const echo='  WHAT   makes this substitution VALID ?!  ';
  const alternative='Which alternative substitution would change the boundary?';
  let alone=true;
  const run=tutor(async({outputPath})=>{
    await writeFile(outputPath,JSON.stringify({unit:1,answer:'The endpoint stays in the interval.',
      followups:alone?[echo]:[echo,alternative],discussedSkill:'',stageDecision:{state:'continue',evidence:''}}));
  });
  const first=await run.ask({...question,stage,question:'How does the boundary move?'});
  assert.equal(run.finished.get(first).answer,'The endpoint stays in the interval.');
  assert.deepEqual(run.finished.get(first).followups,[]);
  alone=false;
  const second=await run.ask({...question,stage,question:'Does the conclusion extend to another interval?'});
  assert.deepEqual(run.finished.get(second).followups,[alternative]);
});

test('a question in the preferred notation retrieves the original definition and uses a separate cached edition', async () => {
  const {notationRevision} = require('./notation-adaptation.cjs');
  const {evidenceOrder} = require('./ask-paper.cjs');
  const {sectionRequest} = require('./section-guides.cjs');
  const quote='T denotes the common deadline.';
  const units=[{title:'Start',text:'A job is released today.'},{title:'Time bound',text:quote}];
  const request={title:'Jobs with a common deadline',scope:'paper',question:'What is D in the original?',units,mathFormat:'latex'};
  const notationEdition={revision:notationRevision,referenceTitle:'Deadlines in discrete time',
    mappings:[{concept:'common deadline',original:'T',preferred:'D',partIds:['time'],sourceStep:2,sourceQuote:quote,
      referenceStep:1,referenceQuote:'D denotes the common deadline.'}],
    parts:[{id:'time',title:'The common deadline',reading:'Finish every job by the common deadline \\(D\\).',sourceStep:2,sourceQuote:quote}],
    overview:{paragraphs:['A common deadline bounds every completion time.','Compare each completion with the same bound.'],
      suggestions:[{question:'How does the deadline bound each job?',step:2},{question:'When would a job be late?',step:2}]}};
  const input=prepareRequest({...request,notationEdition});
  assert.equal(evidenceOrder(input.units,input.context)[0].step,2);
  const stage={partId:'time',title:'The common deadline',sourceSteps:[2],opening:'Inspect the time bound.',question:'Which job is late?'};
  const sectionBody={...request,stage,studyKey:'same-plan',analysisKey:'same-analysis'};
  assert.notEqual(sectionRequest(sectionBody).key,sectionRequest({...sectionBody,notationEdition}).key);
  assert.throws(()=>prepareRequest({...request,notationEdition,units:[units[0],{title:'Another paper',text:'The machine never works.'}]}),{status:400});
  const prompts=[];
  const run=tutor(async({prompt,outputPath})=>{
    prompts.push(prompt);
    const response={unit:2,answer:'The deadline is the latest allowed completion time.',followups:['What if a job finishes exactly at the deadline?'],discussedSkill:''};
    await writeFile(outputPath,JSON.stringify(response));
  });
  const standard=await run.ask(request), adapted=await run.ask({...request,notationEdition});
  assert.notEqual(standard,adapted);
  assert.equal(await run.ask({...request,notationEdition}),adapted);
  assert.ok(!prompts[0].includes(notationEdition.referenceTitle));
  assert.ok(prompts[1].includes(notationEdition.referenceTitle));
  assert.ok(prompts[1].includes(quote));
  assert.equal(run.finished.get(adapted).sourceStep,2);
});
