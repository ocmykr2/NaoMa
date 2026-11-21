const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {after} = require('node:test');

// Keep plan tests independent of GitHub and the user's installed skills.
const names = Object.keys(require('../proof-craft.cjs').hashes);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naoma-editor-test-'));
fs.mkdirSync(path.join(directory, 'references'));
for (const name of names) fs.writeFileSync(path.join(directory, name), 'Synthetic editorial test input for ' + name + '.');
const previous = process.env.NAOMA_PROOF_CRAFT_DIR;
process.env.NAOMA_PROOF_CRAFT_DIR = directory;
after(() => {
  if (previous === undefined) delete process.env.NAOMA_PROOF_CRAFT_DIR;
  else process.env.NAOMA_PROOF_CRAFT_DIR = previous;
  fs.rmSync(directory, {recursive: true, force: true});
});

module.exports = {directory, names};
