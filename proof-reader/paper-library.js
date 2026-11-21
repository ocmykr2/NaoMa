(() => {
  "use strict";

  const databaseName = "proof-reader-library";
  const catalog = "catalog";
  const sources = "sources";
  const preparations = "preparations";
  const generation = hash => window.PAPER_REMOVAL?.generation(hash) || "";
  const scopedPaper = id => typeof id === "string" && (/^[a-f0-9]{64}$/.test(id) || window.PAPER_REMOVAL?.isBundle?.(id));
  const fenceKey = hash => "generation/"+hash;
  function currentWrite(hash,epoch,fence) {
    return generation(hash)===epoch && (!fence?.result || fence.result.generation===epoch);
  }

  function open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("Local paper storage is unavailable in this browser."));
        return;
      }
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of [catalog,sources,preparations]) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, {keyPath: "hash"});
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function transact(stores, mode, operation) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result;
        let failure;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || new Error("The paper library transaction was interrupted."));
        const setResult = value => { result = value; };
        const abort = error => { failure = error; tx.abort(); };
        try { operation(tx, setResult, abort); } catch (error) { abort(error); }
      });
    } finally {
      db.close();
    }
  }

  function list() {
    return transact([catalog], "readonly", (tx, setResult) => {
      // The picker needs only these short records, even for a library of large PDFs.
      const request = tx.objectStore(catalog).getAll();
      request.onsuccess = () => setResult(request.result
        .sort((a, b) => b.savedAt - a.savedAt || a.title.localeCompare(b.title))
        .map(({hash, title, name, preparedTitle}) => ({hash, title, name, ...(preparedTitle ? {preparedTitle} : {})})));
    });
  }

  function get(hash) {
    return transact([sources,catalog], "readonly", (tx, setResult) => {
      const request = tx.objectStore(sources).get(hash);
      const info = tx.objectStore(catalog).get(hash);
      info.onsuccess = () => {
        const record = request.result;
        if (record && info.result?.preparedTitle) record.preparedTitle = info.result.preparedTitle;
        setResult(record || null);
      };
    });
  }

  function renameTitle(hash,title) {
    if (typeof title !== "string" || !title.trim() || title.trim().length > 500) return Promise.resolve(false);
    const epoch=generation(hash);
    return transact([catalog,preparations], "readwrite", (tx,setResult) => {
      const store = tx.objectStore(catalog);
      const fence=tx.objectStore(preparations).get(fenceKey(hash));
      const request = store.get(hash);
      request.onsuccess = () => {
        if (!request.result || !currentWrite(hash,epoch,fence)) { setResult(false); return; }
        const preparedTitle = title.trim();
        store.put({...request.result,title:preparedTitle,preparedTitle});
        setResult(true);
      };
    });
  }

  function getPreparation(hash) {
    return transact([preparations], "readonly", (tx,setResult) => {
      const request = tx.objectStore(preparations).get(hash);
      request.onsuccess = () => setResult(request.result?.job || null);
    });
  }

  function savePreparation(hash,job,expectedGeneration) {
    // Capture this transition before waiting for a database connection.
    const snapshot = structuredClone(job);
    const study=hash.startsWith("study/");
    const id=study?hash.slice(6):hash;
    const scoped=scopedPaper(id);
    const epoch=expectedGeneration ?? (scoped?generation(id):"");
    return transact([preparations], "readwrite", tx => {
      const store = tx.objectStore(preparations);
      const fence=scoped?store.get(fenceKey(id)):null;
      const request = store.get(hash);
      request.onsuccess = () => {
        if (scoped && !currentWrite(id,epoch,fence)) return;
        const prior = request.result?.job;
        if (study && prior && (prior.generation || "")===epoch) {
          // Another window can save a discussion after the reader explicitly
          // returned to background choices. Preserve the latest selection.
          const selected=prior.selectedAt || 0,next=snapshot.selectedAt || 0;
          if (next<selected) {
            if ((prior.savedAt || 0)>=(snapshot.savedAt || 0)) return;
            snapshot.study=prior.study;
            snapshot.selectedAt=selected;
          } else if (next===selected && (prior.savedAt || 0)>(snapshot.savedAt || 0)) return;
          if (selected!==next) {
            snapshot.plans={...prior.plans,...snapshot.plans};
            for (const [key,plan] of Object.entries(prior.plans || {})) {
              if ((plan.completed?.length || 0)>(snapshot.plans[key]?.completed?.length || 0)) snapshot.plans[key]=plan;
            }
            const turns=new Map((prior.turns || []).map(t=>[t.id,t]));
            for (const t of snapshot.turns || []) {
              const existing=turns.get(t.id);
              if (!existing || existing.status!=="ready" || t.status==="ready") turns.set(t.id,t);
            }
            snapshot.turns=[...turns.values()];
          }
          snapshot.savedAt=Math.max(prior.savedAt || 0,snapshot.savedAt || 0);
        } else if ((prior?.savedAt || 0) > snapshot.savedAt && (prior.generation || "")===epoch) return;
        if (!study && prior && (prior.generation || "")===epoch && snapshot.status !== "ready") {
          for (const name of ["papers","skills","overview","knowledge","displayTitle","preparationVersion","parts","localIntroductions"]) {
            if (snapshot[name] === undefined && prior[name] !== undefined) snapshot[name] = prior[name];
          }
        }
        store.put({hash,job:snapshot});
      };
    });
  }

  async function save({hash, name, text, pages, file, paper},expectedGeneration) {
    if (typeof hash !== "string" || !hash || typeof name !== "string" || typeof text !== "string" ||
        (pages != null && (!Array.isArray(pages) || pages.some(page => typeof page !== "string"))) ||
        (file != null && !(file instanceof Blob))) {
      throw new TypeError("The imported paper is missing its source or identifier.");
    }
    const epoch=expectedGeneration ?? generation(hash);
    await transact([catalog, sources, preparations], "readwrite", (tx, setResult, abort) => {
      const store = tx.objectStore(sources);
      const fence=tx.objectStore(preparations).get(fenceKey(hash));
      const existing = store.get(hash);
      const catalogStore = tx.objectStore(catalog);
      const info = catalogStore.get(hash);
      info.onsuccess = () => {
        try {
          if (!currentWrite(hash,epoch,fence)) throw new Error("This paper was removed during import.");
          // A text-only migration can arrive after an import that included the PDF.
          // Merge inside the transaction so two tabs cannot discard each other's source.
          const previous = existing.result;
          const record = {hash, name: name || previous?.name || "", text: text || previous?.text || ""};
          if (pages?.length || previous?.pages) record.pages = pages?.length ? pages : previous.pages;
          if (file || previous?.file) record.file = file || previous.file;
          store.put(record);
          const title = info.result?.preparedTitle || (typeof paper?.title === "string" && paper.title.trim() ? paper.title : name);
          catalogStore.put({...info.result,hash, name:record.name, title, savedAt: Date.now()});
        } catch (error) { abort(error); }
      };
    });
  }

  function remove(hash,token) {
    if (!scopedPaper(hash) || !token) return Promise.reject(new Error("Select a paper from your library to remove."));
    return transact([catalog,sources,preparations],"readwrite",tx=>{
      const store=tx.objectStore(preparations),key=fenceKey(hash);
      const current=store.get(key);
      current.onsuccess=()=>{
        if (current.result?.generation===token) return;
        store.put({hash:key,generation:token});
        tx.objectStore(catalog).delete(hash);
        tx.objectStore(sources).delete(hash);
        store.delete(hash);
        store.delete("study/"+hash);
      };
    });
  }

  window.PAPER_LIBRARY = {list, save, get, renameTitle, getPreparation, savePreparation, remove};
})();
