import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYSTEM_PROMPT,
  TranslateError,
  buildRequest,
  cleanRoman,
  normalizeOptions,
  readHindi,
  translateText,
} from '../lib/translate.js';

function grokMessage(text) {
  return {
    output: [
      { type: 'reasoning', content: [] },
      { type: 'message', content: [{ type: 'output_text', text }] },
    ],
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('system prompt keeps Hindi in English letters', () => {
  assert.match(SYSTEM_PROMPT, /English letters/);
  assert.match(SYSTEM_PROMPT, /No Devanagari/);
});

test('buildRequest asks Grok 4.7 for a short answer', () => {
  const body = buildRequest({ text: 'Hello', speaker: 'she', tone: 'polite' });
  assert.equal(body.model, 'grok-4.7');
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.text.format.name, 'roman_hindi');
  assert.match(body.input[1].content, /feminine/);
  assert.match(body.input[1].content, /aap/);
});

test('casual male request uses tum and masculine verbs', () => {
  const body = buildRequest({ text: 'I am tired', speaker: 'he', tone: 'everyday' });
  assert.match(body.input[1].content, /masculine/);
  assert.match(body.input[1].content, /tum/);
});

test('a plain sentence does not force a speaker or a tone', () => {
  const options = normalizeOptions({ text: 'How are you?' });
  assert.equal(options.speaker, 'auto');
  assert.equal(options.tone, 'auto');
  const body = buildRequest(options);
  assert.match(body.input[1].content, /If the English shows the speaker's gender/);
  assert.match(body.input[1].content, /unless the English is clearly casual/);
});

test('normalizeOptions rejects an empty sentence and a bad speaker', () => {
  assert.throws(() => normalizeOptions({ text: '  ', speaker: 'she', tone: 'polite' }), TranslateError);
  assert.throws(() => normalizeOptions({ text: 'Hi', speaker: 'they', tone: 'polite' }), TranslateError);
});

test('readHindi prefers structured JSON and plain text', () => {
  assert.equal(readHindi({ output_text: '{"hindi":"Aap kaise hain?"}' }), 'Aap kaise hain?');
  assert.equal(readHindi(grokMessage('{"hindi":"Hindi: Main theek hoon."}')), 'Main theek hoon.');
  assert.equal(readHindi(grokMessage('"Station kahan hai?"')), 'Station kahan hai?');
});

test('cleanRoman leaves inner punctuation alone', () => {
  assert.equal(cleanRoman('  “Kya?”  '), 'Kya?');
});

test('translateText returns Roman Hindi', async () => {
  const hindi = await translateText({
    text: 'How are you?',
    speaker: 'she',
    tone: 'polite',
    apiKey: 'test-key',
    log() {},
    fetchImpl: async (_url, init) => {
      assert.match(init.headers.Authorization, /test-key/);
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'grok-4.7');
      return jsonResponse(200, grokMessage('{"hindi":"Aap kaise hain?"}'));
    },
  });
  assert.equal(hindi, 'Aap kaise hain?');
});

test('translateText retries when the first answer is in Hindi script', async () => {
  let calls = 0;
  const hindi = await translateText({
    text: 'Thanks',
    speaker: 'he',
    tone: 'everyday',
    apiKey: 'test-key',
    log() {},
    fetchImpl: async () => {
      calls += 1;
      const text = calls === 1 ? '{"hindi":"धन्यवाद"}' : '{"hindi":"Shukriya"}';
      return jsonResponse(200, grokMessage(text));
    },
  });
  assert.equal(calls, 2);
  assert.equal(hindi, 'Shukriya');
});

test('translateText falls back to plain text when the schema is rejected', async () => {
  const seen = [];
  const hindi = await translateText({
    text: 'Hello',
    speaker: 'she',
    tone: 'polite',
    apiKey: 'test-key',
    log() {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      seen.push(Boolean(body.text));
      if (body.text) return jsonResponse(400, { error: { message: 'bad schema' } });
      return jsonResponse(200, grokMessage('Namaste'));
    },
  });
  assert.deepEqual(seen, [true, false]);
  assert.equal(hindi, 'Namaste');
});

test('translateText reports a rejected key without leaking it', async () => {
  let logged = '';
  await assert.rejects(
    () => translateText({
      text: 'Hello',
      speaker: 'she',
      tone: 'polite',
      apiKey: 'secret-key',
      log(message) { logged = message; },
      fetchImpl: async () => jsonResponse(401, { error: { message: 'bad secret-key' } }),
    }),
    (error) => error.status === 401 && !error.message.includes('secret-key'),
  );
  assert.equal(logged.includes('secret-key'), false);
  assert.match(logged, /\[key\]/);
});
