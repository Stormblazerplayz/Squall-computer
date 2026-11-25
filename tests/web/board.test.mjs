// Tests for a bot's steps on the phone's Board and Mission control (bots[].log).
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const tool = (name, input, status) => ({ id: name + Math.random(), name, input, status: status || 'ok' });
function view(agents, extra) {
  return Object.assign({ agents, lead: 'Nova', chats: [], approvals: [], desktop: { current: '1.4.0', ready: null, busy: false } }, extra || {});
}

test('a working bot sends its run as short steps', () => {
  const quill = {
    name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'working', activity: 'Running npm test',
    turns: [
      { text: 'Looking.', tools: [tool('Read', { file_path: 'C:\\\\proj\\\\README.md' }), tool('Grep', { pattern: 'TODO' })] },
      { text: '', tools: [tool('Edit', { file_path: '/home/x/web/app.js' }), tool('Write', { file_path: 'notes.md' }), tool('Bash', { command: 'npm test\nnpm run lint' }, 'error')] },
      { text: '', tools: [tool('WebSearch', { query: 'swift charts' }), tool('WebFetch', { url: 'https://developer.apple.com/x' }), tool('mcp__github__create_issue', {})] },
    ],
  };
  const nova = { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'idle', activity: 'Ready', turns: [{ text: '', tools: [tool('Bash', { command: 'ls' })] }] };
  const bots = L.buildState(view([nova, quill])).bots;
  assert.deepEqual(bots.find(b => b.id === 'quill').log, [
    'Searched for TODO', 'Edited app.js', 'Wrote notes.md', '$ npm test', 'Searched the web for swift charts', 'Opened developer.apple.com', 'Used create issue',
  ].slice(-6));
  assert.equal('log' in bots.find(b => b.id === 'chief'), false);   // idle: nothing in progress
});

test('a waiting bot keeps its steps; odd tools still read well', () => {
  const pixel = {
    name: 'Pixel', color: '#E9573D', status: 'working', activity: 'x',
    turns: [{ text: '', tools: [tool('Task', { description: 'check the icons' }), tool('TodoWrite', {}), tool('Read', {}, 'error'), tool('', {}), tool('Bash', {})] }],
  };
  const st = L.buildState(view([{ name: 'Nova', lead: true, status: 'idle' }, pixel], { approvals: [{ requestId: 'r1', who: 'Pixel', tool: 'Bash', text: 'ok?' }] }));
  const b = st.bots.find(x => x.id === 'pixel');
  assert.equal(b.status, 'waiting');
  assert.deepEqual(b.log, ['Started a helper: check the icons', 'Updated its plan', 'Read a file (failed)', 'Ran a command']);
});

test('long commands are cut to one short line', () => {
  const a = { name: 'Nova', lead: true, status: 'working', turns: [{ text: '', tools: [tool('Bash', { command: 'echo ' + 'x'.repeat(300) })] }] };
  const [line] = L.buildState(view([a])).bots[0].log;
  assert.equal(line.length, 122);
  assert.ok(line.startsWith('$ echo ') && line.endsWith('…'));
});
