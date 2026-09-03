/**
 * Talks to Ollama, if it happens to be running.
 *
 * Requests are made from the main process rather than the renderer. The note
 * page runs under `default-src 'none'` with no connect-src, so it cannot reach
 * the network at all -- and that is worth keeping. Widening the policy so a
 * page full of untrusted note text can open connections would trade a real
 * guarantee for a convenience.
 *
 * Everything here fails quietly. Ollama is optional: if it is not installed,
 * not running, or slow to answer, the feature simply does not appear.
 */
const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const STATUS_TIMEOUT_MS = 1500;
const COMPLETE_TIMEOUT_MS = 8000;

/** In-flight completion, so a new keystroke can cancel the last request. */
let pending = null;

async function withTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Is Ollama reachable, and what has it got? */
async function status() {
  try {
    const res = await withTimeout(`${HOST}/api/tags`, {}, STATUS_TIMEOUT_MS);
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json();
    const models = (data.models || [])
      // Embedding models cannot generate text; offering one would just fail.
      .filter((m) => !/embed/i.test(m.name))
      .map((m) => ({ name: m.name, size: m.size || 0 }))
      .sort((a, b) => a.size - b.size);
    return { available: true, models, host: HOST };
  } catch (_) {
    return { available: false, models: [] };
  }
}

/**
 * Which model to suggest when none has been chosen.
 *
 * Size matters more than quality here: this runs on every pause in typing, and
 * a 27B model answering in four seconds is worse than a small one answering in
 * two hundred milliseconds. Prefer a code-completion model, then the smallest.
 */
function pickDefault(models) {
  if (!models.length) return '';
  const coder = models.find((m) => /coder|code/i.test(m.name));
  if (coder) return coder.name;
  // Sort here rather than trusting the caller: relying on the list arriving
  // in size order is the kind of assumption that quietly stops being true.
  return [...models].sort((a, b) => (a.size || 0) - (b.size || 0))[0].name;
}

/**
 * Drops any part of the answer that repeats what is already typed.
 *
 * Asked to continue "- milk\n- eggs\n- ", a model will often reply "- bread",
 * which would insert the bullet twice. Trim the longest overlap between the end
 * of the prefix and the start of the completion.
 */
function trimOverlap(prefix, completion) {
  const tail = prefix.slice(-40);
  for (let k = Math.min(tail.length, completion.length); k > 0; k -= 1) {
    if (completion.slice(0, k) === tail.slice(-k)) return completion.slice(k);
  }
  return completion;
}

/**
 * Models trained to fill a gap, which is exactly what autocomplete is.
 *
 * Asked with an ordinary instruction, an instruct-tuned model answers as an
 * assistant: given "hello my name is " it replied "Qwen." -- its own name.
 * The fill-in-the-middle format asks it to complete the text rather than
 * respond to it.
 */
const FIM = /coder|starcoder|codellama|codegemma|codestral/i;

function buildRequest({ prefix, suffix, model }) {
  if (FIM.test(model)) {
    return {
      prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix || ''}<|fim_middle|>`,
      stop: ['\n', '<|fim_pad|>', '<|endoftext|>', '<|file_sep|>'],
    };
  }
  // No FIM support: raw mode at least skips the chat template, so the model
  // continues the text instead of replying to it.
  return { prompt: prefix, stop: ['\n'] };
}

/**
 * Tidies a raw completion into something worth showing.
 *
 * Cuts to one line, ends at the first sentence rather than trailing off, and
 * drops a half-finished word when the model simply ran out of budget.
 */
function tidy(text, prefix, truncated) {
  let out = String(text || '').replace(/^[\r\n]+/, '').split('\n')[0];
  out = trimOverlap(prefix, out);

  // End at the first sentence. The terminator must be followed by a space or
  // the end, so "3.14" is not mistaken for the end of a sentence.
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(out);
  if (sentence) out = sentence[0];

  // Nothing to cut at: cap the length, and drop a half-finished word -- but
  // only when the model actually ran out of budget, which it tells us. Judging
  // that from the text alone throws away perfectly complete last words.
  if (out.length > 90) out = out.slice(0, 90).replace(/\s+\S*$/, '');
  else if (truncated && !/[\s.!?,;:)\]}]$/.test(out)) {
    out = out.replace(/\s+\S*$/, '');
  }
  return out.trimEnd();
}

/**
 * Asks for a continuation of `prefix`.
 *
 * Cancels whatever was already in flight: the caller types faster than the
 * model answers, and a stale suggestion is worse than none.
 */
async function complete({ prefix, suffix, model }) {
  if (!prefix || !prefix.trim()) return '';

  if (pending) pending.abort();
  const controller = new AbortController();
  pending = controller;

  const timer = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS);
  try {
    const { prompt, stop } = buildRequest({ prefix, suffix, model });
    const res = await fetch(`${HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        // Skips the chat template, so the model continues rather than replies.
        raw: true,
        stream: false,
        options: {
          // Short and fairly literal: this is a completion, not an essay.
          num_predict: 24,
          temperature: 0.15,
          stop,
        },
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return tidy(data.response, prefix, data.done_reason === 'length');
  } catch (_) {
    return ''; // aborted, unreachable, or malformed -- all mean "no suggestion"
  } finally {
    clearTimeout(timer);
    if (pending === controller) pending = null;
  }
}

/**
 * Turns a description of some maths into LaTeX.
 *
 * Unlike autocomplete this is a real instruction, so it goes through the chat
 * template rather than fill-in-the-middle -- the model is being asked a
 * question, not continuing a sentence.
 */
async function toLatex({ text, model }) {
  if (!text || !text.trim()) return '';

  const prompt = 'Write the LaTeX for the following, and reply with the LaTeX '
    + 'only -- no explanation, no dollar signs, no code fences.\n\n'
    + `${text.trim()}\n`;

  try {
    const res = await withTimeout(`${HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { num_predict: 120, temperature: 0.1 },
      }),
    }, 20000);
    if (!res.ok) return '';
    const data = await res.json();

    // Models wrap the answer in fences, dollars or \[ \] however firmly you
    // ask them not to. The caller supplies its own delimiters.
    return String(data.response || '')
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/```/g, '')
      .trim()
      .replace(/^\\\[|\\\]$/g, '')
      .replace(/^\\\(|\\\)$/g, '')
      .trim()
      .replace(/^\$+|\$+$/g, '')
      .trim();
  } catch (_) {
    return '';
  }
}

module.exports = {
  status, complete, toLatex, pickDefault, trimOverlap, tidy, HOST,
};
