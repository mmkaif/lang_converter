const ENDPOINT = 'https://api.x.ai/v1/responses';
const MODEL = 'grok-4.7';
const DEVANAGARI = /[\u0900-\u097F]/;

export const SYSTEM_PROMPT = `You translate English into natural spoken Hindi (Hindustani), written only in English letters. A person should be able to read the line out loud and be speaking Hindi.

Rules:
- Put the translation in the hindi field and nowhere else.
- Use only Latin letters, spaces, and normal punctuation. No Devanagari, no Urdu script, and no diacritics.
- Spell it the way people type Hindi in a chat: main, hoon, hai, hain, aap, tum, kya, nahi, bahut, accha, shukriya, kaise, kahan, kyun, theek.
- Write sh for श and ष, kh for ख, gh for घ, and chh for छ.
- Keep names, numbers, and punctuation. Keep the same line breaks as the English.
- Keep English words that Hindi speakers usually leave in English, such as bus, train, phone, school, office, station, okay, and sorry, when that sounds natural.
- Do not add explanations, labels, or a second version.
- Use normal sentence case.
- Match the speaker and the form of address you are given. Do not switch gender, and do not switch between aap and tum.
- When a verb has to show the speaker's gender, follow the speaker you are given.`;

export class TranslateError extends Error {
  constructor(message, status = 502, extra = {}) {
    super(message);
    this.name = 'TranslateError';
    this.status = status;
    this.badRequest = Boolean(extra.badRequest);
  }
}

export function normalizeOptions({ text, speaker, tone }) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) throw new TranslateError('Write an English sentence first.', 400);
  if (value.length > 2000) throw new TranslateError('Keep it under 2000 characters.', 400);
  const who = speaker === undefined || speaker === null || speaker === '' ? 'auto' : speaker;
  const how = tone === undefined || tone === null || tone === '' ? 'auto' : tone;
  if (who !== 'she' && who !== 'he' && who !== 'auto') throw new TranslateError('Choose she or he.', 400);
  if (how !== 'polite' && how !== 'everyday' && how !== 'auto') throw new TranslateError('Choose a polite or casual tone.', 400);
  return { text: value, speaker: who, tone: how };
}

export function buildRequest({ text, speaker, tone, plain = false, reminder = false }) {
  const speakerLine = speaker === 'he'
    ? 'The speaker is male. First-person verbs must be masculine: raha, gaya, karunga, sakta, likha.'
    : speaker === 'she'
      ? 'The speaker is female. First-person verbs must be feminine: rahi, gayi, karungi, sakti, likhi.'
      : 'If the English shows the speaker\'s gender, match it. If it does not, use masculine first-person verbs: raha, gaya, karunga, sakta.';
  const toneLine = tone === 'everyday'
    ? 'Address the listener as tum, in a casual everyday way.'
    : tone === 'polite'
      ? 'Address the listener as aap, in a polite way.'
      : 'Address the listener as aap, unless the English is clearly casual.';
  const reminderLine = reminder
    ? 'The previous answer was unusable. Use only English letters. Do not use Devanagari.'
    : '';
  const user = [
    speakerLine,
    toneLine,
    reminderLine,
    'Translate this English into Roman Hindi.',
    'English begins',
    text,
    'English ends',
  ].filter(Boolean).join('\n');

  const body = {
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };

  if (!plain) {
    body.text = {
      format: {
        type: 'json_schema',
        name: 'roman_hindi',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['hindi'],
          properties: {
            hindi: {
              type: 'string',
              description: 'The Hindi translation written only in English letters.',
            },
          },
        },
      },
    };
  }

  return body;
}

export function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const parts = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
}

export function cleanRoman(text) {
  let value = String(text ?? '').replace(/^\uFEFF/, '').trim();
  value = value.replace(/^(roman hindi|hindi|translation)\s*:\s*/i, '').trim();
  const pairs = [['"', '"'], ['“', '”']];
  for (const [open, close] of pairs) {
    if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length) {
      value = value.slice(open.length, -close.length).trim();
      break;
    }
  }
  return value;
}

export function readHindi(payload) {
  const text = extractOutputText(payload);
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.hindi === 'string') return cleanRoman(parsed.hindi);
  } catch {
    // A plain-text reply is still usable.
  }
  return cleanRoman(text);
}

export function hasDevanagari(text) {
  return DEVANAGARI.test(text);
}

function usable(text) {
  return Boolean(text) && /[A-Za-z]/.test(text) && !hasDevanagari(text);
}

function safeLog(log, apiKey, message) {
  const hidden = apiKey ? String(message).split(apiKey).join('[key]') : String(message);
  log(hidden.slice(0, 500));
}

async function post(apiKey, body, fetchImpl, signal, log) {
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new TranslateError('The translator took too long. Try a shorter sentence.', 504);
    }
    throw new TranslateError('Could not reach the translator.', 502);
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    safeLog(log, apiKey, data?.error?.message || `upstream ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      throw new TranslateError('The API key was rejected. Check XAI_API_KEY in the .env file.', 401);
    }
    if (response.status === 400) {
      throw new TranslateError('The translator could not finish that sentence.', 502, { badRequest: true });
    }
    throw new TranslateError('The translator could not finish that sentence.', 502);
  }

  return data;
}

async function askOnce({ apiKey, text, speaker, tone, reminder, fetchImpl, signal, log }) {
  try {
    const payload = await post(
      apiKey,
      buildRequest({ text, speaker, tone, reminder, plain: false }),
      fetchImpl,
      signal,
      log,
    );
    return readHindi(payload);
  } catch (error) {
    if (!error?.badRequest) throw error;
    const payload = await post(
      apiKey,
      buildRequest({ text, speaker, tone, reminder, plain: true }),
      fetchImpl,
      signal,
      log,
    );
    return readHindi(payload);
  }
}

export async function translateText(options) {
  const { text, speaker, tone } = normalizeOptions(options);
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) throw new TranslateError('Add XAI_API_KEY to the .env file and restart.', 503);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((message) => console.error(message));
  const signal = options.signal ?? AbortSignal.timeout(40000);

  let hindi = await askOnce({ apiKey, text, speaker, tone, reminder: false, fetchImpl, signal, log });
  if (!usable(hindi)) {
    hindi = await askOnce({ apiKey, text, speaker, tone, reminder: true, fetchImpl, signal, log });
  }
  if (!hindi || !/[A-Za-z]/.test(hindi)) {
    throw new TranslateError('The translator returned an empty line.', 502);
  }
  if (hasDevanagari(hindi)) {
    throw new TranslateError('The translator used Hindi script. Try again.', 502);
  }
  return hindi;
}
