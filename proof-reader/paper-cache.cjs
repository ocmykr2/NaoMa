'use strict';
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {writeAtomic}=require('./plan-checkpoints.cjs');

const kinds=['analysis','plan','section'];
const isKey=k=>typeof k==='string' && /^[a-f0-9]{64}$/.test(k);
const fail=(status,message)=>Object.assign(new Error(message),{status});
function sourceIdentity(input,body) {
  if (input.pdf || (body.paperId===undefined && body.sourceText===undefined)) return input;
  if (!isKey(body.paperId) || typeof body.sourceText!=='string' || Buffer.byteLength(body.sourceText)>4*1024*1024 ||
      createHash('sha256').update(body.sourceText).digest('hex')!==body.paperId) {
    throw fail(400,'The source text does not match the selected library paper.');
  }
  return {...input,textIdentity:body.paperId};
}
function ownerOf(input) {
  const units=input.units || input.paper.units;
  const material=units.map(u=>[u.title.replace(/\r\n?/g,'\n').normalize('NFC').trim(),u.text.trim(),u.page ?? null]);
  return createHash('sha256').update(JSON.stringify(material)).update('\0').update(input.pdf || input.textIdentity || '').digest('hex');
}
function generationKey(key,generation) {
  return generation ? createHash('sha256').update(key).update('\0paper-reset\0').update(generation).digest('hex') : key;
}
function createPaperCache(directory=path.join(process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || os.tmpdir(),'ProofReader','paper-caches')) {
  const locks=new Map(),adapters=new Map();
  let tutor;
  function withOwner(owner,fn) {
    const prior=locks.get(owner) || Promise.resolve();
    const task=prior.catch(()=>{}).then(fn);
    locks.set(owner,task);
    return task.finally(()=>{if(locks.get(owner)===task) locks.delete(owner);});
  }
  const filename=owner=>path.join(directory,owner+'.json');
  async function read(owner,input) {
    try {
      const m=JSON.parse(await fs.readFile(filename(owner),'utf8'));
      if (m.owner!==owner || typeof m.generation!=='string' ||
          !kinds.every(k=>Array.isArray(m[k]) && m[k].every(isKey))) throw Error('Invalid saved paper cache index.');
      return m;
    } catch(e) {
      if (e.code!=='ENOENT') throw e;
      return {owner,generation:input.textIdentity || '',analysis:[],plan:[],section:[]};
    }
  }
  return {
    adapter(kind,methods) {adapters.set(kind,methods);},
    questions(methods) {tutor=methods;},
    withQuestion(input,fn) {
      const owner=ownerOf(input);
      return withOwner(owner,()=>fn(owner));
    },
    submit(kind,input,base,fn) {
      const owner=ownerOf(input);
      return withOwner(owner,async()=>{
        const m=await read(owner,input);
        const key=generationKey(base,m.generation);
        if (!m[kind].includes(key)) {
          m[kind].push(key);
          await writeAtomic(filename(owner),JSON.stringify(m));
        }
        return fn(key,m.generation);
      });
    },
    clear(input,legacy) {
      const owner=ownerOf(input);
      return withOwner(owner,async()=>{
        const m=await read(owner,input);
        const keys=Object.fromEntries(kinds.map(k=>[k,[...new Set([...m[k],...(legacy[k] || [])])]]));
        if (tutor?.busy(owner) || kinds.some(k=>keys[k].some(key=>adapters.get(k).busy(key)))) {
          throw fail(409,'This paper still has work in progress. Clear it when preparation and answers finish.');
        }
        for (const k of kinds) for (const key of keys[k]) await adapters.get(k).remove(key);
        tutor?.forget(owner);
        // Legacy plans may predate the index. Rotating their primary source's
        // generation makes every re-import start fresh, even if an old edition
        // cannot be safely attributed to this paper for physical deletion.
        await writeAtomic(filename(owner),JSON.stringify({owner,generation:randomUUID(),analysis:[],plan:[],section:[]}));
        return {cleared:true};
      });
    },
  };
}

module.exports={createPaperCache,generationKey,isKey,sourceIdentity};
