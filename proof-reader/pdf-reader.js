(() => {
  'use strict';

  function build(pages) {
    if (!Array.isArray(pages) || !pages.length || pages.some(page => typeof page !== 'string')) {
      throw new Error('The reader could not identify the pages in this PDF.');
    }
    return {
      title: 'Imported paper',
      subtitle: `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · Original PDF`,
      techniques: [],
      steps: pages.map((text, index) => {
        const page = index + 1;
        return {
          title: `Page ${page}`,
          location: `Page ${page}`,
          page,
          summary: text.trim()
            ? 'Read the original page below to see its equations, figures, and layout.'
            : 'This page has no selectable text. Read it in the original page image below.',
          source: '',
          technique: '',
          options: [],
        };
      }),
    };
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('proof-reader-imported-pdf', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('documents');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function accessFile(mode, operation) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('documents', mode);
        const request = operation(transaction.objectStore('documents'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error || new Error('PDF storage was interrupted.'));
      });
    } finally {
      database.close();
    }
  }

  async function save(file,hash,expectedGeneration) {
    if (file !== null && !(file instanceof Blob)) throw new Error('Choose a PDF file to save.');
    await accessFile('readwrite', store => {
      if (expectedGeneration===undefined) return file===null?store.delete('last'):store.put(file,'last');
      const current=store.get('generation/'+hash);
      current.onsuccess=()=>{
        if ((window.PAPER_REMOVAL?.generation(hash) || '')!==expectedGeneration ||
            (current.result && current.result!==expectedGeneration)) return;
        if (file===null) store.delete('last');
        else store.put(file,'last');
      };
      return current;
    });
  }

  async function restore() {
    return (await accessFile('readonly', store => store.get('last'))) ?? null;
  }

  async function removeIfMatching(hash,token) {
    if (!token) throw new Error('The paper removal is missing its identifier.');
    const database=await openDatabase();
    try {
      await new Promise((resolve,reject)=>{
        const tx=database.transaction('documents','readwrite'), store=tx.objectStore('documents');
        let error;
        tx.oncomplete=resolve;
        tx.onabort=()=>reject(error || tx.error || new Error('Could not remove the saved PDF.'));
        const key='generation/'+hash,previous=store.get(key);
        previous.onsuccess=()=>{
          if (previous.result===token) return;
          store.put(token,key);
          const file=store.get('last');
          file.onsuccess=()=>check(file.result);
        };
        function check(blob) {
          if (!(blob instanceof Blob)) return;
          let matches;
          blob.arrayBuffer().then(bytes=>crypto.subtle.digest('SHA-256',bytes)).then(digest=>{
            matches=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')===hash;
          }).catch(reason=>{error=reason;tx.abort();});
          // This legacy store contains a single blob shared by all imports.
          // Hold its write transaction through hashing so another upload can
          // never replace the document between the comparison and deletion.
          function finish() {
            if (matches===undefined) store.getKey('last').onsuccess=finish;
            else if (matches) store.delete('last');
          }
          finish();
        }
      });
    } finally {database.close();}
  }

  async function renderPage(file, page) {
    if (!(file instanceof Blob)) throw new Error('Choose the PDF again to display its pages.');
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Choose a positive whole page number.');
    const response = await fetch(`/api/pdf-page?page=${page}`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file,
    });
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      throw new Error(details?.error || 'The reader could not load this PDF page.');
    }
    if (response.headers.get('Content-Type') !== 'image/png') {
      throw new Error('The local reader returned an unexpected page format.');
    }
    return response.blob();
  }

  window.PDF_READER = { build, save, restore, renderPage, removeIfMatching };
})();
