# The team's model from the phone

The Squall app can pick the model the team runs on, the same as the model chip on the computer.

State: `models = { current, choices: [{ id, name, note }] }`. `current` is `''` for "By role" (chiefs on Opus,
the rest on Sonnet, helpers on Haiku) or one model id for every bot. Each bot in `bots` may also have `model`: the model
it last ran on, so the phone can show what each teammate is really using.

Action: `team.model { model }`, where `model` is one of the choices' ids (`''` for By role). The answer is `{ ok: true }`
or `{ ok: false, error }`. The change applies to each teammate's next turn, the same as on the computer.

An older computer sends no `models` block, and the phone hides the picker.

Code: `SquallModels` in web/link.js (tested in tests/web/models.test.mjs) and `SquallModelOps` in web/app.js.
