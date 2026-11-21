const assert=require('node:assert/strict');
const {createHash,webcrypto}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

function load(name,env) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,name),'utf8'),env,{filename:name});
}
function storage() {
  const map=new Map();
  return {getItem:key=>map.get(key) ?? null,setItem:(key,value)=>map.set(key,String(value)),
    removeItem:key=>map.delete(key),get length(){return map.size;},key:i=>[...map.keys()][i] ?? null};
}
function transaction(records) {
  let pending=0;
  const tx={objectStore:()=>({
    get:key=>schedule(()=>records.get(key)),getKey:key=>schedule(()=>records.has(key)?key:undefined),
    delete:key=>schedule(()=>records.delete(key)),put:(blob,key)=>schedule(()=>records.set(key,blob))
  }),abort:()=>tx.onabort()};
  function schedule(fn) {
    const r={};
    pending++;
    setImmediate(()=>{
      r.result=fn();
      r.onsuccess?.();
      if (!--pending) tx.oncomplete();
    });
    return r;
  }
  return tx;
}

test('last-PDF removal verifies the bytes and preserves a different file with identical filename and size',async()=>{
  const records=new Map();
  const indexedDB={databases:async()=>[{name:'proof-reader-imported-pdf'}],open:()=>{
    const r={result:{transaction:()=>transaction(records),close(){}}};
    setImmediate(()=>r.onsuccess());
    return r;
  }};
  const original=new File(['one'],'same.pdf'),different=new File(['two'],'same.pdf');
  const hash=createHash('sha256').update('one').digest('hex');
  let published='previous';
  const window={PAPER_REMOVAL:{generation:()=>published}};
  load('pdf-reader.js',{window,indexedDB,Blob,crypto:webcrypto});
  const api=window.PDF_READER;
  records.set('last',different);
  await api.removeIfMatching(hash,'first');
  assert.equal(records.get('last'),different);
  await api.save(original,hash,'previous');
  assert.equal(records.get('last'),different);
  published='first';
  await api.save(original,hash,'first');
  assert.equal(records.get('last'),original);
  await api.removeIfMatching(hash,'second');
  await api.save(original,hash,'first');
  assert.equal(records.has('last'),false,'before local publication, a stale writer is fenced by the blob transaction');
  published='second';
  await api.save(original,hash,'second');
  await api.removeIfMatching(hash,'second');
  assert.equal(records.get('last'),original,'retrying an already applied token preserves a new upload');
});

test('a fresh app finishes an interrupted local erasure using the original token',async()=>{
  const id='a'.repeat(64),localStorage=storage(),sessionStorage=storage(),tokens=[];
  function open(crash) {
    const window=new EventTarget();
    window.PDF_READER={removeIfMatching:async(hash,token)=>{assert.equal(hash,id);tokens.push(token);}};
    window.PAPER_LIBRARY={remove:async(hash,token)=>{
      assert.equal(hash,id);assert.equal(token,tokens.at(-1));if(crash) throw Error('Storage temporarily busy');
    }};
    load('paper-removal.js',{window,localStorage,sessionStorage,CustomEvent,crypto:webcrypto});
    return window.PAPER_REMOVAL;
  }
  await assert.rejects(open(true).remove(id),/Storage temporarily busy/);
  const key='proofreader.removing.'+id,token=localStorage.getItem(key);
  assert.ok(token);
  const recovered=open(false);
  await recovered.resumePending('b'.repeat(64));
  assert.equal(tokens.length,1);
  await recovered.resumePending();
  assert.deepEqual(tokens,[token,token]);
  assert.equal(localStorage.getItem(key),null);
  assert.equal(recovered.generation(id),token);
  await recovered.resumePending(id);
  assert.equal(tokens.length,2);
});

test('another window forgets only the removed paper’s transient study, last import, and optional checkpoint',()=>{
  const hash='a'.repeat(64),other='b'.repeat(64),localStorage=storage(),sessionStorage=storage();
  const window=new EventTarget(),released=[],seen=[];
  window.READER_SESSION={forget:key=>released.push(key)};
  window.addEventListener('proofreader-paper-removed',e=>seen.push(e.detail.hash));
  load('paper-removal.js',{window,localStorage,sessionStorage,CustomEvent,crypto:webcrypto});
  const choice=key=>'proofreader.optionalCheck.'+JSON.stringify([JSON.stringify([key,'part1']),'study']);
  for (const key of [hash,other]) {
    sessionStorage.setItem(choice(key),'checkpoint');
    for (const kind of ['study','questions','preparation']) sessionStorage.setItem('proof.'+kind+'.'+key,'state');
  }
  sessionStorage.setItem('proofreader.lastImport',JSON.stringify({hash}));
  sessionStorage.setItem('proofreader.reading',JSON.stringify({paperId:'import'}));
  localStorage.setItem('proofreader.generation.'+hash,'removed');
  const event=Object.assign(new Event('storage'),{key:'proofreader.generation.'+hash,newValue:'removed'});
  window.dispatchEvent(event);
  for (const field of [choice(hash),'proofreader.lastImport','proofreader.reading']) assert.equal(sessionStorage.getItem(field),null);
  for (const kind of ['study','questions','preparation']) {
    assert.equal(sessionStorage.getItem('proof.'+kind+'.'+hash),null);
    assert.equal(sessionStorage.getItem('proof.'+kind+'.'+other),'state');
  }
  assert.equal(sessionStorage.getItem(choice(other)),'checkpoint');
  assert.deepEqual(released,[hash]);
  assert.deepEqual(seen,[hash]);
});

test('removing a bundled paper persists across reloads and clears only its own reading state',async()=>{
  const id='intervals',other='d'.repeat(64),uploaded='a'.repeat(64);
  const analysis='b'.repeat(64),plan='c'.repeat(64);
  const localStorage=storage(),sessionStorage=storage();
  const key=name=>'proofreader.'+name;
  const makeChoice=paper=>[JSON.stringify([paper,'model']),{state:'known'}];
  const optOut=paper=>[JSON.stringify([paper,'technique']),false];
  const profile={definitionChoices:[id,other,uploaded].map(makeChoice),paperTechniqueChoices:[id,other].map(optOut),mastery:[['shared',true]]};
  localStorage.setItem(key('knowledge'),JSON.stringify(profile));
  for (const paper of [id,other,uploaded]) {
    localStorage.setItem('proof.research.'+paper,JSON.stringify({key:analysis}));
    localStorage.setItem('proof.study.'+paper,JSON.stringify({study:{key:plan}}));
    localStorage.setItem('proof.tutor.'+paper,'discussion');
    sessionStorage.setItem('proof.questions.'+paper,'draft');
  }
  localStorage.setItem(key('partLocation.'+id),'part1');
  localStorage.setItem(key('partLocation.doc-'+uploaded),'part2');
  localStorage.setItem(key('lastPaper'),id);
  sessionStorage.setItem(key('reading'),JSON.stringify({paperId:id}));
  sessionStorage.setItem(key('lastImport'),JSON.stringify({hash:uploaded}));
  sessionStorage.setItem('notation-reference/'+uploaded,'shared source');
  const open=()=>{
    const window=new EventTarget();
    // No PDF adapter. The built-in and an independently uploaded copy can share original bytes.
    window.PAPER_LIBRARY={getPreparation:async()=>null,remove:async paper=>assert.equal(paper,id)};
    load('paper-removal.js',{window,localStorage,sessionStorage,CustomEvent,crypto:webcrypto});
    return window;
  };
  const w=open(),api=w.PAPER_REMOVAL,events=[];
  w.addEventListener('proofreader-paper-removed',event=>events.push(event.detail.hash));
  assert.equal(api.isBundleHidden(id),false);
  assert.deepEqual(Array.from((await api.evidence(id)).analysisKeys),[analysis]);
  assert.deepEqual(Array.from((await api.evidence(id)).planKeys),[plan]);
  await api.remove(id);
  const fresh=open().PAPER_REMOVAL;
  assert.equal(fresh.isBundleHidden(id),true);
  assert.equal(fresh.isBundleHidden(other),false);
  assert.equal(fresh.isBundleHidden(uploaded),false);
  assert.deepEqual(events,[id]);
  assert.equal(localStorage.getItem(key('lastPaper')),null);
  assert.equal(sessionStorage.getItem(key('reading')),null);
  assert.equal(localStorage.getItem(key('partLocation.'+id)),null);
  assert.equal(localStorage.getItem(key('partLocation.doc-'+uploaded)),'part2');
  assert.equal(JSON.parse(sessionStorage.getItem(key('lastImport'))).hash,uploaded);
  assert.equal(sessionStorage.getItem('notation-reference/'+uploaded),'shared source');
  for (const [store,prefix] of [[localStorage,'proof.research.'],[localStorage,'proof.study.'],
    [localStorage,'proof.tutor.'],[sessionStorage,'proof.questions.']]) {
    assert.equal(store.getItem(prefix+id),null);
    assert.ok(store.getItem(prefix+other));
    assert.ok(store.getItem(prefix+uploaded));
  }
  assert.deepEqual(JSON.parse(localStorage.getItem(key('knowledge'))),{
    ...profile,definitionChoices:[other,uploaded].map(makeChoice),paperTechniqueChoices:[optOut(other)]
  });
  assert.throws(()=>api.remove('doc-'+uploaded),/Select a paper/);
  assert.throws(()=>api.remove('study/intervals'),/Select a paper/);
});

test('an interrupted demo removal resumes on startup and notifies other open windows',async()=>{
  const id='intervals',localStorage=storage(),sessionStorage=storage();
  const token='pending-demo-removal',pending='proofreader.removing.'+id;
  localStorage.setItem(pending,token);
  localStorage.setItem('proofreader.removing.unknown','other');
  const window=new EventTarget();
  window.PAPER_LIBRARY={remove:async(paper,receipt)=>{assert.equal(paper,id);assert.equal(receipt,token);}};
  load('paper-removal.js',{window,localStorage,sessionStorage,CustomEvent,crypto:webcrypto});
  const api=window.PAPER_REMOVAL;
  await api.resumePending();
  assert.equal(api.isBundleHidden(id),true);
  assert.equal(localStorage.getItem(pending),null);
  assert.equal(localStorage.getItem('proofreader.removing.unknown'),'other');
  const events=[];
  window.addEventListener('proofreader-paper-removed',event=>events.push(event.detail.hash));
  sessionStorage.setItem('proofreader.reading',JSON.stringify({paperId:id}));
  window.dispatchEvent(Object.assign(new Event('storage'),{key:'proofreader.generation.'+id,newValue:token}));
  assert.deepEqual(events,[id]);
  assert.equal(sessionStorage.getItem('proofreader.reading'),null);
});
