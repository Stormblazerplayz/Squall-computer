# Problems and Done in the phone's Inbox

The phone's Inbox has four filters: All, Needs you, Problems and Done. Before this, Squall only sent approvals, so
Problems and Done were always empty. Now Squall keeps a short inbox log (`app.js`, the "Problems and Done" section) and
`web/link.js` (`phoneInboxLog`) adds it to `state.inbox` after the approvals.

**Problems.** A bot's error lands here: a failed run (`Nova: the run failed …`), `Couldn’t run Nova …`,
`Couldn’t reach Nova …` or `Nova has no Claude session …`. Squall's own window errors (a file too big to attach, a folder
that won't open) stay off the phone. The same error from the same bot within 10 minutes stays one item, moved to now, with a
count in its title. The full error goes in `details`, so the phone's **Details** button shows it.

**Done.** When a bot that Squall runs replies after a run that used tools, it counts as a finished job: the item says
`Nova finished a job`, with the first sentence of the reply, and **Open chat** opens that bot's chat. A plain answer with no
tools doesn't count. Bots that run in their own live sessions (the mirrored ones) don't add Done items yet.

**What the phone can do.** `inbox.read` and `inbox.readAll` mark items read, and `inbox.clear` hides an item. An approval still
can't be cleared: it needs Allow or Deny. Items are kept 2 days, 40 at most on the PC and 30 at most on the phone, in
`localStorage` (`squall.inboxLog`). Nothing is kept in the self-test or the mock team, so the phone only ever sees real errors and
real jobs.

Each item goes to the phone as:

```json
{ "id": "p…", "kind": "error", "botId": "quill", "title": "Quill hit a problem", "body": "The run failed.",
  "details": "Quill: The run failed. Exit 1", "unread": true, "at": "2026-11-25T08:30:00.000Z" }
{ "id": "d…", "kind": "done", "botId": "chief", "title": "Nova finished a job", "body": "The site is built.",
  "openLabel": "Open chat", "opens": "chat", "unread": false, "at": "2026-11-25T08:50:00.000Z" }
```
