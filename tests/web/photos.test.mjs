// Tests for photos sent from the phone: chat.sendPhoto. Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const P = globalThis.SquallPhotos;

const view = {
  agents: [{ name: 'Nova', lead: true, status: 'idle' }, { name: 'Quill', status: 'idle' }],
  lead: 'Nova',
  chats: [
    { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], messages: [] },
    { id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], messages: [] },
  ],
};
const JPEG = Buffer.from('fake jpeg bytes').toString('base64');

test('b64Bytes counts bytes and spots what is not base64', () => {
  assert.equal(P.b64Bytes(Buffer.from('abc').toString('base64')), 3);
  assert.equal(P.b64Bytes(Buffer.from('abcd').toString('base64')), 4);
  assert.equal(P.b64Bytes(Buffer.from('abcde').toString('base64')), 5);
  assert.equal(P.b64Bytes('not base64!'), -1);
  assert.equal(P.b64Bytes('abc'), -1);
  assert.equal(P.b64Bytes(''), -1);
  assert.equal(P.b64Bytes(null), -1);
});

test('photoName keeps a safe name with the right ending', () => {
  assert.equal(P.photoName('IMG_0001.HEIC', 'image/jpeg', 0), 'IMG_0001.jpg');
  assert.equal(P.photoName('a/b\\c:d.png', 'image/png', 0), 'abcd.png');
  assert.equal(P.photoName('', 'image/jpeg', 1), 'phone-photo-2.jpg');
  assert.equal(P.photoName('shot.JPG', 'image/jpeg', 0), 'shot.JPG');
});

test('photoRoute checks the chat, the count, the type and the size', () => {
  assert.equal(P.photoRoute(view, { type: 'chat.send', chatId: 'chief' }), null);
  assert.equal(P.photoRoute(view, null), null);
  const ok = P.photoRoute(view, { type: 'chat.sendPhoto', chatId: 'quill', text: '  look ', photos: [{ data: JPEG, type: 'image/jpeg', name: 'a.jpg' }] });
  assert.equal(ok.do, 'photo');
  assert.equal(ok.chat.id, 'dm:Quill');
  assert.equal(ok.text, 'look');
  assert.deepEqual(ok.photos, [{ dataUrl: 'data:image/jpeg;base64,' + JPEG, type: 'image/jpeg', name: 'a.jpg' }]);
  const e = a => P.photoRoute(view, Object.assign({ type: 'chat.sendPhoto', chatId: 'chief' }, a)).error;
  assert.match(e({ chatId: 'nobody', photos: [{ data: JPEG, type: 'image/jpeg' }] }), /isn’t on the computer/);
  assert.match(e({ photos: [] }), /Pick a photo/);
  assert.match(e({ photos: [1, 2, 3, 4].map(() => ({ data: JPEG, type: 'image/jpeg' })) }), /up to 3/);
  assert.match(e({ photos: [{ data: JPEG, type: 'image/gif' }] }), /JPEG or PNG/);
  assert.match(e({ photos: [{ data: 'oops!', type: 'image/png' }] }), /didn’t come through/);
  const big = Buffer.alloc(P.PHOTO_MAX_BYTES + 3).toString('base64');
  assert.match(e({ photos: [{ data: big, type: 'image/jpeg' }] }), /too big/);
});

test('photoDo saves each photo and then sends the message with them', async () => {
  const calls = [];
  const ops = {
    save: async (data, type, name) => { calls.push(['save', type, name, data.slice(0, data.indexOf(',') + 1)]); return { path: 'C:\\shots\\' + name, url: 'blob:' + name }; },
    send: (chat, text, saved) => { calls.push(['send', chat.id, text, saved.map(s => s.path)]); return true; },
  };
  const r = P.photoRoute(view, { type: 'chat.sendPhoto', chatId: 'chief', photos: [{ data: JPEG, type: 'image/jpeg', name: 'one' }, { data: JPEG, type: 'image/png' }] });
  r.chat.raw = r.chat;
  assert.deepEqual(await P.photoDo(r, ops), { ok: true });
  assert.deepEqual(calls, [
    ['save', 'image/jpeg', 'one.jpg', 'data:image/jpeg;base64,'],
    ['save', 'image/png', 'phone-photo-2.png', 'data:image/png;base64,'],
    ['send', 'dm:Nova', '', ['C:\\shots\\one.jpg', 'C:\\shots\\phone-photo-2.png']],
  ]);
});

test('photoDo stops when a save or the send fails', async () => {
  const r = P.photoRoute(view, { type: 'chat.sendPhoto', chatId: 'chief', photos: [{ data: JPEG, type: 'image/jpeg' }] });
  r.chat.raw = r.chat;
  let sent = false;
  assert.match((await P.photoDo(r, { save: async () => ({}), send: () => { sent = true; return true; } })).error, /couldn’t save/);
  assert.equal(sent, false);
  assert.match((await P.photoDo(r, { save: async () => ({ path: 'x' }), send: () => false })).error, /may be busy/);
  assert.match((await P.photoDo(r, null)).error, /can’t do that yet/);
  assert.deepEqual(await P.photoDo({ error: 'nope' }, {}), { ok: false, error: 'nope' });
});

test('the phone sees photos on messages, with a label when there are no words', () => {
  const msgs = L.phoneMessages([
    { id: 'a', who: 'Storm', kind: 'msg', text: '', photos: 1 },
    { id: 'b', who: 'Storm', kind: 'msg', text: '', photos: 2 },
    { id: 'c', who: 'Storm', kind: 'msg', text: 'Look at this', photos: 1 },
    { id: 'd', who: 'Storm', kind: 'msg', text: 'No photo' },
  ], () => null);
  assert.deepEqual(msgs.map(m => [m.text, m.photos]), [['📷 Photo', 1], ['📷 2 photos', 2], ['Look at this', 1], ['No photo', undefined]]);
});
