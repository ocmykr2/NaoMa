const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {writeAtomic} = require('./plan-checkpoints.cjs');

function preferencesDirectory() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Naoma');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Naoma');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Naoma');
}

function validProvider(value) {
  return value === 'codex' || value === 'claude';
}

function createProviderSettings(directory = preferencesDirectory()) {
  const file = path.join(directory, 'model-provider.json');
  return {
    async get() {
      try {
        const settings = JSON.parse(await fs.readFile(file, 'utf8'));
        if (validProvider(settings?.provider)) return settings.provider;
      } catch (error) {
        if (error.code === 'ENOENT') return 'codex';
      }
      throw Object.assign(new Error('Choose your AI provider again to restore the saved setting.'), {status: 503});
    },
    async set(provider) {
      if (!validProvider(provider)) {
        throw Object.assign(new Error('Choose Codex or Claude.'), {status: 400});
      }
      await writeAtomic(file, JSON.stringify({provider}));
      return provider;
    },
  };
}

module.exports = {createProviderSettings};
