const form = document.querySelector('#form');
const source = document.querySelector('#source');
const output = document.querySelector('#output');
const copyButton = document.querySelector('#copy');
const go = document.querySelector('#go');

let busy = false;
let current = '';

function setOutput(text, kind) {
  output.textContent = text;
  output.classList.toggle('is-loading', kind === 'loading');
  output.classList.toggle('is-error', kind === 'error');
}

source.addEventListener('input', () => {
  go.disabled = busy || source.value.trim().length === 0;
});

source.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    form.requestSubmit();
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

async function run() {
  const text = source.value.trim();
  if (busy) return;
  if (!text) {
    setOutput('Write an English sentence first.', 'error');
    source.focus();
    return;
  }

  busy = true;
  go.disabled = true;
  copyButton.disabled = true;
  setOutput('Translating…', 'loading');

  let again = false;
  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await response.json().catch(() => ({}));
    if (source.value.trim() !== text) {
      again = true;
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Translation failed.');
    if (typeof data.hindi !== 'string' || !data.hindi.trim()) {
      throw new Error('Translation failed.');
    }
    current = data.hindi;
    setOutput(data.hindi);
    copyButton.disabled = false;
  } catch (error) {
    if (source.value.trim() !== text) {
      again = true;
      return;
    }
    current = '';
    const message = error.message === 'Failed to fetch'
      ? 'Could not reach the translator.'
      : (error.message || 'Translation failed.');
    setOutput(message, 'error');
    copyButton.disabled = true;
  } finally {
    busy = false;
    go.disabled = source.value.trim().length === 0;
  }

  if (!again) return;
  if (source.value.trim()) run();
  else {
    current = '';
    setOutput('');
    copyButton.disabled = true;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  run();
});

copyButton.addEventListener('click', async () => {
  if (!current) return;
  await copyText(current);
  const previous = copyButton.textContent;
  copyButton.textContent = 'Copied';
  window.setTimeout(() => {
    copyButton.textContent = previous;
  }, 1400);
});
