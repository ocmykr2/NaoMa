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
function workerFailureMessage(code,provider='codex') {
  const name=provider==='claude'?'Claude Code':'Codex';
  const messages={
    timeout:'The paper agent timed out. Try a shorter selection or run it again.',
    login:'Sign in to the local '+name+' CLI, then retry.',
    quota:'The '+name+' account reached a usage limit. Retry when usage is available.',
    network:'The local '+name+' worker could not reach its service. Check the connection and retry.',
    refused:name+' declined this preparation request. Check the selected model and the requested material.',
    configuration:'The '+name+' CLI rejected the request settings. Check the model and CLI configuration.',
    installation:'Check the '+name+' CLI installation and sign in, then retry.',
    exit:'The local '+name+' worker stopped before completing this step. Retry to continue from the last saved work.',
    empty:'The local '+name+' worker returned no result for this step. Retry to continue from the last saved work.',
  };
  return messages[code];
}
module.exports={workerFailureCode,workerFailureMessage};
