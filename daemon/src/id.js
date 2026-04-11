// ULID generator (Crockford Base32, monotonic within same ms)
// 48-bit timestamp + 80-bit randomness = 26 chars
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom = null;

function randomChars(len) {
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = ENCODING[Math.floor(Math.random() * ENCODING_LEN)];
  }
  return out;
}

function encodeTime(now) {
  const chars = new Array(TIME_LEN);
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    chars[i] = ENCODING[t % ENCODING_LEN];
    t = Math.floor(t / ENCODING_LEN);
  }
  return chars;
}

function incrementRandom(chars) {
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = ENCODING.indexOf(chars[i]);
    if (idx < ENCODING_LEN - 1) {
      chars[i] = ENCODING[idx + 1];
      return chars;
    }
    chars[i] = ENCODING[0];
  }
  throw new Error('ULID random overflow');
}

export function ulid() {
  const now = Date.now();
  let randomPart;
  if (now === lastTime && lastRandom) {
    randomPart = incrementRandom([...lastRandom]);
  } else {
    randomPart = randomChars(RANDOM_LEN);
    lastTime = now;
  }
  lastRandom = randomPart;
  return encodeTime(now).join('') + randomPart.join('');
}

export function newId(prefix) {
  return `${prefix}-${ulid()}`;
}

export function now() {
  return Date.now();
}

export function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
