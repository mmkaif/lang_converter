import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateText, TranslateError } from './lib/translate.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultPublic = path.join(root, 'public');

export function loadEnv(file) {
  return fs.readFile(file, 'utf8').then((text) => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

function readBody(req, limit = 32_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new TranslateError('That sentence is too long.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function resolvePublic(publicDir, urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://romi.local').pathname);
  } catch {
    return null;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  const base = path.resolve(publicDir);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return file;
}

export function createServer(options = {}) {
  const publicDir = options.publicDir ?? defaultPublic;
  const hasKey = () => options.hasKey ?? Boolean(process.env.XAI_API_KEY?.trim());
  const translate = options.translate ?? ((body, ctx) => translateText({
    ...body,
    apiKey: process.env.XAI_API_KEY?.trim() ?? '',
    signal: ctx.signal,
  }));

  return http.createServer((req, res) => {
    handle(req, res, { publicDir, hasKey, translate }).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      try {
        const status = error instanceof TranslateError ? error.status : 500;
        const message = error instanceof TranslateError ? error.message : 'Something went wrong.';
        send(res, status, { error: message });
      } catch {
        // The browser already went away.
      }
    });
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://romi.local');

  if (url.pathname === '/api/status' && req.method === 'GET') {
    send(res, 200, { ready: ctx.hasKey() });
    return;
  }

  if (url.pathname === '/api/translate') {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Use POST.' });
      return;
    }
    if (!ctx.hasKey()) {
      send(res, 503, { error: 'Add XAI_API_KEY to the .env file and restart.' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof TranslateError) throw error;
      send(res, 400, { error: 'Send the sentence as JSON.' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const hindi = await ctx.translate({
        text: payload?.text,
        speaker: payload?.speaker,
        tone: payload?.tone,
      }, { signal: controller.signal });
      send(res, 200, { hindi });
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: 'Not found.' });
    return;
  }

  const file = resolvePublic(ctx.publicDir, url.pathname);
  if (!file) {
    send(res, 404, { error: 'Not found.' });
    return;
  }

  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    send(res, 404, { error: 'Not found.' });
    return;
  }
  if (!stat.isFile()) {
    send(res, 404, { error: 'Not found.' });
    return;
  }

  const body = await fs.readFile(file);
  const type = types[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(req.method === 'HEAD' ? 200 : 200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  await loadEnv(path.join(root, '.env'));
  const port = Number(process.env.PORT) || 4173;
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    const ready = Boolean(process.env.XAI_API_KEY?.trim());
    console.log(`Translator is running at http://localhost:${port}`);
    console.log(`API key: ${ready ? 'ready' : 'missing'}`);
    if (!ready) {
      console.log('Add XAI_API_KEY to .env and start again.');
      console.log('Create a key at https://console.x.ai/team/default/api-keys');
    }
  });
}
