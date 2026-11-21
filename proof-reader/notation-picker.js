(() => {
  "use strict";

  const el = id => document.getElementById(id);
  const textLimit = 4 * 1024 * 1024;
  const paperPages = pages => pages.map((text, i) => ({page:i+1, title:"Page "+(i+1), text}));
  function textUnits(text) {
    const units = [];
    let start = 0;
    while (start < text.length) {
      const limit = Math.min(start + 60000, text.length);
      const newline = limit < text.length ? text.lastIndexOf("\n", limit) : -1;
      const end = newline > start ? newline + 1 : limit;
      units.push({title:"Passage "+(units.length+1), text:text.slice(start,end)});
      start = end;
    }
    return units;
  }
  function validated(ref) {
    if (!ref.units.some(unit => /[\p{L}\p{N}]/u.test(unit.text))) {
      throw new Error("No readable notation was found. Paste a passage from the reference paper instead.");
    }
    if (ref.units.length > 2000 || ref.units.reduce((sum,u) => sum + new TextEncoder().encode(u.text).length, 0) > textLimit) {
      throw new Error("This reference is too long. Paste its notation section instead.");
    }
    return ref;
  }

  function create({digest,extractPages,loadPaper}) {
    const select = el("notationChoice"), file = el("notationFile"), excerpt=el("notationExcerpt");
    const status=el("notationStatus"), submit=el("continuePreflight");
    let owner="", generation=0, reference=null, submitting=false;
    let options=new Map();
    function update() {
      const value=select.value;
      el("notationUpload").hidden=value!=="upload";
      el("notationPaste").hidden=value!=="paste";
      submit.disabled=submitting || Boolean(value && !(value==="paste" ? excerpt.value.trim() : reference));
    }
    function reset() {
      generation++;
      owner="";
      reference=null;
      submitting=false;
    }
    function mount(paperKey,current,references,library) {
      if (owner===paperKey) return;
      reset();
      owner=paperKey;
      options=new Map(library.map(item=>[item.key,item]));
      const chosen=current?.id || "";
      for (const ref of [...references,current]) {
        if (!ref?.id || options.has(ref.id)) continue;
        options.set(ref.id,{key:ref.id,title:ref.title,saved:ref});
      }
      select.replaceChildren(new Option("This paper’s notation",""),
        ...[...options.values()].map(item=>new Option(item.title,item.key)),
        new Option("Upload a reference paper…","upload"),new Option("Paste a reference passage…","paste"));
      select.value=chosen;
      reference=current || null;
      file.value=excerpt.value=el("notationTitle").value=status.textContent="";
      busy(false);
    }
    async function read(loader) {
      const id=++generation;
      reference=null;
      status.textContent="Reading the reference paper…";
      update();
      try {
        const result=validated(await loader());
        if (generation!==id) return;
        reference=result;
        status.textContent="";
      } catch(error) {
        if (generation===id) status.textContent=error.message || "Could not read this reference paper.";
      } finally { if (generation===id) update(); }
    }
    select.addEventListener("change",()=>{
      generation++;
      reference=null;
      file.value=status.textContent="";
      const entry=options.get(select.value);
      if (entry?.saved) reference=entry.saved;
      else if (entry) { void read(()=>loadPaper(entry)); return; }
      update();
    });
    file.addEventListener("change",()=>{
      const chosen=file.files?.[0];
      if (!chosen) return;
      void read(async()=>{
        const pdf=/\.pdf$/iu.test(chosen.name) || chosen.type==="application/pdf";
        if (!pdf && !/\.(?:tex|md|markdown|txt)$/iu.test(chosen.name)) throw new Error("Choose a PDF, LaTeX, Markdown or text file.");
        if (chosen.size>(pdf?12*1024*1024:textLimit)) throw new Error("This file is too large. Paste the notation section instead.");
        const id=await digest(await chosen.arrayBuffer());
        const units=pdf ? paperPages(await extractPages(chosen)) : textUnits(await chosen.text());
        return {id,title:chosen.name,units,...(pdf ? {file:chosen} : {})};
      });
    });
    excerpt.addEventListener("input",()=>{status.textContent="";update();});
    async function selection() {
      if (select.value!=="paste") return reference;
      const text=excerpt.value.trim();
      const encoded=new TextEncoder().encode(text);
      if (encoded.length>textLimit) throw new Error("Use a notation passage of 4 MiB or less.");
      return validated({id:await digest(encoded),title:el("notationTitle").value.trim() || "Pasted notation passage",units:textUnits(text)});
    }
    function busy(value) {
      submitting=value;
      for (const field of [select,file,excerpt,el("notationTitle")]) field.disabled=value;
      update();
    }
    return {mount,reset,selection,busy,showError:message=>{status.textContent=message;}};
  }
  window.NOTATION_PICKER={create,paperPages,textUnits};
})();
