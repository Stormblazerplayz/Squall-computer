# Work timers from the phone

The Squall app can start and stop a chat's work timer, the same as the timer dial on the computer.

State:
- `timers`: `[{ chatId, minutes, startedAt, until, paused }]`, one for each chat with a timer running. `minutes` and
  `until` are `null` for a Continuous timer. `chatId` is the phone's chat id (a bot id, `team` or a group id).
- `workFor`: the dial's length, `'off'`, `'inf'` or minutes.

Actions:
- `timer.start { chatId, minutes }`: `minutes` is 10 to 600, or `'inf'` for Continuous. Starts the timer in that chat the
  same as the dial's Done: an idle teammate gets the first nudge right away. A note in the chat says it came from the phone.
- `timer.stop { chatId }`: stops it, with the usual "Work timer stopped" note.

Goals need no new action: the phone sends `/goal <what>` as a normal message, which starts a Continuous timer on the
computer the same as typing it there, and `/goal done` ends it.

Code: `SquallTimers` in web/link.js (tested in tests/web/timers.test.mjs) and `SquallTimerOps` in web/app.js.
