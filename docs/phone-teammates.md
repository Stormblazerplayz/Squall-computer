# Manage teammates from the phone

The Squall app's Manage teammate sheet can rename a teammate, make it a chief or take that away, and remove it from the team. Squall on the computer does each one with the same checks as the right-click menu here.

## State

- `bots[].chief: true` for every chief (up to 4).
- `team: { size, max: 12, chiefs, maxChiefs: 4, manage }`. `manage` is true when this Squall can do the actions below, so an older computer never shows the buttons.

## Actions

| Action | Fields | Notes |
| --- | --- | --- |
| `bot.rename` | `botId`, `name` | 2 to 20 letters and digits, starting with a letter, not already on the team. The reply has the teammate's new `id`. |
| `bot.chief` | `botId`, `on` (true or false) | At least 1 and at most 4 chiefs. |
| `bot.remove` | `botId`, `confirm` | `confirm` is the name the phone showed, so a screen opened before the team changed can't remove the wrong one. The only chief can't be removed. Its chats and routines go; its folder stays. |

A teammate that's working right now can't be renamed or removed until it's done. A rename or a remove reloads the window a moment later (like New teammate from the phone), after the phone has its answer.

## Where it lives

- `web/link.js`: `teamRoute`, `teamDo` and `withTeam` (tested in `tests/web/team-manage.test.mjs`).
- `web/app.js`: `phoneRenameBot`, `phoneRemoveBot` and `phoneSetChief`, shared as `window.SquallTeamOps`.
