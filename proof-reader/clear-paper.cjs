'use strict';
const {normalizeInput,preparationAssets}=require('./paper-agent.cjs');
const {readingPlanKey}=require('./personalized-plan.cjs');
const {sectionRequest}=require('./section-guides.cjs');
const {isKey,sourceIdentity}=require('./paper-cache.cjs');

function invalid() {return Object.assign(new Error('Choose the paper to clear from the library.'),{status:400});}
function removalSource(source) {
  // Import can retain a scan or a long PDF even when neither analysis nor the
  // tutor can process its pages. Removal needs its identity, not readable text.
  if (!Array.isArray(source?.units) || source.units.some(u=>typeof u?.title!=='string' ||
      typeof u.text!=='string' || (u.page!=null && (!Number.isSafeInteger(u.page) || u.page<1)))) throw invalid();
  let pdf;
  if (source.pdfBase64!==undefined) pdf=normalizeInput({units:[{title:'File',text:''}],pdfBase64:source.pdfBase64}).pdf;
  if (!source.units.length && !pdf && !source.sourceText) throw invalid();
  return sourceIdentity({units:source.units,pdf},source);
}
function createClearPaperHandler({paperCache,readLocalJson,checkLocalRequest}) {
  return async function handle(req,res) {
    checkLocalRequest(req);
    if (req.method!=='POST') throw Object.assign(new Error('Use POST to clear a saved paper.'),{status:405});
    const body=await readLocalJson(req,144*1024*1024);
    const source=body?.source;
    const input=removalSource(source);
    for (const field of ['analysisKeys','planKeys','sectionKeys']) {
      if (body[field]!==undefined && (!Array.isArray(body[field]) || body[field].length>2048 || !body[field].every(isKey))) throw invalid();
    }
    const legacy={analysis:[],plan:[],section:[]};
    if (source.units.length<=256 && !input.textIdentity) {
      // The analysis identity is derivable from the original document alone.
      // A saved source-only document may never have been eligible for analysis.
      let original;
      try { original=normalizeInput(source); }
      catch(e) { if (![400,413].includes(e.status)) throw e; }
      if (original) legacy.analysis.push((await preparationAssets(original)).key);
    }
    // Older caches did not record their primary paper. Only a recomputed key
    // proves that an unindexed file belongs to the selected source. The primary
    // PDF and units always come from the selection, never from a suggested job.
    for (const [kind,field] of [['plan','legacyPlans'],['section','legacySections']]) {
      const jobs=body[field] ?? [];
      if (!Array.isArray(jobs) || jobs.length>100) throw invalid();
      if (input.textIdentity) continue; // Legacy inputs may share extracted passages across two distinct original texts.
      for (const job of jobs) {
        if (!isKey(job?.key)) throw invalid();
        const payload={...job,title:job.title || source.title,units:source.units,pdfBase64:source.pdfBase64,paperId:source.paperId,sourceText:source.sourceText};
        let key;
        try {key=kind==='plan' ? await readingPlanKey(payload) : sectionRequest(payload).key;}
        catch(e) {
          // A historical format may no longer be reproducible.
          if ([400,413,415].includes(e.status)) continue;
          throw e;
        }
        if (key===job.key) legacy[kind].push(key);
      }
    }
    const result=await paperCache.clear(input,legacy);
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(result));
  };
}
module.exports={createClearPaperHandler};
