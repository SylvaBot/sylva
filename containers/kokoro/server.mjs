// Kokoro-82M text to speech for Sylva tips.
//
//   GET  /health                        200 once the model is loaded
//   POST /speak {"text","voice"}        an MP3 (24 kHz mono, 64 kbps)
//
// The model is the q8 ONNX export of hexgrad/Kokoro-82M (Apache-2.0). The
// text clean-up and phoneme fixes are ported from kokoro-js (Apache-2.0,
// hexgrad and Xenova).

import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ort from 'onnxruntime-node';
import { phonemize as espeak } from 'phonemizer';
import { Mp3Encoder } from '@breezystack/lamejs';
import { VOCAB } from './vocab.mjs';

const DATA = process.env.KOKORO_DATA || new URL('./data', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8080);
const RATE = 24000;
const MAX_TOKENS = 510;
const MAX_TEXT = 1000;

/* ---------- Model and voices ---------- */

const parts = readdirSync(join(DATA, 'model')).filter((f) => /^part\d+\.bin$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  .map((f) => readFileSync(join(DATA, 'model', f)));
const session = await ort.InferenceSession.create(Buffer.concat(parts), {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
});

const voices = new Map();
for (const f of readdirSync(join(DATA, 'voices'))) {
  const m = f.match(/^([ab][fm]_[a-z]+)\.bin$/);
  if (!m) continue;
  const b = readFileSync(join(DATA, 'voices', f));
  voices.set(m[1], new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
}

/* ---------- Text to phonemes (from kokoro-js) ---------- */

function splitNum(e) {
  if (e.includes('.')) return e;
  if (e.includes(':')) {
    const [a, t] = e.split(':').map(Number);
    return t === 0 ? `${a} o'clock` : t < 10 ? `${a} oh ${t}` : `${a} ${t}`;
  }
  const a = parseInt(e.slice(0, 4), 10);
  if (a < 1100 || a % 1000 < 10) return e;
  const t = e.slice(0, 2);
  const r = parseInt(e.slice(2, 4), 10);
  const s = e.endsWith('s') ? 's' : '';
  if (a % 1000 >= 100 && a % 1000 <= 999) {
    if (r === 0) return `${t} hundred${s}`;
    if (r < 10) return `${t} oh ${r}${s}`;
  }
  return `${t} ${r}${s}`;
}

function money(e) {
  const unit = e[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${unit}s`;
  if (!e.includes('.')) return `${e.slice(1)} ${unit}${e.slice(1) === '1' ? '' : 's'}`;
  const [a, b] = e.slice(1).split('.');
  const n = parseInt(b.padEnd(2, '0'), 10);
  const small = e[0] === '$' ? (n === 1 ? 'cent' : 'cents') : (n === 1 ? 'penny' : 'pence');
  return `${a} ${unit}${a === '1' ? '' : 's'} and ${n} ${small}`;
}

function decimal(e) {
  const [a, b] = e.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

function normalize(text) {
  return text
    .replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"')
    .replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ').replace(/  +/, ' ').replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, decimal)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

async function phonemes(text, british) {
  text = normalize(text);
  const pieces = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT_RE)) {
    if (last < m.index) pieces.push({ punct: false, text: text.slice(last, m.index) });
    if (m[0].length) pieces.push({ punct: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ punct: false, text: text.slice(last) });
  const lang = british ? 'en' : 'en-us';
  const said = await Promise.all(pieces.map(async (p) => (p.punct ? p.text : (await espeak(p.text, lang)).join(' '))));
  let out = said.join('')
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (!british) out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out.trim();
}

function tokens(ph) {
  const ids = [];
  for (const ch of ph) {
    const id = VOCAB[ch];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/* ---------- Speech ---------- */

const sentences = (text) => text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);

async function speak(text, voiceId) {
  const style = voices.get(voiceId);
  if (!style) throw Object.assign(new Error(`unknown voice ${voiceId}`), { status: 400 });
  const british = voiceId[0] === 'b';
  const chunks = [];
  for (const s of sentences(text)) {
    const ids = tokens(await phonemes(s, british)).slice(0, MAX_TOKENS);
    if (!ids.length) continue;
    const row = Math.min(ids.length, 509) * 256;
    const out = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from([0, ...ids, 0].map(BigInt)), [1, ids.length + 2]),
      style: new ort.Tensor('float32', style.slice(row, row + 256), [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([1]), [1]),
    });
    chunks.push(out.waveform.data, new Float32Array(Math.round(RATE * 0.15)));
  }
  return mp3(chunks);
}

function mp3(chunks) {
  const enc = new Mp3Encoder(1, RATE, 64);
  const out = [];
  for (const c of chunks) {
    const pcm = new Int16Array(c.length);
    for (let i = 0; i < c.length; i++) pcm[i] = Math.max(-1, Math.min(1, c[i])) * 32767;
    for (let i = 0; i < pcm.length; i += 1152) {
      const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
      if (b.length) out.push(Buffer.from(b.buffer, b.byteOffset, b.length));
    }
  }
  const end = enc.flush();
  if (end.length) out.push(Buffer.from(end.buffer, end.byteOffset, end.length));
  return Buffer.concat(out);
}

/* ---------- HTTP ---------- */

// One message at a time: the model uses every core it has.
let queue = Promise.resolve();

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/speak') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => { body += d; if (body.length > 16_384) req.destroy(); });
  req.on('end', () => {
    let job;
    try {
      const { text, voice } = JSON.parse(body);
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || typeof voice !== 'string') {
        throw Object.assign(new Error('bad request'), { status: 400 });
      }
      job = queue.then(() => speak(text, voice));
    } catch (e) {
      res.writeHead(e.status || 400, { 'Content-Type': 'text/plain' }).end(String(e.message));
      return;
    }
    queue = job.catch(() => {});
    job.then(
      (audio) => res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length }).end(audio),
      (e) => res.writeHead(e.status || 500, { 'Content-Type': 'text/plain' }).end(String(e.message)),
    );
  });
}).listen(PORT, () => console.log(`Kokoro listening on ${PORT} with ${voices.size} voices`));
