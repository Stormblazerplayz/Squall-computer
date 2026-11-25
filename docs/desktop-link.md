# The phone link and auto-update in Squall.exe

`src/SquallLink` is everything Squall on the computer needs for:

1. **The Squall app on iPhone and iPad.** Pairing with a QR code, the phone API from
   [Squall-mobile `docs/pairing.md`](https://github.com/Stormblazerplayz/Squall-mobile/blob/main/docs/pairing.md),
   voice calls with Chief, and Settings > **Squall app (iPhone and iPad)** > **Pair a phone**.
2. **Updating itself from GitHub Releases.** Squall checks this repo's newest release, downloads
   `Squall-win-x64.zip`, checks its SHA-256, and when Storm presses **Update** (or Squall is idle), `SquallSwap.exe`
   swaps the files, starts the new Squall and rolls back if it doesn't start.
3. **Squall Uno (live computer use).** `src/SquallLink/Uno` runs Squall's agents on their own Linux computers in
   Docker, with the Claude computer-use tool, a live screen and a "WHAT IT DID" feed for the window and the phone.
   `SquallDesktopLink` creates it (`Uno`, folder `uno` in the link folder) and serves it to the phone; the contract
   for the window, the phone and the API lives in [docs/squall-uno.md](squall-uno.md).

The window half is `web/link.js`, which `web/app.js` wires up. Nothing is made up: the phone only ever sees Squall's real
bots, chats and approvals, and anything Squall can't do yet answers "Squall on the computer can't do that yet."

## Wiring it into Squall.exe (three steps)

The host project (`host/Squall.csproj`, the C# WebView2 app with `Mobile.cs`) isn't in this repo yet. Once it is:

1. Reference the library in `host/Squall.csproj`:

   ```xml
   <ItemGroup>
     <ProjectReference Include="..\src\SquallLink\SquallLink.csproj" />
   </ItemGroup>
   ```

2. Start it when the WebView is ready (on the UI thread):

   ```csharp
   using Squall.Link;

   private SquallDesktopLink? _link;

   private async Task StartLinkAsync()
   {
       _link = new SquallDesktopLink();
       var ui = SynchronizationContext.Current!;
       _link.AttachPage(json => ui.Post(_ => webView.CoreWebView2.PostWebMessageAsJson(json), null));
       _link.RequestExit = () => ui.Post(_ => Close(), null);   // however Squall closes itself
       await _link.StartAsync();
   }
   ```

3. In the handler for the page's bridge messages (`{id, cmd, args}`):

   ```csharp
   case "link":
       result = await _link!.HandlePageCommandAsync(args);   // args is the JsonElement; reply {id, ok: true, result}
       break;

   case "updateRestart":
       if (_link != null && _link.InstallUpdateIfReady()) break;   // a GitHub update is installing: Squall is closing
       // ... the old restart code stays here
       break;
   ```

   and `await _link.DisposeAsync()` when the window closes. An `ArgumentException` from `HandlePageCommandAsync` goes back
   to the page as `{id, ok: false, error}`, like any other failed command.

If the old phone page (`Mobile.cs`, `web/mobile.html`) also listens on port 47615, move one of them:
`new SquallDesktopLink(new LinkOptions { Port = 47616 })`. The phone reads the port from the QR code.

## What it keeps on the PC

`%LOCALAPPDATA%\Squall\link\`:

| File | What |
| --- | --- |
| `paired-phones.json` | Each paired phone's name and type, and only the SHA-256 of its token. |
| `computer.json` | This PC's id, so the phone knows it's the same computer. |
| `updates\` | Downloaded updates, the update log, and when it last checked. |

## Making a release

Push a tag (`git tag v1.4.0 && git push origin v1.4.0`) or run **Actions > Release > Run workflow**. The workflow runs
the tests, then `Build-Release.ps1`, and publishes `Squall-win-x64.zip` and its `.sha256`. A tag with `-beta.1` makes a
pre-release, which Squall skips. `team.json`, `state.json`, `window.json` and `workspace\` are never in the zip, and the
updater never overwrites them.

## Tests

```
dotnet test SquallLink.sln
node --test tests/web/*.test.mjs
```
