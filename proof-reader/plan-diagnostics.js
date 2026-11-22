(() => {
  "use strict";

  // Diagnostics contain operational metadata only. Never display or copy
  // excerpts, prompts, an arbitrary server message, or the reader's study.
  function fields(record,names) {
    const result={};
    for (const name of names) {
      const value=record?.[name];
      if ((Number.isSafeInteger(value) && value>=0) ||
          (typeof value==="string" && /^[A-Za-z0-9_.:[\]/-]{1,160}$/u.test(value))) result[name]=value;
    }
    return result;
  }
  const progressFields=["stage","firstPart","lastPart","completedParts","draftedParts","totalParts","startedAt","updatedAt"];
  function progressSummary(progress) {
    const result=fields(progress,progressFields);
    for (const key of ["blockedParts","waitingParts"]) {
      if (!Array.isArray(progress?.[key])) continue;
      const parts=[...new Set(progress[key].filter(n=>Number.isSafeInteger(n) && n>0 && n<=result.totalParts))].sort((a,b)=>a-b);
      if (parts.length) result[key]=parts;
    }
    return result;
  }
  const eventFields=["sequence","at","event","attempt","retryCount","stage","part","firstPart","lastPart","completedParts","totalParts","sourceStep","page","field","check","code","action"];
  function display(report) {
    const lines=["Job "+(report.key || "not assigned"),"Status  "+report.status];
    if (report.failureCode) lines.push("Failure  "+report.failureCode+(report.failureStage?"  "+report.failureStage:""));
    if (report.attempt!==undefined) lines.push("Attempt  "+report.attempt);
    const p=report.progress;
    if (p?.stage) lines.push("Stage  "+p.stage);
    if (Number.isInteger(p?.totalParts)) {
      if (Number.isInteger(p.draftedParts)) lines.push("Drafted  "+p.draftedParts+"/"+p.totalParts);
      if (Number.isInteger(p.completedParts)) lines.push((["rewriting-notation","adapting-notation"].includes(p.stage)?"Adapted  ":"Reviewed  ")+p.completedParts+"/"+p.totalParts);
      if (p.blockedParts?.length) lines.push("Parts awaiting source verification  "+p.blockedParts.join(", "));
      if (p.waitingParts?.length) lines.push("Parts waiting for prerequisites  "+p.waitingParts.join(", "));
    }
    for (const e of report.events) {
      const when=new Date(e.at);
      const labels=[Number.isFinite(when.getTime())?when.toISOString():"",e.event || "event"];
      if (e.attempt!==undefined) labels.push("attempt "+e.attempt);
      if (e.stage) labels.push(e.stage);
      if (e.part) labels.push("part "+e.part);
      else if (e.firstPart) labels.push(e.lastPart>e.firstPart?"parts "+e.firstPart+"–"+e.lastPart:"part "+e.firstPart);
      if (e.page) labels.push("page "+e.page);
      for (const key of ["sourceStep","field","check","code","action"]) if (e[key]) labels.push(key+"="+e[key]);
      lines.push(labels.filter(Boolean).join("  "));
    }
    return lines.join("\n");
  }

  function attach(load) {
    const el=id=>document.getElementById(id);
    const panel=el("planDiagnostics"),status=el("diagnosticStatus"),output=el("diagnosticReport");
    const reload=el("refreshDiagnostics"),copy=el("copyDiagnostics"),manual=el("diagnosticCopyText");
    let target=null,study=null,scope="plan",generation=0,copyText="",snapshot="";

    function present(report,note) {
      copyText=JSON.stringify(report,null,2);
      output.textContent=display(report);
      status.textContent=note;
      copy.disabled=false;
      manual.hidden=true;
      manual.value="";
    }
    async function refresh() {
      if (!panel.open || !study) return;
      const current=++generation;
      const saved={key:study.key || null,status:study.status || "unknown",historyAvailable:false,...fields(study,["failureCode","failureStage"]),
        progress:progressSummary(study.progress),events:[]};
      if (scope==="overview") {
        present(saved,"Saved overview diagnostics.");
        reload.disabled=true;
        return;
      }
      if (!study.key) {
        present(saved,"The service hasn’t returned a job ID. Only the app’s status is available.");
        reload.disabled=true;
        return;
      }
      reload.disabled=true;
      copy.disabled=true;
      copyText="";
      manual.hidden=true;
      output.textContent=display(saved);
      status.textContent="Loading diagnostics…";
      try {
        const report=await load(study.key);
        if (current!==generation) return;
        if (!report || report.key!==saved.key || !Array.isArray(report.events)) throw Error("invalid diagnostic response");
        const events=report.events.map(e=>fields(e,eventFields));
        const progress=progressSummary(report.progress || saved.progress);
        const localTime=saved.progress.updatedAt ?? 0,reportTime=progress.updatedAt ?? 0;
        const older=(reportTime>0 && localTime>reportTime) ||
          (saved.status==="error" && report.status==="running" && localTime>=reportTime);
        present({...fields(saved,["failureCode","failureStage"]),...fields(report,["version","key","status","attempt","retryCount","failureCode","failureStage"]),historyAvailable:report.historyAvailable===true,
          ...(older?{status:saved.status}:{}),progress:older?saved.progress:progress,events},older?
          "Showing the app’s latest progress. The event history is from an earlier snapshot.":report.historyAvailable===false?
          "No event history was recorded for this run.":"Latest diagnostic snapshot.");
      } catch (error) {
        if (current!==generation) return;
        present(saved,error.status===404?"No diagnostic history is available for this job. Showing its saved status.":
          "Diagnostics couldn’t be loaded. Showing the app’s last known status.");
      } finally {
        if (current===generation) reload.disabled=false;
      }
    }
    panel.addEventListener("toggle",()=>{
      if (panel.open) refresh();
      else generation++;
    });
    reload.addEventListener("click",refresh);
    copy.addEventListener("click",async()=>{
      if (!copyText) return;
      const current=generation;
      try {
        await window.navigator.clipboard.writeText(copyText);
        if (current===generation) {
          manual.hidden=true;manual.value="";
          status.textContent="Diagnostics copied.";
        }
      } catch {
        if (current!==generation) return;
        manual.hidden=false;manual.value=copyText;manual.focus();manual.select?.();
        status.textContent="Select and copy the diagnostic text below.";
      }
    });
    return function show(paper,job,kind="plan") {
      const identity=job?[kind,paper,job.key || ""].join("\n"):null;
      scope=kind;
      study=job;
      panel.hidden=!job;
      const revision=job?JSON.stringify([job.status,job.failureCode,job.failureStage,progressSummary(job.progress)]):"";
      const changed=snapshot!==revision;
      snapshot=revision;
      if (identity===target) {
        if (changed && panel.open) refresh();
        return;
      }
      target=identity;
      generation++;
      panel.open=false;
      status.textContent="";
      output.textContent="";
      manual.value="";manual.hidden=true;copyText="";
    };
  }
  function attachVersion() {
    const panel=document.getElementById("planDiagnostics"),label=document.getElementById("diagnosticVersion");
    const notice=document.getElementById("serviceUpdateNotice");
    if (!panel || !label || !notice) return ()=>{};
    let state=null,sequence=0;
    function failed() { return state==="failed" || state==="tailor-failed"; }
    function eligible() { return failed() || (state==="tailoring" && panel.open); }
    function show(node, text) {
      if (node.textContent!==text) node.textContent=text;
      node.hidden=!text;
    }
    async function refresh() {
      if (!eligible()) return;
      const request=++sequence;
      let versionText="Service version unavailable.",updateText="";
      try {
        const response=await fetch("/api/reader-version",{cache:"no-store"});
        if (response.status===404) {
          versionText="The running service predates version reporting.";
          updateText="Close Naoma and reopen it to load the installed version.";
        } else if (response.ok) {
          const {runningVersion,installedVersion}=await response.json();
          const valid=v=>typeof v==="string" && /^\d+\.\d+\.\d+$/u.test(v);
          if (valid(runningVersion)) versionText="Running Naoma "+runningVersion+".";
          if (valid(installedVersion) && valid(runningVersion) && installedVersion!==runningVersion) {
            versionText+=" Installed version "+installedVersion+".";
            updateText="This window is running Naoma "+runningVersion+". Close and reopen Naoma to use the installed version "+installedVersion+".";
          }
        }
      } catch { /* The existing preparation status remains available offline. */ }
      if (request!==sequence) return;
      show(label,versionText);
      show(notice,failed()?updateText:"");
    }
    panel.addEventListener("toggle",()=>{if (panel.open) refresh();});
    document.getElementById("refreshDiagnostics").addEventListener("click",refresh);
    window.addEventListener("focus",refresh);
    return function onState(next) {
      if (next===state) return;
      state=next;
      sequence++;
      show(label,"");
      show(notice,"");
      refresh();
    };
  }
  window.PLAN_DIAGNOSTICS={attach,attachVersion};
})();
