const {execFile,spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const bundledVersion = '4.36.0';
const types = ['Nat','Int','Rat','Prop'];
const tactics = {
  auto: 'first | assumption | rfl | decide +kernel | (solve | omega) | (solve | simp_all) | grind',
  omega: 'omega', decide: 'decide +kernel', simp_all: 'simp_all', assumption: 'assumption', rfl: 'rfl',
};
const string = {type:'string'};
function record(properties) {
  return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
}
const formalSchema = record({
  variables:{type:'array',items:record({name:string,type:{type:'string',enum:types}})},
  hypotheses:{type:'array',items:record({name:string,expression:string})},
  conclusion:string,tactic:{type:'string',enum:Object.keys(tactics)},
});
const formalGuidance = 'Choose a small, meaningful inference with explicit variables, local hypotheses and one conclusion. '+
  'Variables have type Nat, Int, Rat or Prop. Names are ASCII letters followed by letters, digits or underscores. '+
  'Use integer numerals, parentheses, + - * / %, = != < <= > >=, and, or, not, ->, <-> (or the corresponding Lean symbols). '+
  'Constants True and False are propositions. Use (3 : Rat) or (3 : Int) to type a numeral explicitly. '+
  'Unconstrained numerals default to Nat: Nat subtraction saturates at zero and Nat division rounds down. Rat is exact rational arithmetic. '+
  'Preserve the source domain, strictness, side conditions and quantifier scope. Label a restriction as a special case. '+
  'Use omega for linear Nat or Int arithmetic, decide for small closed cases, simp_all or assumption for local deductions, or auto. '+
  'Use a null formulation if you cannot state a faithful supported inference. All supplied hypotheses are conditional inputs. '+
  'A declaration simply restating a hypothesis, a vacuous implication or an inconsistent premise list cannot substantiate the source claim.';

const symbol = new Map(Object.entries({
  '->':'→','<->':'↔','<=':'≤','>=':'≥','!=':'≠',and:'∧',or:'∨',not:'¬',
}));
const precedence = new Map([
  ['↔',10],['→',15],['∨',20],['∧',30],['=',45],['≠',45],['<',45],['>',45],['≤',45],['≥',45],
  ['+',60],['-',60],['*',70],['/',70],['%',70],
]);
const reserved = new Set(['and','or','not','True','False',...types,'readingPart','theorem','by','let','in','if','then','else',
  'fun','match','with','do','at','this','show','have','from','calc','where','import','axiom','sorry','admit','unsafe']);
function reject(reason) { throw new Error(reason); }
function identifier(value) {
  if (typeof value!=='string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) || reserved.has(value)) {
    reject('Use a short, distinct identifier for each variable and hypothesis.');
  }
  return value;
}
function checkedObject(value,keys) {
  return value && typeof value==='object' && !Array.isArray(value) &&
    keys.every(k=>Object.hasOwn(value,k)) && Object.keys(value).every(k=>keys.includes(k));
}

// Parse to a fully parenthesized expression. Only enumerated operators, declared identifiers
// and bounded numerals are emitted. There is no path here for raw Lean commands or tactics.
function expression(source,names) {
  if (typeof source!=='string' || !source.trim() || source.length>600) reject('A formula is missing or too long.');
  const lexer=/\s+|<->|->|<=|>=|!=|[a-zA-Z][a-zA-Z0-9_]*|[0-9]+|[()+*/%=<>:≤≥≠→↔∧∨¬-]/gy;
  const tokens=[];
  while (lexer.lastIndex<source.length) {
    const match=lexer.exec(source);
    if (!match) reject('This formula uses notation outside the supported expression language.');
    const token=match[0];
    if (!token.trim()) continue;
    tokens.push(symbol.get(token)||token);
    if (tokens.length>128) reject('This formula is too large for a local check.');
  }
  let pos=0;
  function parse(min,depth) {
    if (depth>28) reject('This formula is nested too deeply.');
    const token=tokens[pos++];
    let left;
    if (token==='(') {
      left=parse(0,depth+1);
      if (tokens[pos]===':') {
        const type=tokens[++pos];
        if (!types.includes(type)) reject('Unsupported type annotation.');
        pos++;
        left='('+left+' : '+type+')';
      }
      if (tokens[pos++]!==')') reject('An opening parenthesis has no matching close.');
    } else if (token==='¬' || token==='-') {
      left='('+token+' '+parse(token==='¬'?40:80,depth+1)+')';
    } else if (names.has(token)) {
      left='«'+token+'»';
    } else if (token==='False' || token==='True' || /^(0|[1-9][0-9]{0,11})$/.test(token||'')) {
      left=token;
    } else reject('A formula contains an undeclared name, unsupported constant or incomplete expression.');
    while (precedence.has(tokens[pos]) && precedence.get(tokens[pos])>=min) {
      const op=tokens[pos++],power=precedence.get(op);
      const right=parse(op==='→'||op==='↔'?power:power+1,depth+1);
      left='('+left+' '+op+' '+right+')';
    }
    return left;
  }
  const result=parse(0,0);
  if (pos!==tokens.length) reject('Separate comparisons with a logical connective and check parentheses.');
  return result;
}

function compileFormalization(formal) {
  if (!checkedObject(formal,['variables','hypotheses','conclusion','tactic']) ||
      !Array.isArray(formal.variables) || formal.variables.length>24 ||
      !Array.isArray(formal.hypotheses) || formal.hypotheses.length>20 ||
      typeof formal.tactic!=='string' || !Object.hasOwn(tactics,formal.tactic)) reject('Unsupported formulation or proof method.');
  const names=new Set(), binders=[];
  for (const variable of formal.variables) {
    if (!checkedObject(variable,['name','type']) || !types.includes(variable.type)) reject('Unsupported variable declaration.');
    const name=identifier(variable.name);
    if (names.has(name)) reject('Variable names must be unique.');
    names.add(name);
    binders.push('(«'+name+'» : '+variable.type+')');
  }
  const allNames=new Set(names);
  for (const premise of formal.hypotheses) {
    if (!checkedObject(premise,['name','expression'])) reject('Unsupported hypothesis declaration.');
    const name=identifier(premise.name);
    if (allNames.has(name)) reject('Every variable and hypothesis needs a distinct name.');
    allNames.add(name);
    binders.push('(«'+name+'» : '+expression(premise.expression,names)+')');
  }
  const conclusion=expression(formal.conclusion,names);
  return ['set_option autoImplicit false','set_option maxHeartbeats 80000',
    'set_option maxRecDepth 512','','theorem readingPart '+binders.join('\n    ')+' :',
    '    '+conclusion+' := by','  '+tactics[formal.tactic],'','#print axioms readingPart',''].join('\n');
}

const execFileAsync=promisify(execFile);
const managedRoot=()=>path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'ProofReader','lean');
async function* installedCandidates(override) {
  const exe=process.platform==='win32'?'lean.exe':'lean';
  const roots=process.platform==='win32'?[process.env.LOCALAPPDATA,path.join(os.homedir(),'AppData','Local')]:
    [process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share')];
  const managed=new Set([path.join(__dirname,'lean',bundledVersion,'bin',exe),
    ...roots.filter(Boolean).map(r=>path.join(r,'ProofReader','lean',bundledVersion,'bin',exe))]);
  async function* paths() {
    if (override) {yield override;return;}
    yield* managed;
    for (const dir of (process.env.PATH||'').split(path.delimiter)) {
      if (path.isAbsolute(dir) && !/[\\/]\.elan[\\/]bin[\\/]?$/i.test(dir)) yield path.join(dir,exe);
    }
    const toolchains=path.join(process.env.ELAN_HOME||path.join(os.homedir(),'.elan'),'toolchains');
    try {
      const installed=await fs.readdir(toolchains);
      for (const d of installed.filter(d=>d.startsWith('leanprover--lean4---')).sort().reverse()) yield path.join(toolchains,d,'bin',exe);
    } catch { /* Elan is optional. */ }
  }
  const seen=new Set();
  for await (const candidate of paths()) {
    if (!path.isAbsolute(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const compiler=await fs.stat(candidate);
      if (!compiler.isFile()) continue;
      const library=await fs.stat(path.resolve(path.dirname(candidate),'../lib/lean/Init.olean')).catch(()=>null);
      const stamp=file=>file?[file.dev,file.ino,file.size,file.mtimeMs,file.ctimeMs]:null;
      yield {exe:candidate,pinned:!override && managed.has(candidate),fingerprint:JSON.stringify([stamp(compiler),stamp(library)])};
    } catch { /* Next installed path. */ }
  }
}
async function installWindowsRuntime() {
  const root=managedRoot(),script=path.join(__dirname,'desktop','install-lean.ps1');
  const powershell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Root',root];
  if (process.env.PROOF_READER_LEAN_ARCHIVE) args.push('-Archive',path.resolve(process.env.PROOF_READER_LEAN_ARCHIVE));
  try {
    await execFileAsync(powershell,args,{windowsHide:true,timeout:30*60*1000,maxBuffer:128*1024});
  } catch (error) {
    // Keep stable diagnostics without copying local paths or child-process commands into a receipt.
    const log=error.stderr || '';
    let detail='The pinned Lean runtime could not be prepared. Check the download connection, available disk space or offline archive.';
    if (error.killed) detail='The pinned Lean installation exceeded its time limit.';
    else if (log.includes('published SHA-256')) detail='The Lean release archive failed the pinned SHA-256 check.';
    else if (log.includes('could not be downloaded')) detail='The official Lean release could not be downloaded.';
    else if (log.includes('sample theorem')) detail='The installed Lean release could not verify its sample theorem.';
    throw Object.assign(new Error(detail),{code:'LEAN_INSTALL_UNAVAILABLE'});
  }
  return path.join(root,bundledVersion,'bin','lean.exe');
}
async function healthyRuntime({exe,pinned}) {
  // A damaged installation may print its version but lack the imported library.
  const formal={variables:[{name:'n',type:'Nat'}],hypotheses:[],conclusion:'n+1>n',tactic:'omega'};
  const [result]=await checkBatch(exe,[{base:{source:compileFormalization(formal)},formal}],45000);
  return result.status==='verified' && (!pinned || result.version.startsWith('Lean (version '+bundledVersion+','));
}
function createLeanResolver({discover=installedCandidates,healthy=healthyRuntime,install=installWindowsRuntime,
  supported=process.platform==='win32' && process.arch==='x64',now=Date.now}={}) {
  const pending=new Map();
  let retryAfter=0;
  let failureDetail='';
  let lastHealthy;
  async function usable(candidate) {
    if (candidate.fingerprint && lastHealthy?.exe===candidate.exe && lastHealthy.pinned===candidate.pinned &&
        lastHealthy.fingerprint===candidate.fingerprint && now()<lastHealthy.expires) return true;
    if (!(await healthy(candidate))) {
      if (lastHealthy?.exe===candidate.exe) lastHealthy=undefined;
      return false;
    }
    if (candidate.fingerprint) lastHealthy={...candidate,expires:now()+5*60000};
    return true;
  }
  async function resolve(override,provision) {
    for await (const candidate of await discover(override)) {
      if (await usable(candidate)) return {exe:candidate.exe};
    }
    if (override) return {detail:'The configured Lean executable is missing or cannot check a local theorem.'};
    if (!provision || !supported) return {detail:'No working Lean 4 runtime is available for this platform.'};
    if (now()>=retryAfter) {
      let exe;
      try {
        exe=await install();
      } catch (error) {
        if (error.code!=='LEAN_INSTALL_UNAVAILABLE') throw error;
        failureDetail=error.message;
      }
      if (exe) {
        let installed;
        for await (const candidate of await discover(exe)) {
          if (candidate.exe===exe) {installed=candidate;break;}
        }
        if (await usable({...installed,exe,pinned:true})) {retryAfter=0;return {exe};}
        failureDetail='The installed Lean release did not pass the local theorem check.';
      }
      retryAfter=now()+60000;
    }
    return {detail:failureDetail};
  }
  const resolver=(override,provision=true)=>{
    const key=JSON.stringify([override || null,provision]);
    if (!pending.has(key)) pending.set(key,resolve(override,provision).finally(()=>pending.delete(key)));
    return pending.get(key);
  };
  resolver.invalidate=exe=>{if (lastHealthy?.exe===exe) lastHealthy=undefined;};
  return resolver;
}
const resolveLean=createLeanResolver();
async function findLean(explicit) {
  return (await resolveLean(explicit || process.env.PROOF_READER_LEAN,false)).exe || null;
}

function runLean(exe,args,input,cwd,timeoutMs) {
  const env={...process.env};
  // Imported modules come from the selected installation, independent of the paper or local Lake project.
  for (const name of Object.keys(env)) if (/^(LEAN_|LEAN_PATH$|LD_PRELOAD$|LD_LIBRARY_PATH$|DYLD_)/i.test(name)) delete env[name];
  return new Promise(resolve=>{
    const child=spawn(exe,args,{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
    let stdout='',stderr='',size=0,failure='';
    const stop=reason=>{failure=reason;child.kill();};
    const timer=setTimeout(()=>stop('timeout'),timeoutMs);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const append=(chunk,error)=>{
      size+=Buffer.byteLength(chunk);
      if (size>64*1024) { if (!failure) stop('output'); return; }
      if (error) stderr+=chunk; else stdout+=chunk;
    };
    child.stdout.on('data',c=>append(c,false));
    child.stderr.on('data',c=>append(c,true));
    child.on('error',()=>{failure='spawn';});
    child.stdin.on('error',()=>{});
    child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,failure});});
    child.stdin.end(input);
  });
}

// Keep independent imports bounded even when several parts are prepared at once.
let active=0;
const waiters=[];
async function withSlot(task) {
  if (active>=2) await new Promise(resolve=>waiters.push(resolve)); else active++;
  try { return await task(); } finally {
    const next=waiters.shift();
    if (next) next(); else active--;
  }
}
const verifiedAxioms=new Set(['propext','Classical.choice','Quot.sound']);
async function checkBatch(exe,rows,timeoutMs) {
  const failed=(status,detail)=>rows.map(row=>({...row.base,status,detail}));
  return withSlot(async()=>{
    let cwd;
    try {
      cwd=await fs.mkdtemp(path.join(os.tmpdir(),'proof-reader-lean-check-'));
      const ver=await runLean(exe,['--version'],'',cwd,10000);
      if (ver.failure || ver.code!==0 || !/Lean \(version 4\./.test(ver.stdout)) {
        return failed('unavailable','The installed checker did not report a working Lean 4 runtime.');
      }
      const version=ver.stdout.trim().split(/\r?\n/)[0].slice(0,220);
      let input='',nextLine=1;
      const ranges=rows.map(({base},i)=>{
        base.version=version;
        const namespace='Part'+i,start=nextLine;
        const lines=['namespace '+namespace,...base.source.trimEnd().split('\n'),'end '+namespace];
        input+=lines.join('\n')+'\n';
        nextLine+=lines.length;
        return {namespace,start,end:nextLine-1};
      });
      const result=await runLean(exe,['--stdin','--json','-j1','-M1024'],input,cwd,timeoutMs);
      if (result.failure==='timeout') return failed('timeout','Lean reached the local time limit.');
      if (result.failure || result.stderr.trim()) return failed('error','The Lean process could not complete this check.');
      const messages=result.stdout.split(/\r?\n/).filter(s=>s.trim()).map(line=>JSON.parse(line));
      const errors=messages.filter(m=>m.severity==='error');
      if ((result.code!==0 && !errors.length) || errors.some(m=>m.fileName!=='<stdin>' ||
          !ranges.some(r=>m.pos?.line>=r.start && m.pos.line<=r.end))) {
        return failed('error','Lean exited without a complete check of this module.');
      }
      return rows.map(({base,formal},i)=>{
        const range=ranges[i],local=messages.filter(m=>m.fileName==='<stdin>' && m.pos?.line>=range.start && m.pos.line<=range.end);
        const problem=local.find(m=>m.severity==='error'||m.severity==='warning');
        if (problem) return {...base,status:'unproved',detail:String(problem.data||'The tactic did not close the goal.').slice(0,360)};
        const prefix="'"+range.namespace+".readingPart' ";
        const msg=local.find(m=>m.severity==='information' && m.pos.line===range.end-1 && m.data?.startsWith(prefix));
        const receipt=msg?.data.slice(prefix.length).match(/^(?:does not depend on any axioms|depends on axioms:\s*\[([^\]]*)\])$/);
        if (!receipt) return {...base,status:'error',detail:'Lean did not produce a clean axiom report for the theorem.'};
        const axioms=(receipt[1]||'').split(',').map(s=>s.trim()).filter(Boolean);
        if (axioms.some(a=>!verifiedAxioms.has(a))) return {...base,status:'unproved',detail:'The proof depends on an unapproved axiom.',axioms};
        const digest=createHash('sha256').update(base.version).update('\0').update(base.source).digest('hex');
        return {...base,status:'verified',detail:formal.hypotheses.length?'Lean checked the displayed conclusion under the listed hypotheses.':'Lean checked the displayed conclusion.',axioms,digest};
      });
    } catch { return failed('error','The local Lean checker could not run.'); }
    finally { if (cwd) await fs.rmdir(cwd).catch(()=>{}); }
  });
}

// All independent declarations have unique namespaces and individual error locations
// and axiom reports. A false sibling is never evidence for (or against) another claim.
const pending=new Map();
async function verifyFormalization(formal,{executable,timeoutMs=90000}={}) {
  const base={source:'',version:'',detail:'',axioms:[]};
  try { base.source=compileFormalization(formal); }
  catch (error) {return {...base,status:'unsupported',detail:error.message};}
  const runtime=await resolveLean(executable || process.env.PROOF_READER_LEAN);
  if (!runtime.exe) return {...base,status:'unavailable',detail:runtime.detail};
  const exe=runtime.exe;
  const deadline=Number.isFinite(timeoutMs)?Math.max(100,Math.min(120000,timeoutMs)):90000;
  const key=JSON.stringify([exe,deadline]);
  if (!pending.has(key)) {
    const rows=[];
    pending.set(key,rows);
    setTimeout(async()=>{
      pending.delete(key);
      for (let start=0;start<rows.length;start+=32) {
        const group=rows.slice(start,start+32);
        const results=await checkBatch(exe,group,deadline);
        if (results.some(result=>result.status==='unavailable' || result.status==='error')) resolveLean.invalidate(exe);
        group.forEach((row,i)=>row.resolve(results[i]));
      }
    },25);
  }
  return new Promise(resolve=>pending.get(key).push({base,formal,resolve}));
}
module.exports={formalSchema,formalGuidance,compileFormalization,verifyFormalization,findLean,createLeanResolver};
