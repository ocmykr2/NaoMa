'use strict';
const {boundSignature}=require('./printed-math.cjs');

// Each delimited formula is one token. An excerpt cannot begin inside a
// formula, cross a block boundary, or change the spelling of a prose word.
const pieces=/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|[\p{L}\p{M}\p{N}]+(?:(?:['’\u00ad]|(?<=\p{Nd})[.,](?=\p{Nd}))[\p{L}\p{M}\p{N}]+)*|\s+|[^\s]/gu;
function* tokens(text) {
  for (const match of text.matchAll(pieces)) {
    const raw=match[0],math=match[1]??match[2],start=match.index,end=start+raw.length;
    let key;
    if (math!==undefined) key='math:'+boundSignature(math);
    else if (/^\s/u.test(raw)) {
      if (text[end]===',' || text[end]===';') continue;
      key=' ';
    } else key='text:'+raw.normalize('NFC').replace(/(?<=\p{L})’(?=\p{L})/gu,"'").replace(/(?<=\p{L})\u00ad(?=\p{L})/gu,'');
    yield {key,start,end};
  }
}

function createEvidenceIndex(text) {
  let words;
  function* matches(quote) {
    if (typeof quote!=='string') return;
    const needle=[...tokens(quote.trim())];
    if (!needle.length) return;
    // Reuse short reader blocks across many first-use quotes. Stream long
    // source passages so verifying one reference does not copy an entire PDF
    // into per-token objects.
    if (!words && text.length<=32768) words=[...tokens(text)];
    // Prefix lengths keep scans through repeated PDF rows linear.
    const prefix=new Uint32Array(needle.length);
    for (let i=1,j=0;i<needle.length;i++) {
      while (j && needle[i].key!==needle[j].key) j=prefix[j-1];
      if (needle[i].key===needle[j].key) j++;
      prefix[i]=j;
    }
    const starts=new Uint32Array(needle.length);
    let i=0,j=0;
    for (const word of words || tokens(text)) {
      starts[i%needle.length]=word.start;
      while (j && word.key!==needle[j].key) j=prefix[j-1];
      if (word.key===needle[j].key) j++;
      if (j===needle.length) {
        const start=starts[(i+1-j)%needle.length],end=word.end;
        yield {start,end,text:text.slice(start,end)};
        j=prefix[j-1];
      }
      i++;
    }
  }
  function locate(quote) {
    const found=matches(quote),first=found.next();
    return !first.done && found.next().done ? first.value : null;
  }
  return {matches,locate};
}

// A page/step plus a verbatim excerpt can identify the supporting passage
// without choosing between identical copies. Reworded typography, however,
// must resolve to a single span before we can restore its original wording.
function locatePassageQuote(text,quote) {
  const literal=quote.trim();
  let first=null;
  for(const match of createEvidenceIndex(text).matches(literal)) {
    if(first && (first.text!==literal || match.text!==literal))return null;
    first??=match;
  }
  return first;
}

function evidenceSignature(text) {
  return JSON.stringify(Array.from(tokens(text.trim()),token=>token.key));
}

module.exports={createEvidenceIndex,locatePassageQuote,evidenceSignature};
