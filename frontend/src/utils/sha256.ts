// frontend/src/utils/sha256.ts
//
// SHA-256, in plain TypeScript, synchronous, over UTF-8.
//
// ==================================================================
//  DESIGN NOTE 1251: ONE DIGEST, RUN BY BOTH SIDES, WITH NOTHING TO AWAIT
// ==================================================================
//
// THE LOG HASH IS A SETTLEMENT COMMITMENT (audit §6), and `stateDigest.ts` says in its own header that its
// FNV fingerprint "is not a cryptographic hash and must not become one by accident ... settlement hashes the
// LOG with a real digest." This is that digest.
//
// WHY NOT THE PLATFORM'S. Node has `crypto.createHash`; a browser has `crypto.subtle.digest`, which is
// asynchronous and absent in an insecure context. Two implementations behind one name is #1184's shape in
// the one function whose two answers must agree to the bit -- a client verifying a checkpoint against the
// server's hash. One implementation both sides run, synchronously, is worth the eighty lines; and the test
// vectors from FIPS 180-4 are what say it is SHA-256 and not something that resembles it.
//
// UTF-8 BY HAND for the same reason: `TextEncoder` is global in a browser and in Node, and not in every jest
// environment this project's suites run under. The encoder is twelve lines and has no edge worth a
// dependency -- lone surrogates are encoded as the replacement character, which is what `TextEncoder` does.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    let code = text.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
      const low = text.charCodeAt(at + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        at += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd; // a lone surrogate, as TextEncoder encodes it
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
export function sha256HexOfBytes(message: Uint8Array): string {
  const bitLength = message.length * 8;
  /* PADDING: a 1 bit, zeros to 56 mod 64, then the length as a 64-bit big-endian integer. Messages here are
     far below 2^53 bits, so the high word of the length is the integer division by 2^32. */
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    // Indexed rather than destructured: the frontend builds to es5, where a typed array cannot be iterated.
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += h[i].toString(16).padStart(8, "0");
  return hex;
}

/** SHA-256 of a string's UTF-8 bytes, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  return sha256HexOfBytes(utf8Bytes(text));
}
