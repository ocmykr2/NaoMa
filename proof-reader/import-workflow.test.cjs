const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const {editorialRevision} = require('./part-orientation.js');

const filename = 'scanner-export-009.pdf';
const printedTitle = 'A Recurrence for Counting Paths';
const bytes = Buffer.from('%PDF synthetic unit-test fixture with no external or private data');
const hash = createHash('sha256').update(bytes).digest('hex');
const pages = [printedTitle + '\nAbstract\nThe opening passage is intentionally different from the reviewed overview.\nLemma 1 (Last edge). In a finite directed acyclic graph, the nonempty directed paths to a vertex are partitioned by their last edge.'];
const paragraphs = ['The reviewed overview describes the path-counting problem.', 'The proof partitions paths by their last edge.'];
const alphabet = {id:'path-language',title:'Directed paths',steps:[1],
  selfCheck:{question:'Can a directed edge from A to B alone take you from B to A?',answer:'No. Traversing from B to A requires an edge oriented from B to A.'},
  definitions:[{term:'Directed edge',meaning:'A link with a specified starting vertex and ending vertex.'},
    {term:'Directed path',meaning:'A sequence following the orientation of each successive edge.'}]};
const decomposition = {id:'partition',name:'Partition into disjoint cases',steps:[1],folklore:true,sources:[],
  mechanism:'Split a set into groups by a property that every member has exactly once.',
  knownBridge:'Here every nonempty path has one last edge.'};
const planParts = [
  {id:'split',title:'Partition the paths',summary:'Separate paths by their last edge.',sourceSteps:[1],
    techniqueIds:['partition'],definitionGroupIds:['path-language'],localPrerequisiteIds:[]},
  {id:'sum',title:'Add the contributions',summary:'Sum the sizes of the disjoint classes.',sourceSteps:[1],
    techniqueIds:[],definitionGroupIds:[],localPrerequisiteIds:['last-edge']}
];
const introduction = {id:'last-edge',title:'Last-edge partition',meaning:'Paths ending at v fall into disjoint classes indexed by their last edge.',kind:'lemma',originPartId:'split'};
const ready = {status:'ready', key:'job-1', displayTitle:printedTitle, preparationVersion:2,
  message:'No earlier primary-source comparison was verified for this short example.',
  papers:[], skills:[], knowledge:{techniques:[decomposition],definitionGroups:[alphabet]},
  parts:planParts,localIntroductions:[introduction],
  overview:{paragraphs,suggestions:[{question:'How does the last edge determine the recurrence?',step:1},
    {question:'Which paths form the base case?',step:1}]}};
const oldBrief = 'This retired quick brief must stay hidden.';
const oldSummary = 'This overview was prepared before verified titles were returned.';
const splitGuide = {introduction:'A vertex may have several predecessors. Classifying paths by their final edge lets us count each one exactly once.',
  notation:[{symbol:'v',meaning:'The vertex where the path ends.'},{symbol:'e',meaning:'An edge directed into the final vertex.'}],
  definitions:[{name:'Directed edge',text:alphabet.definitions[0].meaning,intuition:'An arrow records which endpoint comes first.'},
    {name:'Directed path',text:alphabet.definitions[1].meaning}],
  formalAfter:1,
  paragraphs:['Fix the vertex where the paths end and call it \\(v\\). Each nonempty path reaches \\(v\\) through one last incoming edge, which we call \\(e\\).',
    'The choice of \\(e\\) puts the path into exactly one class. Two different final edges cannot describe the same path.'],
  handoff:'The recurrence will add the sizes of these classes.',
  statement:{kind:'Lemma', label:'Lemma 1 (Last edge)', text:'In a finite directed acyclic graph, the nonempty directed paths to a vertex are partitioned by their last edge.'}};
const sumGuide = {introduction:'The classes built in the previous part give a way to count paths from smaller counts.',
  notation:[],definitions:[],
  paragraphs:['Remove the last edge of a path. The remaining path ends at the other endpoint of that edge.',
    'Conversely, appending that edge extends each such path exactly once. Add the counts over the incoming edges.'],
  handoff:'Together with the base case, this gives the path-counting recurrence.',statement:null};
const personalized = {status:'ready',key:'plan-1',editorialRevision,parts:[
  {id:'split',title:'Partition the paths',sourceSteps:[1],opening:'Use the partition argument you know to track the last edge.',question:'Can a nonempty path have two last edges?',orientation:splitGuide},
  {id:'sum',title:'Add the contributions',sourceSteps:[1],opening:'Use the last-edge partition to count every path once.',question:'Why can we add the class sizes?',orientation:sumGuide}
]};

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise,resolve};
}

function storage() {
  const data = new Map();
  return {
    get length(){return data.size;},
    key:index=>[...data.keys()][index] ?? null,
    getItem:key => data.get(key) ?? null,
    setItem:(key,value) => data.set(key,String(value)),
    removeItem:key => data.delete(key)
  };
}

// Implement only the DOM operations used by the shell, picker and overview.
// Reading the actual HTML keeps this harness sensitive to changed IDs and nesting.
class Element extends EventTarget {
  constructor(tag,document) {
    super();
    Object.assign(this,{tagName:tag.toUpperCase(),document,children:[],dataset:{},className:'',value:'',hidden:false});
    this.classList = {
      add:(...names) => { this.className=[...new Set([...this.className.split(/\s+/),...names])].filter(Boolean).join(' '); },
      remove:(...names) => { this.className=this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
      contains:name => this.className.split(/\s+/).includes(name)
    };
    this.classList.toggle=(name,on=!this.classList.contains(name)) => {
      if (on) this.classList.add(name); else this.classList.remove(name);
      return on;
    };
  }
  set textContent(value) { this.replaceChildren(String(value ?? '')); }
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
  get childElementCount() { return this.children.filter(c => c instanceof Element).length; }
  get firstElementChild() { return this.children.find(c => c instanceof Element); }
  append(...items) {
    for (const item of items) {
      if (item instanceof Element) item.parentElement = this;
      this.children.push(item);
    }
    this.document?.onChange?.(this);
  }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() {
    if (this.parentElement) this.parentElement.children=this.parentElement.children.filter(child=>child!==this);
    this.parentElement=null;
  }
  setAttribute(name,value) { this[name] = String(value); }
  getAttribute(name) { return this[name] ?? null; }
  removeAttribute(name) { delete this[name]; }
  focus() { this.document.activeElement = this; }
  click() {
    if (this.dispatchEvent(new Event('click',{cancelable:true})) && this.tagName==='SUMMARY' && this.parentElement?.tagName==='DETAILS') {
      this.parentElement.open=!this.parentElement.open;
    }
  }
  scrollIntoView() {}
  contains(node) {
    for (; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  showModal() { this.open = true; }
  close() {
    if (this.open) { this.open = false; this.dispatchEvent(new Event('close')); }
  }
  matches(selector) {
    return selector.startsWith('.') ? this.className.split(/\s+/).includes(selector.slice(1)) :
      selector.startsWith('#') ? this.id === selector.slice(1) : this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  querySelectorAll(selector) {
    return this.children.filter(c => c instanceof Element).flatMap(c =>
      [...(c.matches(selector) ? [c] : []),...c.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function documentFixture() {
  const document = new EventTarget();
  const ids = new Map();
  document.createElement = tag => new Element(tag,document);
  document.createTextNode = String;
  document.body = document.createElement('body');
  const parents = [document.body];
  const markup = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const [,bodyAttrs,html] = markup.match(/<body([^>]*)>([\s\S]*)<\/body>/);
  const initialState = bodyAttrs.match(/data-paper-state="([^"]*)"/);
  if (initialState) document.body.dataset.paperState = initialState[1];
  for (const part of html.matchAll(/<\/?[\w-]+[^>]*>|[^<]+/g)) {
    const token = part[0], parent = parents.at(-1);
    if (!token.startsWith('<')) { parent.append(token); continue; }
    if (token.startsWith('</')) { parents.pop(); continue; }
    const [,tag,attrs] = token.match(/^<([\w-]+)([^>]*)>/);
    const item = document.createElement(tag);
    for (const m of attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      const [,name,value] = m;
      item[name === 'class' ? 'className' : name] = value ?? true;
    }
    if (item.id) ids.set(item.id,item);
    parent.append(item);
    if (!['input','br','hr','img','source','wbr'].includes(tag)) parents.push(item);
  }
  document.getElementById = id => ids.get(id) || document.body.querySelector('#'+id);
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  return document;
}

function libraryFixture(records = new Map()) {
  // Run the actual library code, including its catalog projection on a cold launch.
  // Simulate only the ordered key-value requests that its IndexedDB transactions use.
  const stores = new Map([['sources',new Map(records)],['catalog',new Map()]]);
  for (const [key,{name,title}] of records) stores.get('catalog').set(key,{hash:key,name,title,savedAt:0});
  const db = {
    close() {},
    objectStoreNames:{contains:name => stores.has(name)},
    createObjectStore(name) { stores.set(name,new Map()); },
    transaction() {
      const queue = [];
      const tx = {objectStore(name) {
        const store = stores.get(name);
        function request(run) {
          const result = {};
          queue.push(() => { result.result=structuredClone(run()); result.onsuccess?.(); });
          return result;
        }
        return {
          get:key => request(() => store.get(key)),
          getAll:() => request(() => [...store.values()]),
          delete:key => request(() => { store.delete(key); }),
          put:record => request(() => { store.set(record.hash,structuredClone(record)); return record.hash; })
        };
      }};
      queueMicrotask(() => {
        try { while (queue.length) queue.shift()(); tx.oncomplete(); }
        catch (error) { tx.error=error; tx.onabort(); }
      });
      return tx;
    },
  };
  const indexedDB = {open() {
    const request={result:db};
    queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess(); });
    return request;
  }};
  const window={indexedDB};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'paper-library.js'),'utf8'),{window,indexedDB,structuredClone,Blob});
  return {...window.PAPER_LIBRARY,indexedDB};
}

function createApp({local = storage(),library = libraryFixture(),search = '',post = [],poll = [],plans = [],diagnostics = [],structures = [],answers = [],removals = [],extractedPages = pages} = {}) {
  const document = documentFixture(), window = new EventTarget();
  const location = new URL('http://fixture.invalid/'+search);
  const calls = [], titles = [];
  const el = id => document.getElementById(id);
  document.onChange = node => { if (node.id === 'paperTitle') titles.push(node.textContent); };
  const json = body => ({ok:true,json:async () => body});
  async function fetch(url,args = {}) {
    calls.push({url,method:args.method || 'GET',body:args.body});
    if (url === '/api/pdf') return json({pages:extractedPages});
    if (url === '/api/techniques' && post.length) return json(await post.shift());
    if (url.startsWith('/api/techniques/') && poll.length) return json(await poll.shift());
    if (url.endsWith('/diagnostics')) {
      const report=await diagnostics.shift();
      if (report?.unreachable) throw Error('fixture disconnected');
      return report ? json(report) : {ok:false,status:404,json:async()=>({})};
    }
    if (url.startsWith('/api/reading-plan') && plans.length) return json(await plans.shift());
    if (url==='/api/paper-cache/clear' && removals.length) {
      const status=await removals.shift();
      return status===200?json({cleared:true}):{ok:false,status,json:async()=>({error:'This paper still has a preparation in progress.'})};
    }
    if (url.startsWith('/api/section-structure')) return json(structures.length ? await structures.shift() : {status:'error'});
    if (url.startsWith('/api/paper-question') && answers.length) return json(await answers.shift());
    if (url.startsWith('/api/paper-question')) return json({status:'error',message:'Unexpected parallel brief'});
    throw new Error('Unexpected request in offline test: '+url);
  }
  class FileReader {
    async readAsDataURL(blob) {
      this.result='data:application/pdf;base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');
      this.onload();
    }
  }
  function Option(text,value) {
    const item = document.createElement('option');
    item.value = value; item.textContent = text;
    return item;
  }
  const push = (_state,_title,url) => { location.href = new URL(url,location).href; };
  window.scrollTo = () => {};
  const globals = {window,document,location,history:{pushState:push,replaceState:push},localStorage:local,
    sessionStorage:storage(),indexedDB:library.indexedDB,URL,URLSearchParams,Event,CustomEvent,FileReader,Blob,Option,TextEncoder,structuredClone,
    crypto:webcrypto,fetch,setTimeout:(fn,delay) => delay>=9000 ? setTimeout(fn,delay).unref() : setTimeout(fn,1),clearTimeout,console};
  Object.assign(window,globals);
  const context = vm.createContext(globals);
  function load(file) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context,{filename:file});
  }
  const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  for (const [,file] of html.matchAll(/<script\b[^>]*src="([^"]+)"/g)) {
    if (['katex.min.js','reader-math.js','page-view.js'].includes(file)) continue;
    if (file === 'app.js') {
      Object.assign(window.PDF_READER,{save:async () => {},restore:async () => null});
    }
    load(file);
  }
  return {el,body:document.body,window,local,library,calls,titles,
    fire:(id,type) => el(id).dispatchEvent(new Event(type)),
    choose(value) { el('paperPicker').value=value; el('paperPicker').dispatchEvent(new Event('change')); }
  };
}

async function until(check,message) {
  for (let i=0; i<200; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r,2));
  }
  assert.fail(message);
}
const importedChoice = 'doc-'+hash;
const fullPosts = app => app.calls.filter(c => c.url === '/api/techniques' && c.method === 'POST');
const quickCalls = app => app.calls.filter(c => c.url.startsWith('/api/paper-question'));

function styledPlan(referenceTitle) {
  return {...personalized,key:'plan-in-reference-notation',notationEdition:{revision:'paper-notation-1',referenceTitle,
    mappings:[{concept:'The terminal vertex',original:'v',preferred:'u',partIds:['split','sum'],sourceStep:1,sourceQuote:'paths to a vertex',
      referenceStep:1,referenceQuote:'terminal vertex'}],
    overview:{paragraphs:['Fix the terminal vertex \\(u\\). Every nonempty path to it has a last edge.'],
      suggestions:[{question:'Which edge ends at \\(u\\)?',step:1}]},
    parts:personalized.parts.map((p,i)=>({id:p.id,title:i?p.title:'Partition the paths to \\(u\\)',reading:p.opening,sourceStep:1,sourceQuote:'paths to a vertex'}))}};
}

test('choose a library paper in Background, use its notation in the reader, and return to either saved edition',async()=>{
  const title='Counting walks',text='Write u for the terminal vertex of a walk.';
  const refHash=createHash('sha256').update(text).digest('hex');
  const library=libraryFixture(new Map([[refHash,{hash:refHash,name:'walks.tex',text,title}]]));
  await library.renameTitle(refHash,title);
  const phase=deferred(),finish=deferred(),local=storage();
  const app=createApp({local,library,post:[ready],plans:[personalized,phase.promise,finish.promise]});
  const posts=()=>app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST');
  await openPdf(app);
  await checkPublished(app);
  assert.equal(app.el('notationChoice').value,'');
  assert.ok(app.el('notationChoice').options.some(o=>o.value===refHash && o.textContent===title));
  assert.ok(!app.el('notationChoice').options.some(o=>o.value===hash));
  app.fire('continuePreflight','click');
  await until(()=>app.el('overviewPanel').hidden===false,'original plan did not open');
  assert.equal(JSON.parse(posts()[0].body).notationReference,undefined);
  const edit=a=>{a.fire('profileButton','click'); a.fire('editNotation','click');};
  function select(a,key){a.el('notationChoice').value=key; a.fire('notationChoice','change');}
  edit(app);
  select(app,refHash);
  await until(()=>!app.el('continuePreflight').disabled,'reference did not load');
  app.fire('continuePreflight','click');
  await until(()=>posts().length===2,'adapted plan was not requested');
  const body=JSON.parse(posts()[1].body);
  assert.deepEqual(body.notationReference,{title,units:[{title:'Passage 1',text}]});
  assert.equal(fullPosts(app).length,1);
  phase.resolve({status:'running',key:'plan-in-reference-notation',progress:{stage:'adapting-notation',totalParts:2,completedParts:0}});
  await until(()=>app.el('paperStateMessage').textContent.includes('Matching symbols'),'reference progress missing');
  assert.ok(app.el('overviewPanel').hidden);
  finish.resolve(styledPlan(title));
  await until(()=>app.el('overviewPanel').textContent.includes('Fix the terminal vertex'),'adapted overview missing');
  app.fire('readCurrentPart','click');
  assert.equal(app.el('stageTitle').textContent,'Partition the paths to \\(u\\)');
  app.fire('profileButton','click');
  assert.ok(app.el('notationMappings').textContent.includes('\\(v\\) in the original'));
  assert.ok(app.el('notationName').textContent.includes(title));
  app.fire('editNotation','click');
  assert.equal(app.el('notationChoice').value,refHash);
  select(app,'');app.fire('continuePreflight','click');
  await until(()=>app.el('stageTitle').textContent==='Partition the paths','baseline guide was not restored');
  assert.equal(posts().length,2);
  const reopened=createApp({local,library,search:'?paper='+importedChoice});
  await until(()=>reopened.body.dataset.paperState===undefined,'saved paper did not reopen');
  edit(reopened); select(reopened,refHash);
  await until(()=>!reopened.el('continuePreflight').disabled,'saved ref did not load');
  reopened.fire('continuePreflight','click');
  await until(()=>reopened.window.READER_SESSION.session(hash).study.key==='plan-in-reference-notation','earlier edition was not restored');
  assert.ok(!reopened.calls.some(c=>c.method==='POST' && c.url==='/api/reading-plan'));
});

test('reference upload and pasted LaTeX work during familiarity selection, including a scan with empty extraction',async()=>{
  const referenceText='Write \\(u\\) for the terminal vertex and \\(E\\) for the edge set.';
  const app=createApp({post:[ready],plans:[styledPlan('Graph notation')],extractedPages:['']});
  await openPdf(app); await checkPublished(app);
  const choice=app.el('notationChoice'),submit=app.el('continuePreflight');
  choice.value='upload';app.fire('notationChoice','change');
  assert.equal(submit.disabled,true);
  app.el('notationFile').files=[new File(['%PDF reference'], 'reference.pdf',{type:'application/pdf'})];
  app.fire('notationFile','change');
  await until(()=>app.el('notationStatus').textContent.includes('Paste a passage'),'empty scan was accepted');
  assert.equal(submit.disabled,true);
  app.el('notationFile').files=[new File([referenceText],'conventions.tex',{type:'text/plain'})];
  app.fire('notationFile','change');
  await until(()=>!submit.disabled,'readable local reference was rejected');
  choice.value='paste';app.fire('notationChoice','change');
  assert.equal(submit.disabled,true);
  app.el('notationTitle').value='Graph notation';
  app.el('notationExcerpt').value=referenceText;app.fire('notationExcerpt','input');
  assert.equal(submit.disabled,false);
  app.fire('continuePreflight','click');
  await until(()=>app.el('overviewPanel').textContent.includes('Fix the terminal vertex'),'pasted notation failed to open');
  assert.equal(fullPosts(app).length,1);
  const submitted=JSON.parse(app.calls.find(c=>c.method==='POST' && c.url==='/api/reading-plan').body);
  assert.equal(submitted.notationReference.units[0].text,referenceText);
  assert.equal(submitted.notationReference.title,'Graph notation');
});

test('a PDF reference preserves page locators and a failed adaptation can be changed back to the original',async()=>{
  const referencePages=['Graph conventions','The letter u denotes the terminal vertex.'];
  const app=createApp({post:[ready],plans:[{status:'error',needsAction:true,actionRequired:'reference',message:'Select a readable copy of the reference paper.'},personalized],extractedPages:referencePages});
  await openPdf(app); await checkPublished(app);
  app.el('notationChoice').value='upload';app.fire('notationChoice','change');
  app.el('notationFile').files=[new File(['%PDF conventions'], 'conventions.pdf',{type:'application/pdf'})];
  app.fire('notationFile','change');
  await until(()=>!app.el('continuePreflight').disabled,'reference PDF could not be selected');
  app.fire('continuePreflight','click');
  await until(()=>app.body.dataset.paperState==='failed','adaptation failure was not shown');
  const posts=()=>app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST');
  const sent=JSON.parse(posts()[0].body).notationReference;
  assert.deepEqual(sent.units,referencePages.map((text,i)=>({page:i+1,title:'Page '+(i+1),text})));
  assert.equal(sent.pdfBase64,Buffer.from('%PDF conventions').toString('base64'));
  assert.ok(!app.el('changeFailedNotation').hidden);
  app.fire('changeFailedNotation','click');
  assert.ok(app.el('notationChoice').value);
  app.el('notationChoice').value='';app.fire('notationChoice','change');
  app.fire('continuePreflight','click');
  await until(()=>app.body.dataset.paperState===undefined,'could not switch to source notation after an error');
  assert.equal(JSON.parse(posts()[1].body).notationReference,undefined);
  assert.equal(fullPosts(app).length,1);
});

test('the bundled catalog covers every source unit and points back to the part that introduces each local prerequisite',() => {
  const window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'paper-knowledge-data.js'),'utf8'),{window});
  for (const [key,catalog] of Object.entries(window.PAPER_KNOWLEDGE_DATA)) {
    const {parts,localIntroductions,techniques,definitionGroups}=catalog;
    const partIndex=new Map(parts.map((part,i)=>[part.id,i]));
    const byId=new Map(localIntroductions.map(item=>[item.id,item]));
    const sourceCount=3;
    assert.equal(partIndex.size,parts.length);
    assert.equal(byId.size,localIntroductions.length);
    const covered=[...new Set(parts.flatMap(part=>part.sourceSteps))].sort((a,b)=>a-b);
    assert.deepEqual(covered,Array.from({length:sourceCount},(_,i)=>i+1));
    for (const local of localIntroductions) {
      assert.ok(partIndex.has(local.originPartId));
      assert.ok(local.meaning.trim() && ['lemma','technique','definition'].includes(local.kind));
    }
    for (const [index,part] of parts.entries()) {
      const orientation=require('./part-orientation.js').normalize(part.orientation);
      assert.ok(orientation,'missing orientation in '+key+'/'+part.id);
      assert.equal(orientation.statement,null);
      for (const id of part.localPrerequisiteIds) assert.ok(partIndex.get(byId.get(id)?.originPartId)<index);
      for (const id of part.definitionGroupIds) assert.ok(definitionGroups.some(g=>g.id===id));
      for (const id of part.techniqueIds) assert.ok(techniques.some(t=>t.id===id));
    }
  }
});

async function confirmPdfUpload(app,{prepare=true,file=new File([bytes],filename,{type:'application/pdf'})} = {}) {
  const previous=app.calls.filter(c=>c.url==='/api/pdf').length;
  app.fire('openImport','click');
  app.el('paperFile').files = [file];
  app.fire('paperFile','change');
  await until(() => !app.el('confirmImport').disabled && app.calls.filter(c=>c.url==='/api/pdf').length>previous,'PDF extraction stalled');
  app.el('researchOnImport').checked=prepare;
  app.fire('confirmImport','click');
  await until(()=>!app.el('uploadDialog').open,'the import dialog did not finish');
}

async function openPdf(app,{prepare=true,file} = {}) {
  await until(() => app.body.dataset.paperState==='preflight','bundled paper checklist did not open');
  await confirmPdfUpload(app,{prepare,file});
  if (prepare) await until(() => fullPosts(app).length > 0,'full-paper research did not start');
  else await until(() => app.body.dataset.paperState==='source-only','original-only mode did not open');
}

function checkWaiting(app) {
  assert.equal(app.body.dataset.paperState,'preparing');
  assert.equal(app.el('paperStatePanel').hidden,false);
  assert.equal(app.el('overviewPanel').hidden,true);
  assert.equal(app.el('stepSheet').hidden,true);
  assert.ok(!app.el('paperTitle').textContent.includes('scanner-export'));
  assert.doesNotMatch(app.el('paperPicker').options.find(o => o.value === importedChoice)?.textContent || '',/scanner-export/i);
  assert.ok(!app.el('overviewBody').textContent.includes(oldBrief));
  assert.ok(!app.el('overviewBody').textContent.includes(oldSummary));
  assert.equal(quickCalls(app).length,0);
}

async function checkPublished(app) {
  await until(() => app.body.dataset.paperState==='preflight' && app.el('paperPicker').value===importedChoice,'prepared paper did not reach its checklist');
  assert.equal(app.el('overviewPanel').hidden,true);
  assert.ok(app.el('preflightKnowledge').textContent.includes(alphabet.title));
  assert.ok(!app.el('preflightKnowledge').textContent.includes(introduction.title));
  assert.ok(app.el('preflightKnowledge').textContent.includes(decomposition.mechanism));
  assert.ok(!app.el('preflightKnowledge').textContent.includes(decomposition.knownBridge));
  assert.equal(app.el('paperPicker').options.find(o => o.value === importedChoice)?.textContent,printedTitle);
  assert.ok(app.titles.every(t => !/scanner-export|Imported PDF/i.test(t)),'filename briefly appeared as the paper title');
  assert.equal(quickCalls(app).length,0);
}

test('an imported PDF reaches the prerequisite checklist with its verified title and reopens without new research',async () => {
  const done = deferred();
  const app = createApp({post:[{status:'running',key:'job-1'}],poll:[done.promise]});
  await openPdf(app);
  checkWaiting(app);
  assert.match(app.el('preparationEstimate').textContent,/About \d+–\d+ minutes until the background choices/);
  assert.ok(Number.isFinite(app.window.READER_SESSION.session(hash).research.startedAt));
  assert.ok(!app.el('overviewBody').textContent.includes('opening passage is intentionally different'));
  assert.equal(fullPosts(app).length,1);
  done.resolve(ready);
  await checkPublished(app);
  await until(async () => (await app.library.get(hash)).preparedTitle===printedTitle,'verified library title was not saved');
  const reopened = createApp({local:app.local,library:app.library,search:'?paper='+importedChoice});
  await checkPublished(reopened);
  assert.equal(fullPosts(reopened).length,0);
  const fromLibrary = createApp({library:app.library,search:'?paper='+importedChoice});
  await checkPublished(fromLibrary);
  assert.equal(fullPosts(fromLibrary).length,0);
  const otherPaper = createApp({library:app.library,search:'?paper=intervals'});
  await until(() => otherPaper.body.dataset.paperState==='preflight','previously selected bundled paper did not open');
  const savedOption = otherPaper.el('paperPicker').options.find(o => o.value===importedChoice);
  assert.equal(savedOption?.textContent,printedTitle,'cold picker lost the verified title for an unselected import');
});

test('uploading the same PDF again asks for familiarity and notation even when its plan is already open',async()=>{
  const app=createApp({post:[ready,ready],plans:[personalized,styledPlan('Reference notation')]});
  await openPdf(app);
  await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>!app.el('overviewPanel').hidden,'the initial plan did not open');
  const planPosts=()=>app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST');
  assert.equal(planPosts().length,1);
  app.choose('intervals');
  await until(()=>app.el('paperPicker').value==='intervals' && app.body.dataset.paperState==='preflight','could not switch papers');
  app.choose(importedChoice);
  await until(()=>app.el('paperPicker').value===importedChoice && !app.el('overviewPanel').hidden,'the library should reopen the saved plan');
  assert.equal(planPosts().length,1);

  await confirmPdfUpload(app);
  await checkPublished(app);
  const refresh=createApp({local:app.local,library:app.library,search:'?paper='+importedChoice});
  await checkPublished(refresh);
  assert.ok(refresh.calls.every(c=>!c.url.startsWith('/api/reading-plan')),'refresh must preserve the pending choice');
  const technique=app.el('preflightKnowledge').querySelectorAll('input').find(i=>i.getAttribute('aria-label')==='I know '+decomposition.name);
  assert.ok(technique);
  technique.checked=true;technique.dispatchEvent(new Event('change'));
  const notation=app.el('notationChoice');
  assert.ok(notation.options.some(option=>option.value==='paste'));
  notation.value='paste';app.fire('notationChoice','change');
  app.el('notationTitle').value='Reference notation';
  app.el('notationExcerpt').value='We write u for the vertex at which a path ends.';app.fire('notationExcerpt','input');
  assert.equal(planPosts().length,1,'uploading or editing choices should not start personalization');
  app.fire('continuePreflight','click');
  await until(()=>!app.el('overviewPanel').hidden && planPosts().length===2,'the confirmed choices did not produce the new reading plan');
  const body=JSON.parse(planPosts()[1].body);
  assert.equal(body.notationReference.title,'Reference notation');
  assert.deepEqual(body.readerKnowledge.techniques.map(t=>t.name),[decomposition.name]);
});

test('a reimport after clearing the catalog cannot bypass background selection using an orphaned study archive',async()=>{
  const previous=createApp({post:[ready],plans:[styledPlan('Prior notation')]});
  await openPdf(previous);
  await checkPublished(previous);
  previous.el('notationChoice').value='paste';previous.fire('notationChoice','change');
  previous.el('notationTitle').value='Prior notation';
  previous.el('notationExcerpt').value='Write u for the terminal vertex of a path.';previous.fire('notationExcerpt','input');
  previous.fire('continuePreflight','click');
  await until(()=>!previous.el('overviewPanel').hidden,'the first reading session did not open');
  const old=await previous.library.getPreparation('study/'+hash);
  assert.equal(old.study.status,'ready');
  assert.equal(old.study.notationReference.title,'Prior notation');
  // Reproduce the old reset. The PDF and its analysis are gone, but a separate
  // IndexedDB record still contains its ready plan for the same analysis key.
  for (const staleTab of [false,true]) {
    const library=libraryFixture();
    await library.savePreparation('study/'+hash,old);
    const fresh=deferred();
    const app=createApp({library,post:[fresh.promise],plans:[personalized]});
    if (staleTab) {
      app.local.setItem('proof.study.'+hash,JSON.stringify(old));
      app.window.sessionStorage.setItem('proof.study.'+hash,JSON.stringify(old));
    }
    await openPdf(app);
    checkWaiting(app);
    fresh.resolve(ready);
    await checkPublished(app);
    assert.ok(app.el('notationChoice').options.some(option=>option.value==='upload'));
    assert.equal(app.el('notationChoice').value,'','a forgotten style must not be silently preselected');
    assert.ok(app.calls.every(c=>!c.url.startsWith('/api/reading-plan')),'no old study should be resumed before confirmation');
    assert.ok(!app.titles.includes(printedTitle),'old reading content flashed before the checklist');
    app.fire('continuePreflight','click');
    await until(()=>!app.el('overviewPanel').hidden,'confirmation did not open the plan');
  }
});

test('a saved study cannot replace a newer outline with the same analysis key when opened from the library',async()=>{
  const old=createApp({post:[ready],plans:[personalized]});
  await openPdf(old);
  await checkPublished(old);
  old.fire('continuePreflight','click');
  await until(()=>!old.el('overviewPanel').hidden,'original plan did not open');
  const third={...planParts[1],id:'base',title:'Handle the empty path',summary:'Account for the path of length zero.'};
  const stored=await old.library.getPreparation(hash);
  await old.library.savePreparation(hash,{...stored,savedAt:stored.savedAt+1,parts:[...ready.parts,third]});
  const current={...personalized,key:'plan-with-current-outline',parts:[...personalized.parts,
    {...personalized.parts[1],id:third.id,title:third.title}]};
  const app=createApp({library:old.library,search:'?paper='+importedChoice,plans:[current]});
  await checkPublished(app);
  assert.equal(app.body.dataset.paperState,'preflight');
  assert.ok(app.calls.every(c=>!c.url.startsWith('/api/reading-plan')));
  app.fire('continuePreflight','click');
  await until(()=>!app.el('overviewPanel').hidden,'the revised outline did not open after confirmation');
  const requests=app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST');
  assert.equal(requests.length,1,'the old plan must not be selected again after confirmation');
  assert.deepEqual(JSON.parse(requests[0].body).analysis.parts.map(p=>p.id),['split','sum','base']);
  assert.equal(app.window.READER_SESSION.session(hash).study.key,current.key);
});

test('unchecking an inherited technique applies to this paper’s plan and tutor and preserves shared mastery',async()=>{
  const local=storage(),masteryKey=JSON.stringify(['folklore',decomposition.name.toLowerCase()]);
  local.setItem('proofreader.knowledge',JSON.stringify({mastery:[[masteryKey,true]]}));
  const first=createApp({local,post:[ready]});
  await openPdf(first);await checkPublished(first);
  const checkbox=(app,id)=>app.el(id).querySelectorAll('input').find(i=>i.getAttribute('aria-label')==='I know '+decomposition.name);
  function set(input,value) {input.checked=value;input.dispatchEvent(new Event('change'));}
  assert.equal(checkbox(first,'preflightKnowledge').checked,true);
  set(checkbox(first,'preflightKnowledge'),false);
  const profile=()=>JSON.parse(local.getItem('proofreader.knowledge'));
  assert.deepEqual(profile().mastery,[[masteryKey,true]]);
  assert.deepEqual(profile().paperTechniqueChoices,[[JSON.stringify([hash,decomposition.id]),false]]);
  const app=createApp({local,library:first.library,search:'?paper='+importedChoice,plans:[personalized],
    answers:[{status:'ready',answer:'Classify a path by its last edge.',sourceStep:1,stageDecision:{state:'continue',evidence:''}}]});
  await checkPublished(app);
  assert.equal(checkbox(app,'preflightKnowledge').checked,false);
  app.fire('continuePreflight','click');
  await until(()=>!app.el('overviewPanel').hidden,'the plan did not open');
  const plan=app.calls.find(c=>c.url==='/api/reading-plan' && c.method==='POST');
  assert.deepEqual(JSON.parse(plan.body).readerKnowledge.techniques,[]);
  app.fire('readCurrentPart','click');
  app.el('stageAskText').value='How do I classify these paths?';
  app.fire('stageAskForm','submit');
  await until(()=>quickCalls(app).length>0,'the tutor did not receive the question');
  const question=JSON.parse(quickCalls(app)[0].body);
  assert.deepEqual(question.known,[]);
  assert.deepEqual(question.readerKnowledge.techniques,[]);
  const reader=app.window.READER_KNOWLEDGE.create(profile(),[]);
  assert.equal(reader.isKnown(decomposition,[],'another-paper'),true);
  app.fire('profileButton','click');
  set(checkbox(app,'paperKnowledge'),true);
  assert.deepEqual(profile().paperTechniqueChoices,[]);
  set(checkbox(app,'paperKnowledge'),false);
  assert.deepEqual(profile().mastery,[[masteryKey,false]]);
});

test('removing one imported paper clears its study archive and reopens the background choices on upload',async()=>{
  const otherTitle='Counting directed walks',otherText=otherTitle+'\n\nA directed walk traverses each edge from its initial vertex to its terminal vertex.';
  const otherHash=createHash('sha256').update(otherText).digest('hex');
  const library=libraryFixture(new Map([[otherHash,{hash:otherHash,title:otherTitle,name:'walks.tex',text:otherText}]]));
  const otherResearch={...ready,displayTitle:otherTitle,key:'b'.repeat(64),preparation:true,savedAt:Date.now()};
  await library.savePreparation(otherHash,otherResearch);
  const analysis={...ready,key:'a'.repeat(64)},plan={...personalized,key:'c'.repeat(64)};
  const app=createApp({library,post:[analysis,analysis],plans:[plan],removals:[409,200]});
  const clearRequests=()=>app.calls.filter(c=>c.url==='/api/paper-cache/clear');
  await until(()=>app.body.dataset.paperState==='preflight','bundled paper did not open');
  assert.equal(app.el('removePaper').hidden,false,'the same library action should appear for bundled and uploaded papers');
  await openPdf(app);await checkPublished(app);
  const groupChoice=()=>app.el('preflightKnowledge').querySelector('select');
  const techniqueChoice=()=>app.el('preflightKnowledge').querySelectorAll('input').find(i=>i.getAttribute('aria-label')==='I know '+decomposition.name);
  groupChoice().value='known';groupChoice().dispatchEvent(new Event('change'));
  techniqueChoice().checked=true;techniqueChoice().dispatchEvent(new Event('change'));
  app.fire('continuePreflight','click');
  await until(()=>!app.el('overviewPanel').hidden,'the plan did not open');
  const previous=await library.getPreparation('study/'+hash);
  assert.equal(previous.study.key,plan.key);
  assert.equal(app.el('removePaper').hidden,false);
  app.fire('removePaper','click');
  assert.ok(app.el('removePaperDialog').open);
  assert.ok(app.el('removePaperDialog').textContent.includes(printedTitle),'the reader must identify the selected paper');
  app.fire('cancelRemovePaper','click');
  assert.ok(!app.el('removePaperDialog').open);
  assert.equal(clearRequests().length,0);
  assert.ok(await library.get(hash));
  app.fire('removePaper','click');app.fire('confirmRemovePaper','click');
  await until(()=>clearRequests().length===1 && !!app.el('removePaperError').textContent,'an active job should leave a visible error');
  assert.ok(await library.get(hash));
  assert.deepEqual(await library.getPreparation('study/'+hash),previous);
  app.fire('confirmRemovePaper','click');
  await until(()=>{
    if (clearRequests().length===2 && !app.el('removePaperError').hidden) assert.fail(app.el('removePaperError').textContent);
    return app.el('paperPicker').value==='intervals' && !app.el('removePaperDialog').open;
  },'removal did not return to the bundled guide');
  assert.equal(clearRequests().length,2);
  const body=JSON.parse(clearRequests()[1].body);
  assert.deepEqual(body.source.units.map(u=>u.text),pages);
  assert.ok(body.analysisKeys.includes(analysis.key));
  assert.ok(body.planKeys.includes(plan.key));
  assert.equal(await library.get(hash),null);
  assert.equal(await library.getPreparation(hash),null);
  assert.equal(await library.getPreparation('study/'+hash),null);
  assert.equal(app.local.getItem('proof.study.'+hash),null);
  assert.equal(app.local.getItem('proof.research.'+hash),null);
  assert.ok(!app.el('paperPicker').options.some(o=>o.value===importedChoice));
  assert.deepEqual(await library.getPreparation(otherHash),otherResearch);
  app.choose('doc-'+otherHash);
  await until(()=>app.el('paperPicker').value==='doc-'+otherHash && app.el('preflightPaperTitle').textContent===otherTitle && app.body.dataset.paperState==='preflight','the other saved paper did not open');
  assert.equal(app.el('removePaper').hidden,false);
  assert.ok(!app.el('removePaper').disabled);
  app.fire('removePaper','click');
  assert.ok(app.el('removePaperDialog').open);
  assert.equal(app.el('removePaperTitle').textContent,otherTitle);
  app.fire('cancelRemovePaper','click');
  assert.equal(clearRequests().length,2,'canceling on the other upload must not clear its data');
  const before=fullPosts(app).length;
  await confirmPdfUpload(app);await checkPublished(app);
  assert.equal(groupChoice().value,'unfamiliar','paper-specific background choices should start fresh');
  assert.equal(techniqueChoice().checked,true,'transferable knowledge is shared across papers');
  assert.equal(fullPosts(app).length,before+1,'import after removal must request the paper analysis again');
  assert.equal(app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST').length,1,'the old plan must not be reused before confirming choices');
});

test('bundled papers can be removed individually, stay removed on relaunch, and leave an importable empty library',async()=>{
  const library=libraryFixture(),local=storage();
  const choices=app=>app.el('paperPicker').options.map(option=>option.value).filter(Boolean);
  function openRemoval(app) {
    const button=app.el('removePaper');
    assert.equal(button.hidden,false);
    assert.ok(!button.disabled);
    const title=app.el('preflightPaperTitle').textContent;
    assert.ok(title);
    app.fire('removePaper','click');
    assert.ok(app.el('removePaperDialog').open);
    assert.equal(app.el('removePaperTitle').textContent,title);
  }
  async function remove(app,id) {
    openRemoval(app);
    app.fire('confirmRemovePaper','click');
    await until(()=>{
      if (!app.el('removePaperError').hidden) assert.fail(app.el('removePaperError').textContent);
      return !app.el('removePaperDialog').open && !choices(app).includes(id);
    },'the selected paper should leave the picker after confirmation');
  }
  const app=createApp({library,local,removals:[200]});
  await until(()=>app.body.dataset.paperState==='preflight','the initial bundled paper did not open');
  assert.equal(app.el('paperPicker').value,'intervals');
  openRemoval(app);
  app.fire('cancelRemovePaper','click');
  assert.ok(!app.el('removePaperDialog').open);
  assert.deepEqual(choices(app),['intervals']);
  assert.ok(!app.calls.some(call=>call.url==='/api/paper-cache/clear'));
  await remove(app,'intervals');
  await until(()=>app.body.dataset.paperState==='empty','the last removal should open the empty library');
  const empty=createApp({library,local,search:'?paper=intervals',post:[ready]});
  await until(()=>empty.body.dataset.paperState==='empty','the empty library should persist across relaunch');
  assert.deepEqual(choices(empty),[]);
  assert.ok(empty.el('removePaper').hidden);
  assert.ok(!empty.el('uploadDialog').open);
  assert.ok(!empty.el('openImport').hidden && !empty.el('openImport').disabled);
  await confirmPdfUpload(empty);
  await checkPublished(empty);
  assert.deepEqual(choices(empty),[importedChoice]);
  assert.equal(empty.el('removePaper').hidden,false);
  const onlyImport=createApp({library,local,search:'?paper=intervals'});
  await checkPublished(onlyImport);
  assert.deepEqual(choices(onlyImport),[importedChoice]);
  assert.ok(!onlyImport.el('uploadDialog').open);
});

test('saved legacy filename, unversioned overview and ready quick brief wait for fresh preparation',async () => {
  const local=storage(),done=deferred();
  local.setItem('proof.research.'+hash,JSON.stringify({...ready,displayTitle:undefined,preparationVersion:undefined,
    overview:{paragraphs:[oldSummary],suggestions:[]}}));
  local.setItem('proof.tutor.'+hash,JSON.stringify([{topic:'paper-overview',step:0,status:'ready',answer:oldBrief}]));
  const library=libraryFixture(new Map([[hash,{hash,name:filename,title:'scanner-export-009',text:'',pages,
    file:new File([bytes],filename,{type:'application/pdf'})}]]));
  const app=createApp({local,library,search:'?paper='+importedChoice,post:[done.promise]});
  await until(() => fullPosts(app).length===1,'legacy paper did not refresh');
  checkWaiting(app);
  done.resolve(ready);
  await checkPublished(app);
});

test('failed full preparation exposes retry and publishes only after the retry succeeds',async () => {
  const app=createApp({post:[{status:'error',message:'Synthetic retryable failure'},ready]});
  await openPdf(app);
  await until(() => app.body.dataset.paperState==='failed','failure state was not rendered');
  assert.equal(app.el('overviewPanel').hidden,true);
  assert.equal(app.el('retryPaper').hidden,false);
  assert.equal(app.el('preparationEstimate').hidden,true);
  app.fire('retryPaper','click');
  await checkPublished(app);
  assert.equal(fullPosts(app).length,2);
});

test('a completed response missing its knowledge map never exposes a partial reading guide',async () => {
  const app=createApp({post:[{...ready,knowledge:undefined}]});
  await openPdf(app);
  await until(() => app.body.dataset.paperState==='failed','incomplete preparation published as complete');
  assert.equal(app.el('paperTitle').textContent,'');
  assert.equal(app.el('overviewPanel').hidden,true);
  assert.ok(!app.el('overviewBody').textContent.includes(paragraphs[0]));
  assert.equal(quickCalls(app).length,0);
});

test('opening only the original skips research until the reader chooses preparation',async () => {
  const done=deferred();
  const app=createApp({post:[done.promise]});
  await openPdf(app,{prepare:false});
  assert.equal(fullPosts(app).length,0);
  assert.equal(quickCalls(app).length,0);
  assert.equal(app.el('paperTitle').textContent,'');
  app.fire('preparePaperButton','click');
  await until(() => fullPosts(app).length===1,'explicit preparation did not start');
  checkWaiting(app);
  done.resolve(ready);
  await checkPublished(app);
});

test('a late result cannot replace the selected bundled paper and is available when returning',async () => {
  const done=deferred();
  const app=createApp({post:[{status:'running',key:'job-1'}],poll:[done.promise]});
  await openPdf(app);
  checkWaiting(app);
  app.choose('intervals');
  await until(() => app.el('paperPicker').value==='intervals' && app.body.dataset.paperState==='preflight','switch away did not finish');
  const before=app.el('paperTitle').textContent;
  done.resolve(ready);
  await until(() => JSON.parse(app.local.getItem('proof.research.'+hash)).status==='ready','background result not saved');
  assert.equal(app.el('paperTitle').textContent,before);
  assert.equal(app.el('paperPicker').value,'intervals');
  app.choose(importedChoice);
  await checkPublished(app);
  assert.equal(fullPosts(app).length,1);
});

test('a plan in progress shows the reported batch and reviewed parts while keeping the study closed',async()=>{
  const stage=deferred(),finish=deferred();
  const progress={stage:'drafting',completedParts:0,totalParts:2,firstPart:1,lastPart:2,startedAt:Date.now()-90000};
  const app=createApp({post:[ready],plans:[{status:'running',key:'plan-1',progress},stage.promise,finish.promise]});
  await openPdf(app);
  await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>app.el('paperStateMessage').textContent==='Drafting parts 1–2.','draft status missing');
  assert.equal(app.el('planPartCount').value,0);
  assert.match(app.el('planProgressDetail').textContent,/0 of 2 parts reviewed · 1m \d+s elapsed/);
  assert.match(app.el('preparationEstimate').textContent,/About \d+–\d+ minutes remaining/);
  stage.resolve({status:'running',key:'plan-1',progress:{...progress,stage:'editing',firstPart:2,lastPart:2,completedParts:1}});
  await until(()=>app.el('paperStateMessage').textContent==='The editor is reviewing part 2.','editor status did not update');
  assert.equal(app.el('planPartCount').value,1);
  assert.equal(app.el('planPartCount').max,2);
  assert.equal(app.el('overviewPanel').hidden,true);
  const reopened=createApp({local:app.local,library:app.library,search:'?paper='+importedChoice,plans:[finish.promise]});
  await until(()=>reopened.el('paperStateMessage').textContent==='The editor is reviewing part 2.','saved progress did not reopen');
  assert.equal(reopened.el('preparationEstimate').textContent,app.el('preparationEstimate').textContent);
  assert.match(reopened.el('planProgressDetail').textContent,/1 of 2 parts reviewed · 1m \d+s elapsed/);
  assert.ok(!reopened.calls.some(c=>c.url==='/api/reading-plan' && c.method==='POST'));
  finish.resolve(personalized);
  await until(()=>app.el('overviewPanel').hidden===false,'reviewed plan did not open');
  await until(()=>reopened.el('overviewPanel').hidden===false,'reopened plan did not finish');
});

test('a source mismatch distinguishes saved drafts from final reviews and names the affected card',async()=>{
  const message='The source check needs another pass for “Partition the paths” — use the defining source words for Incoming edge. Retry to continue from the saved sections.';
  for (const legacy of [false,true]) {
    const progress={stage:'checking',totalParts:2,completedParts:0,firstPart:1,lastPart:1};
    if (!legacy) Object.assign(progress,{draftedParts:2,sourceDefinitions:[{part:1,name:'Incoming edge'}]});
    const app=createApp({post:[ready],plans:[{status:'error',needsAction:true,actionRequired:'review',key:'plan-1',progress,message},personalized]});
    await openPdf(app);
    await checkPublished(app);
    app.fire('continuePreflight','click');
    await until(()=>app.body.dataset.paperState==='failed','source failure did not open');
    assert.equal(app.el('paperStateTitle').textContent,'Preparation paused at source review');
    assert.match(app.el('paperStateMessage').textContent,/verify the source for “Incoming edge” \(part 1\)/);
    const bar=app.el('planPartCount'),detail=app.el('planProgressDetail').textContent;
    assert.equal(detail,legacy?'0 of 2 parts reviewed':'2 of 2 parts drafted · 0 of 2 parts reviewed');
    assert.equal(bar.getAttribute('aria-valuetext'),detail);
    assert.equal(bar.value,legacy?0:2);
    assert.equal(bar.max,legacy?2:4);
    app.fire('retryPaper','click');
    await until(()=>!app.el('overviewPanel').hidden,'retry did not reach the reader');
  }
});

test('a background window moves from an obsolete error to the active plan and opens the reviewed result',async()=>{
  const initial=createApp({post:[ready],plans:[{status:'error',key:'plan-1',needsAction:true,actionRequired:'service',message:'Stopped on the previous service.'}]});
  await openPdf(initial); await checkPublished(initial);
  initial.fire('continuePreflight','click');
  await until(()=>initial.body.dataset.paperState==='failed','initial failure missing');
  const storageKey='proof.study.'+hash;
  const obsolete=JSON.parse(initial.local.getItem(storageKey));
  delete obsolete.study.needsAction; delete obsolete.study.actionRequired;
  obsolete.study.status='failed';
  const copy=storage();copy.setItem(storageKey,JSON.stringify(obsolete));
  copy.setItem('proof.research.'+hash,initial.local.getItem('proof.research.'+hash));
  // The old window already has a status read in flight. Its late reply must not restore its old error.
  const staleRead=deferred(),activeRead=deferred();
  const app=createApp({local:copy,library:libraryFixture(new Map([[hash,{hash,name:filename,text:'',pages,file:new File([bytes],filename)}]])),
    search:'?paper='+importedChoice,plans:[staleRead.promise,activeRead.promise]});
  await until(()=>app.calls.some(c=>c.url==='/api/reading-plan/plan-1'),'saved error was never reconciled');
  const active=JSON.parse(copy.getItem(storageKey));
  active.savedAt+=100;
  active.study.status='running';
  active.study.progress={stage:'drafting',completedParts:0,draftedParts:1,totalParts:2,firstPart:2,lastPart:2};
  const external=record=>{
    const value=JSON.stringify(record);copy.setItem(storageKey,value);
    app.window.dispatchEvent(Object.assign(new Event('storage'),{key:storageKey,newValue:value}));
  };
  external(active);
  await until(()=>app.el('paperStateMessage').textContent==='Drafting part 2.','background window kept the saved error');
  assert.match(app.el('planProgressDetail').textContent,/1 of 2 parts drafted/);
  staleRead.resolve({status:'error',key:'plan-1',message:'This reply predates recovery.'});
  await until(()=>app.calls.filter(c=>c.url==='/api/reading-plan/plan-1').length===2,'window did not follow the existing job');
  const finished={...active,savedAt:active.savedAt+100,study:{...active.study,...personalized,completed:[],activeIndex:0}};
  // Simulate a suspended page missing the completion event and then waking.
  copy.setItem(storageKey,JSON.stringify(finished));app.window.dispatchEvent(new Event('focus'));
  await until(()=>!app.el('overviewPanel').hidden,'wake did not reconcile the saved completion');
  activeRead.resolve({status:'error',key:'plan-1',message:'Late response'});
  await new Promise(setImmediate);
  assert.equal(app.window.READER_SESSION.session(hash).study.status,'ready');
  assert.equal(app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST').length,0);
});

test('diagnostics are fetched on demand and copy only operational fields',async()=>{
  const pending=deferred(),refresh=deferred();
  const progress={stage:'checking',firstPart:1,lastPart:2,draftedParts:2,completedParts:0,totalParts:2,blockedParts:[1],waitingParts:[2]};
  const record={version:1,key:'plan-1',status:'running',attempt:2,historyAvailable:true,
    progress:{...progress,waitingParts:[2,2,9,-1,'private paper excerpt']},
    events:[{sequence:3,at:Date.now(),event:'check-failed',attempt:2,stage:'checking',part:1,field:'definitions.0.sourceQuote',
      check:'source-quote',code:'source-quote-not-found',action:'verify-page',sourceQuote:'private paper excerpt'}]};
  const app=createApp({post:[ready],plans:[{status:'running',key:'plan-1',progress},pending.promise],diagnostics:[record,refresh.promise]});
  await openPdf(app); await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>app.el('paperStateMessage').textContent.includes('Checking parts'),'plan did not start');
  assert.match(app.el('planProgressDetail').textContent,/Part 2 is waiting for a prerequisite/);
  assert.match(app.el('preparationEstimate').textContent,/depends on verifying the source for part 1/);
  const panel=app.el('planDiagnostics'),requests=()=>app.calls.filter(c=>c.url.endsWith('/diagnostics'));
  assert.equal(panel.hidden,false);assert.equal(requests().length,0);
  panel.open=true;app.fire('planDiagnostics','toggle');
  await until(()=>app.el('diagnosticReport').textContent.includes('source-quote-not-found'),'diagnostic events were missing');
  assert.deepEqual(requests().map(c=>[c.method,c.url]),[['GET','/api/reading-plan/plan-1/diagnostics']]);
  assert.match(app.el('diagnosticReport').textContent,/field=definitions\.0\.sourceQuote/);
  assert.match(app.el('diagnosticReport').textContent,/action=verify-page/);
  assert.match(app.el('diagnosticReport').textContent,/Parts waiting for prerequisites  2/);
  app.fire('copyDiagnostics','click');
  await until(()=>!app.el('diagnosticCopyText').hidden,'clipboard fallback did not appear');
  const source=app.el('diagnosticCopyText').value;
  assert.deepEqual(JSON.parse(source).events[0].code,'source-quote-not-found');
  assert.deepEqual(JSON.parse(source).progress.waitingParts,[2]);
  assert.equal(JSON.parse(source).key,'plan-1');assert.ok(!source.includes('private paper excerpt'));
  let copied;
  app.window.navigator={clipboard:{writeText:async text=>{copied=text;}}};
  app.fire('copyDiagnostics','click');await until(()=>copied===source,'clipboard did not receive the report');
  app.fire('refreshDiagnostics','click');
  assert.equal(requests().length,2);
  pending.resolve(personalized);
  await until(()=>!app.el('overviewPanel').hidden,'ready result did not open');
  refresh.resolve(record);await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(panel.hidden,true);assert.equal(panel.open,false);assert.equal(app.el('diagnosticReport').textContent,'');
});

test('diagnostics remain readable for a legacy job, an unavailable service or a missing job ID',async()=>{
  for (const scenario of ['legacy','offline','missing']) {
    const assigned=scenario!=='missing';
    const plan={status:'error',needsAction:true,actionRequired:'service',message:'Check the local reading service.',...(assigned?{key:'older-plan'}:{})};
    const reply=scenario==='legacy'?{version:1,key:'older-plan',status:'error',attempt:1,historyAvailable:false,events:[]}:{unreachable:true};
    const app=createApp({post:[ready],plans:[plan],diagnostics:[reply]});
    await openPdf(app);await checkPublished(app);
    app.fire('continuePreflight','click');await until(()=>app.body.dataset.paperState==='failed','failed plan missing');
    app.el('planDiagnostics').open=true;app.fire('planDiagnostics','toggle');
    await until(()=>app.el('diagnosticReport').textContent.includes('Status  error'),'fallback snapshot missing');
    const note=app.el('diagnosticStatus').textContent;
    assert.match(note,scenario==='legacy'?/No event history/:scenario==='offline'?/last known status/:/job ID/);
    assert.equal(app.calls.filter(c=>c.url.endsWith('/diagnostics')).length,assigned?1:0);
  }
});

test('an unexpected service defect displays its saved diagnostics without automatically resubmitting',async()=>{
  const error={status:'error',key:'plan-1',unexpected:true,needsAction:false,failureCode:'unexpected-failure',
    failureStage:'editing',message:'An unexpected error interrupted the section review.'};
  const app=createApp({post:[ready],plans:[error],diagnostics:[{unreachable:true}]});
  await openPdf(app);await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>app.body.dataset.paperState==='failed','unexpected defect did not surface');
  assert.equal(app.el('paperStateTitle').textContent,'Couldn’t prepare your reading plan');
  assert.equal(app.el('changeFailedNotation').hidden,true);
  app.el('planDiagnostics').open=true;app.fire('planDiagnostics','toggle');
  await until(()=>app.el('diagnosticReport').textContent.includes('unexpected-failure  editing'),'failure diagnostics were not available');
  app.window.dispatchEvent(new Event('online'));
  await new Promise(setImmediate);
  assert.equal(app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST').length,1);
});

test('unclassified overview and section defects preserve the service diagnosis and require an explicit retry',async()=>{
  const unknown={status:'error',unexpected:true,needsAction:false,failureCode:'unexpected-failure',message:'Couldn’t prepare this explanation.'};
  const overview=createApp({post:[{...unknown,key:'overview-job',failureStage:'analysis'}]});
  await openPdf(overview);
  await until(()=>overview.body.dataset.paperState==='failed','unexpected overview defect did not surface');
  assert.equal(overview.el('paperStateTitle').textContent,'Couldn’t prepare this paper');
  overview.el('planDiagnostics').open=true;overview.fire('planDiagnostics','toggle');
  assert.match(overview.el('diagnosticReport').textContent,/unexpected-failure  analysis/);
  assert.equal(fullPosts(overview).length,1);
  const app=createApp({post:[ready],plans:[personalized],structures:[{...unknown,key:'section-job',failureStage:'formulating'}]});
  await openPdf(app);await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>!app.el('overviewPanel').hidden,'plan did not open');
  app.fire('readCurrentPart','click');
  await until(()=>app.el('stageProofStatus').textContent.includes('Couldn’t prepare'),'unknown section defect did not surface');
  const state=app.window.READER_SESSION,guide=state.partGuide(state.session(hash).study,'split');
  assert.deepEqual([guide.unexpected,guide.needsAction,guide.failureCode,guide.failureStage],[true,false,'unexpected-failure','formulating']);
  assert.equal(app.el('stageProofDiagnostics').hidden,false);
  assert.match(app.el('stageProofDiagnosticReport').textContent,/section-job[\s\S]*formulating[\s\S]*unexpected-failure/);
  app.window.dispatchEvent(new Event('focus'));await new Promise(setImmediate);
  assert.equal(app.calls.filter(c=>c.url==='/api/section-structure' && c.method==='POST').length,1);
});

test('remaining-time ranges reflect paper size, notation, completed work, current stage and overruns',()=>{
  const window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'reading-plan.js'),'utf8'),{window});
  const estimate=window.READING_PLAN.preparationEstimate;
  const minute=60000,now=40*minute;
  const input={pages:9,parts:14,now,startedAt:now,reference:true};
  function range(label) {
    const result=/About (\d+)–(\d+) minutes/.exec(label);
    assert.ok(result,label);
    return [Number(result[1]),Number(result[2])];
  }
  function during(stage,completedParts,firstPart,lastPart,age,timing={}) {
    return estimate({...input,progress:{stage,totalParts:14,completedParts,firstPart,lastPart,
      phaseStartedAt:now-age*minute,...timing}});
  }
  const initial=range(estimate({...input,overview:true}));
  assert.ok(initial[0]<3 && initial[1]>=3,'the observed 179-second analysis falls within the estimate');
  assert.ok(range(estimate({...input,overview:true,pages:60}))[1]>initial[1]);
  assert.ok(range(estimate(input))[1]>range(estimate({...input,reference:false}))[1]);
  assert.ok(range(during('preparing',10,null,null,0))[1]<range(estimate({...input,reference:false}))[1],
    'a retry with ten finished parts should estimate the remaining four');
  const mapping=range(during('adapting-notation',0,null,null,0));
  assert.ok(mapping[0]<=29 && mapping[1]>=29,'notation plus six drafting and editing batches took about 29 minutes');
  const rewritten=range(during('rewriting-notation',6,7,12,1));
  const draft=range(during('drafting',0,1,5,0));
  const editing=range(during('editing',0,1,5,2));
  assert.ok(mapping[0]>rewritten[0] && rewritten[0]>draft[0] && draft[0]>editing[0]);
  assert.ok(draft[0]<=21 && draft[1]>=21,'drafting and editing three batches took about 21 minutes');
  const finalBatch=range(during('editing',10,11,14,0));
  assert.ok(finalBatch[1]<editing[1]);
  assert.ok(range(during('editing',10,11,14,2))[1]<finalBatch[1]);
  const fast=during('drafting',10,11,14,0,{reviewStartPart:5,reviewStartedAt:now-5*minute});
  const slow=during('drafting',10,11,14,0,{reviewStartPart:5,reviewStartedAt:now-12*minute});
  assert.ok(range(fast)[1]<range(slow)[1],'use only newly reviewed parts to measure this run’s pace');
  assert.match(during('revising-notation',13,14,14,0),/extra revision/);
  assert.match(during('drafting',0,1,5,10),/taking longer/);
  assert.match(during('saving',14,null,null,0),/less than a minute/);
  assert.match(estimate({overview:true,now}),/Estimating/);
});

test('the reader selects prerequisites, waits for tailoring, and revisits completed part discussions',async () => {
  const tailored=deferred();
  const reply=(state,answer,evidence='') => ({status:'ready',answer,sourceStep:1,followups:[],stageDecision:{state,evidence}});
  const understands='The final edge is unique, so these sets are disjoint.';
  const app=createApp({post:[ready],plans:[{status:'running',key:'plan-1'},tailored.promise],
    answers:[reply('continue','Can you say which edge fixes the class?'),
      reply('complete','Exactly. A unique last edge puts each nonempty path into one class.',understands)]});
  await openPdf(app);
  await checkPublished(app);
  const preflight=app.el('preflightKnowledge');
  const technique=preflight.querySelectorAll('input').find(input=>input.getAttribute('aria-label')==='I know '+decomposition.name);
  assert.ok(technique,'preflight includes the transferable method');
  technique.checked=true; technique.dispatchEvent(new Event('change'));
  const group=preflight.querySelector('select');
  group.value='partial'; group.dispatchEvent(new Event('change'));
  const term=preflight.querySelectorAll('input').find(input=>input.getAttribute('aria-label')==='I know Directed edge');
  assert.ok(term,'a single definition can be selected');
  term.checked=true; term.dispatchEvent(new Event('change'));
  app.fire('continuePreflight','click');
  const planPosts=()=>app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST');
  await until(()=>planPosts().length===1,'no tailoring request');
  assert.equal(app.body.dataset.paperState,'preparing');
  assert.equal(app.el('overviewPanel').hidden,true);
  const request=JSON.parse(planPosts()[0].body);
  assert.deepEqual(request.readerKnowledge.techniques.map(t=>t.name),[decomposition.name]);
  const [chosen]=request.readerKnowledge.definitionGroups;
  assert.deepEqual(chosen.knownTerms,['Directed edge']);
  assert.deepEqual(chosen.remainingTerms,['Directed path']);
  assert.deepEqual(request.analysis.localIntroductions.map(l=>l.id),['last-edge']);
  tailored.resolve(personalized);
  await until(()=>!app.body.dataset.paperState && !app.el('overviewPanel').hidden,'tailored overview did not appear');
  assert.ok(paragraphs.every(p=>app.el('overviewBody').textContent.includes(p)));
  assert.equal(app.el('paperTitle').textContent,printedTitle);
  app.fire('readCurrentPart','click');
  await until(()=>app.body.dataset.readingView==='part','first part did not open');
  assert.equal(app.el('stageTitle').textContent,planParts[0].title);
  assert.equal(app.el('stageIntroduction').textContent,splitGuide.introduction);
  assert.equal(app.el('stageNotation').hidden,false);
  const reference=app.el('stageNotation'), toggle=app.el('stageNotationTitle');
  assert.equal(toggle.textContent,'Notation reference');
  assert.equal(reference.open,false,'the lookup should start collapsed');
  assert.equal(toggle.parentElement,reference);
  toggle.click();
  assert.equal(reference.open,true,'the native summary should open the reference');
  assert.deepEqual(app.el('stageNotationList').querySelectorAll('dt').map(node=>node.textContent),splitGuide.notation.map(row=>row.symbol));
  assert.deepEqual(app.el('stageNotationList').querySelectorAll('dd').map(node=>node.textContent),splitGuide.notation.map(row=>row.meaning));
  const formalDefinitions=app.el('stageDefinitions');
  assert.equal(formalDefinitions.hidden,false,'known definitions must remain available in the mathematical exposition');
  assert.deepEqual(formalDefinitions.querySelectorAll('.stage-definition-text').map(p=>p.textContent),splitGuide.definitions.map(d=>d.text));
  assert.ok(formalDefinitions.textContent.includes(alphabet.definitions[0].term));
  assert.equal(formalDefinitions.querySelectorAll('.stage-definition-intuition').length,1);
  assert.ok(formalDefinitions.textContent.includes(splitGuide.definitions[0].intuition));
  assert.deepEqual(app.el('stageLeadIn').querySelectorAll('p').map(p=>p.textContent),splitGuide.paragraphs.slice(0,1));
  assert.deepEqual(app.el('stageOpening').querySelectorAll('p').map(p=>p.textContent),splitGuide.paragraphs.slice(1));
  assert.ok(!app.el('stageOpening').textContent.includes(personalized.parts[0].opening),'the legacy opening must not precede the completed body');
  const sectionOrder=app.el('stageOrientation').children.filter(child=>child.id).map(child=>child.id);
  assert.deepEqual(sectionOrder.slice(0,4),['stageIntroduction','stageLeadIn','stageDefinitions','stageStatement']);
  const blocks=app.el('stageOpening').parentElement.children.filter(child=>child.id).map(child=>child.id);
  assert.ok(blocks.indexOf('stageOrientation')<blocks.indexOf('stageOpening') && blocks.indexOf('stageOpening')<blocks.indexOf('stageHandoff'));
  assert.ok(blocks.indexOf('stageHandoff')<blocks.indexOf('stageNotation'));
  assert.doesNotMatch(app.el('stageOrientation').textContent,/Why this step|After this part/);
  for (const passage of [app.el('stageLeadIn').querySelector('p'),app.el('stageNotationList').querySelector('dt'),formalDefinitions.querySelector('.stage-definition-text')]) {
    app.window.getSelection=()=>({isCollapsed:false,anchorNode:passage,focusNode:passage,toString:()=>passage.textContent});
    app.fire('stageExploreExample','pointerdown');
    app.window.getSelection=()=>null;
    app.fire('stageExploreExample','click');
    assert.equal(app.el('stageExploreTarget').value,passage.textContent);
    app.fire('stageExploreExample','click');
  }
  assert.ok(app.el('stageHandoff').textContent.includes(splitGuide.handoff));
  assert.equal(app.el('stageStatement').hidden,false);
  assert.equal(app.el('stageStatementLabel').textContent,splitGuide.statement.label);
  assert.ok(app.el('stageStatementText').textContent.includes(splitGuide.statement.text));
  assert.ok(app.el('stageFirstQuestion').hidden || !app.el('stageFirstQuestion').textContent.trim(),
    'starting a part should let the reader read without opening a checkpoint');
  assert.ok(app.el('stagePrerequisites').textContent.includes(decomposition.name));
  assert.ok(app.el('stageIntroductions').textContent.includes(introduction.title));
  const definition=app.el('stagePrerequisites').querySelectorAll('a').find(a=>a.textContent===alphabet.title);
  definition.dispatchEvent(new Event('click'));
  assert.ok(app.el('paperKnowledge').textContent.includes(decomposition.knownBridge));
  const review=app.el('paperKnowledge').querySelectorAll('input').find(t=>t.getAttribute('aria-label')==='I know Directed path');
  assert.equal(review.checked,false);
  const check=review.closest('.knowledge-item').querySelector('.knowledge-self-check');
  const [tryQuestion,showAnswer]=check.querySelectorAll('button');
  const prompt=check.querySelector('.knowledge-check-prompt'), solution=check.querySelector('.knowledge-check-answer');
  assert.equal(prompt.hidden,true);
  tryQuestion.dispatchEvent(new Event('click'));
  assert.equal(prompt.hidden,false);
  assert.equal(check.querySelector('.knowledge-check-question').textContent,alphabet.selfCheck.question);
  assert.equal(solution.hidden,true);
  showAnswer.dispatchEvent(new Event('click'));
  assert.equal(solution.hidden,false);
  assert.equal(solution.textContent,alphabet.selfCheck.answer);
  assert.equal(review.checked,false,'revealing a self-check answer must leave mastery unchanged');
  app.el('profileDialog').close();
  const respond=message=>{ app.el('stageAskText').value=message; app.fire('stageAskForm','submit'); };
  respond('Can you explain the classes?');
  await until(()=>app.el('stageTurns').textContent.includes('which edge fixes the class'),'first answer did not appear');
  assert.equal(app.el('stageTitle').textContent,planParts[0].title);
  respond(understands);
  await until(()=>app.el('stageTitle').textContent===planParts[1].title,'model completion did not advance the part');
  assert.equal(app.el('stageIntroduction').textContent,sumGuide.introduction);
  assert.equal(app.el('stageNotation').hidden,true);
  assert.equal(reference.open,false,'disclosure state should reset on changing part');
  assert.equal(app.el('stageDefinitions').hidden,true);
  assert.equal(app.el('stageStatement').hidden,true,'a calculation should not inherit the previous lemma box');
  assert.ok(app.el('stagePrerequisites').textContent.includes(introduction.title));
  const stageRequests=quickCalls(app).filter(c=>c.method==='POST').map(c=>JSON.parse(c.body));
  assert.deepEqual(stageRequests.map(r=>r.stage.partId),['split','split']);
  assert.ok(stageRequests[1].history.some(h=>h.question==='Can you explain the classes?'));
  const localLink=app.el('stagePrerequisites').querySelectorAll('a').find(a=>a.textContent.includes(introduction.title));
  assert.match(localLink.href,/part=split#local\/last-edge$/);
  localLink.dispatchEvent(new Event('click'));
  await until(()=>app.el('stageTitle').textContent===planParts[0].title,'local prerequisite did not lead to its origin');
  assert.ok(app.el('stageIntroductions').textContent.includes(introduction.meaning));
  assert.equal(app.el('stageAskForm').hidden,true,'archived discussion should be read-only');
  app.fire('stageResume','click');
  await until(()=>app.el('stageTitle').textContent===planParts[1].title,'return from local prerequisite failed');
  const archived=app.el('stageArchiveList').querySelector('button') || app.el('stageArchiveList').querySelector('a');
  assert.ok(archived,'previous part is missing from the archive');
  archived.dispatchEvent(new Event('click'));
  await until(()=>app.el('stageTitle').textContent===planParts[0].title,'archive did not reopen the earlier part');
  assert.equal(reference.hidden,false);
  assert.equal(reference.open,false,'reopening an archived section should start with the argument');
  toggle.click();
  assert.equal(reference.open,true);
  assert.ok(app.el('stageTurns').textContent.includes(understands));
  assert.ok(app.el('stageTurns').textContent.includes('each nonempty path into one class'));
  app.fire('stageResume','click');
  await until(()=>app.el('stageTitle').textContent===planParts[1].title,'return to current part failed');
  const restored=createApp({library:app.library,search:'?paper='+importedChoice+'&part=sum'});
  await until(()=>restored.el('stageTitle').textContent===planParts[1].title,'current part did not survive reload');
  assert.ok(restored.el('stageArchiveList').textContent.includes(planParts[0].title));
  const first=restored.el('stageArchiveList').querySelectorAll('a').find(a=>a.textContent.includes(planParts[0].title));
  first.dispatchEvent(new Event('click'));
  await until(()=>restored.el('stageTitle').textContent===planParts[0].title,'cold archive did not open');
  for (const excerpt of ['Can you explain the classes?','which edge fixes the class',understands,'a unique last edge']) {
    assert.ok(restored.el('stageTurns').textContent.toLowerCase().includes(excerpt.toLowerCase()),'lost archived text: '+excerpt);
  }
  assert.deepEqual(restored.calls.filter(c=>c.method==='POST' && c.url!=='/api/section-structure'),[],
    'opening an archived discussion should not send a question or regenerate the reading plan');
});

test('stage exploration previews targets before sending and keeps modes, replies and retries with their source part',async () => {
  const secondPage='Consider paths from the root in a finite directed acyclic graph with a unique source. The last-edge classes are disjoint, so their cardinalities sum to the number of paths.';
  const anchor={step:2,phrase:'The last-edge classes are disjoint'};
  const secondPart={...planParts[1],sourceSteps:[2],sourceAnchors:[anchor]};
  const prepared={...ready,parts:[planParts[0],secondPart]};
  const plan={...personalized,parts:[personalized.parts[0],{...personalized.parts[1],sourceSteps:[2]}]};
  const delayed=deferred();
  const reply=answer=>({status:'ready',answer,sourceStep:2,followups:[],stageDecision:{state:'continue',evidence:''}});
  const example='With 2 paths ending in one edge and 3 ending in another, the total is 5.';
  const simpler='Start with one predecessor. Every nonempty path into the last vertex uses that single incoming edge.';
  const restriction='Suppose every non-root vertex has exactly one incoming edge.';
  const restrictedReply='On a rooted directed tree, each vertex has just one path from the root. The general recurrence adds one contribution for each incoming edge.';
  const missing='Two overlapping classes would count their shared paths twice.';
  const ordinary='The empty path needs its own base case.';
  const reviewAnswer='With one path through each final edge, two distinct final edges give two classes.';
  const afterCompletion='Deleting uniqueness would allow overlapping classes.';
  const app=createApp({extractedPages:[pages[0],secondPage],post:[prepared],plans:[plan],
    answers:[{status:'running',key:'example-job'},delayed.promise,reply(simpler),reply(restrictedReply),
      {status:'error',message:'A temporary failure while checking the condition.'},reply(missing),reply(ordinary),
      {...reply(reviewAnswer),sourceStep:1},{...reply(afterCompletion),sourceStep:1}]});
  await openPdf(app);
  await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>!app.body.dataset.paperState,'plan did not open');
  app.fire('readCurrentPart','click');
  await until(()=>app.el('stageTitle').textContent===planParts[0].title,'first part did not open');
  const beforeSkip=quickCalls(app).length;
  app.fire('stageContinue','click');
  assert.equal(app.el('stageCheckpoint').hidden,false);
  assert.equal(app.el('stageTitle').textContent,planParts[0].title);
  app.fire('stageCheckSkip','click');
  await until(()=>app.el('stageTitle').textContent===secondPart.title,'second part did not open');
  assert.equal(quickCalls(app).length,beforeSkip,'skipping the optional checkpoint sent an agent request');
  assert.equal(app.window.READER_SESSION.session(hash).turns.length,0,'skipping created a fictitious exchange');

  const {el,fire}=app;
  const requests=()=>quickCalls(app).filter(c=>c.method==='POST').map(c=>JSON.parse(c.body));
  const target=el('stageExploreTarget');
  const form=el('stageExploreForm');
  assert.equal(el('stageExplore').hidden,false);
  assert.equal(form.hidden,true);
  assert.equal(el('stageExploreSubmit').closest('form'),form);
  assert.equal(el('stageExploreSubmit').type,'submit');
  const custom='the assumption that the last-edge classes are disjoint';
  const freeQuestion='What about a path with no edges?';
  el('stageAskText').value=freeQuestion;
  fire('stageAskText','input');

  fire('stageExploreRemove','click');
  assert.equal(form.hidden,false);
  assert.match(el('stageExploreHint').textContent,/this part/i);
  target.value=custom;
  fire('stageExploreTarget','input');
  fire('stageExploreRemove','click');
  assert.equal(form.hidden,true);
  const passage=el('stageOpening').firstElementChild;
  const highlight=sumGuide.paragraphs[0];
  assert.ok(passage.textContent.includes(highlight));
  app.window.getSelection=()=>({isCollapsed:false,anchorNode:passage,focusNode:passage,toString:()=>highlight});
  fire('stageExploreExample','pointerdown');
  app.window.getSelection=()=>null;
  fire('stageExploreExample','click');
  const selected=target.value;
  assert.equal(selected,highlight,'the explicit mode click should prefill the full highlighted passage');
  assert.match(el('stageExploreLabel').textContent,/highlight/i);
  assert.ok(!el('stageExploreSuggestions').querySelectorAll('button').some(b=>/^Selected\s*·/i.test(b.textContent)));
  await new Promise(setImmediate);
  assert.equal(requests().length,0,'selecting, editing or collapsing an exploration sent a request');

  function submit() { fire('stageExploreForm','submit'); }
  function checkRequest(request,mode,chosen) {
    assert.deepEqual(request.exploration,{mode,target:chosen});
    assert.equal(request.scope,'step');
    assert.equal(request.step,2);
    assert.equal(request.stage.partId,'sum');
    assert.deepEqual(request.stage.sourceSteps,[2]);
    assert.deepEqual(request.stage.sourceAnchors,[anchor]);
    assert.equal(request.stage.opening,sumGuide.paragraphs[0]);
    assert.notEqual(request.stage.opening,plan.parts[1].opening,'the old opening is no longer visible to this reader');
    assert.equal(request.stage.localPrerequisites[0].id,'last-edge');
    assert.equal(request.units[1].text,secondPage);
    if (chosen) assert.ok(request.question.includes(chosen),'discussion question omitted the requested target');
  }
  assert.ok(!el('stageExploreSubmit').disabled);
  submit();
  await until(()=>requests().length===1,'worked example was not sent');
  const first=requests()[0];
  checkRequest(first,'example',selected);
  assert.deepEqual(first.history,[]);
  assert.ok(el('stageTurns').textContent.includes(first.question));
  assert.equal(el('stageExploreExample').disabled,true);
  assert.equal(el('stageSend').disabled,true);
  submit();
  await new Promise(setImmediate);
  assert.equal(requests().length,1,'a second submit duplicated the pending turn');
  // Even an erroneous completion signal from the service must leave an exploration open for follow-up.
  const simplerOffer='What if every non-root vertex has only one incoming edge?';
  delayed.resolve({...reply(example),followups:[simplerOffer],stageDecision:{state:'complete',evidence:selected}});
  await until(()=>el('stageTurns').textContent.includes(example),'worked example never appeared');
  assert.equal(el('stageAskForm').hidden,false);

  fire('stageExploreSimplify','click');
  assert.match(el('stageExploreHint').textContent,/choose a simpler case/i);
  assert.ok(el('stageExploreSuggestions').querySelectorAll('button').some(b=>b.title===simplerOffer));
  target.value='   ';
  fire('stageExploreTarget','input');
  await new Promise(setImmediate);
  assert.equal(requests().length,1);
  assert.ok(!el('stageExploreSubmit').disabled,'blank target should allow explicit submission');
  submit();
  await until(()=>el('stageTurns').textContent.includes(simpler),'blank-target simpler problem did not return');
  const second=requests()[1];
  checkRequest(second,'simplify','');
  assert.ok(second.history.some(h=>h.answer===example && h.exploration?.mode==='example'));

  fire('stageExploreSimplify','click');
  target.value=restriction;
  fire('stageExploreTarget','input');
  assert.equal(requests().length,2);
  submit();
  await until(()=>el('stageTurns').textContent.includes(restrictedReply),'the requested simpler instance did not return');
  checkRequest(requests()[2],'simplify',restriction);

  const responseParagraph=el('stageTurns').querySelectorAll('.turn-answer').at(-1);
  app.window.getSelection=()=>({isCollapsed:false,anchorNode:responseParagraph,focusNode:responseParagraph,toString:()=>restrictedReply});
  fire('stageExploreRemove','pointerdown');
  app.window.getSelection=()=>null;
  fire('stageExploreRemove','click');
  assert.equal(target.value,custom,'reopening with highlighted text must preserve the independently typed condition');
  const useHighlight=form.querySelectorAll('button').find(b=>/use.*highlight/i.test(b.textContent));
  assert.ok(useHighlight,'reader can explicitly replace an existing draft with the highlighted passage');
  useHighlight.dispatchEvent(new Event('click'));
  assert.equal(target.value,restrictedReply);
  target.value='  '+custom+'  ';
  fire('stageExploreTarget','input');
  submit();
  await until(()=>el('stageTurns').textContent.includes('temporary failure'),'failed exploration did not surface in discussion');
  checkRequest(requests()[3],'remove',custom);
  const retry=el('stageTurns').querySelectorAll('button').find(b=>b.textContent==='Retry question');
  assert.ok(retry,'failed exploration did not expose its retry');
  retry.dispatchEvent(new Event('click'));
  await until(()=>el('stageTurns').textContent.includes(missing),'retried condition analysis did not appear');
  const retried=requests()[4];
  checkRequest(retried,'remove',custom);
  assert.equal(retried.question,requests()[3].question);
  assert.equal(el('stageTurns').querySelectorAll('article').length,4,'retry duplicated the failed exchange');

  assert.equal(el('stageAskText').value,freeQuestion,'an exploration displaced the regular composer draft');
  fire('stageAskForm','submit');
  await until(()=>el('stageTurns').textContent.includes(ordinary),'regular composer did not work after exploring');
  const normal=requests()[5];
  assert.equal(normal.question,freeQuestion);
  assert.equal(normal.exploration,undefined);
  assert.equal(normal.stage.partId,'sum');
  assert.deepEqual(normal.history.map(h=>h.exploration?.mode),['example','simplify','simplify','remove']);
  assert.equal(el('stageTitle').textContent,secondPart.title);
  const archived=el('stageArchiveList').querySelectorAll('a').find(a=>a.textContent.includes(planParts[0].title));
  archived.dispatchEvent(new Event('click'));
  await until(()=>el('stageTitle').textContent===planParts[0].title,'archive did not open');
  assert.equal(el('stageExplore').hidden,false);
  assert.ok(!el('stageTurns').textContent.includes(example),'second-part reply leaked into the first part');
  for (const control of ['stageExploreExample','stageExploreSimplify','stageExploreRemove']) {
    assert.equal(el(control).disabled,false);
    fire(control,'click');
    assert.equal(form.hidden,false);
    fire(control,'click');
  }
  fire('stageExploreExample','click');
  target.value='the final edge'; fire('stageExploreTarget','input'); submit();
  await until(()=>el('stageTurns').textContent.includes(reviewAnswer),'the example never returned to the earlier discussion');
  assert.equal(el('stageTitle').textContent,planParts[0].title);
  assert.equal(requests().at(-1).stage.partId,'split');
  assert.deepEqual(requests().at(-1).history,[]);
  assert.equal(app.window.READER_SESSION.session(hash).study.activeIndex,1);
  fire('stageResume','click');
  await until(()=>el('stageTitle').textContent===secondPart.title,'review lost the resume point');
  fire('stageContinue','click'); fire('stageCheckSkip','click');
  await until(()=>app.window.READER_SESSION.session(hash).study.activeIndex===2,'the paper did not complete');
  el('stageArchiveList').querySelectorAll('a').find(a=>a.textContent.includes(planParts[0].title)).dispatchEvent(new Event('click'));
  await until(()=>el('stageTitle').textContent===planParts[0].title,'completed paper could not revisit the first part');
  assert.equal(el('stageExplore').hidden,false);
  fire('stageExploreRemove','click');
  target.value='uniqueness'; fire('stageExploreTarget','input'); submit();
  await until(()=>el('stageTurns').textContent.includes(afterCompletion),'completed paper did not allow an exploration');
  assert.equal(requests().at(-1).history[0].answer,reviewAnswer);
  assert.equal(app.window.READER_SESSION.session(hash).study.completed.length,2);
});

test('an optional checkpoint can be dismissed, retried and reviewed before the reader explicitly continues',async () => {
  const pending=deferred(),retryAnswer=deferred();
  const app=createApp({post:[ready],plans:[personalized],
    answers:[{status:'running',key:'check-1'},pending.promise,retryAnswer.promise]});
  await openPdf(app);
  await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>!app.body.dataset.paperState,'the tailored plan did not open');
  app.fire('readCurrentPart','click');
  const {el,fire}=app;
  const [first,next]=personalized.parts;
  const requests=()=>quickCalls(app).filter(c=>c.method==='POST').map(c=>JSON.parse(c.body));
  const session=()=>app.window.READER_SESSION.session(hash);
  const check=el('stageCheckpoint'), text=el('stageCheckText'), question=el('stageFirstQuestion');
  const answer='No. A nonempty path has exactly one last edge, which determines exactly one class.';

  await until(()=>el('stageTitle').textContent===first.title,'first part did not open');
  assert.equal(check.hidden,true);
  assert.ok(!question.textContent.includes(first.question));
  assert.equal(el('stageAskForm').hidden,false);
  fire('stageContinue','click');
  assert.equal(check.hidden,false);
  assert.ok(question.textContent.includes(first.question));
  assert.equal(requests().length,0,'opening the checkpoint should use its saved question');
  assert.equal(session().study.activeIndex,0);
  assert.equal(el('stageCheckSkip').textContent,'Skip');
  text.value='   ';
  fire('stageCheckText','input');
  fire('stageCheckForm','submit');
  await new Promise(setImmediate);
  assert.equal(requests().length,0,'blank text must not start a feedback job');
  fire('stageCheckBack','click');
  assert.equal(check.hidden,true);
  assert.equal(el('stageTitle').textContent,first.title);
  assert.equal(el('stageAskForm').hidden,false);
  assert.equal(session().turns.length,0);

  fire('stageContinue','click');
  text.value=answer;
  fire('stageCheckText','input');
  fire('stageCheckForm','submit');
  await until(()=>requests().length===1,'checking an answer never called the tutor');
  const firstRequest=requests()[0];
  assert.equal(firstRequest.checkpoint,true);
  assert.equal(firstRequest.question,answer);
  assert.equal(firstRequest.stage.question,first.question);
  assert.equal(firstRequest.stage.partId,first.id);
  assert.deepEqual(firstRequest.stage.sourceSteps,first.sourceSteps);
  assert.equal(firstRequest.scope,'step');
  assert.equal(firstRequest.exploration,undefined);
  assert.equal(el('stageCheckSubmit').disabled,true);
  fire('stageCheckForm','submit');
  await new Promise(setImmediate);
  assert.equal(requests().length,1,'double submission duplicated the feedback request');
  pending.resolve({status:'error',message:'The tutor connection timed out.'});
  await until(()=>el('stageCheckFeedback').textContent.includes('timed out'),'a failed check did not display its error');
  assert.equal(text.value,answer,'failed check lost the typed response');
  assert.equal(session().study.activeIndex,0);
  const retry=el('stageCheckFeedback').querySelectorAll('button').find(b=>/retry/i.test(b.textContent));
  assert.ok(retry,'failed check did not offer a retry');
  retry.dispatchEvent(new Event('click'));
  await until(()=>requests().length===2,'feedback retry did not send');
  assert.equal(requests()[1].question,answer);
  assert.equal(requests()[1].checkpoint,true);
  assert.equal(requests()[1].stage.question,first.question);
  assert.equal(session().turns.length,1,'a retry must reuse the original turn');
  const feedback='Yes. Uniqueness gives disjointness, and existence places every nonempty path in a class.';
  retryAnswer.resolve({status:'ready',answer:feedback,sourceStep:1,followups:[],stageDecision:{state:'complete',evidence:answer}});
  await until(()=>el('stageCheckFeedback').textContent.includes(feedback),'feedback did not appear in the checkpoint');
  assert.equal(check.hidden,false);
  assert.equal(el('stageTitle').textContent,first.title);
  assert.equal(session().study.activeIndex,0,'feedback advanced before the reader chose to continue');
  assert.equal(el('stageCheckSkip').textContent,'Continue');
  fire('stageCheckSkip','click');
  await until(()=>el('stageTitle').textContent===next.title,'explicit continuation did not advance');
  assert.equal(check.hidden,true);
  assert.equal(requests().length,2);
  assert.equal(session().turns.length,1);
  assert.equal(session().study.completed.length,1);
});

test('cold reopening keeps an earlier first-question exchange behind the optional check and preserves the full archive',async () => {
  const app=createApp({post:[ready],plans:[personalized]});
  await openPdf(app);
  await checkPublished(app);
  app.fire('continuePreflight','click');
  await until(()=>!app.body.dataset.paperState,'the tailored study was not ready');
  app.fire('readCurrentPart','click');
  const [first,next]=personalized.parts;
  await until(()=>app.el('stageTitle').textContent===first.title,'first part did not open');
  const oldAnswer='A path has one final edge, so its class is uniquely determined.';
  const ordinaryQuestion='How should we count the empty path?';
  const ordinaryAnswer='Count the empty path at its starting vertex as the base case.';
  const stored={studyKey:personalized.key,partId:first.id,topic:'study/'+personalized.key+'/'+first.id,step:1,sourceStep:1,followups:[]};
  for (const [question,answer] of [[first.question,oldAnswer],[ordinaryQuestion,ordinaryAnswer]]) {
    app.window.READER_SESSION.addPrepared(hash,{...stored,question,answer});
  }
  const local=storage();
  local.setItem('proof.sectionReadingMode','full');
  const reopened=createApp({local,library:app.library,search:'?paper='+importedChoice+'&part='+first.id});
  const {el,fire}=reopened;
  await until(()=>el('stageTurns').textContent.includes(ordinaryAnswer),'ordinary Q&A was not restored on the active part');
  assert.ok(el('stageTurns').textContent.includes(ordinaryQuestion));
  assert.ok(!el('stageTurns').textContent.includes(first.question));
  assert.ok(!el('stageTurns').textContent.includes(oldAnswer));
  assert.equal(el('stageCheckpoint').hidden,true);
  fire('stageContinue','click');
  assert.ok(el('stageFirstQuestion').textContent.includes(first.question));
  const savedExplanation=el('stageCheckFeedback').querySelector('details');
  assert.ok(savedExplanation,'the historical explanation did not survive in the optional check');
  assert.ok(!savedExplanation.open);
  assert.ok(savedExplanation.querySelector('summary').textContent);
  savedExplanation.open=true;
  assert.ok(savedExplanation.textContent.includes(oldAnswer));
  fire('stageCheckSkip','click');
  await until(()=>el('stageTitle').textContent===next.title,'skipping did not advance past the historical check');
  assert.equal(el('stageCheckpoint').hidden,true);
  assert.ok(!el('stageTurns').textContent.includes(first.question));
  assert.ok(!el('stageTurns').textContent.includes(oldAnswer));
  const archived=el('stageArchiveList').querySelectorAll('a').find(a=>a.textContent.includes(first.title));
  archived.dispatchEvent(new Event('click'));
  await until(()=>el('stageTitle').textContent===first.title,'could not reopen the historical discussion');
  for (const excerpt of [first.question,oldAnswer,ordinaryQuestion,ordinaryAnswer]) {
    assert.ok(el('stageTurns').textContent.includes(excerpt),'archive lost a historical discussion entry');
  }
  assert.equal(reopened.window.READER_SESSION.session(hash).turns.length,2,'reopening or skipping generated a fake exchange');
  assert.equal(reopened.calls.filter(c=>c.method==='POST').length,0);
});

test('opening an older paper adds the guide in place and keeps its discussion and draft',async () => {
  const original=createApp({post:[ready],plans:[personalized]});
  await openPdf(original);
  await checkPublished(original);
  original.fire('continuePreflight','click');
  await until(()=>!original.body.dataset.paperState,'the original study did not open');
  original.window.READER_SESSION.addPrepared(hash,{studyKey:personalized.key,partId:'split',step:1,sourceStep:1,
    topic:'study/'+personalized.key+'/split',question:'What about the empty path?',answer:'Use it for the base case.'});
  const stored=await original.library.getPreparation('study/'+hash);
  const legacyOpening='When each class has two paths, consider that special case first.';
  for (const study of [stored.study,...Object.values(stored.plans)]) {
    study.parts[0].opening=legacyOpening;
    for (const part of study.parts) part.orientation={purpose:'An earlier why-field.',takeaway:'An earlier takeaway.',
      handoff:'An earlier closing.',statement:splitGuide.statement};
    delete study.orientationJob;
    delete study.editorialRevision;
  }
  stored.savedAt++;
  await original.library.savePreparation('study/'+hash,stored);

  const upgrade=deferred();
  const app=createApp({library:original.library,search:'?paper='+importedChoice+'&part=split',
    plans:[{status:'error',message:'The reading guide could not be prepared.'},upgrade.promise]});
  const {el}=app;
  await until(()=>app.body.dataset.readingView==='part' && el('stageOrientationRetry') && !el('stageOrientationRetry').hidden,'failed guide upgrade did not offer a retry');
  assert.ok(el('stageOpening').textContent.includes(legacyOpening));
  assert.equal(el('stageIntroduction').textContent,planParts[0].summary);
  assert.doesNotMatch(el('stageOrientation').textContent,/Why this step|After this part|An earlier why-field|An earlier takeaway/);
  assert.equal(el('stageNotation').hidden,true);
  assert.equal(el('stageDefinitions').hidden,true);
  assert.ok(el('stageTurns').textContent.includes('Use it for the base case.'));
  const draft='Why does each path choose one last edge?';
  el('stageAskText').value=draft;
  app.fire('stageAskText','input');
  app.fire('stageOrientationRetry','click');
  await until(()=>app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST').length===2,'the retry did not request an update');
  app.fire('stageExploreExample','click');
  el('stageExploreTarget').value='My own example target';
  app.fire('stageExploreTarget','input');
  app.fire('stageExploreExample','click');
  const openingNode=el('stageOpening').firstElementChild;
  app.window.getSelection=()=>({isCollapsed:false,anchorNode:openingNode,focusNode:openingNode,toString:()=>legacyOpening});
  app.fire('stageExploreRemove','pointerdown');
  app.window.getSelection=()=>null;
  app.fire('stageExploreRemove','click');
  assert.equal(el('stageExploreTarget').value,legacyOpening);
  assert.ok(el('stageExploreSuggestions').querySelectorAll('button').some(b=>b.title===legacyOpening));
  el('stageAskText').focus();
  const request=JSON.parse(app.calls.filter(c=>c.url==='/api/reading-plan' && c.method==='POST').at(-1).body);
  assert.equal(request.mode,'orientation');
  assert.equal(request.analysis.revision,ready.key);
  upgrade.resolve({status:'ready',mode:'orientation',key:'orientation-only',editorialRevision,parts:personalized.parts.map(p=>({id:p.id,orientation:p.orientation}))});
  await until(()=>el('stageStatementLabel').textContent===splitGuide.statement.label,'the statement did not appear after enrichment');
  assert.equal(el('stageStatement').hidden,false);
  assert.ok(el('stageHandoff').textContent.includes(splitGuide.handoff));
  assert.deepEqual(el('stageLeadIn').querySelectorAll('p').map(p=>p.textContent),splitGuide.paragraphs.slice(0,1));
  assert.deepEqual(el('stageOpening').querySelectorAll('p').map(p=>p.textContent),splitGuide.paragraphs.slice(1));
  assert.equal(el('stageIntroduction').textContent,splitGuide.introduction);
  assert.equal(el('stageNotation').hidden,false);
  assert.equal(el('stageNotation').open,false,'background enrichment should not open the reference');
  assert.equal(el('stageDefinitions').hidden,false);
  assert.ok(el('stageTurns').textContent.includes('Use it for the base case.'));
  assert.equal(el('stageAskText').value,draft);
  assert.equal(app.window.document.activeElement,el('stageAskText'));
  assert.equal(el('stageExploreTarget').value,'','a highlight must expire when its source passage is replaced');
  assert.ok(!el('stageExploreSuggestions').querySelectorAll('button').some(b=>b.title===legacyOpening));
  app.fire('stageExploreExample','click');
  assert.equal(el('stageExploreTarget').value,'My own example target','updates should preserve a manually edited target');
  assert.equal(app.window.READER_SESSION.session(hash).study.key,personalized.key);
  assert.equal(app.window.READER_SESSION.session(hash).study.activeIndex,0);
  assert.equal(fullPosts(app).length,0);
});

test('stage updates retain typeset headings and keep drafts scoped to their study',() => {
  const document=documentFixture(), location=new URL('http://fixture.invalid/?paper=sample');
  const rendered=[];
  const window={READER_MATH:{render(node) {
    rendered.push(node.id);
    if (node.id==='stageTitle') {
      const equation=document.createElement('span');
      equation.className='reader-math';
      equation.textContent=node.textContent;
      node.replaceChildren(equation);
    }
  }}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'stage-ui.js'),'utf8'),{window,document,location,URL});
  const part={...planParts[0],title:'Counting paths to \\(v\\)'};
  const data={paperKey:'sample',studyKey:'first-plan',part,parts:[part],index:0,furthest:0,turns:[],
    orientation:splitGuide,localIntroductions:[],onAsk(){},onExplore(){}};
  const el=id=>document.getElementById(id);
  window.STAGE_UI.part(data);
  const heading=el('stageTitle').firstElementChild;
  assert.equal(heading.className,'reader-math');
  el('stageNotationTitle').click();
  const formula=document.createElement('span');
  formula.className='reader-math';
  formula.textContent='v';
  el('stageLeadIn').firstElementChild.append(formula);
  const mathToken={getRootNode:()=>({host:formula})};
  window.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:mathToken,focusNode:mathToken,toString:()=>'v'});
  el('stageExploreExample').dispatchEvent(new Event('pointerdown'));
  window.getSelection=()=>null;
  el('stageExploreExample').dispatchEvent(new Event('click'));
  assert.equal(el('stageExploreTarget').value,'v','a single inline symbol in the setup should be selectable as an exploration target');
  el('stageExploreExample').dispatchEvent(new Event('click'));
  el('stageAskText').value='My draft for this plan';
  el('stageAskText').dispatchEvent(new Event('input'));
  window.STAGE_UI.part({...data,busy:true});
  assert.equal(el('stageTitle').firstElementChild,heading);
  assert.equal(rendered.filter(id=>id==='stageTitle').length,1);
  assert.equal(rendered.filter(id=>id==='stageNotationList').length,1);
  assert.equal(el('stageNotation').open,true,'normal tutor updates should preserve an open reference');
  const {formalAfter,...legacyGuide}=splitGuide;
  window.STAGE_UI.part({...data,orientation:legacyGuide});
  assert.equal(el('stageLeadIn').textContent,'');
  assert.deepEqual(el('stageOpening').querySelectorAll('p').map(p=>p.textContent),legacyGuide.paragraphs);
  window.STAGE_UI.part({...data,orientation:{...sumGuide,formalAfter:2}});
  assert.equal(el('stageLeadIn').textContent,'','without formal boxes the proof should stay together');
  assert.deepEqual(el('stageOpening').querySelectorAll('p').map(p=>p.textContent),sumGuide.paragraphs);
  assert.equal(el('stageNotation').hidden,true);
  assert.equal(el('stageNotation').open,false);
  window.STAGE_UI.part(null);
  window.STAGE_UI.part({...data,studyKey:'second-plan'});
  assert.equal(el('stageAskText').value,'');
  window.STAGE_UI.part(data);
  assert.equal(el('stageAskText').value,'My draft for this plan');
});

test('a recovered definition group keeps its claims together and opens each original passage',()=>{
  const document=documentFixture(),location=new URL('http://fixture.invalid/?paper=weights'),window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'stage-ui.js'),'utf8'),{window,document,location,URL});
  const opened=[],group='Rounded and actual live weight',part=planParts[0];
  const data={paperKey:'weights',studyKey:'ready',part,parts:[part],index:0,furthest:0,turns:[],localIntroductions:[],
    orientation:{...splitGuide,definitions:[
      {name:'Rounded live weight',text:'Use the rounded weight of each unfinished job.',claimSource:{group,step:9,page:4}},
      {name:'Actual live weight',text:'Use the original weight of each unfinished job.',claimSource:{group,step:1,page:1}},
    ]},onSource:step=>opened.push(step)};
  window.STAGE_UI.part(data);
  const cards=document.getElementById('stageDefinitions').querySelectorAll('section');
  assert.equal(cards.length,1);
  assert.deepEqual(cards[0].querySelectorAll('h3').map(e=>e.textContent),['Definition · '+group]);
  assert.deepEqual(cards[0].querySelectorAll('h4').map(e=>e.textContent),['Rounded live weight','Actual live weight']);
  const links=cards[0].querySelectorAll('a');
  assert.deepEqual(links.map(a=>a.textContent),['Page 4','Page 1']);
  links.forEach(a=>a.click());
  assert.deepEqual(opened,[9,1]);
  delete data.orientation.definitions[1].claimSource.page;
  window.STAGE_UI.part(data);
  assert.equal(document.getElementById('stageDefinitions').querySelectorAll('a')[1].textContent,'Source passage 1');
});

test('opening an imported part loads its steps and carries the selected mathematical context to its discussion',async()=>{
  const received=deferred();
  const key='fixture-structure';
  const modules=[
    {id:'identify',title:'Identify a last edge',claim:'A nonempty directed path ends in a unique edge.',
      assumptions:['The path contains an edge.'],dependsOn:[],sourceStep:1,sourcePage:1,explanation:'Read the path in its stated direction.'},
    {id:'disjoint',title:'Separate the classes',claim:'Two different final edges give disjoint classes.',
      assumptions:['Every path has a unique final edge.'],dependsOn:['identify'],sourceStep:1,sourcePage:1,explanation:'A path with one final edge cannot end in a different edge.'}
  ];
  const result={key,partId:'split',status:'ready',goal:'Partition the paths by their last edge.',modules};
  const reply=answer=>({key:'fixture-answer',status:'ready',sourceStep:1,answer,followups:[],stageDecision:{state:'continue',evidence:''}});
  const app=createApp({post:[ready],plans:[personalized],structures:[{status:'running',key},received.promise],
    answers:[{status:'error',message:'A temporary interruption.'},reply('The two classes have no path in common.'),reply('Start from any endpoint.')]});
  const {el,fire}=app;
  const calls=()=>app.calls.filter(c=>c.url.startsWith('/api/section-structure'));
  const questions=()=>quickCalls(app).filter(c=>c.method==='POST').map(c=>JSON.parse(c.body));
  await openPdf(app);await checkPublished(app);
  fire('continuePreflight','click');
  await until(()=>!app.body.dataset.paperState,'overview unavailable');
  assert.equal(calls().length,0);
  fire('readCurrentPart','click');
  await until(()=>calls().some(c=>c.method==='GET'),'no status poll for the opened section');
  assert.equal(el('stageFullSection').hidden,false);
  const posted=JSON.parse(calls()[0].body);
  assert.equal(posted.title,printedTitle);
  assert.equal(posted.studyKey,personalized.key);
  assert.equal(posted.stage.partId,'split');
  assert.deepEqual(posted.stage.sourceSteps,[1]);
  assert.equal(posted.units[0].text,pages[0]);
  received.resolve(result);
  await until(()=>app.window.STAGE_UI.currentModule()==='identify','modular reading did not become available');
  fire('stageProofNext','click');
  fire('stageExploreRemove','click');
  fire('stageExploreForm','submit');
  await until(()=>el('stageTurns').textContent.includes('temporary interruption'),'missing failed turn');
  assert.deepEqual(questions()[0].stage.moduleFocus,{title:modules[1].title,claim:modules[1].claim,explanation:modules[1].explanation,
    sourceStep:1,assumptions:modules[1].assumptions,dependsOn:[modules[0].title]});
  fire('stageProofBack','click');
  const retry=el('stageTurns').querySelectorAll('button').find(button=>button.textContent.includes('Retry'));
  assert.ok(retry);
  retry.click();
  await until(()=>el('stageTurns').textContent.includes('no path in common'),'missing retry answer');
  assert.deepEqual(questions()[1].stage.moduleFocus,questions()[0].stage.moduleFocus);
  fire('stageModeFull','click');
  el('stageAskText').value='How do I start the proof?';
  fire('stageAskForm','submit');
  await until(()=>el('stageTurns').textContent.includes('Start from any endpoint.'),'missing full section discussion');
  assert.equal(questions()[2].stage.moduleFocus,undefined);
  assert.equal(calls().filter(c=>c.method==='POST').length,1);
  assert.equal(app.window.READER_SESSION.session(hash).study.activeIndex,0);
});

test('the step reader exposes the mathematical argument and explores one step in its own section',async()=>{
  const document=documentFixture(), location=new URL('http://fixture.invalid/?paper=sample');
  const pref=storage(), window={localStorage:pref}, sources=[],requested=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'stage-ui.js'),'utf8'),{document,window,location,URL});
  const ui=window.STAGE_UI, el=id=>document.getElementById(id);
  const base={paperKey:'sample',studyKey:'first',part:planParts[0],parts:planParts,index:0,furthest:1,turns:[],
    orientation:splitGuide,onExplore(){},onReadStructure(){requested.push('split');},onSource:n=>sources.push(n)};
  const modules=[
    {id:'identify',title:'Identify the last edge',claim:'Every nonempty path has one final edge.',
      explanation:'Reading a path backward singles out the last edge before the endpoint.',assumptions:['The path is nonempty.'],dependsOn:[],
      sourceStep:1,sourcePage:1,sourceQuote:'The nonempty paths are partitioned by their last edge.'},
    {id:'count',title:'Count each class once',claim:'Two different last edges give disjoint classes.',
      explanation:'A path cannot end with two different edges.',assumptions:[],dependsOn:['identify'],sourceStep:1,
      verification:{status:'verified',source:'Lean kernel secret.'},formal:{conclusion:'Private machine data.'}},
  ];
  const guide={status:'ready',partId:'split',goal:'Count the paths ending at this vertex.',overview:'Partition them by the last edge.',modules};
  ui.part(base);ui.part(base);await Promise.resolve();
  assert.deepEqual(requested,['split']);
  assert.equal(el('stageReadMode').hidden,false);
  assert.equal(el('stageFullSection').hidden,false);
  assert.equal(el('stageProofNotice').hidden,false);
  assert.equal(ui.currentModule(),null);
  ui.part({...base,sectionGuide:{status:'error',message:'Lean compiler internal error.'}});
  assert.equal(el('stageProofRetry').hidden,false);
  assert.doesNotMatch(el('stageProofStatus').textContent,/Lean|compiler/i);
  const publicFailure='A cited passage could not be located in the original section.';
  ui.part({...base,sectionGuide:{status:'error',failureStage:'formulating',failureCode:'locator',message:publicFailure}});
  assert.equal(el('stageProofStatus').textContent,publicFailure);
  el('stageProofRetry').click();await Promise.resolve();
  assert.equal(requested.length,2);
  const ready={...base,sectionGuide:guide};
  ui.part(ready);
  assert.equal(ui.currentModule(),'identify');
  assert.equal(el('stageFullSection').hidden,true);
  assert.equal(el('stageProofNotice').hidden,true);
  assert.equal(el('stageProofBack').disabled,true);
  assert.equal(el('stageProofOutlineList').querySelector('button').getAttribute('aria-current'),'step');
  el('stageProofContent').querySelector('a').click();
  assert.deepEqual(sources,[1]);
  el('stageProofNext').click();
  assert.equal(el('stageProofHeading').textContent,'Count each class once');
  assert.equal(el('stageProofCount').textContent,'Step 2 of 2');
  assert.equal(el('stageProofNext').disabled,true);
  assert.equal(ui.currentModule(),'count');
  ui.part({...ready,archived:true});
  assert.equal(ui.currentModule(),'count');
  assert.equal(el('stageExplore').hidden,false);
  assert.doesNotMatch(el('stageProofStructure').textContent,/Lean|kernel|verified|Private machine/);
  el('stageProofContent').querySelector('.proof-links').querySelector('button').click();
  assert.equal(ui.currentModule(),'identify');
  const claim=el('stageProofContent').querySelector('.proof-claim');
  window.getSelection=()=>({isCollapsed:false,rangeCount:1,anchorNode:claim,focusNode:claim,toString:()=>'one final edge'});
  el('stageExploreExample').dispatchEvent(new Event('pointerdown'));
  window.getSelection=()=>null;
  el('stageExploreExample').click();
  assert.equal(el('stageExploreTarget').value,'one final edge');
  el('stageModeFull').click();
  assert.equal(ui.currentModule(),null);
  assert.equal(el('stageFullSection').hidden,false);
  assert.equal(pref.getItem('proof.sectionReadingMode'),'full');
  ui.part({...base,index:1,part:planParts[1],sectionGuide:guide});
  assert.equal(el('stageProofStructure').hidden,true);
  assert.equal(requested.length,2);
  const second={...base,index:1,part:planParts[1],onReadStructure(){requested.push('sum');}};
  ui.part(second);el('stageModeSteps').click();await Promise.resolve();
  assert.deepEqual(requested,['split','split','sum']);
  ui.part(null);
  assert.equal(ui.currentModule(),null);
});
