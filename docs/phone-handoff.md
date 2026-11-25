# Hand offs on the phone

**Hand off.** On the phone, Team > a bot > Hand off sends the `handoff` action:
`{"botId": "quill", "job": "take_over" | "review" | "split", "note": "…"}`. Squall writes to the lead (Chief) in its chat, as
Storm: take over the bot's current work, review what it has done so far, or split it up across the team. The message
includes what the bot is doing now, its last message and Storm's note. A note in both chats says Storm handed the work over.
The bot itself isn't stopped: the lead decides what happens next. Chief can't hand work to itself.

**Mission control.** `state.handoffs` lists who handed work to whom in the last 2 days, newest first, 12 at most:
a lead's tasks in a team or group chat (the "assigned N tasks" note) and Storm's hand offs from the phone. Each one is
`{ "id", "from": botId, "to": botId, "what", "at" }`. It comes from Squall's own chat messages, so it's always real.
