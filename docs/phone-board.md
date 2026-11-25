# A bot's steps on the phone

While a bot works (or waits on Storm's OK), each bot in `state.bots` carries `log`: the steps of the run it's on, oldest
first, the last 6. The phone's Board shows them under **Steps**, and Mission control shows the last 3.

| The bot used | The line |
| --- | --- |
| Bash | `$ npm test` (the first line of the command) |
| Edit, MultiEdit, NotebookEdit / Write | `Edited app.js` / `Wrote notes.md` |
| Read | `Read README.md` |
| Grep, Glob | `Searched for TODO` |
| WebSearch / WebFetch | `Searched the web for …` / `Opened developer.apple.com` |
| Task | `Started a helper: …` |
| TodoWrite | `Updated its plan` |
| anything else | `Used …` |

A step that failed gets `(failed)`. When the bot is idle, `log` is left out. It comes from Squall's own runs (`a.turns` in
`app.js`, the same steps Squall's Live pane shows); a bot that runs in its own live session doesn't send steps this way yet.
