'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createEvidenceIndex}=require('./prose-evidence.cjs');

test('presentation-only evidence resolves to the actual source range',()=>{
  const sentence='The cell’s capa\u00adcity , bounded by \\(r\\leq 2\\), is finite.';
  const index=createEvidenceIndex('Earlier. '+sentence+' Later.');
  const quote="cell's capacity, bounded  by \\[r ≤ 2\\], is finite";
  const found=index.locate(quote);
  const expected=sentence.slice(4,-1);
  assert.deepEqual(found,{start:13,end:13+expected.length,text:expected});
  assert.equal(createEvidenceIndex('The cafe\u0301 has three seats.').locate('café has three').text,'cafe\u0301 has three');
  for (const altered of ['2.1','20','-2']) assert.equal(index.locate(quote.replace('2',altered)),null);
  assert.equal(index.locate(quote.replace('≤','<')),null);
  assert.equal(index.locate(quote.replace('capacity','opacity')),null);
  assert.equal(index.locate('ell’s capacity'),null);
  assert.equal(index.locate('r ≤ 2'),null);
});

test('a unique locator cannot select among repeated witnesses or stitch separated text',()=>{
  const text='Give \\(n\\) items. Give  \\[n\\] items.';
  const index=createEvidenceIndex(text);
  assert.equal(index.locate('Give \\(n\\) items.'),null);
  assert.deepEqual([...index.matches('Give \\(n\\) items.')].map(x=>x.text),['Give \\(n\\) items.','Give  \\[n\\] items.']);
  assert.equal(index.locate('Give items.'),null);
  assert.equal(createEvidenceIndex('An integer weight.').locate('integerweight'),null);
  assert.equal(createEvidenceIndex('Use weight 1.5 here.').locate('Use weight 1'),null);
  assert.equal(createEvidenceIndex('Use weight 1.5 here.').locate('5 here'),null);
  assert.equal(createEvidenceIndex('At most 1,200 items.').locate('At most 1'),null);
});
