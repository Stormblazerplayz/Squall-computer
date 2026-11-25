// A small GIF reader for the tests only (tests/web/gif.test.mjs and uno.test.mjs): it reads back what web/gif.js wrote,
// LZW and all, so the tests can check the pixels, not just the bytes. Not a test file itself (no .test. in its name).

// GIF's LZW the other way: the packed code stream back to pixel indices.
export function lzwDecode(data, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  let dict = [];
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; codeSize = minCodeSize + 1; next = eoi + 1; };
  reset();
  const out = [];
  let pos = 0, acc = 0, accBits = 0, prev = -1, clears = 0, ended = false;
  while (true) {
    while (accBits < codeSize && pos < data.length) { acc |= data[pos++] << accBits; accBits += 8; }
    if (accBits < codeSize) break;
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize; accBits -= codeSize;
    if (code === clear) { reset(); prev = -1; clears++; continue; }
    if (code === eoi) { ended = true; break; }
    let entry;
    if (prev < 0) {
      if (code >= next) throw new Error('first code after a clear is not a pixel: ' + code);
      entry = dict[code];
    } else {
      if (code < next) entry = dict[code];
      else if (code === next) entry = dict[prev].concat(dict[prev][0]);
      else throw new Error('code ' + code + ' is past the table (' + next + ')');
      if (next < 4096) dict[next++] = dict[prev].concat(entry[0]);
      if (next >= (1 << codeSize) && codeSize < 12) codeSize++;
    }
    for (const v of entry) out.push(v);
    prev = code;
  }
  return { indices: out, clears, ended };
}

export const u16 = (b, i) => b[i] | (b[i + 1] << 8);

// The blocks of a GIF file, in order.
export function readGif(bytes) {
  const b = bytes;
  const head = String.fromCharCode(...b.subarray(0, 6));
  const width = u16(b, 6), height = u16(b, 8), packed = b[10];
  let p = 13;
  let global = null;
  if (packed & 0x80) { const n = 1 << ((packed & 7) + 1); global = b.subarray(p, p + n * 3); p += n * 3; }
  const exts = [], images = [];
  let control = null, trailer = false;
  const blocks = () => { const parts = []; while (b[p]) { const len = b[p++]; parts.push(b.subarray(p, p + len)); p += len; } p++; return parts; };
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3b) { trailer = p === b.length; break; }
    if (t === 0x21) {
      const label = b[p++];
      const parts = blocks();
      exts.push({ label, parts });
      if (label === 0xf9) control = { disposal: (parts[0][0] >> 2) & 7, delay: u16(parts[0], 1) };
      continue;
    }
    if (t === 0x2c) {
      const img = { x: u16(b, p), y: u16(b, p + 2), w: u16(b, p + 4), h: u16(b, p + 6), packed: b[p + 8], control };
      p += 9;
      img.table = global;
      if (img.packed & 0x80) { const n = 1 << ((img.packed & 7) + 1); img.table = b.subarray(p, p + n * 3); img.local = true; p += n * 3; }
      img.minCodeSize = b[p++];
      const parts = blocks();
      img.blockSizes = parts.map(x => x.length);
      const data = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
      let o = 0; for (const x of parts) { data.set(x, o); o += x.length; }
      Object.assign(img, lzwDecode(data, img.minCodeSize));
      images.push(img);
      control = null;
      continue;
    }
    throw new Error('unknown block 0x' + t.toString(16) + ' at ' + (p - 1));
  }
  return { head, width, height, packed, global, exts, images, trailer };
}
