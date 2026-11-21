'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs/promises');
const {execFile}=require('node:child_process');
const exec=require('node:util').promisify(execFile);

test('the desktop host recovers its own exited service within budget and respects closure and port ownership',
  {skip:process.platform!=='win32',timeout:45000},async t=>{
  const desktop=path.join(__dirname,'desktop');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-desktop-lifecycle-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true,maxRetries:3,retryDelay:100}));
  await fs.writeFile(path.join(dir,'pids'),'');
  await fs.writeFile(path.join(dir,'server.cjs'),`
const http=require('node:http'),fs=require('node:fs');
const identity=JSON.stringify({app:'proof-reader',installation:(fs.existsSync('foreign')?'9':'7').repeat(64)});
http.createServer((req,res)=>{fs.appendFileSync('requests',req.url+'\\n');res.writeHead(200,{'Content-Length':Buffer.byteLength(identity)});res.end(identity);})
  .listen(Number(process.env.PROOF_READER_PORT),'127.0.0.1',()=>{
    fs.writeFileSync('identity-'+process.pid,identity);fs.appendFileSync('pids',process.pid+'\\n');
  });
setInterval(()=>{if(fs.existsSync('exit-'+process.pid))process.exit(23);},30);
setTimeout(()=>process.exit(24),35000).unref();
`);
  const compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const exe=path.join(dir,'lifecycle-test.exe');
  const options={cwd:desktop,windowsHide:true,timeout:30000};
  await exec(compiler,['/nologo','/platform:x64','/target:exe','/main:ServiceLifecycleTest','/out:'+exe,
    '/reference:System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll,System.Net.Http.dll',
    '/reference:Microsoft.Web.WebView2.Core.dll,Microsoft.Web.WebView2.WinForms.dll','ProofReader.cs','ServiceLifecycleTest.cs'],options);
  let result;
  try {result=await exec(exe,[dir,process.execPath,process.env.PROOF_READER_TEST_LOOPBACK==='1'?'http':'fixture'],options);}
  catch(error){
    const evidence=await Promise.all(['pids','requests'].map(f=>fs.readFile(path.join(dir,f),'utf8').catch(()=>'')));
    throw new Error('Desktop fixture saw '+evidence[0].trim().split(/\s+/u).filter(Boolean).length+
      ' started servers and '+evidence[1].trim().split(/\s+/u).filter(Boolean).length+' HTTP requests. '+error.message);
  }
  assert.equal(result.stderr,'');
});
