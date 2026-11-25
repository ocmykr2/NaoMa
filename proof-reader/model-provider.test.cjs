const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createProviderSettings} = require('./model-provider.cjs');

test('Claude is the default and an explicit provider choice survives restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-provider-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const settings = createProviderSettings(dir);
  assert.equal(await settings.get(), 'claude');
  await settings.set('codex');
  assert.equal(await createProviderSettings(dir).get(), 'codex');
  await settings.set('claude');
  assert.equal(await createProviderSettings(dir).get(), 'claude');
  await assert.rejects(settings.set('other'), {status:400});
  assert.equal(await settings.get(), 'claude');
  await fs.writeFile(path.join(dir, 'model-provider.json'), '{');
  await assert.rejects(settings.get(), {status:503});
  await settings.set('codex');
  assert.equal(await settings.get(), 'codex');
});

test('the local provider API accepts only local, explicit provider choices', {timeout:20000}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-provider-api-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
    env:{...process.env, LOCALAPPDATA:dir, XDG_CONFIG_HOME:dir, HOME:dir, USERPROFILE:dir, PROOF_READER_PORT:'0'},
    stdio:['ignore', 'pipe', 'pipe'], windowsHide:true,
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  const address = await Promise.race([
    once(child.stdout, 'data').then(([data]) => String(data).trim()),
    closed.then(([code]) => { throw new Error('Reader exited during startup with code ' + code); }),
  ]);
  const url = new URL('/api/model-provider', address);
  const put = (provider, extraHeaders) => fetch(url, {
    method:'PUT', headers:{'content-type':'application/json', ...extraHeaders}, body:JSON.stringify({provider}),
  });
  assert.deepEqual(await (await fetch(url)).json(), {provider:'claude'});
  assert.deepEqual(await (await put('codex')).json(), {provider:'codex'});
  assert.deepEqual(await (await put('claude')).json(), {provider:'claude'});
  assert.equal((await put('codex', {origin:'https://example.org'})).status, 403);
  assert.equal((await put('unknown')).status, 400);
  assert.equal((await fetch(url, {method:'POST'})).status, 405);
  assert.deepEqual(await (await fetch(url)).json(), {provider:'claude'});
  const staleTab = await fetch(new URL('/api/paper-question', address), {
    method:'POST', headers:{'content-type':'application/json', 'x-naoma-provider':'codex'},
    body:JSON.stringify({title:'Counting marbles', step:1, question:'Why are there six marbles?',
      units:[{title:'A count', text:'There are two rows of three marbles each.'}]}),
  });
  assert.equal(staleTab.status, 409);
});
