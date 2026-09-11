# Playtest — players who are not in the room

`PLAYTEST_TRANSPORT.md` is two tabs on this machine. This is the same game with real people on their own
machines, reached through an ngrok tunnel. Nothing touches Vercel and nothing is pushed.

---

## What is different, and why it is not just "add a tunnel"

**A tunnel hands out one origin.** The app is on :3000, the game server's WebSocket is on :8917 — two ports,
and a tunnel is one. Two tunnels would work and are the obvious thing to reach for, but they cost two URLs, a
second hostname baked into `.env.local`, and a mixed-content rule waiting to be tripped: a page served over
`https` **cannot** open a `ws://` socket to a machine that is not the viewer's own, and `127.0.0.1` on your
machine is not theirs.

So `server\playtest-proxy.js` puts both behind **one** port, 8918:

```
  /gs and below     ->  127.0.0.1:8917   the game server, WebSocket upgrade and all
  everything else   ->  the app
```

Node's standard library only — nothing to install, and it binds to `127.0.0.1`, so there is no Windows
firewall prompt and the game does not appear on your local network. The tunnel agent reaches it from
localhost because it runs here too.

**The app is served from `frontend\build`, not from the dev server**, and the reason is the meter. The free
plan gives **1 GB of transfer and 20,000 requests a month**. A CRA dev server ships an unminified bundle in
hundreds of requests per load; the production build is **~1 MB gzipped** in a handful of files with immutable
cache headers, so a reload costs nothing at all. That is the difference between a playtest and a playtest that
stops halfway through. `--dev` switches back to the dev server with hot reload for when you are fixing things
between rounds — see the bottom of this file.

---

## Once, ever

**Window: any.** ngrok is already installed here, by winget, as
`C:\Users\Bradshaw\AppData\Local\Microsoft\WindowsApps\ngrok.exe` -- which is on PATH, so the whole of the
install is checking that it answers:

```powershell
ngrok version
```

That must print a version. If it says *"is not recognized"*, ngrok is not installed after all:
`winget install ngrok.ngrok`, close the window, open a new one, and run `ngrok version` again -- **a new
window matters**, because PATH is read when the window opens and an install cannot reach back into one that
is already running.

Then, once:

```powershell
ngrok config add-authtoken 3J3ZRqQAjePpO0keBbDtMulMM5O_4C9rCPwHJmcK1h36sxVDP
```

> **PASTING MULTI-LINE POWERSHELL INTO THE CONSOLE DOES NOT WORK THE WAY IT LOOKS.** The console runs each
> line the moment it arrives, so an `if { }` on one line and its `elseif { }` on the next arrive as two
> separate commands and the second is answered with *"The term 'elseif' is not recognized"*. Nothing in this
> file spans lines for that reason. If you ever do need a block, put it in a `.ps1` file and run that, or
> keep `} elseif {` on the same line as the brace that closes the previous branch.

Check 8918 is free — **no output means free**:

```powershell
Get-NetTCPConnection -LocalPort 8918 -State Listen -ErrorAction SilentlyContinue
```

And, if you have not since the last `git pull`:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
npm install
```

---

## Every playtest

**Three PowerShell windows, and you open them yourself.** Each command below stays running and holds its
window until Ctrl+C. Windows key, type `powershell`, Enter — three times.

**The order matters exactly once:** the tunnel goes first, because its hostname is compiled *into* the
frontend and the build has to happen after you know it.

### Window 1 — the tunnel

```powershell
ngrok http 8918
```

Read the **Forwarding** line:

```
Forwarding   https://long-name-here.ngrok-free.app -> http://localhost:8918
```

Copy the host — `long-name-here.ngrok-free.app`, **without** `https://`. Leave this window alone.

It will complain that nothing is listening on 8918 yet. That is fine; nothing is, yet.

*Your account's domain is static, so after the first time this is the same host. If it has not changed, skip
the `.env.local` edit in step 2 and go straight to the build.*

### Window 2 — point the app at that host, then build it

Paste the host into the first line. **`$ngrokHost`, not `$host`** — `$host` is a reserved PowerShell variable
and assigning to it fails.

```powershell
$ngrokHost = 'PASTE-THE-HOST-HERE'
$envFile = 'C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend\.env.local'
(Get-Content $envFile) -replace '^REACT_APP_GAME_SERVER_URL=.*', "REACT_APP_GAME_SERVER_URL=wss://$ngrokHost/gs" | Set-Content $envFile -Encoding ascii
Select-String -Path $envFile -Pattern '^REACT_APP_'
```

The last line must print exactly two, and the first must end in `/gs`:

```
REACT_APP_GAME_SERVER_URL=wss://long-name-here.ngrok-free.app/gs
REACT_APP_BUILD_ID=dev
```

`wss`, not `ws` — the page is https and a plain `ws://` socket from it is blocked by the browser before it
reaches anything.

Then build. Two to four minutes, and warnings are normal:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend
npm run build
```

Wait for **`The build folder is ready to be deployed.`** `REACT_APP_*` is substituted at build time, so this
build *is* where the tunnel hostname lives. Any frontend change from here means building again.

### Window 2, same window — the game server

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
npm run build
node dist/server/src/start.js --insecure-local-identity --build dev
```

Expect:

```
1830 game server listening on ws://127.0.0.1:8917 (build "dev", INSECURE local identity)
  compiled <stamp> UTC -- if a fix you just made is not in this stamp, the server was not rebuilt
  rooms stored in ...\server\data -- one .log.jsonl per room
```

**Check the stamp.** Older than a fix you were told about means the server did not pick it up — `npm run
build` again. This window is now busy, which is correct.

`--build dev` must match `REACT_APP_BUILD_ID=dev` above; they are compared exactly and a mismatch is reported
as build skew rather than as a desync, which is the whole point of it.

### Window 3 — the proxy

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
node playtest-proxy.js
```

```
playtest proxy on http://127.0.0.1:8918
  /gs            -> 127.0.0.1:8917   game server
  everything else -> ...\frontend\build  (production build, gzipped)
```

Busy too. Three windows, all busy, and nothing left to type.

---

## Prove it before you invite anybody

**Thirty seconds, and it separates three faults that look identical from a player's chair.**

In a fourth window:

```powershell
Invoke-RestMethod -Uri "https://PASTE-THE-HOST-HERE/gs" -Headers @{"ngrok-skip-browser-warning"="1"}
```

That must answer **`1830 game server`**. If it does, the tunnel is up, the proxy is routing, and the game
server is alive — all three, in one line. If it times out or errors, stop here: no browser is going to help.

Then open `https://PASTE-THE-HOST-HERE` **on your phone with wifi off**. That is the only test that is
actually from outside your machine.

---

## The invitation

Send players the `https://` URL, and tell them two things:

- **ngrok shows a warning page first.** Click **Visit Site**. It appears once per browser.
- **One tab each.** Not a duplicated tab — seats live in `sessionStorage` (#528) and Chrome *copies* it into
  a duplicate, so both tabs would be the same player and every turn-authority check would pass for the wrong
  reason. This only really binds you: everyone else is on their own machine.

**Use the ngrok URL yourself too**, rather than `localhost`. One origin for everybody is one story to debug.

Then: you host a sandbox room and read out the code (`JUNO-4T2`); everybody else joins with it. The roster
comes from the game server (#1215), so Firestore is not needed for any of this.

### The line that proves each player is really connected

**Window 2**, one line per player, and the ids must all differ:

```
[INSECURE] accepted a self-declared identity "p-a1b2c3d4". Local play only -- see #1210.
```

Four players, four lines, four different ids. No line for someone means their browser never reached the
server, whatever their screen says.

---

## While you play

**Keep window 2 visible.** It prints a line for every action it does *not* apply, with the reason and the
indices. A button that does nothing is not a mystery any more: either there is a line and it says why, or
there is no line and the frame never left that player's browser. Those are different faults with different
fixes.

What to actually watch for is in `PLAYTEST_TRANSPORT.md` — the ten checks there are unchanged, and check 3
(both players acting in alternation, #1219's nonce collision) is worth more with real players than it ever
was with two tabs.

Two things will not work, and are not worth reporting:

- **Chat.** Still on Firestore (#644).
- **Reconnection.** If a player's socket drops they are stuck until they reload. Rooms survive a *server*
  restart now (#1250), so a reload does come back to the same game.

---

## Stopping

`Ctrl+C` in each of the three windows. **Close the tunnel when you are done** — see the next section for why.

## Between rounds, when you change something

- **Frontend change:** window 2 → `cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend` then
  `npm run build`. The proxy serves the new files immediately; players do a hard reload (`Ctrl+Shift+R`).
- **Server change:** `Ctrl+C` in window 2, then `npm run build` and the `node dist\...\start.js` line again.
  Check the compiled stamp.
- **Changing a lot, fast:** stop the proxy and start it as `node playtest-proxy.js --dev`, then run
  `npm start` in `frontend` in a fourth window. That serves the dev server through the tunnel, hot reload and
  all — but it is tens of megabytes per load against a 1 GB month, so switch back before real players arrive.

---

## The two things worth knowing

**`--insecure-local-identity` on a public URL.** Every client is believed about who it is (#1210). At a
kitchen table that is fine. On a URL anyone can reach, anyone who has the link can join a room and claim any
name in it. The link is unguessable and the game is a sandbox with no money in it — but the tunnel is not a
thing to leave running overnight, and the domain is static, so it is the *same* link tomorrow.

**The free plan's meter:** 1 GB out and 20,000 requests a month, 3 endpoints at once. The production build and
the immutable cache headers exist to keep a four-player evening in the low tens of megabytes. Source maps are
refused by the proxy on purpose — `main.js.map` is 15 MB, which is 1.5% of the month for one devtools window.
Debug against `localhost` on this machine instead.

---

## If something goes wrong

| What you see | Where it is |
|---|---|
| Browser: `ERR_NGROK_...` or the tunnel page errors | Window 1. The agent is down or the authtoken never landed. |
| `playtest-proxy: nothing answered on 127.0.0.1:8917` | Window 2. The game server is not running. |
| `no build at ...\frontend\build` | You skipped `npm run build`, or ran it somewhere else. |
| Page loads, but *"Could not reach the room — that action was not sent."* | The socket. Check `.env.local` says `wss://...**/gs**` — and that you rebuilt the frontend *after* editing it. |
| A player is on the board but window 2 never printed their `[INSECURE]` line | Their bundle is older than the fix. Hard reload. |
| *"It is not your turn."* when it is | Real, and a finding. Export the log. |

**Export the log** (`Ctrl+Shift+L`, host tab) and it can be replayed headless to the exact index:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
node dist/server/src/replayCli.js path\to\your-log.json
```

A note of **what you clicked and what you expected** is worth more than a description of the screen. The log
has the screen in it; it does not have your intent.

**To go back to two tabs on one machine:** put the `ws://127.0.0.1:8917` line back in `.env.local` and follow
`PLAYTEST_TRANSPORT.md`. Nothing here changed that path.
