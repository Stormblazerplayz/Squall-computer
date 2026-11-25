# Squall Uno: live computer use

Squall Uno is Squall's own computer-using agent. Every Squall agent (Chief and each bot) gets **its own computer
inside Squall**: a small Linux desktop (Firefox, a taskbar, a terminal) running in a Docker container on the PC.
A Squall Uno session drives that computer with Claude's computer-use toolset, and you can watch it click and type
live, from the Squall window or from the phone. Nothing here touches the PC's own screen.

Everything below is real: frames come from the container's screen, events come from the actions Squall Uno really
ran. Nothing is made up when Docker or the API key is missing; the app says what is missing instead.

## What the PC needs

- **Docker Desktop**, installed and running. Squall builds the desktop image (`squall-uno-desktop:1`) from the
  `Uno/Desktop/` files shipped inside SquallLink the first time a computer starts (a few minutes, once).
- **An Anthropic API key**, either the user environment variable `SQUALL_UNO_KEY` (it wins when both are set), or
  saved from Squall's Uno settings (`uno/key.dat` in the Squall link folder, encrypted with Windows DPAPI for the
  current user). No answer ever contains the key; `settings.keyHint` shows its first 7 and last 4 characters.

## Ids and names

- `agentId`: the Squall agent the computer belongs to (`"chief"` for Chief, otherwise the bot id the app already
  uses). `agentName`: its display name ("Chief", "Scout").
- One computer per agent: `computerId` = `"pc-" + agentId` lower-cased with anything outside `[a-z0-9-]` turned
  into `-` (max 40 chars). Container name: `squall-uno-<computerId>`.
- Sessions: `sessionId` = `"uno-" + 12 hex chars`. One running session per computer at a time.

## Objects (JSON, camelCase; times are Unix milliseconds)

```jsonc
// Computer
{ "id": "pc-chief", "agentId": "chief", "agentName": "Chief", "name": "Chief's computer",
  "state": "off" | "starting" | "on" | "error",
  "stateText": "Setting up the computer. The first time takes a few minutes.",   // plain sentence, may be ""
  "width": 1280, "height": 800,
  "sessionId": "uno-…" | null,         // the session running on it right now
  "frameSeq": 42 }                     // newest frame number (0 = none yet)

// Session
{ "id": "uno-3f2a9c1b7d4e", "computerId": "pc-chief", "agentId": "chief", "agentName": "Chief",
  "task": "Find the weather in Paris",
  "state": "starting" | "running" | "paused" | "you" | "done" | "stopped" | "error",   // "paused" = waiting for Resume, "you" = the user has the wheel
  "startedAt": 1764000000000, "endedAt": null,
  "steps": 7,                          // tool calls run so far
  "now": "Clicking Search at (640, 120)",   // what it is doing right now (or last did)
  "lastText": "…",                     // newest thing Squall Uno said
  "error": null,
  "inputTokens": 12345, "outputTokens": 678 }

// Event (the "WHAT IT DID" feed). seq numbers are big and only go up (they start from the clock when Squall
// starts, so they keep growing across restarts): just pass the newest one back as `since`.
{ "seq": 101, "at": 1764000000000, "sessionId": "uno-…", "computerId": "pc-chief",
  "who": "uno" | "you" | "system",
  "kind": "start" | "screenshot" | "zoom" | "click" | "double_click" | "triple_click" | "right_click" |
          "middle_click" | "move" | "drag" | "mouse_down" | "mouse_up" | "type" | "key" | "hold_key" |
          "scroll" | "wait" | "cursor" | "say" | "message" | "pause" | "resume" | "takeover" | "handback" | "done" |
          "stopped" | "error",
  "text": "Clicked at (412, 230)",      // short plain sentence for the feed
  "x": 412, "y": 230,                  // optional, screen pixels (computer's width × height space)
  "x2": 600, "y2": 300,                // optional, end point of a drag
  "step": 3 }                          // optional

// Settings
{ "hasKey": true, "keySource": "env" | "saved" | "none", "keyHint": "sk-ant-…a1b2",
  "dockerReady": true, "dockerText": "Docker is running.",   // or what to do
  "imageReady": true,
  "model": "claude-opus-5-5", "maxSteps": 80,
  "tokensToday": { "input": 120000, "output": 4000 } }
```

## One request format, two ways in

The Squall window and the phone send the same **ops**. Each op is a JSON object with `op` plus its fields; the
answer is a JSON object. A failed op answers `{ "ok": false, "error": "<plain sentence>" }`.

- Window: `Bridge.call('link', { do: 'uno', op: '…', … })` → `SquallDesktopLink.HandlePageCommandAsync`.
- Phone: `POST /api/v1/uno` with the bearer token and body `{ "op": "…", … }`. Unknown token → 401 as usual. Every op
  answers HTTP 200 with the op's JSON (including `{ok:false, error}`); a body that isn't JSON with an `op` → 400
  `{ok:false, error}`.

| op | fields | answer |
|---|---|---|
| `state` | `since` (int, optional, default 0), `sessionId` (optional) | `{ ok, settings, computers[], sessions[] (newest first, max 30), events[] (seq > since, oldest first, max 300, only that session's if sessionId), lastSeq }` — pass `lastSeq` as the next `since` (when more than 300 are waiting it is the last one returned, so the next call gets the rest; a `since` bigger than anything Squall has, e.g. from before a restart, starts from the oldest kept event) |
| `start` | `agentId`, `agentName`, `task` | `{ ok, sessionId, computerId }` — starts the computer if needed, then the session |
| `message` | `sessionId`, `text` | `{ ok }` — follow-up; if the session ended it continues the same conversation, if it is running the text is given to Squall Uno before its next step (when paused: after Resume) |
| `stop` | `sessionId` | `{ ok }` |
| `stopAll` | – | `{ ok, stopped }` — stops every running session, paused ones too (computers stay on) |
| `pause` | `sessionId` | `{ ok }` — session state becomes `"paused"`: the step it is on finishes, then it waits before its next model call (no tokens meanwhile). Feed: `who: "you"`, `kind: "pause"`, "Paused by you." Already paused → `{ ok }`. Not running → `{ok:false, error:"That task isn't running, so there's nothing to pause."}`; while the user has the wheel → `{ok:false}` (hand it back first) |
| `resume` | `sessionId` | `{ ok }` — a paused session goes back to `"running"`; Squall Uno is told it was paused and takes a screenshot first. Feed: `kind: "resume"`, "Resumed." Not paused → `{ ok }`; not running → `{ok:false, error}`. Resuming while the user has the wheel (paused, then took over) means it carries on as soon as they hand back |
| `takeover` | `sessionId` | `{ ok }` — session state becomes `"you"`; Squall Uno waits after the action it is on. Works while paused too |
| `input` | `computerId`, `action` (`left_click`, `double_click`, `right_click`, `type`, `key`, `scroll`), `x`, `y` (clicks, scroll), `text` (type, key), `direction` (`up`/`down`, scroll), `amount` (scroll, optional, default 3) | `{ ok }` — only while that computer's session is `"you"` or no session is running; logged with `who: "you"`. `x`/`y` are in the computer's 1280×800 space; key names like `Return`, `ctrl+l` |
| `handback` | `sessionId`, `note` (optional) | `{ ok }` — Squall Uno gets a list of what you did plus the note, then carries on (if it was paused before you took over, it goes back to `"paused"` until `resume`) |
| `computerOff` | `computerId` | `{ ok }` — stops its session and removes the container |
| `saveKey` | `key` | `{ ok, settings }` |
| `removeKey` | – | `{ ok, settings }` |
| `check` | – | `{ ok, text, settings }` — asks Anthropic for the model's details (free) and checks Docker; `text` is plain sentences saying what works and what to fix |
| `setMaxSteps` | `value` (10–300) | `{ ok, settings }` |
| `watch` | `computerId` or null (window only) | `{ ok }` — the window gets live frames for that computer |
| `shots` | `sessionId` | `{ ok, sessionId, shots[] }` — that session's replay pictures (Shot objects, oldest first, no pictures in them) |
| `shot` | `sessionId`, `id` | `{ ok, shot }` — one Shot with `jpeg` (base64) added; `{ok:false}` once it isn't kept anymore |

### Live frames

- Phone: `GET /api/v1/uno/frame?computer=<id>&after=<seq>` (bearer token). Answers `200 image/jpeg` with headers
  `X-Uno-Frame: <seq>`, `X-Uno-Width`, `X-Uno-Height`, `X-Uno-Cursor: <x>,<y>`; `204` when there is no newer frame
  than `after` (wait ~250 ms and ask again); `404 {error:"no_computer"}` when the computer is off. Polling this
  keeps the computer's screen streaming (about 4 frames a second) for 15 seconds after the last request.
  Frame numbers are shared by all computers and only go up, so pass back the `X-Uno-Frame` you got; an `after`
  from another computer just gets that computer's newest frame. Screens are only captured while someone needs them
  (a running session, the window watching, or a phone that asked in the last 15 seconds).
- Window: after `watch`, the page gets pushes `{"event":"unoFrame","computerId","seq","width","height","cursorX","cursorY","jpeg":"<base64>"}`
  (see Pushes below), starting with the newest frame right away if there is one. `watch` with `computerId: null` stops.

### Replay pictures (the filmstrip)

While a session runs, Squall keeps real pictures of the screen so you can scrub back through it: every screenshot
Squall Uno takes, and the screen right after each click, drag, typing, key or scroll (the first live frame about
0.7 s later, or one picture taken when Squall Uno moves on sooner or the session ends). They live in memory only (gone
after Squall restarts): each session keeps its newest 120, and all sessions together stay under 64 MB, dropping the
oldest pictures of the session used longest ago first.

```jsonc
// Shot
{ "id": 1764000000123, "sessionId": "uno-…", "computerId": "pc-chief", "step": 4, "seq": 101,   // the event it shows
  "at": 1764000000000, "kind": "click", "text": "Clicked at (412, 230)",
  "width": 1280, "height": 800, "cursorX": 412, "cursorY": 230, "bytes": 84213 }
```

- Phone: `GET /api/v1/uno/shot?session=<sessionId>&id=<id>` (bearer token) answers `200 image/jpeg` with headers
  `X-Uno-Step`, `X-Uno-Width`, `X-Uno-Height`, `X-Uno-Cursor`, or `404 {error:"no_shot"}`. A kept picture never
  changes, so the phone may cache it.
- Window: the `shot` op, and a push for every new one (below).

**Save replay** (in the filmstrip's header and in the replay bar) saves the shown task's pictures as one animated
GIF, made entirely in the window by `web/gif.js` (no host op, nothing uploaded): each kept picture becomes a frame,
scaled to at most 800 px wide, with the pointer ring and a caption strip (`Step 7 · Clicked at (412, 230)`, and
`7 of 12`). Frames show for 0.9 s, the last for 2.5 s, and the GIF loops. Each frame has its own palette of its 255
most used colors, and after the first only the part that changed is written, which keeps it small. The button shows
`Making GIF… 4/12` while it works, then the file downloads as `squall-uno-<agent>-<yyyy-mm-dd-hhmm>.gif` (when the
task started, local time). Pictures that aren't kept anymore are left out, and the window says how many.

### Big screen

The live screen's **Big screen** button (top-right of the screen) makes the live view fill the window: a class on
the view, not the browser's full screen, so the rest of Squall stays where it was. The header, the status line and
the buttons (Pause / Resume, Stop, Take the wheel…) stay; the feed, the filmstrip and the task box are tucked away.
**Esc** or **Exit big screen** leaves it. In it:

- **Ctrl + mouse wheel** (or a trackpad pinch) zooms from 1x to 4x around the pointer; the `2.5×` chip next to the
  button goes back to 1x.
- **Drag** moves around while zoomed in. The picture can't be dragged off the screen.
- **Double-click** zooms to 2.5x on that spot, or back to 1x. While you have the wheel a double-click is two clicks on
  the computer instead, so use Ctrl + wheel to zoom then.

Clicks still only reach the computer while you have the wheel, at the computer pixel under the pointer however far
it's zoomed; a drag that moved the picture isn't a click. The picture, mouse, ripples and motion zoom together. No new
ops: it's the same `watch` and frame pushes as the live view. The math (`clampZoom`, `clampPan`, `zoomAt`, `wheelZoom`,
`toggleZoom`, `panBy`, `zoomedDisplayToScreen`) is in `web/uno.js` and tested in `tests/web/uno.test.mjs`.

### Pushes to the window

These use the existing `Page.Tell(name, payload)`, which posts `{"event": name, ...payload}` to the page (the same
shape as `linkPhones` and `linkUpdate`; web/app.js hands it to `Bridge.on(name, m => …)`). Because the key `event`
carries the name, no payload has a key called `event`:

- `{"event":"uno","ev":{…Event}}` for every event (the Event object is under `ev`).
- `{"event":"unoState","computers":[…],"sessions":[…],"settings":{…}}` whenever a computer, session or setting
  changes (sessions newest first, max 30).
- `{"event":"unoFrame","computerId","seq","width","height","cursorX","cursorY","jpeg":"<base64>"}` for each new
  frame of the computer the window watches (see `watch`).
- `{"event":"unoShot","shot":{…Shot}}` for every new replay picture (without the picture; get it with `shot`).

## How a session runs

1. The computer starts (`docker run`) if it is off, and the image is built first if needed.
2. Squall Uno calls the Messages API (`claude-opus-5-5`, adaptive thinking, the `computer_toolset_20260801`
   toolset) with a system prompt that says it is **Squall Uno**, working for the agent on its own computer.
3. Each `tool_use` (member names like `left_click`, `type`, `screenshot`, …) runs inside the container with
   `xdotool` / ImageMagick, gets logged as an Event, and answers with a `tool_result` that echoes
   `toolset_name: "computer"` (a JPEG for `screenshot` / `zoom`, `"OK"` otherwise).
4. It stops when the model ends its turn (`done`), the user stops it (`stopped`), it hits `maxSteps` model turns
   (`error`, "Squall Uno took 80 steps and stopped before it finished. …"; a `message` lets it keep going), or an
   error happens (`error`, with a plain sentence). A refusal ends with `error` too.
5. While the user has the wheel (`takeover`), Squall Uno skips the rest of the actions it was given and waits before
   its next model call; `handback` gives it a list of what the user did plus their note.
6. `pause` works the same way without giving the user the computer: the action running right now finishes, the rest of
   that turn's actions answer "Not done: the user paused you…", and no model call (so no tokens) happens until
   `resume`, which also tells Squall Uno to take a fresh screenshot. A paused task is still active: it keeps its
   computer (on, and its screen still streams), the computer stays busy for new tasks, and `stop`, `stopAll`,
   `takeover`, `message` and `computerOff` all work. The step limit counts model turns, so a pause never uses any of
   it. There is no idle timer or time limit on tasks and Squall never turns a computer off by itself while a task holds
   it, so a paused task waits as long as it takes; closing Squall stops it like any running task (it comes back as
   `stopped`).
7. A `message` to an ended session continues the same conversation. Conversations live in memory (the 10 newest
   ended ones are kept); after a restart Squall Uno starts fresh with the old task as a reminder and the feed says so.
8. Sessions and settings are kept in `uno/state.json` (no screenshots, no key). Sessions running when Squall closed
   come back as `stopped`. Closing Squall stops (doesn't delete) the computers; `computerOff` removes one for good.
