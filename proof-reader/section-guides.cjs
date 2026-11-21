const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {prepareRequest} = require('./ask-paper.cjs');
const {writeAtomic,unexpectedCheckpoint} = require('./plan-checkpoints.cjs');
const {generateLeanReading,leanReadingRevision} = require('./lean-reading.cjs');

const endpoint='/api/section-structure';
const error=(status,message)=>Object.assign(new Error(message),{status});

function sectionRequest(body) {
  if (!body?.stage || !Array.isArray(body.stage.sourceSteps) ||
      ![body.studyKey,body.analysisKey].every(k=>typeof k==='string' && k.length>0 && k.length<=500)) {
    throw error(400,'Choose a section from the prepared paper.');
  }
  const input=prepareRequest({title:body.title,units:body.units,pdfBase64:body.pdfBase64,paperId:body.paperId,sourceText:body.sourceText,
    readerKnowledge:body.readerKnowledge,notationEdition:body.notationEdition,stage:body.stage,step:body.stage.sourceSteps[0],scope:'step',
    question:'Explain how the argument in this section fits together.',mathFormat:'latex'});
  const {stage,readerKnowledge}=input.context;
  const hash=createHash('sha256').update(JSON.stringify([leanReadingRevision,body.studyKey,body.analysisKey,
    stage.partId,stage.title,stage.sourceSteps,stage.sourceAnchors,stage.localPrerequisites,readerKnowledge,input.units]));
  if (input.context.notationEdition) hash.update('\0notation\0').update(JSON.stringify(input.context.notationEdition));
  // The source and reader's plan determine this structure. The legacy opening and
  // the rich edition can be two different wordings of the same mathematical task.
  return {input,key:hash.update(input.pdf || '').digest('hex')};
}

function publicGuide(guide) {
  return {partId:guide.partId,goal:guide.goal,overview:guide.overview,
    modules:guide.modules.map(({id,title,claim,assumptions,dependsOn,priorPartIds,explanation,sourceStep,sourceQuote,sourcePage})=>
      ({id,title,claim,assumptions,dependsOn,...(priorPartIds?.length?{priorPartIds}:{}),explanation,sourceStep,sourceQuote,...(sourcePage?{sourcePage}:{})}))};
}

const failureMessages={
  source:'The original pages for this section could not be read.',
  formulating:'The argument steps could not be matched to this section.',
  checking:'The mathematical check could not finish for these steps.',
  explaining:'The explanation could not be completed for these steps.',
  saving:'The completed explanation could not be saved locally.',
  locator:'A cited passage could not be located in the original section.',
  notation:'The explanation could not match the selected notation.',
  correspondence:'A step could not be supported by the original argument.',
  format:'The generated steps did not fit the reading format.',
  dependencies:'The generated steps did not link to the required earlier results.',
  timeout:'Preparing these steps timed out.',
  empty:'The reading service returned no explanation.',
  network:'The reading service lost its connection.',
  quota:'The reading service has reached its usage limit.',
  login:'The reading service needs you to sign in to Codex.',
  configuration:'The reading service could not start with its current settings.',
  refused:'The reading service declined this request.',
  installation:'The local reading service needs the Codex CLI to be available.',
  exit:'The reading worker stopped before returning the explanation.',
  'unexpected-failure':'Couldn’t prepare this explanation. An unexpected error occurred.',
};
function publicFailure(stage,cause) {
  const detail=cause?.message || '';
  let code='unexpected-failure';
  if (Object.hasOwn(failureMessages,cause?.workerCode)) code=cause.workerCode;
  else if (detail===failureMessages.source) code='source';
  else if (stage==='saving' && ['ENOSPC','EACCES','EPERM','EBUSY','EMFILE'].includes(cause?.code)) code='saving';
  return {failureStage:stage,failureCode:code,message:failureMessages[code]};
}

function createSectionGuideHandler({worker,renderSourcePage,readLocalJson,checkLocalRequest,generate=generateLeanReading,paperCache,
  cacheDir=path.join(process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || os.tmpdir(),'ProofReader','section-guides')}) {
  const jobs=new Map();
  const stored=k=>path.join(cacheDir,k+'.json');
  const draftFile=key=>path.join(cacheDir,key+'.formulation');
  const fault=key=>unexpectedCheckpoint(cacheDir,key,['source','formulating','checking','explaining','saving']);
  const unexpected=(key,stage)=>({key,status:'error',needsAction:false,unexpected:true,failureCode:'unexpected-failure',
    failureStage:stage,message:failureMessages['unexpected-failure']});
  const draftLimit=322*1024;
  function isRawDraft(draft) {
    return typeof draft?.goal==='string' && Array.isArray(draft.modules) && draft.modules.length>0 &&
      draft.modules.every(row=>row && typeof row.id==='string' && !Object.hasOwn(row,'verification') && !Object.hasOwn(row,'explanation'));
  }
  async function loadDraft(key) {
    try {
      const file=draftFile(key);
      if ((await fs.stat(file)).size>draftLimit) return null;
      const saved=JSON.parse(await fs.readFile(file,'utf8'));
      if (saved.key===key && saved.revision===leanReadingRevision && isRawDraft(saved.draft)) return saved.draft;
    } catch { /* A lost or incomplete draft can be prepared again. */ }
    return null;
  }
  async function saveDraft(key,draft) {
    if (draft===null) return fs.rm(draftFile(key),{force:true});
    if (!isRawDraft(draft)) return;
    const text=JSON.stringify({key,revision:leanReadingRevision,draft});
    if (Buffer.byteLength(text)<=draftLimit) await writeAtomic(draftFile(key),text);
  }
  paperCache?.adapter('section',{busy:key=>jobs.get(key)?.status==='running',async remove(key) {
    await fs.rm(stored(key),{force:true});await saveDraft(key,null);await fault(key).clear();jobs.delete(key);
  }});
  async function load(key) {
    try {
      if ((await fs.stat(stored(key))).size>4*1024*1024) return null;
      const r=JSON.parse(await fs.readFile(stored(key),'utf8'));
      if (r.key===key && r.revision===leanReadingRevision && r.guide?.modules?.length) {
        return {status:'ready',key,...publicGuide(r.guide)};
      }
    } catch { /* The cache can be rebuilt from the original paper. */ }
    return null;
  }
  async function build(key,input) {
    let stage='source';
    let recovery,feedback;
    function onStage(next) {
      stage=next;
      jobs.set(key,{key,status:'running',stage,...(recovery?{progress:{stage,recovery}}:{})});
    }
    let guide;
    for (let attempt=0;;attempt++) {
      try {
        guide ||= await generate(input,{worker,renderSourcePage,onStage,feedback,
          loadDraft:()=>loadDraft(key),saveDraft:draft=>saveDraft(key,draft)});
        const result={key,status:'ready',...publicGuide(guide)};
        const transient=guide.modules.some(m=>['unavailable','timeout','error'].includes(m.verification?.status));
        onStage('saving');
        if (!transient) await writeAtomic(stored(key),JSON.stringify({key,revision:leanReadingRevision,guide}));
        await saveDraft(key,null);
        await fault(key).clear();
        jobs.set(key,result);
        return;
      } catch (cause) {
        const failure=publicFailure(stage,cause);
        const code=failure.failureCode;
        if (code==='unexpected-failure') {
          await fault(key).save(stage).catch(()=>{});
          jobs.set(key,unexpected(key,stage));
          return;
        }
        const external=({login:'sign-in',quota:'quota',configuration:'service',installation:'service',refused:'review'})[code] ||
          (cause?.message===failureMessages.source?'source':null);
        if (external || attempt>=1) {
          const actionRequired=external || (['saving','network','empty','exit','timeout'].includes(code)?'service':'review');
          jobs.set(key,{key,status:'error',needsAction:true,actionRequired,...failure});
          return;
        }
        // Reuse an accepted formulation when only its explanation failed, and
        // retain a completed guide in memory when just the atomic save failed.
        const transport=['network','empty','exit','timeout'].includes(code);
        recovery={attempt:attempt+1,reason:transport?code:'invalid-output',action:transport?'retry-worker':'review-section'};
        feedback={stage,code,detail:String(cause.message||'').slice(0,1200),issues:(cause.issues||[]).slice(0,8)};
        onStage('recovering');
        onStage(guide?'saving':'source');
      }
    }
  }
  async function submit(input,key) {
      let result=await load(key) || jobs.get(key);
      if (!result || result.status==='error') {
        if ([...jobs.values()].filter(j=>j.status==='running').length>=3) throw error(429,'Other sections are being prepared. Try this one again shortly.');
        if (jobs.size>=80) {
          const oldest=[...jobs].find(([,j])=>j.status!=='running');
          if (oldest) jobs.delete(oldest[0]);
        }
        result={key,status:'running',stage:'source'};
        jobs.set(key,result);
        void build(key,input);
      }
      return result;
  }
  return async function handle(req,res,route) {
    checkLocalRequest(req);
    let result;
    if (route===endpoint && req.method==='POST') {
      const {input,key}=sectionRequest(await readLocalJson(req,24*1024*1024));
      result=paperCache ? await paperCache.submit('section',input,key,id=>submit(input,id)) : await submit(input,key);
    } else if (req.method==='GET' && /^\/api\/section-structure\/[0-9a-f]{64}$/u.test(route)) {
      const key=route.slice(endpoint.length+1);
      result=jobs.get(key) || await load(key);
      if (!result) {
        const stage=await fault(key).load();
        if(stage)result=unexpected(key,stage);
      }
      if (!result) throw error(404,'Reopen this section to prepare the explanation.');
    } else throw error(405,'Use POST for a section or GET to follow its preparation.');
    res.writeHead(result.status==='running'?202:200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(result));
  };
}
module.exports={createSectionGuideHandler,sectionRequest};
