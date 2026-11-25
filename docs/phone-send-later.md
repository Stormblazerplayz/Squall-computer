# Send later, from the phone

Storm writes a message on the phone and picks when it goes. Squall on the computer keeps it and sends it then, the same as
typing it into that chat at that time.

## Actions

| Action | Fields | What happens |
| --- | --- | --- |
| `chat.sendLater` | `chatId`, `text`, `at` (ISO time) | Kept until `at`. The time must be 1 minute to 7 days ahead, and at most 30 can wait at once. |
| `chat.cancelLater` | `id` | Taken off the list. |
| `chat.sendLaterNow` | `id` | Sent right away and taken off the list. |

Errors are plain words for the phone to show, like "Pick a time at least a minute from now." or
"That message already went, or was canceled."

## State

`state.later` (left out when nothing waits): `[{ id, chatId, text, at }]`, soonest first. `chatId` is the phone's chat id (a
bot's id, or a group's id). The state's `version` covers it, so the phone redraws when the list changes.

## On the computer

- The list lives in the window's `localStorage` (`squall.sendLater`), so it lasts a restart.
- Squall checks every 15 seconds. A message is sent through the same path as the phone's `chat.send`.
- When a message is set, the chat gets a short note ("From your phone: a message is set to send 7:30 AM.").
- If Squall wasn't running at the time and the message is more than 12 hours late, it doesn't go. The chat gets a note
  saying so instead, because a day-old message would be confusing.
- If it can't be sent (Claude isn't signed in), the chat gets a note with the message.

Code: the "send later" section of `web/link.js`, tested in `tests/web/later.test.mjs`.
