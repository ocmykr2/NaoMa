const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');

async function writeAtomic(filename,text) {
  await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  const temp = filename+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temp,text,{encoding:'utf8',flag:'wx',mode:0o600});
    await fs.rename(temp,filename);
  } finally {
    await fs.rm(temp,{force:true}).catch(()=>{});
  }
}

// The address already includes the original document, reader choices and editorial version.
// Only the final .json file is served by the reading-plan endpoint.
const checksum = (key,batches) => createHash('sha256').update(key).update(JSON.stringify(batches)).digest('hex');
function planCheckpoints(directory,key,limit) {
  const filename = path.join(directory,key+'.checkpoint');
  return {
    async load() {
      try {
        if ((await fs.stat(filename)).size>limit) return new Map();
        const data=JSON.parse(await fs.readFile(filename,'utf8'));
        if (data.version===1 && data.key===key && Array.isArray(data.batches) &&
            data.checksum===checksum(key,data.batches)) return new Map(data.batches);
      } catch { /* A missing or interrupted checkpoint can be regenerated from the paper. */ }
      return new Map();
    },
    async save(history) {
      const batches=[...history];
      const data=JSON.stringify({version:1,key,batches,checksum:checksum(key,batches)});
      if (Buffer.byteLength(data)<=limit) await writeAtomic(filename,data);
    },
    async discard() { await fs.rm(filename,{force:true}); },
  };
}

// Store the stage only. The exception and any source excerpts stay private.
function unexpectedCheckpoint(directory,key,stages) {
  const filename=path.join(directory,key+'.fault');
  return {
    async load() {
      try {
        if ((await fs.stat(filename)).size>512) return null;
        const saved=JSON.parse(await fs.readFile(filename,'utf8'));
        return saved.key===key && stages.includes(saved.stage)?saved.stage:null;
      } catch {return null;}
    },
    save(stage) {return writeAtomic(filename,JSON.stringify({key,stage}));},
    clear() {return fs.rm(filename,{force:true});},
  };
}
module.exports={planCheckpoints,writeAtomic,unexpectedCheckpoint};
