const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createProofCraftLoader, hashes, revision} = require('./proof-craft.cjs');

const names = Object.keys(hashes);
const bytes = Object.fromEntries(names.map(name => [name, Buffer.from('Editorial fixture: ' + name + '\n')]));
const checksums = Object.fromEntries(names.map(name => [name, createHash('sha256').update(bytes[name]).digest('hex')]));
const base = 'https://raw.githubusercontent.com/fitelson/proof-craft/' + revision + '/';
function download(url, options) {
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(url.startsWith(base));
  const contents = bytes[url.slice(base.length)];
  assert.ok(contents, url);
  return new Response(contents);
}
async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-proof-craft-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}

test('first use verifies the four pinned files, shares a download and starts offline after restart', async t => {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(names, ['SKILL.md', 'REFERENCE.md', 'references/halmos-exposition.md', 'references/finite-reductions.md']);
  assert.ok(Object.values(hashes).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  const directory = await temp(t);
  const requests = [];
  const load = createProofCraftLoader({directory, checksums, request(url, options) {
    requests.push(url);
    return download(url, options);
  }});
  const [first, peer] = await Promise.all([load(null), load(null)]);
  assert.deepEqual(requests.toSorted(), names.map(name => base + name).toSorted());
  assert.equal(first.name, 'proof-craft');
  assert.deepEqual(first.files, names.map(name => ({name, text: bytes[name].toString()})));
  assert.deepEqual(first, peer);
  const offline = createProofCraftLoader({directory, checksums, request: () => assert.fail('attempted network')});
  assert.deepEqual(await offline(null), first);
});

test('an altered download never creates a cached skill; the next request retries installation', async t => {
  const directory = await temp(t);
  let modified = true;
  const load = createProofCraftLoader({directory, checksums, request: (url, options) =>
    modified && url.endsWith('/SKILL.md') ? new Response(Buffer.concat([Buffer.from([239,187,191]), bytes['SKILL.md']])) : download(url, options)});
  await assert.rejects(load(null), {status: 503, message: /SKILL.md failed its SHA-256/});
  assert.deepEqual(await fs.readdir(directory), []);
  modified = false;
  assert.equal((await load(null)).files.length, 4);
});

test('a corrupt cache is replaced only with a complete verified edition', async t => {
  const directory = await temp(t);
  const file = path.join(directory, revision + '.json');
  const load = createProofCraftLoader({directory, checksums, request: download});
  const original = await load(null);
  const tampered = JSON.parse(await fs.readFile(file, 'utf8'));
  tampered['REFERENCE.md'] += 'extra';
  await fs.writeFile(file, JSON.stringify(tampered));
  assert.deepEqual(await load(null), original);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))['REFERENCE.md'], bytes['REFERENCE.md'].toString());
});

test('an existing pinned installation works offline and a damaged file is recovered from the verified edition', async t => {
  const directory = await temp(t);
  const bundledDirectory = await temp(t);
  for (const name of names) {
    const dest = path.join(bundledDirectory, name);
    await fs.mkdir(path.dirname(dest), {recursive: true});
    await fs.writeFile(dest, bytes[name]);
  }
  const options = {directory, bundledDirectory, checksums};
  const offline = createProofCraftLoader({...options, request: () => assert.fail('unexpected download')});
  const original = await offline(null);
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(path.join(bundledDirectory, 'SKILL.md'), 'incomplete');
  const recover = createProofCraftLoader({...options, request: download});
  assert.deepEqual(await recover(null), original);
  assert.deepEqual(await offline(null), original);
});

test('a temporary network failure retries without interaction; persistent failures identify the source', async t => {
  const directory = await temp(t);
  let failures = 0;
  const flaky = createProofCraftLoader({directory, checksums, request(url, options) {
    if (url.endsWith('/SKILL.md') && failures++ === 0) throw new Error('network unavailable');
    return download(url, options);
  }});
  assert.equal((await flaky(null)).name, 'proof-craft');
  assert.equal(failures, 2);
  const empty = await temp(t);
  const unavailable = createProofCraftLoader({directory: empty, checksums, request: () => new Response(null, {status: 404})});
  await assert.rejects(unavailable(null), {status: 503, message: /downloaded from GitHub/});
  assert.deepEqual(await fs.readdir(empty), []);
});
