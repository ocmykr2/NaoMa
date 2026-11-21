const assert = require('node:assert/strict');
const test = require('node:test');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const load = (file, globals) => vm.runInNewContext(readFileSync(path.join(__dirname,file),'utf8'),globals);
const storage = () => {
  const values = new Map();
  return {getItem: k => values.get(k), setItem(k,v) { values.set(k,v); }};
};
const complete = {
  status:'ready', key:'new', preparationVersion:2, displayTitle:'Counting Exchange Pairs',
  parts:[{id:'pairs',title:'Counting pairs',sourceSteps:[1]}],localIntroductions:[],
  papers:[], skills:[], message:'No earlier paper was verified.',
  overview:{paragraphs:['Count pairs of objects.','An exchange preserves the total.'],
    suggestions:[{question:'Why pair the objects?',step:1},{question:'What changes in the exchange?',step:2}]},
  knowledge:{techniques:[],definitionGroups:[]},
};
function fixture({local = storage(), library, respond} = {}) {
  const calls = [];
  const listeners = [];
  const window = {PAPER_LIBRARY:library,dispatchEvent:e=>listeners.push(e.detail)};
  load('reading-session.js',{window,localStorage:local,sessionStorage:storage(),location:{protocol:'http:'},document:{hidden:false},
    setTimeout:fn=>setImmediate(fn),crypto,CustomEvent:class {constructor(_,args){this.detail=args.detail;}},
    fetch:async (url,args) => {
      calls.push([args?.method || 'GET',url]);
      const reply = respond ? await respond(url,args) : complete;
      return {ok:!reply.httpStatus,status:reply.httpStatus || 200,json:async()=>structuredClone(reply)};
    }});
  return {api:window.READER_SESSION,calls,listeners};
}
const source = async () => ({title:'Original source',units:[{title:'Part',text:'Its proof.'}]});
const key = 'same-hash';
const copy = obj => JSON.parse(JSON.stringify(obj));

test('reopening a disconnected paper import reattaches to its existing job',async()=>{
  const local=storage();
  const first=fixture({local,respond:async(url,args)=>args?.method==='POST'?{status:'running',key:'existing'}:{httpStatus:503,error:'Offline'}});
  await first.api.prepare(key,source);
  assert.equal(first.api.session(key).research.status,'error');
  assert.equal(first.api.session(key).research.disconnected,true);
  const reopened=fixture({local,respond:async(url,args)=>{
    assert.equal(args?.method || 'GET','GET');
    assert.equal(url,'/api/techniques/existing');
    return {...complete,key:'existing'};
  }});
  await reopened.api.resume(key,source);
  assert.ok(reopened.api.isPrepared(reopened.api.session(key).research));
  assert.equal(reopened.calls.length,1);
});

test('a saved opt-in resumes a pre-key interruption and sends one preparation request',async () => {
  const local = storage();
  const a=fixture({local});
  a.api.setPreparation(key,true);
  assert.equal(a.api.session(key).research.status,'queued');
  local.setItem('proof.research.'+key,JSON.stringify({status:'starting',preparation:true,requestedVersion:1}));
  const b=fixture({local,respond:(url,args)=>args ? {status:'running',key:'new'} : complete});
  const pending=b.api.resume(key,source);
  await Promise.all([pending,b.api.resume(key,source),b.api.prepare(key,source),
    b.api.ask(key,source,{topic:'paper-overview',question:'Generate a brief',step:0})]);
  assert.deepEqual(b.calls,[['POST','/api/techniques'],['GET','/api/techniques/new']]);
  assert(b.api.isPrepared(b.api.session(key).research));
  const c=fixture({local});
  await c.api.resume(key,source);
  assert.deepEqual(c.calls,[]);
  assert(c.api.isPrepared(c.api.session(key).research));
});

test('legacy running research is polled and upgraded once, while old reading history never opts in',async () => {
  const local=storage();
  local.setItem('proof.tutor.'+key,JSON.stringify([{step:0,topic:'paper-overview',status:'ready',answer:'An older brief.'}]));
  const untouched=fixture({local});
  await untouched.api.resume(key,source);
  assert.deepEqual(untouched.calls,[]);
  assert.equal(untouched.api.session(key).research.preparation,undefined);
  local.setItem('proof.research.'+key,JSON.stringify({status:'running',key:'old',papers:[{title:'Prior finding'}]}));
  const resumed=fixture({local,respond:(url,args)=>args ? complete : {status:'ready',key:'old',papers:[],skills:[]}});
  await Promise.all([resumed.api.resume(key,source),resumed.api.resume(key,source)]);
  assert.deepEqual(resumed.calls,[['GET','/api/techniques/old'],['POST','/api/techniques']]);
  assert(resumed.api.isPrepared(resumed.api.session(key).research));
  assert.equal(resumed.api.session(key).turns[0].answer,'An older brief.');
  resumed.api.setPreparation(key,false);
  const restarted=fixture({local});
  await restarted.api.resume(key,source);
  assert.equal(restarted.api.session(key).research.preparation,false);
  assert.deepEqual(restarted.calls,[]);
});

test('legacy ready/error, explicit source-only, expired IDs, incomplete results and manual retry',async () => {
  for (const status of ['ready','error','failed']) {
    const local=storage();
    local.setItem('proof.research.'+key,JSON.stringify({status,knowledge:{techniques:[],definitionGroups:[]}}));
    const {api,calls}=fixture({local});
    await api.resume(key,source);
    if (status==='ready') {
      assert.equal(calls.length,1);
      assert(api.isPrepared(api.session(key).research));
    } else {
      assert.deepEqual(calls,[]);
      assert.equal(api.session(key).research.unexpected,true);
    }
  }
  const local=storage();
  local.setItem('proof.research.'+key,JSON.stringify({...complete,status:'running',preparation:true,key:'missing',requestedVersion:1}));
  let attempts=0;
  const {api,calls}=fixture({local,respond:(url,args)=> !args ? {httpStatus:404,error:'Expired'} :
    ++attempts===1 ? {status:'ready',key:'old-build',papers:[],skills:[]} : complete});
  await api.resume(key,source);
  const failed=api.session(key).research;
  assert.equal(failed.status,'error');
  assert.equal(failed.displayTitle,complete.displayTitle);
  assert.deepEqual(copy(failed.overview),complete.overview);
  await api.resume(key,source);
  assert.equal(calls.length,2);
  await api.prepare(key,source);
  assert.equal(calls.length,3);
  assert(api.isPrepared(api.session(key).research));
  for (const invalid of [{displayTitle:'file.pdf'},{displayTitle:'Untitled'},{message:''},
    {overview:{paragraphs:['Only one'],suggestions:[]}},{knowledge:{}},{preparationVersion:0}]) {
    assert.equal(api.isPrepared({...complete,...invalid}),false);
  }
  const optedOut=fixture({local:storage()});
  optedOut.api.setPreparation(key,false);
  await optedOut.api.resume(key,source);
  assert.deepEqual(optedOut.calls,[]);
});

test('durable result restores after local storage runs out of space',async () => {
  const journal=new Map();
  const library={savePreparation:async(k,job)=>journal.set(k,structuredClone(job)),getPreparation:async k=>structuredClone(journal.get(k))};
  const local=storage();
  const set=local.setItem;
  local.setItem=(k,v)=>{ if(v.length>300)throw new Error('Quota');set(k,v); };
  const a=fixture({local,library});
  a.api.setPreparation(key,true);
  await a.api.resume(key,source);
  const b=fixture({local,library});
  await b.api.resume(key,source);
  assert(b.api.isPrepared(b.api.session(key).research));
  assert.deepEqual(b.calls,[]);
});

test('a stale incomplete IndexedDB snapshot cannot certify a ready marker',async () => {
  const local=storage();
  local.setItem('proof.research.'+key,JSON.stringify({status:'ready',savedAt:20,key:'later',needsArtifacts:true,preparation:true}));
  const library={getPreparation:async()=>({...complete,key:'earlier',savedAt:10,knowledge:undefined})};
  const {api,calls}=fixture({local,library});
  const restored=await api.restorePreparation(key);
  assert.equal(restored.status,'queued');
  assert.equal(api.isPrepared(restored),false);
  assert.deepEqual(calls,[]);
  await api.resume(key,source);
  assert(api.isPrepared(api.session(key).research));
});

// Model ordered IDB requests inside a transaction and the existing v1 stores.
function databaseFixture() {
  const stores=new Map([['catalog',new Map()],['sources',new Map()]]);
  let version=1;
  const db={
    objectStoreNames:{contains:name=>stores.has(name)},
    createObjectStore:name=>stores.set(name,new Map()), close(){},
    transaction() {
      let pending=0;
      const tx={
        objectStore(name) {
          const records=stores.get(name);
          function operation(fn) {
            pending++;
            const req={};
            setImmediate(()=>{
              req.result=structuredClone(fn());
              req.onsuccess?.();
              if (--pending===0) tx.oncomplete();
            });
            return req;
          }
          return {get:k=>operation(()=>records.get(k)),getAll:()=>operation(()=>[...records.values()]),
            delete:k=>operation(()=>records.delete(k)),
            put:value=>operation(()=>{ records.set(value.hash,structuredClone(value)); return value.hash; })};
        },
        abort(){tx.onabort();},
      };
      return tx;
    },
  };
  return {open(_,newVersion) {
    const req={result:db};
    setImmediate(()=>{
      if(newVersion>version){version=newVersion;req.onupgradeneeded();}
      req.onsuccess();
    });
    return req;
  }};
}

test('catalog rename and repeat imports preserve original PDF bytes, title, and latest preparation',async () => {
  const indexedDB=databaseFixture();
  const window={indexedDB};
  load('paper-library.js',{window,indexedDB,Blob,structuredClone});
  const lib=window.PAPER_LIBRARY;
  const file=new Blob(['original bytes']);
  const value={hash:key,name:'scan.pdf',file,text:'',pages:['Original page'],paper:{title:'Scan'}};
  await lib.save(value);
  assert.equal(await lib.renameTitle('absent','Another title'),false);
  assert.equal(await lib.renameTitle(key,complete.displayTitle),true);
  await lib.save({hash:key,name:'',text:'Accessible text',paper:{title:'Fallback title'}});
  const record=await lib.get(key);
  assert.equal(record.preparedTitle,complete.displayTitle);
  assert.equal(record.text,'Accessible text');
  assert.equal(record.name,'scan.pdf');
  assert.deepEqual(copy(record.pages),['Original page']);
  assert.equal(await record.file.text(),'original bytes');
  const catalog=await lib.list();
  assert.equal(catalog.length,1);
  assert.equal(catalog[0].hash,key);
  assert.equal(catalog[0].title,complete.displayTitle);
  assert.equal(catalog[0].preparedTitle,complete.displayTitle);
  await lib.savePreparation(key,{...complete,savedAt:12});
  await lib.savePreparation(key,{status:'starting',savedAt:20});
  await lib.savePreparation(key,{status:'error',savedAt:10});
  const latest=await lib.getPreparation(key);
  assert.equal(latest.status,'starting');
  assert.equal(latest.displayTitle,complete.displayTitle);
  assert.deepEqual(copy(latest.knowledge),complete.knowledge);
});

test('the study backup respects an explicit newer preflight selection and a removal invalidates pending writes',async()=>{
  const indexedDB=databaseFixture(),id='a'.repeat(64),studyKey='study/'+id;
  let token='';
  const window={indexedDB,PAPER_REMOVAL:{generation:()=>token}};
  load('paper-library.js',{window,indexedDB,Blob,structuredClone});
  const library=window.PAPER_LIBRARY;
  const plan={key:'previous edition',status:'ready'};
  const older={selectedAt:10,savedAt:30,study:plan,plans:{old:plan},turns:[]};
  const preflight={...older,selectedAt:20,savedAt:20,study:{}};
  await library.savePreparation(studyKey,older,token);
  await library.savePreparation(studyKey,preflight,token);
  assert.deepEqual(copy((await library.getPreparation(studyKey)).study),{});
  await library.savePreparation(studyKey,{...older,savedAt:100},token);
  const stored=await library.getPreparation(studyKey);
  assert.equal(stored.selectedAt,20);
  assert.deepEqual(copy(stored.study),{});
  const delayed=library.savePreparation(studyKey,{...older,selectedAt:1000,savedAt:1000},token);
  token='removed';
  await delayed;
  assert.deepEqual(copy(await library.getPreparation(studyKey)),copy(stored));
  const replacement={...preflight,selectedAt:5,savedAt:5,generation:token};
  await library.savePreparation(studyKey,replacement,token);
  assert.deepEqual(copy(await library.getPreparation(studyKey)),replacement);
});

test('a late writer with the stale localStorage epoch cannot recreate records after the IndexedDB erase',async()=>{
  const indexedDB=databaseFixture(),hash='e'.repeat(64),other='a'.repeat(64),token='reimport-epoch';
  let published='';
  const window={indexedDB,PAPER_REMOVAL:{generation:id=>id===hash?published:''}};
  load('paper-library.js',{window,indexedDB,Blob,structuredClone});
  const api=window.PAPER_LIBRARY,source={hash,name:'test.pdf',text:'paper'};
  await api.save(source,'');
  await api.savePreparation('study/'+hash,{savedAt:1,study:{status:'ready'}},'');
  await api.remove(hash,token);
  // The deleting tab has committed its database transaction, but neither
  // writer has received the new localStorage value or a removal notification.
  await api.savePreparation(hash,{savedAt:3,parts:['stale']},'');
  await api.savePreparation('study/'+hash,{savedAt:4,study:{status:'ready'}},'');
  await assert.rejects(api.save(source,''),/removed during import/);
  assert.equal(await api.getPreparation(hash),null);
  assert.equal(await api.getPreparation('study/'+hash),null);
  assert.deepEqual(copy(await api.list()),[]);
  await api.save({...source,hash:other},'');
  assert.ok(await api.get(other));
  published=token;
  await api.save(source,token);
  await api.savePreparation(hash,{savedAt:1,generation:token,parts:['new']},token);
  await api.remove(hash,token); // replaying an interrupted operation is idempotent
  assert.ok(await api.get(hash));
  assert.deepEqual(copy((await api.getPreparation(hash)).parts),['new']);
});

test('bundle study backups obey the same database fence as uploaded papers',async()=>{
  const indexedDB=databaseFixture(),window=new EventTarget(),id='intervals',other='d'.repeat(64);
  const localStorage=storage();
  window.indexedDB=indexedDB;
  load('paper-library.js',{window,indexedDB,Blob,structuredClone});
  load('paper-removal.js',{window,localStorage});
  const library=window.PAPER_LIBRARY;
  await library.savePreparation(id,{savedAt:1,parts:['old']},'');
  await library.savePreparation('study/'+id,{savedAt:1,turns:['old']},'');
  await library.savePreparation(other,{savedAt:1,parts:['other']},'');
  await library.remove(id,'deletion');
  await library.savePreparation(id,{savedAt:2,parts:['stale']},'');
  await library.savePreparation('study/'+id,{savedAt:2,turns:['stale']},'');
  assert.equal(await library.getPreparation(id),null);
  assert.equal(await library.getPreparation('study/'+id),null);
  assert.deepEqual(copy((await library.getPreparation(other)).parts),['other']);
  await assert.rejects(library.remove('study/'+other,'wrong'),/Select a paper/);
});
