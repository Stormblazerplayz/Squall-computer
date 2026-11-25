# Squall-computer

Squall for the computer: Storm's AI team app for Windows. The phone app is [Squall-mobile](https://github.com/Stormblazerplayz/Squall-mobile).

## What is in this repo

| Path | What it is |
| --- | --- |
| `web/` | The Squall window: the HTML, CSS and JavaScript that run inside a WebView2 host (`index.html`, `app.js`, `markdown.js` and the style sheets). |
| `web/mobile.html` | The page the host serves to a phone on the home Wi-Fi: pair, then see and send chats. |
| `src/SquallLink/` | The phone link (pairing, the phone API, voice) and the GitHub auto-updater, in C#. `src/SquallSwap/` is the small program that swaps in an update. |
| `web/link.js` | The window's half of the phone link, and the Pair a phone screen. |
| `web/uno.js` | The window's half of Squall Uno (each agent's own computer, live): the sidebar section and the live view. See [`docs/squall-uno.md`](docs/squall-uno.md). |
| `tests/` | Tests: `dotnet test SquallLink.sln` and `node --test tests/web/*.test.mjs`. |
| `team.json` | The team: each agent's role, prompt, allowed tools and memory, who leads, and the team rules. |

## What is not in this repo yet

- **The native host.** `Squall.exe` (C# and WebView2) opens the window, runs the bots through the Claude Code CLI and serves phone access (`Mobile.cs`, according to the comment in `web/mobile.html`). Its source was not on the PC this repo was pushed from, so it is not here. Add it as `host/Squall.csproj` when it is found: releases are built from it.
- Binaries (`Squall.exe`, the WebView2 DLLs), the bots' `workspace/` folders, and Squall's runtime state and logs.
- `web/farside-demo.json`, the script behind the `/demo farside` command, because it holds private project notes. Without it that command answers that there is no demo.
- One project name and a local folder path in `web/app.js` were replaced with neutral text. The `FARSIDE` constant in the idle-bot section is a placeholder: set it to your own folder.

## Phone pairing and updates

**The iPhone and iPad app** pairs with a QR code: Settings, Squall app (iPhone and iPad), Pair a phone. The phone side is
[Squall-mobile `docs/pairing.md`](https://github.com/Stormblazerplayz/Squall-mobile/blob/main/docs/pairing.md); the
computer side is `src/SquallLink` (C#) and `web/link.js`. Squall also updates itself from this repo's GitHub Releases.
How to wire both into `Squall.exe`, and how to make a release, is in [`docs/desktop-link.md`](docs/desktop-link.md).

**The older phone web page** (Settings, Phone, Turn on) still works the same way: the PC's address and a 6-digit code
for `web/mobile.html`.
