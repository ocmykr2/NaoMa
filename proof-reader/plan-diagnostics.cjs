'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {writeAtomic} = require('./plan-checkpoints.cjs');

const maxEvents = 96;
const events = new Set(['started','resumed','stage','checked','check-failed','retry','deferred','failed','ready']);
const enums = {
  stage: new Set(['preparing','recovering','adapting-notation','rewriting-notation','reading-source','drafting','checking',
    'revising-draft','editing','revising-notation','saving','ready']),
  check: new Set(['source','source-quote','definition','theorem','notation','editorial','schema','worker','storage','checkpoint','dependency']),
  code: new Set(['source-quote-not-found','source-quote-inconclusive','source-quote-mismatch','source-quote-invalid','source-quote-unrelated',
    'definition-evidence','definition-incomplete','definition-dependencies','source-page-verified',
    'source-page-unverified','theorem-unverified','notation-conflict','notation-incomplete','editorial-rejected',
    'notation-source-locator','notation-reference-locator','notation-map-conflict','notation-map-invalid',
    'invalid-output','generation-failed','unexpected-failure','storage-error','timeout','login','quota','network','refused',
    'configuration','installation','exit','empty','prerequisite-pending']),
  action: new Set(['verify-page','repair-definition','find-defining-passage','revise-draft','revise-notation','review-section',
    'split-batch','resume-checkpoint','retry-worker','retry-section','wait-for-prerequisite','save-result']),
};

const schemaField = /^(?:orientation\.)?(?:definitions(?:\.[0-9]{1,3}(?:\.(?:name|text|intuition|sourceQuote|sourceStep|dependsOn))?)?|(?:notation|referenceNotation)(?:\.[0-9]{1,3}(?:\.(?:symbol|meaning))?)?|statement(?:\.(?:label|text|sourceQuote|sourceStep))?|paragraphs(?:\.[0-9]{1,3})?|sourceQuote|sourceStep|introduction|handoff|question|opening|orientation|parts)$/u;
const counts = ['part','firstPart','lastPart','completedParts','draftedParts','totalParts','sourceStep','page'];
const mapField=/^(?:mappings|retained)(?:\.[0-9]{1,3}(?:\.(?:sourceQuote|sourceStep|referenceQuote|referenceStep|concept|symbol|original|preferred|partIds))?)?$/u;
const integer = (value, min) => Number.isSafeInteger(value) && value >= min;
function dependencyCounts(progress) {
  const result={};
  for (const field of ['blockedParts','waitingParts']) {
    if (!Array.isArray(progress[field])) continue;
    const values=progress[field].filter(n=>integer(n,1) && n<=progress.totalParts);
    if (values.length) result[field]=[...new Set(values)].sort((a,b)=>a-b);
  }
  return result;
}

// Accept diagnostic metadata only. Never stringify the caller's object or an
// Error: a worker error can hold a PDF excerpt, prompt or subprocess output.
function project(input) {
  if (!events.has(input?.event)) return null;
  const out = {event:input.event};
  for (const [name,allowed] of Object.entries(enums)) {
    if (allowed.has(input[name])) out[name] = input[name];
  }
  if (typeof input.field === 'string' && input.field.length <= 80 &&
      (schemaField.test(input.field) || (out.check==='notation' && mapField.test(input.field)))) out.field = input.field;
  for (const name of counts) {
    const value = input[name];
    if (integer(value, name === 'completedParts' || name === 'draftedParts' ? 0 : 1) && value <= 100000) out[name] = value;
  }
  if (input.event==='failed') {
    Object.assign(out,dependencyCounts({...input,totalParts:out.totalParts}));
    if (input.code==='editorial-rejected' && input.boundCheckVersion===2) out.boundCheckVersion=2;
  }
  return out;
}

function snapshot(key, rows) {
  const last = rows.at(-1);
  return {version:1,key,status:last.event === 'ready' ? 'ready' : last.event === 'failed' ? 'error' : 'running',
    attempt:last.attempt,retryCount:last.retryCount,events:rows};
}

function planDiagnostics(directory,key) {
  const validKey = typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key);
  const filename = validKey ? path.join(directory,key+'.diagnostics') : null;
  let pending = Promise.resolve();
  async function load() {
    if (!filename) return null;
    try {
      if ((await fs.stat(filename)).size > 128*1024) return null;
      const data = JSON.parse(await fs.readFile(filename,'utf8'));
      if (data.version !== 1 || data.key !== key || !Array.isArray(data.events) ||
          !data.events.length || data.events.length > maxEvents) return null;
      const rows = [];
      for (const row of data.events) {
        const safe = project(row);
        if (!safe || !integer(row.sequence,1) || !integer(row.at,0) || !integer(row.attempt,1) ||
            !integer(row.retryCount,0) || (rows.length && row.sequence !== rows.at(-1).sequence + 1)) return null;
        rows.push({...safe,sequence:row.sequence,at:row.at,attempt:row.attempt,retryCount:row.retryCount});
      }
      return snapshot(key,rows);
    } catch { return null; }
  }
  return {
    record(input) {
      const safe = project(input);
      if (!filename || !safe) return pending;
      pending = pending.then(async () => {
        const previous = await load();
        const last = previous?.events.at(-1);
        const start = safe.event === 'started' || safe.event === 'resumed';
        const attempt = start ? (last?.attempt || 0) + 1 : last?.attempt || 1;
        const retryCount = (start ? 0 : last?.retryCount || 0) + (safe.event === 'retry' ? 1 : 0);
        const row = {...safe,sequence:(last?.sequence || 0) + 1,at:Date.now(),attempt,retryCount};
        const rows = (previous?.events || []).slice(1-maxEvents);
        rows.push(row);
        await writeAtomic(filename,JSON.stringify(snapshot(key,rows)));
      }).catch(()=>{ /* Preparation can continue if diagnostic storage is unavailable. */ });
      return pending;
    },
    async read() { await pending; return load(); },
  };
}
module.exports={planDiagnostics,dependencyCounts};
