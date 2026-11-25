# Manage teammates from the phone

The Squall app's Manage teammate sheet can rename a teammate, make it a chief or take that away, pick the project it works in, and remove it from the team. Squall on the computer does each one with the same checks as the right-click menu here.

## State

- `bots[].chief: true` for every chief (up to 4).
- `bots[].project`: the project the teammate works in (a folder under Documents\Projects, or the folder's own name when it's somewhere else). Left out when it works across all of Projects.
- `team: { size, max: 12, chiefs, maxChiefs: 4, manage, projects }`. `projects` is the list of project names, read from the computer when the window opens and every minute after. `manage` is true when this Squall can do the actions below, so an older computer never shows the buttons.

## Actions

| Action | Fields | Notes |
| --- | --- | --- |
| `bot.rename` | `botId`, `name` | 2 to 20 letters and digits, starting with a letter, not already on the team. The reply has the teammate's new `id`. |
| `bot.chief` | `botId`, `on` (true or false) | At least 1 and at most 4 chiefs. |
| `bot.project` | `botId`, `project` | A name from `team.projects`, or `""` for all of Projects. Used from the teammate's next run, in a new conversation there. |
| `bot.remove` | `botId`, `confirm` | `confirm` is the name the phone showed, so a screen opened before the team changed can't remove the wrong one. The only chief can't be removed. Its chats and routines go; its folder stays. |

A teammate that's working right now can't be renamed or removed until it's done. A rename or a remove reloads the window a moment later (like New teammate from the phone), after the phone has its answer.

## Where it lives

- `web/link.js`: `teamRoute`, `teamDo`, `withTeam` and `projectCache` (tested in `tests/web/team-manage.test.mjs`).
- `web/app.js`: `phoneRenameBot`, `phoneRemoveBot`, `phoneSetChief`, `phoneProjects` and `phoneSetFolder`, shared as `window.SquallTeamOps`.
