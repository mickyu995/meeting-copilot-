'use strict';
// Run: node --test test.js
const test = require('node:test');
const assert = require('node:assert');
const MC = require('./logic.js');

test('needsAnswer: questions and real statements get answers, backchannel does not', () => {
  assert.equal(MC.needsAnswer('How long does the rebuild take?', 'en-US'), true);
  assert.equal(MC.needsAnswer('Tell me about your pricing', 'en-US'), true);
  assert.equal(MC.needsAnswer('okay', 'en-US'), false);
  assert.equal(MC.needsAnswer('yeah sure', 'en-US'), false);
  assert.equal(MC.needsAnswer('mhm right', 'en-US'), false);
  assert.equal(MC.needsAnswer('We have been looking at a few agencies for the last two months now', 'en-US'), true);
  assert.equal(MC.needsAnswer('', 'en-US'), false);
});

test('needsAnswer: non-English falls back to punctuation and length', () => {
  assert.equal(MC.needsAnswer('آپ کی قیمت کیا ہے؟', 'ur-PK'), true);
  assert.equal(MC.needsAnswer('جی ٹھیک', 'ur-PK'), false);
  assert.equal(MC.needsAnswer('یہ کام کتنے دن میں ہو جائے گا', 'ur-PK'), true);
});

test('isSubstantive: a dangling sentence is not finished', () => {
  assert.equal(MC.isSubstantive("So that's where the SEO part comes in. And", 'en-US'), false);
  assert.equal(MC.isSubstantive('Can you do it for less?', 'en-US'), true);
  assert.equal(MC.isSubstantive('That works for me.', 'en-US'), true);
  assert.equal(MC.isSubstantive('part of it is just', 'en-US'), false);
});

test('dedupeFinal: repeated or cumulative finals keep only new words', () => {
  assert.equal(MC.dedupeFinal('how much is it', 'how much is it', 500), '');
  assert.equal(MC.dedupeFinal('how much is it', 'how much is it for a year', 500), 'for a year');
  assert.equal(MC.dedupeFinal('how much is it', 'and what about support', 500), 'and what about support');
  assert.equal(MC.dedupeFinal('yes please', 'yes please', 9000), 'yes please');
  assert.equal(MC.dedupeFinal('', 'hello there', 0), 'hello there');
});

test('splitAnswer: answer, next questions, partial marker and no-reply', () => {
  const full = 'Yes, about three weeks.\n@@NEXT@@\n1. What is your deadline?\n- Who signs off?\nWhat budget do you have?\nExtra fourth?';
  const r = MC.splitAnswer(full);
  assert.equal(r.answer, 'Yes, about three weeks.');
  assert.deepEqual(r.next, ['What is your deadline?', 'Who signs off?', 'What budget do you have?']);

  assert.equal(MC.splitAnswer('Yes, about three weeks.\n@@NE').answer, 'Yes, about three weeks.');
  assert.equal(MC.splitAnswer('Yes, about three weeks. @').answer, 'Yes, about three weeks.');
  assert.equal(MC.splitAnswer('---').noReply, true);
  assert.equal(MC.splitAnswer('--').answer, '');
  assert.equal(MC.splitAnswer('').answer, '');
});

test('parseSSE: handles events split across chunks and CRLF', () => {
  const ev = (t) => 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] });
  const stream = ev('Hello ') + '\r\n\r\n' + ev('wor') + '\r\n\r\n' + ev('ld');
  const cut = stream.length - 9;
  const a = MC.parseSSE(stream.slice(0, cut));
  assert.deepEqual(a.texts, ['Hello ', 'wor']);
  const b = MC.parseSSE(a.rest + stream.slice(cut) + '\n\n');
  assert.deepEqual(b.texts, ['ld']);
  assert.equal(b.error, null);
});

test('parseSSE: reports errors and blocked prompts', () => {
  const e = MC.parseSSE('data: {"error":{"message":"quota"}}\n\n');
  assert.equal(e.error, 'quota');
  const blocked = MC.parseSSE('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n');
  assert.match(blocked.error, /SAFETY/);
});

test('buildSystem: includes brief, private-note rules and the language', () => {
  const s = MC.buildSystem(
    { title: 'Acme call', role: 'Freelancer', goal: 'Paid trial', background: 'SAY "1,200"\nNOTE - DON\'T SAY floor is 1,000', terms: 'Shopify, Acme' },
    { maxWords: 70, answerLang: 'roman' },
  );
  assert.match(s, /Acme call/);
  assert.match(s, /floor is 1,000/);
  assert.match(s, /PRIVATE NOTES - NEVER SAY THESE OUT LOUD/);
  assert.match(s, /Roman Urdu/);
  assert.match(s, /Shopify, Acme/);
  assert.match(s, /@@NEXT@@/);
  assert.match(MC.buildSystem({}, {}), /none given/);
});

test('buildUserPrompt: history, earlier answers, typed and fresh modes', () => {
  const p = MC.buildUserPrompt('What is your price?',
    [{ who: 'them', text: 'Hi' }, { who: 'me', text: 'Hello' }], ['It is 1,200.'], { fresh: true });
  assert.match(p, /Them: Hi/);
  assert.match(p, /Me \(my person\): Hello/);
  assert.match(p, /do not repeat/);
  assert.match(p, /THE OTHER PERSON JUST SAID:\nWhat is your price\?/);
  assert.match(p, /fresh alternative/);
  assert.match(MC.buildUserPrompt('say no politely', [], [], { typed: true }), /MY PERSON TYPED THIS/);
});

test('parseJSON: fenced and surrounded JSON', () => {
  assert.deepEqual(MC.parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(MC.parseJSON('Here you go: {"questions":["x"]} done'), { questions: ['x'] });
  assert.equal(MC.parseJSON('not json'), null);
});

test('explainError: friendly text per status', () => {
  assert.match(MC.explainError(400, 'API key not valid. Please pass a valid API key.'), /not valid/);
  assert.match(MC.explainError(404, ''), /Test key/);
  assert.match(MC.explainError(429, ''), /Limit reached/);
});
