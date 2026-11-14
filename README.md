# Squall-computer

Squall for the computer: Storm's AI team app for Windows. The phone app is [Squall-mobile](https://github.com/Stormblazerplayz/Squall-mobile).

## What is in this repo

| Path | What it is |
| --- | --- |
| `web/` | The Squall window: the HTML, CSS and JavaScript that run inside a WebView2 host (`index.html`, `app.js`, `markdown.js` and the style sheets). |
| `web/mobile.html` | The page the host serves to a phone on the home Wi-Fi: pair, then see and send chats. |
| `team.json` | The team: each agent's role, prompt, allowed tools and memory, who leads, and the team rules. |

## What is not in this repo yet

- **The native host.** `Squall.exe` (C# and WebView2) opens the window, runs the bots through the Claude Code CLI and serves phone access (`Mobile.cs`, according to the comment in `web/mobile.html`). Its source was not on the PC this repo was pushed from, so it is not here. Add it when it is found.
- Binaries (`Squall.exe`, the WebView2 DLLs), the bots' `workspace/` folders, and Squall's runtime state and logs.
- `web/farside-demo.json`, the script behind the `/demo farside` command, because it holds private project notes. Without it that command answers that there is no demo.
- One project name and a local folder path in `web/app.js` were replaced with neutral text. The `FARSIDE` constant in the idle-bot section is a placeholder: set it to your own folder.

## Phone pairing

**Today** (from `web/app.js` and `web/mobile.html`): Settings, Phone, Turn on shows the PC's address and a 6-digit code that lasts 5 minutes. The phone's web page posts the code to `/api/pair` and keeps the token it gets back.

**What the iPhone and iPad app expects** is the newer v1 contract: a QR code holding `squall://pair?v=1&host=...&port=47615&code=...&name=...`, then `POST /api/v1/pair`, `GET /api/v1/hello` and `DELETE /api/v1/pair`. It is written down in [`docs/pairing.md`](https://github.com/Stormblazerplayz/Squall-mobile/blob/main/docs/pairing.md) in Squall-mobile. The desktop side of that contract, and the screen that shows the QR code, are not built yet.
