# Add teammate from the phone

`bot.add { name, role, color, prompt }` brings a new teammate to life, the same as **Bring to life** in Add teammate
on the computer: a new Claude session with its own memory and folder, which says hello in its chat.

- **name:** 2 to 20 letters and digits, starting with a letter, not already on the team. The team holds 12 at most.
- **role:** up to 60 characters (empty is a Generalist).
- **color:** `#RRGGBB`.
- **prompt:** what they do, up to 2,000 characters (empty is a generalist).

The reply is `{ ok: true, id }` with the new teammate's id. When this Squall can add teammates, the state has
`team.add = true` and `team.presets: [{ id, label, role, brief, color }]`, the same starting points as on the computer.

Code: `SquallAdd` in web/link.js and `window.SquallAddOps` in web/app.js. Tests: tests/web/add-teammate.test.mjs.
