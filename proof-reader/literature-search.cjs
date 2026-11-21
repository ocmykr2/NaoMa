const source = 'Crossref';
const searchEndpoint = 'https://api.crossref.org/works';
const paperTypes = new Set(['journal-article', 'proceedings-article', 'posted-content', 'book-chapter', 'monograph', 'book', 'report', 'dissertation']);
const entities = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', times: '×', minus: '−',
};

class LiteratureError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function plainText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (original, code) => {
    if (code[0] !== '#') return Object.hasOwn(entities, code) ? entities[code] : original;
    const hex = code[1].toLowerCase() === 'x';
    const n = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  }).replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:[\w-]+:)?(?:p|div|br|li|title|sec|abstract)\b[^>]*>/gi, ' ')
    .replace(/<\/?[a-z][\w:.-]*(?:\s+[^<>]*?)?\s*\/?>/gi, '')
    .replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim();
}

function publicQuery(value) {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new LiteratureError(400, 'Enter one line of public search terms, between 2 and 200 characters.');
  }
  const query = value.trim().replace(/\s+/gu, ' ');
  if (query.length < 2 || !/[\p{L}\p{N}]/u.test(query)) {
    throw new LiteratureError(400, 'Enter at least two characters and include a word or number.');
  }
  return query;
}

function formatWorks(items) {
  const papers = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  for (const item of items) {
    if (!item || !paperTypes.has(item.type)) continue;
    const doi = typeof item.DOI === 'string' ? item.DOI.trim() : '';
    if (!/^10\.\d{4,9}\/[^\s\u0000-\u001f]+$/i.test(doi)) continue;
    const title = Array.isArray(item.title) ? plainText(item.title[0]) : '';
    const titleKey = title.toLowerCase();
    const id = doi.toLowerCase();
    if (!title || seenIds.has(id) || seenTitles.has(titleKey)) continue;
    seenIds.add(id);
    seenTitles.add(titleKey);
    const names = (Array.isArray(item.author) ? item.author : []).map(author => {
      return plainText(author?.name) || [plainText(author?.given), plainText(author?.family)].filter(Boolean).join(' ');
    }).filter(Boolean);
    const authors = names.slice(0, 8).join(', ') + (names.length > 8 ? ', et al.' : '');
    const year = item.published?.['date-parts']?.[0]?.[0];
    const url = 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/');
    papers.push({ id, title, authors, year: Number.isInteger(year) && year > 0 ? year : null,
      url, abstract: plainText(item.abstract), source });
    if (papers.length === 6) break;
  }
  return papers;
}

function createLiteratureSearch(fetchWorks = globalThis.fetch) {
  const cache = new Map();
  const pending = new Map();

  async function queryProvider(query) {
    const url = new URL(searchEndpoint);
    url.search = new URLSearchParams({
      'query.bibliographic': query, rows: '18', select: 'DOI,type,title,author,published,abstract',
    });
    const signal = AbortSignal.timeout(10000);
    try {
      const response = await fetchWorks(url, {
        signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'ProofReader/1.0 (local literature search)' },
      });
      if (response.status === 429) throw new LiteratureError(503, 'Crossref is receiving too many requests. Try again shortly.');
      if (!response.ok) throw new LiteratureError(502, 'Crossref could not complete this search. Try again shortly.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 3 * 1024 * 1024) throw new LiteratureError(502, 'Crossref returned too much data. Try more specific terms.');
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data?.message?.items)) throw new LiteratureError(502, 'Crossref returned an unreadable search result. Try again.');
      return { papers: formatWorks(data.message.items), source };
    } catch (error) {
      if (error instanceof LiteratureError) throw error;
      if (signal.aborted) throw new LiteratureError(504, 'The Crossref search timed out. Try again shortly.');
      throw new LiteratureError(502, 'The reader could not retrieve results from Crossref. Check your connection and try again.');
    }
  }

  return async function search(value) {
    const query = publicQuery(value);
    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() < hit.expires) return hit.results;
    if (pending.has(key)) return pending.get(key);
    const search = queryProvider(query).then(results => {
      cache.delete(key);
      cache.set(key, { expires: Date.now() + 30 * 60 * 1000, results });
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return results;
    }).finally(() => pending.delete(key));
    pending.set(key, search);
    return search;
  };
}

module.exports = { createLiteratureSearch, formatWorks, publicQuery };
