# Playtest — the server transport

First time the game runs against the Node server instead of Firestore. Everything here is local; nothing
touches Vercel, and no push is needed.

---

## Setup

**You need two PowerShell windows, and you open them yourself** — nothing below opens a window for you.
The reason for two is that each of these commands *stays running* and holds its window until you press
Ctrl+C. "Window 1" and "Window 2" are labels for windows you have opened, not commands.

To open one: press the Windows key, type `powershell`, press Enter. Do that twice.

### Step 1 — first time only (either window)

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
npm install
```

### Step 2 — window 1, the server

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
npm run build
node dist/server/src/start.js --insecure-local-identity --build dev
```

Expect two lines:

```
1830 game server listening on ws://127.0.0.1:8917 (build "dev", INSECURE local identity)
  compiled 2026-09-07 00:51:41 UTC -- if a fix you just made is not in this stamp, the server was not rebuilt
```

**Check the stamp after every fix.** If it is older than the change you were told about, the server did not
pick it up — `npm run build` again. A fix to anything under `frontend\src\utils` runs on the server too, and
the browser recompiling itself says nothing about the server.

That window is now **busy** — no new prompt appears, and that is correct. Leave it alone.

If it says **"Refusing to start"**, the flag is missing. That refusal is deliberate — the server will not
invent an identity checker for you.

### Step 3 — window 2, the client

A **second** PowerShell window:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend
npm start
```

`frontend\.env.local` already points it at the server. Nothing to type.

This window is busy too, and a browser tab opens on its own after a few seconds.

**If it says something is already running on port 3000, answer `n`.** A second dev server is not what you
want. But the one already running may have been started *before* `.env.local` existed — CRA reads env files
only at startup — in which case it is quietly still on Firestore. Find its window, `Ctrl+C`, `npm start`
again. If you cannot find the window:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ }
```

(By port, not by name — `Stop-Process -Name node` would kill the game server too.)

### Step 4 — two tabs, one room

**Both tabs are `http://localhost:3000`. Not Vercel** — Vercel has no `.env.local` and cannot reach
`127.0.0.1` on your machine, so it would be a normal Firestore game wearing the same clothes.

**Open the second tab by typing the URL, not by duplicating the first.** Seats are kept in `sessionStorage`
(#528), and Chrome *copies* sessionStorage into a duplicated tab — both tabs would be the same player, and
every turn-authority check below would pass for the wrong reason.

Then: **tab 1 hosts** a sandbox room and gets a code like `JUNO-4T2`; **tab 2 joins** with that code.

The roster now comes from the game server too (#1215), so **Firestore is not needed for any of this**. It
was, until a Firestore outage stopped a playtest dead: "Host game" awaited a write that never landed and the
button simply did nothing.

### The one line that proves it is really on the server

Watch **window 1**. Each tab that connects prints:

```
[INSECURE] accepted a self-declared identity "p-a1b2c3d4". Local play only -- see #1210.
```

**Two tabs, two lines, two different ids.** If no line appears, the browser is still on Firestore and
nothing below is being tested. If both ids are the same, you duplicated the tab.

### Stopping

`Ctrl+C` in each window.

### Restarting the server after a code change

`Ctrl+C` in the SERVER window, then:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
npm run build
node dist/server/src/start.js --insecure-local-identity --build dev
```

The APP window needs nothing — it recompiles on its own.

**Press Enter after the last line.** Pasting several lines runs all but the last; the last one sits at the
prompt waiting, and the window looks like it stopped.

---

## Running the test suite

**The short way** — runs everything, then prints only each failing test with its first lines, and the totals:

```powershell
& C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend\test-summary.ps1
```

Add `-Lines 20` for more of each failure. The full output is always in `frontend\test-output.txt`.

**The long way**, if you want the raw run:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend
npm test -- --watchAll=false 2>&1 | ForEach-Object { "$_" } | Tee-Object test-output.txt | Select-Object -Last 25
```

`--watchAll=false` is what makes it exit instead of sitting in watch mode; `CI=true npm test` is bash syntax
and does nothing here. `ForEach-Object { "$_" }` is what stops the output printing red — **Jest writes even
its success summary to stderr**, and PowerShell paints redirected stderr red whatever it says.

Just the verdict, from the saved file:

```powershell
Select-String -Path C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend\test-output.txt -Pattern "^(Tests|Test Suites):"
```

The first two failure blocks, if there are any:

```powershell
Select-String -Path C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend\test-output.txt -Pattern "^\s*●" -Context 0,14 | Select-Object -First 2
```

---

## Prove the server alone

Worth thirty seconds, because it separates *"the server is broken"* from *"the browser cannot talk to it"* —
and those have completely different fixes.

Run it **before** step 2, in the same window; or at any time later in a third window — it starts its own
server on a port the operating system picks, so it does not fight with the one you have running.

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
npm run smoke
```

Thirteen `ok` lines and `SMOKE PASSED`. If this fails, stop — the browser will not help.

---

## What to check

**Keep the SERVER window where you can see it.** It now prints a line for every action it does *not* apply —
the reason and the indices. A button that does nothing is no longer a mystery: either there is a line, and it
says why, or there is no line and the frame never left the browser. Those are different faults.

Roughly in order of how much it would cost to find out later.

### 1. One auto-skip, not two — **the one I would most like checked**

Get a corporation to a step it cannot act on: a trainless one reaching **Run Routes**, or one at its train
limit reaching **Buy Trains**.

- **Right:** one "Skipped…" line, one step advanced.
- **Wrong:** the same line twice, or a share price moving two cells on a forced withhold.

*Why it matters:* the game's own actions used to be sent by your browser and are now generated by the server.
If both do it, everything automatic happens twice. This is #774's old two-cells-rather-than-one bug arriving
through a new door — and it is the one remaining trap in the cutover that has never been exercised.

### 2. Every phase transition, in one full game

The whole family that was refused one button at a time (#1220) — none of them is a seat's move, and each was
broken separately until the class was named:

- **Proceed to Stock Round** (`OpenStockRound`)
- **the par-price step that closes the auction** (`SetBoPar`)
- **placing a home station** when a corporation floats (`PlaceHomeStation`)
- **exchanging a private for a share** — and specifically *between other players' turns*, which is the M&H's
  own right (`ExchangePrivate`)
- **Undo** (`RevertTo`)

If any of these does nothing, the server window will say which and why. That line is worth more than a
description of the screen.

### 3. Both players can act, in alternation

Play several turns back and forth rather than a run of moves by one player.

*Why:* every client's nonce counter used to start at the same value, so the second player's first move
collided with the host's first move and was silently answered as "already made" (#1219). Alternating is what
exercises it; a run of moves by one player would not have found it.

### 4. Both tabs see the same game

Act in tab A. Tab B should show it without being touched.

- **Wrong:** B never updates; B updates but the boards differ; B shows a *different* corporation acting.

### 5. Out-of-turn is refused, and says so

In the tab whose turn it is **not**, try an ordinary move — buy a share, run a route, pass.

- **Right:** *"It is not your turn."*
- **Wrong:** it goes through; or the message is wrong for the case — in an **Operating Round the turn belongs
  to the operating corporation's president**, not to whoever's seat is highlighted.

Note this must be a *move*. The transitions in check 2 are deliberately allowed from any seat.

### 6. A negotiation still works off-turn

Offer a private company or a train from one tab; answer from the other.

- **Right:** the owner / selling president can answer while somebody else is on turn.
- **Wrong:** *"It is not your turn."* — the exemption that makes trading possible has broken. This is the one
  place where the ordering inside the turn gate matters, so it is worth doing deliberately.

### 7. The error bar says something useful

When something is refused, read the message at the top.

- **Right:** the server's own sentence — *"It is not your turn."*, a build mismatch, or *"The room had moved
  on — this tab has caught up."*
- **Wrong:** *"Could not reach the room — that action was not sent."* That generic line should now appear
  **only** when the socket is genuinely down. If you see it while the server window is happy, tell me — it
  means a fourth failure path is still silent.

### 8. The chart still moves for the right reasons

- a **dividend paid** (price rises), a **withhold** (falls), a **share sale** (falls);
- a **Stock Round ending with a corporation sold out** — its price should rise once.

Watch the Activity Log's wording too: a withheld dividend must not be described as a share sale.

### 9. The D&H power survives a reload

Lay **F16 using the D&H's power**, then reload the tab (`Ctrl+Shift+R` — it keeps your seat deliberately).

- **Right:** the free station still shows as spent.
- **Wrong:** it comes back available — that is the bug #1204 was meant to close.

### 10. The log is clean

`Ctrl+Shift+L` (host tab). In the JSON: `duplicateIndices` should be `[]` and `index` should run 0,1,2,…
with no gaps or repeats. The server allocates these now.

---


## Not broken — just not built yet

Please do not report these:

- **Chat does not work.** It is the one thing still on Firestore (#644), and Firestore is unreachable. Not
  worth its own transport today; it degrades quietly rather than breaking the game.
- **Restarting the server empties the room.** The log store is not wired up; rooms are in memory. The roster
  goes with it — same reason, same fix later.
- **No reconnection.** If the socket drops, that tab is stuck until you reload. Deliberate — resilience comes
  after the happy path is proven.
- **Any client can claim any name.** That is what `--insecure-local-identity` means.
- **`Ctrl+Shift+L` only works for the host.** Known, unrelated, and on the list.

---

## If something goes wrong

**Export the log** (`Ctrl+Shift+L`) and send it. That is the whole point of the last few weeks — I can replay
it headless and find the exact index where it went wrong:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\server
node dist/server/src/replayCli.js path\to\your-log.json
```

A note of **what you clicked and what you expected** is worth more than a description of what the screen
looked like — the log has the screen in it, and it does not have your intent.

**To go back to Firestore at any point:** put a `#` in front of `REACT_APP_GAME_SERVER_URL` in
`frontend\.env.local` and restart `npm start`. That path is untouched, so if a bug appears on the server and
not on Firestore, the transport is the difference.
