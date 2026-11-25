// A small animated GIF encoder for the Squall window, with no dependencies.
//
// Squall Uno's "Save replay" (web/uno.js) uses it to turn a task's real step pictures into one animated GIF, made
// entirely in the page. It writes GIF89a with the NETSCAPE2.0 loop extension, a delay per frame, a global or a local
// color table (up to 256 colors) and variable-width LZW with clear codes.
//
// Colors: each frame gets its own palette, made by popularity: every pixel is counted in a 5-bit-per-channel box
// (32,768 boxes), the 255 most used boxes become the palette (each the average of the real colors in it), and any
// other box maps to its nearest palette color (worked out once per box and cached). No dithering.
//
// Size: after the first frame only the rectangle that changed is written (the rest of the picture stays, disposal 1),
// which keeps screen recordings small. Pass { crop: false } to write every frame whole.
//
//   const gif = SquallGif.createGif(width, height, { loop: 0 });
//   gif.addFrame(rgba, 900);           // rgba: width × height × 4 bytes (canvas ImageData.data), delay in ms
//   const bytes = gif.finish();        // Uint8Array, a whole .gif file
//
// Tested with Node in tests/web/gif.test.mjs.
(function (root) {
  'use strict';

  const MAX_CODES = 4096;   // LZW codes are at most 12 bits

  // ---------------------------------------------------------------- bytes out

  function ByteOut(size) {
    this.buf = new Uint8Array(size || 65536);
    this.n = 0;
  }
  ByteOut.prototype.room = function (k) {
    if (this.n + k <= this.buf.length) return;
    let len = this.buf.length * 2;
    while (len < this.n + k) len *= 2;
    const next = new Uint8Array(len);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  };
  ByteOut.prototype.byte = function (v) { this.room(1); this.buf[this.n++] = v & 255; };
  ByteOut.prototype.u16 = function (v) { this.room(2); this.buf[this.n++] = v & 255; this.buf[this.n++] = (v >> 8) & 255; };
  ByteOut.prototype.ascii = function (s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); };
  ByteOut.prototype.bytes = function (a, from, to) {
    const part = from == null ? a : a.subarray(from, to);
    this.room(part.length);
    this.buf.set(part, this.n);
    this.n += part.length;
  };
  ByteOut.prototype.result = function () { return this.buf.slice(0, this.n); };

  // ---------------------------------------------------------------- the palette

  const boxOf = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

  // The table size a palette of n colors needs: 2^bits entries, at least 2 (bits 1..8).
  function tableBits(n) {
    let bits = 1;
    while ((1 << bits) < n && bits < 8) bits++;
    return bits;
  }

  // A palette from a list of colors: { colors: Uint8Array(n × 3), size: n, bits, cache } (cache: box -> index).
  function makePalette(colors) {
    const size = Math.max(1, Math.min(256, Math.floor(colors.length / 3)));
    const c = new Uint8Array(size * 3);
    c.set(colors.subarray ? colors.subarray(0, size * 3) : colors.slice(0, size * 3));
    const cache = new Int16Array(32768).fill(-1);
    return { colors: c, size, bits: tableBits(size), cache };
  }

  // The palette index nearest to (r, g, b), by squared distance.
  function nearest(pal, r, g, b) {
    const c = pal.colors;
    let best = 0, bestD = Infinity;
    for (let i = 0, j = 0; i < pal.size; i++, j += 3) {
      const dr = c[j] - r, dg = c[j + 1] - g, db = c[j + 2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    return best;
  }

  /**
   * A palette for one picture (rgba: 4 bytes a pixel; alpha is ignored), by popularity of its 5-bit-per-channel
   * colors: the `max` (default 255, at most 256) most used boxes, most used first, each the average of the real
   * colors that fell in it. Ties go to the lower box so the result never depends on luck.
   */
  function buildPalette(rgba, max) {
    const limit = Math.max(1, Math.min(256, Math.floor(max || 255)));
    const count = new Uint32Array(32768);
    const sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    const end = Math.floor(rgba.length / 4) * 4;
    for (let i = 0; i < end; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const k = boxOf(r, g, b);
      count[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
    }
    const used = [];
    for (let k = 0; k < 32768; k++) if (count[k]) used.push(k);
    used.sort((a, b) => count[b] - count[a] || a - b);
    const keep = used.slice(0, limit);
    const colors = new Uint8Array(Math.max(1, keep.length) * 3);
    keep.forEach((k, i) => {
      const n = count[k];
      colors[i * 3] = Math.round(sr[k] / n);
      colors[i * 3 + 1] = Math.round(sg[k] / n);
      colors[i * 3 + 2] = Math.round(sb[k] / n);
    });
    const pal = makePalette(colors);
    keep.forEach((k, i) => { pal.cache[k] = i; });
    // the boxes that didn't make it map to the nearest kept color, measured from their own average color
    for (let i = limit; i < used.length; i++) {
      const k = used[i], n = count[k];
      pal.cache[k] = nearest(pal, Math.round(sr[k] / n), Math.round(sg[k] / n), Math.round(sb[k] / n));
    }
    return pal;
  }

  /** The palette index of every pixel of rgba (a Uint8Array, one byte a pixel). Unknown boxes are cached as found. */
  function mapPixels(rgba, pal) {
    const n = Math.floor(rgba.length / 4);
    const out = new Uint8Array(n);
    const cache = pal.cache;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const k = boxOf(r, g, b);
      let x = cache[k];
      if (x < 0) { x = nearest(pal, (r & 0xf8) | 4, (g & 0xf8) | 4, (b & 0xf8) | 4); cache[k] = x; }
      out[p] = x;
    }
    return out;
  }

  // ---------------------------------------------------------------- LZW

  /**
   * GIF's variable-width LZW: the packed code stream (least significant bit first, not yet in sub-blocks) for the
   * pixel indices, each below 2^minCodeSize. Starts with a clear code, sends a clear code whenever the 4096-entry
   * table is full, and ends with the end-of-information code.
   */
  function lzwEncode(indices, minCodeSize) {
    const clear = 1 << minCodeSize, eoi = clear + 1;
    const out = new ByteOut(Math.max(256, indices.length >> 1));
    let codeSize = minCodeSize + 1, next = eoi + 1;
    let acc = 0, accBits = 0;
    const emit = code => {
      acc |= code << accBits;
      accBits += codeSize;
      while (accBits >= 8) { out.byte(acc & 255); acc >>>= 8; accBits -= 8; }
    };
    let dict = new Map();
    emit(clear);
    if (indices.length) {
      const mask = clear - 1;
      let prefix = indices[0] & mask;
      for (let i = 1; i < indices.length; i++) {
        const k = indices[i] & mask;
        const key = prefix * 256 + k;
        const hit = dict.get(key);
        if (hit !== undefined) { prefix = hit; continue; }
        emit(prefix);
        if (next === MAX_CODES) {
          emit(clear);
          dict = new Map();
          codeSize = minCodeSize + 1;
          next = eoi + 1;
        } else {
          if (next >= (1 << codeSize)) codeSize++;
          dict.set(key, next++);
        }
        prefix = k;
      }
      emit(prefix);
    }
    emit(eoi);
    if (accBits > 0) out.byte(acc & 255);
    return out.result();
  }

  // Writes data as GIF sub-blocks (a length byte, then up to 255 bytes), then the 0 that ends them.
  function writeBlocks(out, data) {
    for (let i = 0; i < data.length; i += 255) {
      const len = Math.min(255, data.length - i);
      out.byte(len);
      out.bytes(data, i, i + len);
    }
    out.byte(0);
  }

  function writeTable(out, pal) {
    out.bytes(pal.colors);
    for (let i = pal.size * 3; i < (3 << pal.bits); i++) out.byte(0);
  }

  // ---------------------------------------------------------------- frames

  /** The smallest rectangle where a and b (both width × height rgba) differ in color, or null when they don't. */
  function changedBox(a, b, width, height) {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      let i = y * width * 4;
      for (let x = 0; x < width; x++, i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // The pixels of one rectangle of a width-wide rgba picture, as their own rgba.
  function cropRGBA(rgba, width, box) {
    const out = new Uint8Array(box.w * box.h * 4);
    for (let y = 0; y < box.h; y++) {
      const from = ((box.y + y) * width + box.x) * 4;
      out.set(rgba.subarray(from, from + box.w * 4), y * box.w * 4);
    }
    return out;
  }

  const u16ok = v => Number.isInteger(v) && v > 0 && v <= 65535;

  /**
   * A GIF being made: addFrame(rgba, delayMs) for each frame in order, then finish() for the file's bytes.
   * opts.loop: 0 (default) plays forever, n plays n more times, -1 writes no loop extension (plays once).
   * opts.palette: a palette (from buildPalette) to use for every frame as the global color table; without it each
   * frame has its own local table. opts.crop: false writes every frame whole.
   */
  function createGif(width, height, opts) {
    const o = opts || {};
    if (!u16ok(width) || !u16ok(height)) throw new Error('A GIF has to be 1 to 65535 pixels each way.');
    const loop = o.loop == null ? 0 : Math.floor(+o.loop);
    const crop = o.crop !== false;
    const global = o.palette ? makePaletteFrom(o.palette) : null;
    const out = new ByteOut(1 << 20);
    let prev = null, frames = 0, done = false;

    // header and logical screen descriptor (color resolution 8 bits)
    out.ascii('GIF89a');
    out.u16(width);
    out.u16(height);
    out.byte(global ? 0xf0 | (global.bits - 1) : 0x70);
    out.byte(0);    // background color index
    out.byte(0);    // pixel aspect ratio: not given
    if (global) writeTable(out, global);
    if (loop >= 0) {
      out.byte(0x21); out.byte(0xff); out.byte(11); out.ascii('NETSCAPE2.0');
      out.byte(3); out.byte(1); out.u16(Math.min(65535, loop)); out.byte(0);
    }

    function addFrame(rgba, delayMs) {
      if (done) throw new Error('This GIF is already finished.');
      if (!rgba || rgba.length < width * height * 4) throw new Error('A frame has to be ' + width + ' × ' + height + ' pixels.');
      let box = { x: 0, y: 0, w: width, h: height };
      if (crop && prev) box = changedBox(prev, rgba, width, height) || { x: 0, y: 0, w: 1, h: 1 };
      const whole = box.w === width && box.h === height;
      const pixels = whole ? rgba.subarray(0, width * height * 4) : cropRGBA(rgba, width, box);
      const pal = global || buildPalette(pixels, 255);
      const indices = mapPixels(pixels, pal);

      // graphic control extension: leave the frame in place (disposal 1), the delay in hundredths of a second
      const cs = Math.max(0, Math.min(65535, Math.round((+delayMs || 0) / 10)));
      out.byte(0x21); out.byte(0xf9); out.byte(4);
      out.byte(1 << 2);
      out.u16(cs);
      out.byte(0);    // transparent color index (not used)
      out.byte(0);

      // image descriptor, then its own color table when there's no global one
      out.byte(0x2c);
      out.u16(box.x); out.u16(box.y); out.u16(box.w); out.u16(box.h);
      out.byte(global ? 0 : 0x80 | (pal.bits - 1));
      if (!global) writeTable(out, pal);

      const minCodeSize = Math.max(2, pal.bits);
      out.byte(minCodeSize);
      writeBlocks(out, lzwEncode(indices, minCodeSize));

      if (crop) prev = rgba.slice(0, width * height * 4);
      frames++;
      return box;
    }

    function finish() {
      if (!done) { out.byte(0x3b); done = true; }
      return out.result();
    }

    return { width, height, addFrame, finish, frames: () => frames, size: () => out.n };
  }

  // A palette given by the caller: one made by buildPalette, or plain [r, g, b, r, g, b, …] colors.
  function makePaletteFrom(p) {
    if (p && p.colors && p.cache && p.bits) return p;
    const colors = p && p.colors ? p.colors : p;
    if (!colors || colors.length < 3) throw new Error('A palette needs at least one color.');
    return makePalette(colors instanceof Uint8Array ? colors : Uint8Array.from(colors));
  }

  /** The whole file at once: frames [{ rgba, delay }] at width × height (opts as createGif). */
  function encodeGif(width, height, frames, opts) {
    const gif = createGif(width, height, opts);
    for (const f of frames || []) gif.addFrame(f.rgba, f.delay);
    return gif.finish();
  }

  const api = { createGif, encodeGif, buildPalette, mapPixels, lzwEncode, changedBox, tableBits };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquallGif = api;
})(typeof window !== 'undefined' ? window : globalThis);
