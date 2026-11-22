const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createLiteratureSearch } = require('./literature-search.cjs');
const { createPaperAgentHandler, readLocalJson, runCodexWorker } = require('./paper-agent.cjs');
const { createQuestionHandler } = require('./ask-paper.cjs');
const { createPlanHandler } = require('./personalized-plan.cjs');
const { createSectionGuideHandler } = require('./section-guides.cjs');
const {createPaperCache}=require('./paper-cache.cjs');
const {createClearPaperHandler}=require('./clear-paper.cjs');
const {createProviderSettings} = require('./model-provider.cjs');
const {runClaudeWorker} = require('./claude-worker.cjs');

const searchLiterature = createLiteratureSearch();
const paperCache=createPaperCache();
const providerSettings = createProviderSettings();
async function selectWorker(req) {
  const provider = await providerSettings.get();
  const displayed = req.headers['x-naoma-provider'];
  if (displayed !== undefined && displayed !== provider) {
    throw new RequestError(409, 'The AI provider changed. Open AI provider to confirm your choice, then try again.');
  }
  return {provider, worker: provider === 'claude' ? runClaudeWorker : runCodexWorker};
}
const handlers={worker:runCodexWorker,selectWorker,readLocalJson,checkLocalRequest,renderSourcePage:renderPage,paperCache};
const handleTechniques = createPaperAgentHandler({paperCache,selectWorker});
const handleQuestion = createQuestionHandler(handlers);
const handlePlan = createPlanHandler(handlers);
const handleSection = createSectionGuideHandler(handlers);
const handleClearPaper=createClearPaperHandler(handlers);
const port = Number(process.env.PROOF_READER_PORT ?? 8794);
const openOnStart = process.argv.includes('--open');
const directory = process.platform === 'win32' ? __dirname.toLowerCase() : __dirname;
const identity = JSON.stringify({
  app: 'proof-reader', installation: createHash('sha256').update(directory).digest('hex'),
});
async function readInstalledVersion() {
  try {
    const version = (await readFile(path.join(__dirname, 'VERSION'), 'utf8')).trim();
    return /^\d+\.\d+\.\d+$/u.test(version) ? version : null;
  } catch {
    return null;
  }
}
const runningVersion = readInstalledVersion();

const maxUpload = 12 * 1024 * 1024;
const maxText = 4 * 1024 * 1024;
const maxPageImage = 48 * 1024 * 1024;
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/demo.js', ['demo.js', 'text/javascript']],
  ['/pdf-reader.js', ['pdf-reader.js', 'text/javascript']],
  ['/page-view.js', ['page-view.js', 'text/javascript']],
  ['/reading-plan.js', ['reading-plan.js', 'text/javascript']],
  ['/plan-diagnostics.js', ['plan-diagnostics.js', 'text/javascript']],
  ['/part-orientation.js', ['part-orientation.js', 'text/javascript']],
  ['/paper-knowledge-data.js', ['paper-knowledge-data.js', 'text/javascript']],
  ['/knowledge-state.js', ['knowledge-state.js', 'text/javascript']],
  ['/knowledge-ui.js', ['knowledge-ui.js', 'text/javascript']],
  ['/reading-session.js', ['reading-session.js', 'text/javascript']],
  ['/stage-ui.js', ['stage-ui.js', 'text/javascript']],
  ['/notation-picker.js', ['notation-picker.js', 'text/javascript']],
  ['/overview-data.js', ['overview-data.js', 'text/javascript']],
  ['/paper-library.js', ['paper-library.js', 'text/javascript']],
  ['/paper-removal.js', ['paper-removal.js', 'text/javascript']],
  ['/explorer.js', ['explorer.js', 'text/javascript']],
  ['/katex.min.js', ['katex.min.js', 'text/javascript']],
  ['/reader-math.js', ['reader-math.js', 'text/javascript']],
  ['/reader-math.css', ['reader-math.css', 'text/css']],
  ['/import.js', ['import.js', 'text/javascript']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkLocalRequest(req) {
  const port = req.socket.localPort;
  const suffix = port === 80 ? '' : `:${port}`;
  const hosts = new Set([`127.0.0.1${suffix}`, `localhost${suffix}`]);
  const origin = req.headers.origin;
  if (!hosts.has(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site' ||
      (origin !== undefined && origin !== `http://${req.headers.host}`)) {
    throw new RequestError(403, 'Open the reader on this computer to make this request.');
  }
}

function checkUpload(req) {
  checkLocalRequest(req);
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/pdf') {
    throw new RequestError(415, 'Select a PDF file to upload.');
  }
  if (Number(req.headers['content-length']) > maxUpload) {
    throw new RequestError(413, 'This PDF exceeds 12 MiB. Save the pages you want to read as a smaller PDF and try again.');
  }
}

async function readPdf(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxUpload) {
      throw new RequestError(413, 'This PDF exceeds 12 MiB. Save the pages you want to read as a smaller PDF and try again.');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new RequestError(415, 'The selected file is missing its PDF header. Check the file and try again.');
  }
  return bytes;
}

function runPoppler(tool, args, pdf, outputLimit) {
  return new Promise((resolve, reject) => {
    const program = process.platform === 'win32' ? `${tool}.exe` : tool;
    const child = spawn(program, args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks = [];
    let outputSize = 0;
    let errors = '';

    function stop(error) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    }
    const timer = setTimeout(() => {
      stop(new RequestError(422, 'Processing this PDF timed out. Try exporting the pages you need as a smaller PDF.'));
    }, 20000);
    child.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > outputLimit) {
        stop(new RequestError(422, 'The PDF output is too large to load. Try exporting a smaller section.'));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on('data', chunk => {
      if (errors.length < 8192) errors += chunk.toString('utf8', 0, 8192 - errors.length);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new RequestError(500, error.code === 'ENOENT'
        ? `The reader could not find ${tool} on this computer. Install Poppler to open PDFs in the reader.`
        : `The reader could not start ${tool}. Check your local Poppler installation.`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        if (/wrong page range/i.test(errors)) {
          reject(new RequestError(404, 'This page is outside the PDF.'));
          return;
        }
        reject(new RequestError(422, /password|encrypt/i.test(errors)
          ? 'This PDF is password protected. Unlock it and upload it again.'
          : 'The reader could not open this PDF. Check that the file is complete, or paste the text into the reader.'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    // A rejected PDF may close the input pipe before all bytes have been written.
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') {
        stop(new RequestError(500, 'The reader could not send the PDF to Poppler.'));
      }
    });
    child.stdin.end(pdf);
  });
}

async function extractPages(pdf) {
  const data = await runPoppler('pdftotext', ['-enc', 'UTF-8', '-layout', '-', '-'], pdf, maxText);
  const pages = data.toString('utf8').replace(/\r\n?/g, '\n').split('\f');
  // Poppler ends each page, including an image-only page, with one form feed.
  if (pages.length > 1 && !pages.at(-1).trim()) pages.pop();
  return { text: pages.join('\n\n').trim(), pages };
}

function getPageNumber(query) {
  const values = new URLSearchParams(query).getAll('page');
  if (values.length !== 1 || !/^[1-9]\d{0,9}$/.test(values[0]) || Number(values[0]) > 2147483647) {
    throw new RequestError(400, 'Choose a positive whole page number.');
  }
  return values[0];
}

async function renderPage(pdf, page) {
  const range = ['-f', page, '-l', page];
  const info = await runPoppler('pdfinfo', [...range, '-'], pdf, 256 * 1024);
  const size = info.toString('utf8').match(/^Page\s+\d+\s+size:\s*([\d.e+\-]+)\s+x\s+([\d.e+\-]+)\s+pts/im);
  const longestSide = size && Math.max(Number(size[1]), Number(size[2]));
  if (!(longestSide > 0) || !Number.isFinite(longestSide)) {
    throw new RequestError(422, 'The PDF does not specify a readable page size.');
  }
  // Keep normal pages at 125 dpi and scale unusually large pages before allocation.
  const dpi = Math.min(125, 72 * 3000 / longestSide);
  const png = await runPoppler('pdftoppm', [...range, '-singlefile', '-r', String(dpi), '-png', '-'], pdf, maxPageImage);
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new RequestError(422, 'The reader could not render this PDF page.');
  }
  return png;
}

const server = http.createServer({ requestTimeout: 30000, headersTimeout: 15000 }, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const [route, query] = req.url.split('?');
  try {
    if (route === '/api/model-provider') {
      checkLocalRequest(req);
      let provider;
      if (req.method === 'PUT') {
        const settings = await readLocalJson(req, 512);
        provider = await providerSettings.set(settings?.provider);
      } else if (req.method === 'GET') {
        provider = await providerSettings.get();
      } else {
        res.setHeader('Allow', 'GET, PUT');
        throw new RequestError(405, 'Use GET or PUT for the AI provider setting.');
      }
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({provider}));
      return;
    }
    if (route==='/api/paper-cache/clear') {
      await handleClearPaper(req,res);
      return;
    }
    if (route === '/api/reading-plan' || route.startsWith('/api/reading-plan/')) {
      await handlePlan(req, res, route);
      return;
    }
    if (route === '/api/section-structure' || route.startsWith('/api/section-structure/')) {
      await handleSection(req,res,route);
      return;
    }
    if (route === '/api/techniques' || route.startsWith('/api/techniques/')) {
      await handleTechniques(req, res, route);
      return;
    }
    if (route === '/api/paper-question' || route.startsWith('/api/paper-question/')) {
      await handleQuestion(req, res, route);
      return;
    }
    if (route === '/api/reader-version') {
      checkLocalRequest(req);
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new RequestError(405, 'Use GET to check the reader version.');
      }
      const versions = {runningVersion:await runningVersion, installedVersion:await readInstalledVersion()};
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify(versions));
      return;
    }
    if (route === '/api/reader-identity') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new RequestError(405, 'Use GET to identify the reader.');
      }
      checkLocalRequest(req);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(identity) });
      res.end(identity);
      return;
    }
    if (route === '/api/literature') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new RequestError(405, 'Use GET to search the literature.');
      }
      checkLocalRequest(req);
      const terms = new URLSearchParams(query).getAll('q');
      if (terms.length !== 1) throw new RequestError(400, 'Enter one set of public search terms.');
      const results = await searchLiterature(terms[0]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(results));
      return;
    }
    if (route === '/api/pdf' || route === '/api/pdf-page') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new RequestError(405, 'Use POST to upload a PDF.');
      }
      checkUpload(req);
      const page = route === '/api/pdf-page' ? getPageNumber(query) : null;
      const pdf = await readPdf(req);
      if (page !== null) {
        const png = await renderPage(pdf, page);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        res.end(png);
        return;
      }
      const extracted = await extractPages(pdf);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(extracted));
      return;
    }
    const asset = files.get(route);
    if (!asset) throw new RequestError(404, 'Page not found.');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw new RequestError(405, 'This page supports GET and HEAD requests only.');
    }
    const data = await readFile(path.join(__dirname, asset[0]));
    res.writeHead(200, {
      'Content-Type': asset[1].startsWith('text/') ? `${asset[1]}; charset=utf-8` : asset[1],
      'Content-Length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (res.destroyed) return;
    if (!req.complete) {
      res.setHeader('Connection', 'close');
      req.resume();
    }
    res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.status ? error.message : 'The reader could not complete this request. Try again.' }));
  }
});

function showReader(portNumber) {
  const url = `http://127.0.0.1:${portNumber}/`;
  console.log(url);
  if (openOnStart && process.platform === 'win32') {
    const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {windowsHide:true, stdio:'ignore'});
    opener.on('error', () => console.log('Open the address above in your browser.'));
    opener.unref();
  }
}

async function sameInstallation(portNumber) {
  try {
    const response = await fetch(`http://127.0.0.1:${portNumber}/api/reader-identity`, {
      signal: AbortSignal.timeout(2000), redirect: 'error',
    });
    if (response.status !== 200 || Number(response.headers.get('Content-Length')) !== Buffer.byteLength(identity)) {
      await response.body?.cancel();
      return false;
    }
    return await response.text() === identity;
  } catch {
    return false;
  }
}

server.on('error', async error => {
  if (openOnStart && error.code === 'EADDRINUSE') {
    if (await sameInstallation(port)) {
      showReader(port);
      return;
    }
    console.error(`Port ${port} is in use by another service. Close that service or set PROOF_READER_PORT to a different port.`);
  } else {
    console.error(`Could not start the local reader: ${error.message}`);
  }
  process.exitCode = 1;
});
runningVersion.then(() => server.listen(port, '127.0.0.1', () => showReader(server.address().port)));
