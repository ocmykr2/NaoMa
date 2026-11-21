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

test('a cold compiler must return a real receipt on retry, and two timeouts preserve its installation', { skip: !windows }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-lean-probe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, '4.36.0', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const exe = path.join(bin, 'lean.exe');
  const source = path.join(root, 'Fixture.cs');
  await fs.writeFile(source, [
    'using System; using System.IO; using System.Threading;',
    'class Fixture { static int Main(string[] args) {',
    '  if (args[0] == "--version") { Console.WriteLine("Lean (version 4.36.0, x86_64-w64-windows-gnu, test)"); return 0; }',
    '  string dir = AppDomain.CurrentDomain.BaseDirectory;',
    '  string log = Path.Combine(dir, "calls");',
    '  string mode = File.ReadAllText(Path.Combine(dir, "mode"));',
    '  bool first = !File.Exists(log); File.AppendAllText(log, "sample\\n");',
    '  if (first || mode == "timeout") Thread.Sleep(20000);',
    '  if (!Console.In.ReadToEnd().Contains("#print axioms readingPart")) return 1;',
    '  Console.WriteLine(mode == "invalid" ? "unverified" : "\'readingPart\' depends on axioms: [propext, Quot.sound]"); return 0;',
    '} }',
  ].join('\n'));
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await run(csc, ['/nologo', '/target:exe', '/out:' + exe, source], { windowsHide: true });
  const wrapper = path.join(root, 'probe.ps1');
  await fs.writeFile(wrapper, [
    'param($Installer, $Root, $Archive)',
    "$PSDefaultParameterValues['Test-Runtime:FirstSampleTimeoutMs'] = 1500",
    "$PSDefaultParameterValues['Test-Runtime:RetrySampleTimeoutMs'] = 3000",
    '& $Installer -Root $Root -Archive $Archive',
  ].join('\r\n'));
  const archive = path.join(root, 'invalid.zip');
  await fs.writeFile(archive, 'untrusted');
  const invoke = () => run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', wrapper, script, root, archive], { windowsHide: true, timeout: 30000 });
  const calls = path.join(bin, 'calls');
  for (const mode of ['recover', 'timeout', 'invalid']) {
    await fs.rm(calls, { force: true });
    await fs.writeFile(path.join(bin, 'mode'), mode);
    if (mode === 'recover') await invoke();
    else {
      const expected = mode === 'timeout' ? /compiler health check timed out/i : /SHA-256 digest/;
      await assert.rejects(invoke(), error => expected.test(error.stderr));
    }
    assert.deepEqual((await fs.readFile(calls, 'utf8')).trim().split(/\s+/), ['sample', 'sample']);
    await fs.access(exe);
    await assert.rejects(fs.access(path.join(root, '.stage')), { code: 'ENOENT' });
  }
});

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
