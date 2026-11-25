# Notes on the phone

The Squall app can search the Obsidian vault, read a note and add text to the end of one, the same as the vault window here. Nothing is removed or overwritten.

## How it talks

The phone sends an action; the answer comes in the next state as `notes`, so nothing new is needed in the phone API.

| Action | Fields | Does |
| --- | --- | --- |
| `notes.search` | `query` | Searches names and text. An empty `query` lists every note by path. |
| `notes.open` | `path` | Reads a note. |
| `notes.append` | `path`, `text` | Adds `text` (2,000 characters at most) to the end, then reads the note again. |
| `notes.close` | | Closes the open note and keeps the list. |

```
"notes": {
  "query": "squall",
  "results": [{ "path": "Projects/Squall.md", "name": "Squall", "snippet": "..." }],
  "note": { "path": "Projects/Squall.md", "name": "Squall", "text": "# Squall ...", "cut": false }
}
```

- At most 40 results. A note's text is cut at 20,000 characters (`cut: true`).
- Only a note the computer listed for the phone can be opened or added to.
- `notes` leaves the state 10 minutes after the phone last asked, so it doesn't ride along forever.

## Where it lives

- `web/link.js`: `notesRoute`, `noteRows`, `notesDesk` and `withNotes` (tests in `tests/web/notes.test.mjs`).
- `web/app.js`: `window.SquallNotesOps` (vaultSearch, vaultRead, vaultAppend, vaultGraph).
