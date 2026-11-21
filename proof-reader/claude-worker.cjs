'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {writeAtomic} = require('./plan-checkpoints.cjs');
const {workerFailureMessage} = require('./worker-failure.cjs');

function failure(code) {
  return Object.assign(new Error(workerFailureMessage(code, 'claude')), {status: 503, workerCode: code});
}

function diagnosticCode(message) {
  if (/not logged in|please run .*login|authentication[_ ]error|unauthori[sz]ed|invalid (?:x-)?api[- ]key|invalid bearer token|\b401\b/i.test(message)) return 'login';
  if (/rate[_ -]limit|usage limit|spending limit|spend limit|credit balance|insufficient[_ ](?:quota|credits)|exceeded your .*limit|hit your .*limit|\b(?:402|429)\b/i.test(message)) return 'quota';
  if (/overloaded|api connection error|failed to (?:connect|fetch)|fetch failed|network (?:error|is unreachable)|connection (?:error|reset|refused|closed)|ECONNRESET|ENOTFOUND|ETIMEDOUT|\b(?:502|503|504|529)\b/i.test(message)) return 'network';
  if (/invalid_request_error|invalid (?:model|schema)|json schema .*invalid|model[_ ]not[_ ]found|model .*not available|unknown (?:option|argument)|unrecognized option|does not exist or you do not have access/i.test(message)) return 'configuration';
  if (/permission_error|forbidden|content[_ -]filter|\brefusal\b|\b403\b/i.test(message)) return 'refused';
  return null;
}

async function claudeExecutable() {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const directories = (process.env.PATH || '').split(path.delimiter);
  // Desktop shortcuts may inherit the PATH from before Claude Code was installed.
  directories.push(path.join(os.homedir(), '.local', 'bin'));
  if (process.platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin');
  const candidates = new Set();
  for (const dir of directories.filter(dir => path.isAbsolute(dir))) {
    candidates.add(path.join(dir, executable));
    // On Windows npm puts a .cmd shim on PATH. Run its official native
    // entry point directly so the schema never passes through cmd.exe.
    if (process.platform === 'win32') candidates.add(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', executable));
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installation directory. */ }
  }
  // Use an absolute path even on a missing install. Spawning it yields ENOENT
  // without making a second executable search in the paper's job directory.
  return path.join(os.homedir(), '.local', 'bin', executable);
}

// The outer document belongs to Claude Code. Only its schema-validated payload
// is a paper result; the free-form result string can also be an API error.
function readResult(stdout, code, diagnostic) {
  let result;
  try { result = JSON.parse(stdout); } catch { /* Handle incomplete output below. */ }
  if (code === 0 && result?.type === 'result' && result.subtype === 'success' && !result.is_error) {
    if (result.structured_output && typeof result.structured_output === 'object' && !Array.isArray(result.structured_output)) {
      return result.structured_output;
    }
    throw failure(diagnostic || 'empty');
  }
  // Inspect the final error only. Never expose model content or a source excerpt in diagnostics.
  const detail = [result?.subtype, result?.result, ...(Array.isArray(result?.errors) ? result.errors : [])].join('\n');
  const incomplete = result?.subtype === 'error_max_structured_output_retries' || code === 0;
  throw failure(diagnosticCode(detail) || diagnostic || (incomplete ? 'empty' : 'exit'));
}

async function runClaudeWorker({
  directory, schemaPath, outputPath, prompt, timeoutMs = 12 * 60 * 1000, webSearch = true, imagePaths = [],
}, launch = spawn) {
  if (timeoutMs <= 0) throw failure('timeout');
  const schema = JSON.stringify(JSON.parse(await fs.readFile(schemaPath, 'utf8')));
  const tools = webSearch ? ['Read', 'WebSearch', 'WebFetch'] : ['Read'];
  const args = ['-p', '--restricted', '--strict-mcp-config', '--disable-slash-commands',
    '--permission-mode', 'dontAsk', '--no-session-persistence', '--model', 'opus',
    '--output-format', 'json', '--json-schema', schema, '--tools', tools.join(','), '--allowedTools', ...tools];
  const images = [...new Set(imagePaths)].map(file => {
    const relative = path.relative(directory, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw failure('configuration');
    return path.resolve(directory, relative);
  });
  const request = [
    'Use Read for the supplied files in this job directory. Return the requested data through structured output.',
    ...(images.length ? ['Examine the supplied source page images with Read before answering:', ...images] : []),
    prompt,
  ].join('\n\n');
  const executable = await claudeExecutable();
  const result = await new Promise((resolve, reject) => {
    const child = launch(executable, args, {cwd: directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout = [];
    let bytes = 0, diagnostic = null, stderrTail = '', drainTimer, settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error); else resolve(value);
    }
    function stop(error) {
      finish(error);
      child.kill('SIGKILL');
    }
    const timer = setTimeout(() => stop(failure('timeout')), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) return stop(failure('empty'));
      stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const text = stderrTail + chunk;
      diagnostic = diagnosticCode(text) || diagnostic;
      stderrTail = text.slice(-256);
    });
    child.once('error', () => finish(failure('installation')));
    function completed(code) {
      if (settled) return;
      try { finish(null, readResult(Buffer.concat(stdout).toString('utf8'), code, diagnostic)); }
      catch (error) { finish(error); }
    }
    child.once('close', completed);
    child.once('exit', code => {
      // Some CLI helpers inherit pipes, keeping close pending after the result is complete.
      if (!settled) drainTimer = setTimeout(() => completed(code), 300);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(request);
  });
  await writeAtomic(outputPath, JSON.stringify(result));
}

module.exports = {runClaudeWorker};
