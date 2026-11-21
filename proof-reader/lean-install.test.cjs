const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const script = path.join(__dirname, 'desktop', 'install-lean.ps1');
const windows = process.platform === 'win32';

function install(root, archive) {
  return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Root', root, '-Archive', archive], { windowsHide: true, timeout: 15 * 60_000 });
}

test('the Windows installer rejects an unpinned archive and preserves an interrupted previous installation', { skip: !windows }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-lean-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'untrusted.zip');
  const old = path.join(root, '.previous-4.36.0');
  await fs.writeFile(archive, 'untrusted archive');
  await fs.mkdir(old);
  await fs.writeFile(path.join(old, 'old.txt'), 'checkpoint');
  const protectedDir = path.join(root, 'keep');
  const abandonedStage = path.join(root, '.install-' + '0'.repeat(32));
  await fs.mkdir(protectedDir);
  await fs.writeFile(path.join(protectedDir, 'external.txt'), 'preserved');
  await fs.mkdir(abandonedStage);
  try {
    await fs.symlink(protectedDir, path.join(abandonedStage, 'link'), 'junction');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('This account cannot create directory junctions for the optional cleanup check.');
  }
  await assert.rejects(install(root, archive), error => /SHA-256 digest/.test(error.stderr));
  assert.equal(await fs.readFile(path.join(root, '4.36.0', 'old.txt'), 'utf8'), 'checkpoint');
  assert.equal(await fs.readFile(path.join(protectedDir, 'external.txt'), 'utf8'), 'preserved');
  assert.deepEqual((await fs.readdir(root)).sort(), ['.install.lock', '4.36.0', 'keep', 'untrusted.zip']);
});

// Set this only when the actual pinned release archive is available locally.
const officialArchive = process.env.NAOMA_TEST_LEAN_ARCHIVE;
test('the real Windows release installs concurrently, repairs a broken compiler and reuses a verified runtime', {
  skip: !windows || !officialArchive,
}, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-lean-real-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  // The installed version fits here, but the previous 41-character staging name
  // left the native compiler with a 260-character core module path.
  const root = temp.length >= 143 ? temp : path.join(temp, 'r'.repeat(142 - temp.length));
  const archive = path.resolve(officialArchive);
  const compiler = path.join(root, '4.36.0', 'bin', 'lean.exe');
  const coldInstalls = await Promise.allSettled([install(root, archive), install(root, archive)]);
  for (const result of coldInstalls) if (result.status === 'rejected') throw result.reason;
  const { stdout } = await run(compiler, ['--version'], { windowsHide: true });
  assert.match(stdout, /Lean \(version 4\.36\.0, x86_64-w64-windows-gnu/);
  const coreModule = path.join(root, '4.36.0', 'lib', 'lean', 'Init.olean');
  await fs.rename(coreModule, coreModule + '.broken');
  assert.equal((await run(compiler, ['--version'], { windowsHide: true })).stdout, stdout);
  await install(root, archive);
  await fs.access(coreModule);
  await assert.rejects(fs.access(coreModule + '.broken'), { code: 'ENOENT' });
  await install(root, path.join(root, 'unavailable.zip'));
  assert.deepEqual((await fs.readdir(root)).sort(), ['.install.lock', '4.36.0']);
  const tooLong = path.join(temp, 't'.repeat(Math.max(1, 180 - temp.length)));
  await assert.rejects(install(tooLong, archive), error => /runtime path is too long/i.test(error.stderr));
  assert.deepEqual(await fs.readdir(tooLong), ['.install.lock']);
});
