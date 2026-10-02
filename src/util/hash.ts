/**
 * Pure-JS MD5 + SHA-1 with **zero platform dependencies**, so the authoring
 * surface (guid derivation, bundle signature) runs identically in Node and the
 * browser. These MUST be byte-for-byte identical to `node:crypto`'s
 * `createHash("md5"|"sha1")` — object identity and the golden-bundle signature
 * depend on it (fuzzed against `node:crypto` in test/util/hash.test.ts).
 *
 * Inputs are UTF-8 encoded via `TextEncoder` (isomorphic), matching Node's
 * default string `update()` encoding.
 */

const utf8 = new TextEncoder();

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? utf8.encode(input) : input;
}

/* ------------------------------- MD5 ------------------------------- */

function md5Bytes(input: string | Uint8Array): Uint8Array {
  const msg = toBytes(input);
  const len = msg.length;

  // Pad: append 0x80, then zeros, then 64-bit little-endian bit length.
  const withPad = ((len + 8) >>> 6) + 1;
  const words = new Int32Array(withPad * 16);
  for (let i = 0; i < len; i++) {
    const idx = i >> 2;
    words[idx] = (words[idx] as number) | (msg[i]! << ((i % 4) * 8));
  }
  const padIdx = len >> 2;
  words[padIdx] = (words[padIdx] as number) | (0x80 << ((len % 4) * 8));
  words[words.length - 2] = len * 8;

  let a = 1732584193,
    b = -271733879,
    c = -1732584194,
    d = 271733878;

  const add = (x: number, y: number) => (x + y) | 0;
  const rol = (n: number, s: number) => (n << s) | (n >>> (32 - s));
  const cmn = (q: number, a0: number, b0: number, x: number, s: number, t: number) =>
    add(rol(add(add(a0, q), add(x, t)), s), b0);
  const ff = (a0: number, b0: number, c0: number, d0: number, x: number, s: number, t: number) =>
    cmn((b0 & c0) | (~b0 & d0), a0, b0, x, s, t);
  const gg = (a0: number, b0: number, c0: number, d0: number, x: number, s: number, t: number) =>
    cmn((b0 & d0) | (c0 & ~d0), a0, b0, x, s, t);
  const hh = (a0: number, b0: number, c0: number, d0: number, x: number, s: number, t: number) =>
    cmn(b0 ^ c0 ^ d0, a0, b0, x, s, t);
  const ii = (a0: number, b0: number, c0: number, d0: number, x: number, s: number, t: number) =>
    cmn(c0 ^ (b0 | ~d0), a0, b0, x, s, t);

  for (let i = 0; i < words.length; i += 16) {
    const oa = a,
      ob = b,
      oc = c,
      od = d;
    const w = (j: number) => words[i + j]!;

    a = ff(a, b, c, d, w(0), 7, -680876936);
    d = ff(d, a, b, c, w(1), 12, -389564586);
    c = ff(c, d, a, b, w(2), 17, 606105819);
    b = ff(b, c, d, a, w(3), 22, -1044525330);
    a = ff(a, b, c, d, w(4), 7, -176418897);
    d = ff(d, a, b, c, w(5), 12, 1200080426);
    c = ff(c, d, a, b, w(6), 17, -1473231341);
    b = ff(b, c, d, a, w(7), 22, -45705983);
    a = ff(a, b, c, d, w(8), 7, 1770035416);
    d = ff(d, a, b, c, w(9), 12, -1958414417);
    c = ff(c, d, a, b, w(10), 17, -42063);
    b = ff(b, c, d, a, w(11), 22, -1990404162);
    a = ff(a, b, c, d, w(12), 7, 1804603682);
    d = ff(d, a, b, c, w(13), 12, -40341101);
    c = ff(c, d, a, b, w(14), 17, -1502002290);
    b = ff(b, c, d, a, w(15), 22, 1236535329);

    a = gg(a, b, c, d, w(1), 5, -165796510);
    d = gg(d, a, b, c, w(6), 9, -1069501632);
    c = gg(c, d, a, b, w(11), 14, 643717713);
    b = gg(b, c, d, a, w(0), 20, -373897302);
    a = gg(a, b, c, d, w(5), 5, -701558691);
    d = gg(d, a, b, c, w(10), 9, 38016083);
    c = gg(c, d, a, b, w(15), 14, -660478335);
    b = gg(b, c, d, a, w(4), 20, -405537848);
    a = gg(a, b, c, d, w(9), 5, 568446438);
    d = gg(d, a, b, c, w(14), 9, -1019803690);
    c = gg(c, d, a, b, w(3), 14, -187363961);
    b = gg(b, c, d, a, w(8), 20, 1163531501);
    a = gg(a, b, c, d, w(13), 5, -1444681467);
    d = gg(d, a, b, c, w(2), 9, -51403784);
    c = gg(c, d, a, b, w(7), 14, 1735328473);
    b = gg(b, c, d, a, w(12), 20, -1926607734);

    a = hh(a, b, c, d, w(5), 4, -378558);
    d = hh(d, a, b, c, w(8), 11, -2022574463);
    c = hh(c, d, a, b, w(11), 16, 1839030562);
    b = hh(b, c, d, a, w(14), 23, -35309556);
    a = hh(a, b, c, d, w(1), 4, -1530992060);
    d = hh(d, a, b, c, w(4), 11, 1272893353);
    c = hh(c, d, a, b, w(7), 16, -155497632);
    b = hh(b, c, d, a, w(10), 23, -1094730640);
    a = hh(a, b, c, d, w(13), 4, 681279174);
    d = hh(d, a, b, c, w(0), 11, -358537222);
    c = hh(c, d, a, b, w(3), 16, -722521979);
    b = hh(b, c, d, a, w(6), 23, 76029189);
    a = hh(a, b, c, d, w(9), 4, -640364487);
    d = hh(d, a, b, c, w(12), 11, -421815835);
    c = hh(c, d, a, b, w(15), 16, 530742520);
    b = hh(b, c, d, a, w(2), 23, -995338651);

    a = ii(a, b, c, d, w(0), 6, -198630844);
    d = ii(d, a, b, c, w(7), 10, 1126891415);
    c = ii(c, d, a, b, w(14), 15, -1416354905);
    b = ii(b, c, d, a, w(5), 21, -57434055);
    a = ii(a, b, c, d, w(12), 6, 1700485571);
    d = ii(d, a, b, c, w(3), 10, -1894986606);
    c = ii(c, d, a, b, w(10), 15, -1051523);
    b = ii(b, c, d, a, w(1), 21, -2054922799);
    a = ii(a, b, c, d, w(8), 6, 1873313359);
    d = ii(d, a, b, c, w(15), 10, -30611744);
    c = ii(c, d, a, b, w(6), 15, -1560198380);
    b = ii(b, c, d, a, w(13), 21, 1309151649);
    a = ii(a, b, c, d, w(4), 6, -145523070);
    d = ii(d, a, b, c, w(11), 10, -1120210379);
    c = ii(c, d, a, b, w(2), 15, 718787259);
    b = ii(b, c, d, a, w(9), 21, -343485551);

    a = add(a, oa);
    b = add(b, ob);
    c = add(c, oc);
    d = add(d, od);
  }

  const out = new Uint8Array(16);
  [a, b, c, d].forEach((word, wi) => {
    for (let j = 0; j < 4; j++) out[wi * 4 + j] = (word >>> (j * 8)) & 0xff;
  });
  return out;
}

/** Hex MD5 digest — matches `createHash("md5").update(input).digest("hex")`. */
export function md5Hex(input: string | Uint8Array): string {
  return toHex(md5Bytes(input));
}

/* ------------------------------- SHA-1 ------------------------------- */

/** Raw 20-byte SHA-1 digest — matches `createHash("sha1").update(input).digest()`. */
export function sha1Bytes(input: string | Uint8Array): Uint8Array {
  const msg = toBytes(input);
  const len = msg.length;
  const withLen = len + 9;
  const blocks = Math.ceil(withLen / 64);
  const total = blocks * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  // 64-bit big-endian bit length in the last 8 bytes.
  const bitLen = len * 8;
  // Safe for len well beyond any bundle; write low 32 bits (high bits are 0).
  buf[total - 4] = (bitLen >>> 24) & 0xff;
  buf[total - 3] = (bitLen >>> 16) & 0xff;
  buf[total - 2] = (bitLen >>> 8) & 0xff;
  buf[total - 1] = bitLen & 0xff;

  let h0 = 1732584193,
    h1 = -271733879,
    h2 = -1732584194,
    h3 = 271733878,
    h4 = -1009589776;

  const w = new Int32Array(80);
  const rol = (n: number, s: number) => (n << s) | (n >>> (32 - s));

  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) {
      const k = i + j * 4;
      w[j] = (buf[k]! << 24) | (buf[k + 1]! << 16) | (buf[k + 2]! << 8) | buf[k + 3]!;
    }
    for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3]! ^ w[j - 8]! ^ w[j - 14]! ^ w[j - 16]!, 1);

    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 1518500249;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = -1894007588;
      } else {
        f = b ^ c ^ d;
        k = -899497514;
      }
      const t = (rol(a, 5) + f + e + k + w[j]!) | 0;
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, hi) => {
    out[hi * 4] = (h >>> 24) & 0xff;
    out[hi * 4 + 1] = (h >>> 16) & 0xff;
    out[hi * 4 + 2] = (h >>> 8) & 0xff;
    out[hi * 4 + 3] = h & 0xff;
  });
  return out;
}

/* ------------------------------- helpers ------------------------------- */

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Cryptographically-random bytes via the Web Crypto API — present and identical
 * in Node ≥ 18 (`globalThis.crypto`) and every browser. Replaces
 * `node:crypto.randomBytes` so canonical minting stays isomorphic.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
