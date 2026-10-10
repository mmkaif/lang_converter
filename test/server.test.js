import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createServer, resolvePublic } from '../server.js';
import { TranslateError } from '../lib/translate.js';

async function withServer(options, fn) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('resolvePublic stays inside the public folder', () => {
  const dir = '/tmp/romi-public';
  assert.equal(resolvePublic(dir, '/'), `${dir}/index.html`);
  assert.equal(resolvePublic(dir, '/styles.css'), `${dir}/styles.css`);
  assert.equal(resolvePublic(dir, '/%2e%2e/package.json'), `${dir}/package.json`);
  assert.equal(resolvePublic(dir, '/%2e%2e%2fpackage.json'), null);
  assert.equal(resolvePublic(dir, '/..%2fpackage.json'), null);
});

test('status reports a missing key and translate refuses', async () => {
  await withServer({ hasKey: false }, async (base) => {
    const status = await fetch(`${base}/api/status`);
    assert.equal((await status.json()).ready, false);
    const response = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', speaker: 'she', tone: 'polite' }),
    });
    assert.equal(response.status, 503);
  });
});

test('translate returns the Hindi line', async () => {
  await withServer({
    hasKey: true,
    translate: async (body) => {
      assert.equal(body.text, 'How are you?');
      assert.equal(body.speaker, 'he');
      assert.equal(body.tone, 'everyday');
      return 'Tum kaise ho?';
    },
  }, async (base) => {
    const response = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'How are you?', speaker: 'he', tone: 'everyday' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hindi: 'Tum kaise ho?' });
  });
});

test('reading the request body does not cancel the translation', async () => {
  await withServer({
    hasKey: true,
    translate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return 'Theek hai';
    },
  }, async (base) => {
    const response = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Okay', speaker: 'she', tone: 'polite' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hindi: 'Theek hai' });
  });
});

test('bad JSON and a translator error stay readable', async () => {
  await withServer({
    hasKey: true,
    translate: async () => {
      throw new TranslateError('Write an English sentence first.', 400);
    },
  }, async (base) => {
    const bad = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(bad.status, 400);
    const empty = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ', speaker: 'she', tone: 'polite' }),
    });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /English sentence/);
  });
});

test('the home page is served and secret files are not', async () => {
  await withServer({ hasKey: false }, async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /English to Hindi/);
    assert.doesNotMatch(html, /For example/);
    const leaked = await fetch(`${base}/%2e%2e/package.json`);
    assert.equal(leaked.status, 404);
  });
});
