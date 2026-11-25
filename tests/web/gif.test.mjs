// Tests for web/gif.js (the animated GIF encoder behind Squall Uno's "Save replay"). Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lzwDecode, readGif, u16 } from './gif-read.mjs';

const require = createRequire(import.meta.url);
const G = require('../../web/gif.js');

// A width × height rgba picture from a function (x, y) -> [r, g, b].
function picture(width, height, fn) {
  const a = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fn(x, y);
    const i = (y * width + x) * 4;
    a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255;
  }
  return a;
}

const colorAt = (table, i) => [table[i * 3], table[i * 3 + 1], table[i * 3 + 2]];

// ---------------------------------------------------------------- the file

test('a 2-frame GIF: header, screen size, loop, two images, delays and the trailer', () => {
  const W = 5, H = 3;
  const RED = [200, 16, 32], BLUE = [24, 64, 248], WHITE = [248, 248, 248], GREEN = [40, 200, 72];
  const one = picture(W, H, (x, y) => (x + y) % 2 ? RED : BLUE);
  const two = picture(W, H, (x, y) => y === 1 ? GREEN : x < 2 ? WHITE : RED);
  const bytes = G.encodeGif(W, H, [{ rgba: one, delay: 900 }, { rgba: two, delay: 2500 }], { crop: false });

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  assert.equal(u16(bytes, 6), W);
  assert.equal(u16(bytes, 8), H);
  assert.equal(bytes[bytes.length - 1], 0x3b);

  const gif = readGif(bytes);
  assert.equal(gif.head, 'GIF89a');
  assert.equal(gif.global, null);            // every frame brings its own colors
  assert.ok(gif.trailer, 'the trailer is the last byte');

  const loop = gif.exts.find(e => e.label === 0xff);
  assert.ok(loop, 'there is an application extension');
  assert.equal(String.fromCharCode(...loop.parts[0]), 'NETSCAPE2.0');
  assert.deepEqual(Array.from(loop.parts[1]), [1, 0, 0]);   // loop forever

  assert.equal(bytes.filter(v => v === 0x2c).length >= 2, true);
  assert.equal(gif.images.length, 2);
  for (const [img, src, delay] of [[gif.images[0], one, 90], [gif.images[1], two, 250]]) {
    assert.deepEqual([img.x, img.y, img.w, img.h], [0, 0, W, H]);
    assert.ok(img.local);
    assert.equal(img.control.delay, delay);
    assert.equal(img.control.disposal, 1);
    assert.ok(img.ended, 'the image data ends with the end code');
    assert.equal(img.clears, 1, 'one clear code, at the start');
    // the pixels come back exactly (these colors sit alone in their boxes, so the palette keeps them as they are)
    assert.equal(img.indices.length, W * H);
    for (let p = 0; p < W * H; p++) assert.deepEqual(colorAt(img.table, img.indices[p]), [src[p * 4], src[p * 4 + 1], src[p * 4 + 2]], 'pixel ' + p);
  }
  // and the indices are the ones the palette maps to
  const pal = G.buildPalette(two, 255);
  assert.deepEqual(gif.images[1].indices, Array.from(G.mapPixels(two, pal)));
});

test('after the first frame only the changed rectangle is written', () => {
  const W = 16, H = 10;
  const base = picture(W, H, (x, y) => [x * 16, y * 24, 128]);
  const moved = base.slice();
  for (let y = 3; y <= 5; y++) for (let x = 6; x <= 9; x++) { const i = (y * W + x) * 4; moved[i] = 255; moved[i + 1] = 255; moved[i + 2] = 0; }
  const gif = readGif(G.encodeGif(W, H, [{ rgba: base, delay: 900 }, { rgba: moved, delay: 900 }, { rgba: moved, delay: 2500 }]));
  assert.equal(gif.images.length, 3);
  assert.deepEqual([gif.images[0].x, gif.images[0].y, gif.images[0].w, gif.images[0].h], [0, 0, W, H]);
  const b = gif.images[1];
  assert.deepEqual([b.x, b.y, b.w, b.h], [6, 3, 4, 3]);
  assert.equal(b.indices.length, 12);
  b.indices.forEach(i => assert.deepEqual(colorAt(b.table, i), [255, 255, 0]));
  // the same picture again still makes a frame (it carries the delay): one pixel, as it was
  const c = gif.images[2];
  assert.deepEqual([c.w, c.h], [1, 1]);
  assert.equal(c.control.delay, 250);
  assert.deepEqual(G.changedBox(base, base, W, H), null);
  assert.deepEqual(G.changedBox(base, moved, W, H), { x: 6, y: 3, w: 4, h: 3 });
});

test('a global color table, and no loop extension when asked', () => {
  const W = 4, H = 4;
  const img = picture(W, H, (x) => x < 2 ? [0, 0, 0] : [255, 255, 255]);
  const gif = readGif(G.encodeGif(W, H, [{ rgba: img, delay: 100 }], { palette: [0, 0, 0, 255, 255, 255], loop: -1 }));
  assert.ok(gif.global);
  assert.equal(gif.global.length, 6);              // 2 colors: a 1-bit table
  assert.equal(gif.packed & 0x80, 0x80);
  assert.equal(gif.exts.some(e => e.label === 0xff), false);
  assert.equal(gif.images[0].local, undefined);
  assert.equal(gif.images[0].minCodeSize, 2);      // GIF's smallest
  assert.deepEqual(gif.images[0].indices, [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
});

test('a frame of the wrong size, a bad screen size and adding after finish are refused in plain words', () => {
  assert.throws(() => G.createGif(0, 10), /1 to 65535/);
  const gif = G.createGif(2, 2);
  assert.throws(() => gif.addFrame(new Uint8Array(4), 100), /2 × 2/);
  gif.addFrame(new Uint8Array(16), 100);
  gif.finish();
  assert.throws(() => gif.addFrame(new Uint8Array(16), 100), /finished/);
});

// ---------------------------------------------------------------- LZW

test('LZW round-trips long and many-colored pictures, with clear codes when the table fills', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 16;
  // random bytes fill the 4096-code table fast: several clear codes
  const noisy = Uint8Array.from({ length: 30000 }, () => rnd() & 255);
  let r = lzwDecode(G.lzwEncode(noisy, 8), 8);
  assert.ok(r.ended);
  assert.ok(r.clears >= 3, 'clears: ' + r.clears);
  assert.deepEqual(r.indices, Array.from(noisy));
  // long runs of few colors make long codes (the code that is being defined, too)
  const runs = Uint8Array.from({ length: 50000 }, (_, i) => (Math.floor(i / 37) + (i % 5 === 0 ? 1 : 0)) & 3);
  r = lzwDecode(G.lzwEncode(runs, 2), 2);
  assert.deepEqual(r.indices, Array.from(runs));
  // one pixel, and none
  assert.deepEqual(lzwDecode(G.lzwEncode(Uint8Array.of(3), 2), 2).indices, [3]);
  r = lzwDecode(G.lzwEncode(new Uint8Array(0), 2), 2);
  assert.ok(r.ended);
  assert.deepEqual(r.indices, []);
  // every size of table
  for (let bits = 2; bits <= 8; bits++) {
    const v = Uint8Array.from({ length: 5000 }, () => rnd() % (1 << bits));
    assert.deepEqual(lzwDecode(G.lzwEncode(v, bits), bits).indices, Array.from(v), 'min code size ' + bits);
  }
});

test('image data goes in sub-blocks of at most 255 bytes', () => {
  const W = 64, H = 64;
  let seed = 3;
  const img = picture(W, H, () => { seed = (seed * 69069 + 1) >>> 0; return [seed >>> 24, (seed >>> 16) & 255, (seed >>> 8) & 255]; });
  const gif = readGif(G.encodeGif(W, H, [{ rgba: img, delay: 900 }]));
  const sizes = gif.images[0].blockSizes;
  assert.ok(sizes.length > 1);
  assert.ok(sizes.every(s => s >= 1 && s <= 255));
  assert.ok(sizes.slice(0, -1).every(s => s === 255));
  assert.equal(gif.images[0].indices.length, W * H);
});

// ---------------------------------------------------------------- the palette

test('the palette keeps the 255 most used colors, most used first, and maps the rest to the nearest', () => {
  // 300 different colors, each in its own 5-bit box; color i is used 300 - i times
  const colors = Array.from({ length: 300 }, (_, i) => [(i % 32) * 8, (Math.floor(i / 32) % 32) * 8, 64]);
  const px = [];
  colors.forEach((c, i) => { for (let k = 0; k < 300 - i; k++) px.push(c); });
  const rgba = new Uint8Array(px.length * 4);
  px.forEach((c, p) => { rgba.set(c, p * 4); rgba[p * 4 + 3] = 255; });

  const pal = G.buildPalette(rgba, 255);
  assert.equal(pal.size, 255);
  assert.equal(pal.bits, 8);
  assert.equal(pal.colors.length, 255 * 3);
  for (let i = 0; i < 255; i++) assert.deepEqual(colorAt(pal.colors, i), colors[i], 'color ' + i);

  const idx = G.mapPixels(rgba, pal);
  assert.equal(idx.length, px.length);
  // a kept color maps to itself
  assert.equal(idx[0], 0);
  // a dropped color maps to the kept one nearest to it: (296 % 32) * 8 = 64, row 9 -> nearest is the same spot a row up
  const at = px.findIndex(c => c === colors[296]);
  const got = colorAt(pal.colors, idx[at]);
  const d = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const best = Math.min(...colors.slice(0, 255).map(c => d(c, colors[296])));
  assert.equal(d(got, colors[296]), best);
});

test('the palette averages the colors in a box, fits small pictures and caches what it maps', () => {
  // two colors in the same 5-bit box average out; a third sits alone
  const rgba = Uint8Array.from([10, 20, 30, 255, 12, 22, 30, 255, 200, 100, 50, 255, 200, 100, 50, 255, 200, 100, 50, 255]);
  const pal = G.buildPalette(rgba);
  assert.equal(pal.size, 2);
  assert.equal(pal.bits, 1);
  assert.deepEqual(colorAt(pal.colors, 0), [200, 100, 50]);   // used 3 times: first
  assert.deepEqual(colorAt(pal.colors, 1), [11, 21, 30]);
  assert.deepEqual(Array.from(G.mapPixels(rgba, pal)), [1, 1, 0, 0, 0]);
  // a color the picture never had: worked out once, then cached
  const box = ((250 >> 3) << 10) | ((250 >> 3) << 5) | (250 >> 3);
  assert.equal(pal.cache[box], -1);
  assert.deepEqual(Array.from(G.mapPixels(Uint8Array.from([250, 250, 250, 255]), pal)), [0]);
  assert.equal(pal.cache[box], 0);
  // the cap is honored, and a blank picture still gives one color
  assert.equal(G.buildPalette(rgba, 1).size, 1);
  assert.equal(G.buildPalette(new Uint8Array(0)).size, 1);
  assert.deepEqual([1, 2, 3, 4, 5, 200, 256].map(G.tableBits), [1, 1, 2, 2, 3, 8, 8]);
});
