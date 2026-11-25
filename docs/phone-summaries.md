# Summaries and Catch up from the phone

Two actions let the phone ask for the same short Haiku summary the computer's **Summary** button writes:

- `summary.message { chatId, messageId }`: a short version of one teammate message of 500 characters or more.
- `summary.catchUp { chatId }`: a short version of the chat's latest messages (up to 30, events left out).

A summary can take longer than an action may, so the action only starts the job and answers `{ ok: true }`. At most two
run at once. The answer comes in the next state:

- the message gets `summary` (also shown under it on the computer, and kept for Squall's own messages);
- `state.summaries = { jobs: [{ chatId, messageId|null, state: "working"|"failed", error? }], catchUps: [{ chatId, text, at, upTo, count }] }`.

`upTo` is the phone's id of the newest message the catch up covers. A failed job stays listed for 2 minutes, a catch up for
12 hours. `state.summaries` is only sent when this Squall can summarize, so an older phone or computer just doesn't show it.

Code: `SquallSummaries` in web/link.js and `window.SquallSummaryOps` in web/app.js. Tests: tests/web/summaries.test.mjs.
