'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {runClaudeWorker} = require('./claude-worker.cjs');
const {workerFailureCode} = require('./worker-failure.cjs');

async function jobFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'naoma-claude-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const schemaPath = path.join(directory, 'result.schema.json');
  const outputPath = path.join(directory, 'result.json');
  const schema = {type: 'object', properties: {claim: {type: 'string'}}, required: ['claim'], additionalProperties: false};
  await fs.writeFile(schemaPath, JSON.stringify(schema));
  return {directory, schemaPath, outputPath, prompt: 'Compare the two routes in "routes.json" with $x < 2.'};
}

function launchFixture(program, check = () => {}) {
  return (executable, args, options) => {
    check(executable, args, options);
    return spawn(process.execPath, ['-e', '(' + program.toString() + ')()', '--', ...args], options);
  };
}

test('Claude uses the moving Opus alias, supplies job-local source evidence, and publishes only the structured payload', async t => {
  const job = await jobFor(t);
  const source = path.join(job.directory, 'route diagram.png');
  const answer = {claim: 'The two routes meet at station β.'};
  for (const webSearch of [false, true]) {
    await fs.writeFile(job.outputPath, 'old');
    const fake = launchFixture(async () => {
      let prompt = '';
      for await (const chunk of process.stdin) prompt += chunk;
      if (!prompt.includes('route diagram.png') || !prompt.includes('"routes.json" with $x < 2.')) process.exit(4);
      process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', is_error: false,
        result: 'The task is complete.', structured_output: {claim: 'The two routes meet at station β.'}}));
    }, (executable, args, options) => {
      assert.equal(path.basename(executable), process.platform === 'win32' ? 'claude.exe' : 'claude');
      assert.equal(options.cwd, job.directory);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag));
      assert.equal(args[args.indexOf('--model') + 1], 'opus');
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
      assert.equal(args[args.indexOf('--output-format') + 1], 'json');
      assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]).required, ['claim']);
      const tools = webSearch ? ['Read', 'WebSearch', 'WebFetch'] : ['Read'];
      assert.deepEqual(args[args.indexOf('--tools') + 1].split(','), tools);
      assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1), tools);
      assert.ok(!args.includes(job.prompt));
    });
    await runClaudeWorker({...job, webSearch, imagePaths: [source]}, fake);
    assert.deepEqual(JSON.parse(await fs.readFile(job.outputPath, 'utf8')), answer);
  }
});

test('free-form messages and truncated output cannot become successful Claude paper results', async t => {
  const job = await jobFor(t);
  for (const program of [
    () => process.stdout.write('{"type":"result"'),
    () => process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'{"claim":"A route exists"}'})),
    () => process.stdout.write(JSON.stringify({type:'result', subtype:'error_max_structured_output_retries', is_error:true})),
  ]) {
    await assert.rejects(runClaudeWorker(job, launchFixture(program)), e => workerFailureCode(e) === 'empty');
    await assert.rejects(fs.stat(job.outputPath), {code: 'ENOENT'});
  }
});

test('Claude failures preserve worker classifications without displaying paper text', async t => {
  const job = await jobFor(t);
  for (const [message, code, exitCode] of [
    ['Invalid API key', 'login', 0], ['Rate limit reached', 'quota', 1], ['API connection error', 'network', 1],
    ['Unknown option --restricted', 'configuration', 1], ['permission_error', 'refused', 1],
    ['Unexpected failure', 'exit', 1],
  ]) {
    const launch = (_exe, _args, options) => spawn(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:true,result:process.argv[1]}));process.exitCode=Number(process.argv[2])',
      message + ' private manuscript excerpt', String(exitCode)], options);
    await assert.rejects(runClaudeWorker(job, launch), e => workerFailureCode(e) === code && !e.message.includes('manuscript'));
  }
  const failingCLI = launchFixture(() => {
    process.stderr.write('Error: unknown option --restricted');
    process.exitCode = 1;
  });
  await assert.rejects(runClaudeWorker(job, failingCLI), e => workerFailureCode(e) === 'configuration');
});

test('Claude jobs respect their deadline and reject source images outside the job', async t => {
  const job = await jobFor(t);
  await assert.rejects(runClaudeWorker({...job, timeoutMs: 150}, launchFixture(() => setInterval(() => {}, 1000))),
    e => workerFailureCode(e) === 'timeout');
  await assert.rejects(runClaudeWorker({...job, imagePaths: [path.join(job.directory, '..', 'other.png')]},
    () => assert.fail('The child should not launch')), e => workerFailureCode(e) === 'configuration');
  await assert.rejects(runClaudeWorker(job, (_cmd, args, options) => spawn(path.join(job.directory, 'missing-claude'), args, options)),
    e => workerFailureCode(e) === 'installation');
});

test('a completed Claude result is usable when an inherited pipe stays open after exit', async t => {
  const job = await jobFor(t);
  const launch = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {},
    });
    child.stdin.on('finish', () => {
      child.stdout.write(JSON.stringify({type: 'result', subtype: 'success', structured_output: {claim: 'Two routes.'}}));
      child.emit('exit', 0);
    });
    return child;
  };
  await runClaudeWorker({...job, timeoutMs: 3000}, launch);
  assert.deepEqual(JSON.parse(await fs.readFile(job.outputPath, 'utf8')), {claim: 'Two routes.'});
});

test('Windows npm installs launch the official native entry point directly', {skip: process.platform !== 'win32'}, async t => {
  const job = await jobFor(t);
  const prefix = path.join(job.directory, 'npm installs');
  const binary = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  await fs.mkdir(path.dirname(binary), {recursive: true});
  await fs.writeFile(binary, '');
  const oldPath = process.env.PATH;
  process.env.PATH = prefix + path.delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  await runClaudeWorker(job, launchFixture(() => {
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', structured_output: {claim: 'Two routes.'}}));
  }, (executable, _args, options) => {
    assert.equal(executable, binary);
    assert.equal(options.shell, false);
  }));
});
