'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('version diagnostics compare the running service with the release currently on disk', {timeout:20000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-version-'));
  let child, closed;
  async function stop() {
    if (child) {
      child.kill();
      await closed;
      child = null;
    }
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, {recursive:true, force:true});
  });
  // Run the real service in an isolated installation so the test can update
  // its version file while the first process is still serving requests.
  const sources = (await fs.readdir(__dirname)).filter(name => /\.c?js$/u.test(name) && !name.endsWith('.test.cjs'));
  await Promise.all(sources.map(name => fs.copyFile(path.join(__dirname, name), path.join(root, name))));
  async function start() {
    child = spawn(process.execPath, [path.join(root, 'server.cjs')], {
      env:{...process.env, PROOF_READER_PORT:'0'}, stdio:['ignore','pipe','pipe'], windowsHide:true,
    });
    closed = once(child, 'close');
    const address = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data).trim()),
      closed.then(([code]) => { throw Error('Reader exited during startup with code ' + code); }),
    ]);
    return new URL('/api/reader-version', address);
  }
  const file = path.join(root, 'VERSION');
  await fs.writeFile(file, '1.2.3\n');
  let url = await start();
  async function check(runningVersion, installedVersion) {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), {runningVersion, installedVersion});
  }
  await check('1.2.3', '1.2.3');
  const identity = await (await fetch(new URL('/api/reader-identity', url))).text();
  await fs.writeFile(file, '1.2.4\r\n');
  await check('1.2.3', '1.2.4');
  assert.equal(await (await fetch(new URL('/api/reader-identity', url))).text(), identity);
  assert.equal((await fetch(url, {method:'POST'})).status, 405);
  assert.equal((await fetch(url, {headers:{origin:'https://example.org'}})).status, 403);
  await fs.writeFile(file, 'invalid release metadata');
  await check('1.2.3', null);
  await fs.unlink(file);
  await check('1.2.3', null);
  await stop();
  url = await start();
  await check(null, null);
  await fs.writeFile(file, '1.2.4');
  await check(null, '1.2.4');
});
