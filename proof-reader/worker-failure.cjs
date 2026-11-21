'use strict';
const codes=new Set(['timeout','network','empty','exit','login','quota','installation','configuration','refused']);

function workerFailureCode(error) {
  const seen=new Set();
  for (let cause=error;cause && !seen.has(cause);cause=cause.cause) {
    seen.add(cause);
    if (codes.has(cause.workerCode)) return cause.workerCode;
    // Older workers reported these specific messages without a code. A model
    // field, file name or programming exception can also contain "timeout".
    if (Object.getPrototypeOf(cause)!==Error.prototype) continue;
    const message=String(cause.message || '');
    if (/^(?:Codex|The (?:paper agent|local Codex worker)) timed out(?:[.!]|$)/iu.test(message)) return 'timeout';
    if (/^(?:Connection lost\.?$|(?:The local Codex worker|Codex) (?:could not reach its service|connection interrupted)\b)/iu.test(message)) return 'network';
    if (/^(?:Sign in to the local Codex CLI|The Codex CLI is not logged in)\b/iu.test(message)) return 'login';
    if (/^(?:The )?Codex (?:account reached a usage limit|quota exceeded)\b/iu.test(message)) return 'quota';
  }
  return null;
}
module.exports={workerFailureCode};
