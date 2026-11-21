const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {writeAtomic} = require('./plan-checkpoints.cjs');

const revision = '46f6f6b13135d6d1d15816d95f318676d62079f4';
const source = 'https://raw.githubusercontent.com/fitelson/proof-craft/' + revision + '/';
const hashes = Object.freeze({
  'SKILL.md': 'bb090e9d6a96f9851b0f1179eb6cf9b0f624d5bfa7faedd33e0018122eddaf73',
  'REFERENCE.md': '8e3e940a0e95550b3251e783fa657eb851781168897a6281733d3dd1e14912ff',
  'references/halmos-exposition.md': '5a62ebcc0bf22b338f856d7c5a7b665305c53c131a4e14660e2f8bc3395cfc9b',
  'references/finite-reductions.md': '2204e92f0f41f20d182eb6c57e36bf8793ef111c599eedbdb310a472a359e469'
});

function cacheRoot() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function failure(message, cause) {
  return Object.assign(new Error(message, {cause}), {status: 503});
}

function skill(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.name).update('\0').update(file.text.replace(/\r\n/gu, '\n')).update('\0');
  return {name: 'proof-craft', files, digest: hash.digest('hex')};
}

function createProofCraftLoader({directory = path.join(cacheRoot(), 'ProofReader', 'skills', 'proof-craft'),
  bundledDirectory, checksums = hashes, request = (...args) => fetch(...args)} = {}) {
  const filename = path.join(directory, revision + '.json');
  const names = Object.keys(checksums);
  let pending;
  function verified(name, text) {
    return typeof text === 'string' && text.length > 0 && createHash('sha256').update(text).digest('hex') === checksums[name];
  }
  async function fetchFile(name) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await request(source + name, {redirect: 'error', signal: AbortSignal.timeout(15000)});
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (createHash('sha256').update(bytes).digest('hex') !== checksums[name])
            throw failure('The downloaded Proof Craft file ' + name + ' failed its SHA-256 check.');
          return {name, text: bytes.toString('utf8')};
        }
        lastError = new Error('HTTP ' + response.status);
        if (response.status < 500 && response.status !== 429 && response.status !== 408) break;
      } catch (error) {
        if (error.status === 503) throw error;
        lastError = error;
      }
      if (attempt === 0) await delay(350);
    }
    throw failure('Proof Craft could not be downloaded from GitHub (' + name + '). Check your connection and retry preparation.', lastError);
  }
  async function loadDefault() {
    if (bundledDirectory) {
      try {
        const files = await Promise.all(names.map(async name => ({name, text: await fs.readFile(path.join(bundledDirectory, name), 'utf8')})));
        if (files.every(file => verified(file.name, file.text))) return skill(files);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw failure('The installed Proof Craft files could not be read.', error);
      }
    }
    let saved;
    try { saved = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw failure('The local Proof Craft cache could not be read.', error);
    }
    if (saved && names.every(name => verified(name, saved[name]))) return skill(names.map(name => ({name, text: saved[name]})));
    const files = await Promise.all(names.map(fetchFile));
    try { await writeAtomic(filename, JSON.stringify(Object.fromEntries(files.map(file => [file.name, file.text])))); }
    catch (error) { throw failure('Proof Craft was verified, but its local cache could not be saved. Check available space and folder permissions.', error); }
    return skill(files);
  }
  return async function loadEditorialSkill(override = process.env.NAOMA_PROOF_CRAFT_DIR) {
    if (override) {
      try {
        const files = await Promise.all(names.map(async name => ({name, text: await fs.readFile(path.join(override, name), 'utf8')})));
        if (files.some(file => !file.text.trim())) throw new Error('Empty guidance file.');
        return skill(files);
      } catch (error) { throw failure('Check the Proof Craft directory in NAOMA_PROOF_CRAFT_DIR. Its skill and reference files must be readable.', error); }
    }
    if (!pending) pending = loadDefault().finally(() => { pending = undefined; });
    return pending;
  };
}

module.exports = {loadEditorialSkill: createProofCraftLoader({bundledDirectory: path.join(__dirname, 'skills', 'proof-craft')}),
  createProofCraftLoader, revision, hashes};
