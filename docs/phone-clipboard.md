# Shared clipboard from the phone

- `clip.send { text }`: puts text on the computer's clipboard (20,000 characters at most).
- `clip.get`: reads the computer's clipboard. The text comes in the next state as `state.clipboard { text, at, cut }`.
- `clip.clear`: forgets what was read.

The computer's clipboard is only read when the phone asks, and the text leaves the state after 2 minutes or on
`clip.clear`. `state.clipboard` is `{}` when nothing was asked for, so the phone can tell this computer has the feature.
Text only.

Code: `SquallClip` in web/link.js and `window.SquallClipOps` in web/app.js. Tests: tests/web/clipboard.test.mjs.
