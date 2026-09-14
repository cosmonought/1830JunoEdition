# Batch 4.5 — Authoritative rules-version pinning and the replay-compatibility boundary

Date: 2026-09-14. Design note **#1520**. Baseline (post-Batch-4, user-validated): 350 suites / 5386 tests.
Full suite after this batch (user-validated): 351 suites / 5401 tests, all green.

> **`RULES_ENGINE_VERSION = 1` is the post-Batch-4 reducer.** Version 1 names the semantics of the reducer as
> it stands after Batch 3 (operating-corporation identity, station legality) and Batch 4 (train availability
> with the Bank Pool, the mandatory-purchase gate, discards to the pool). Any future change that alters what a
> stored gameplay log replays to — a refusal an old log would now meet, a state field an old log would now
> produce differently — **must deliberately bump this constant in `frontend/src/gameEngine/rulesVersion.ts`
> and add a line to `RULES_ENGINE_CHANGELOG` saying why.** The number never moves on its own; nothing derives
> it from a build or a commit. UI, protocol and narration changes do not bump it.
>
> **`--legacy-logs development-corpus` is a development compatibility mechanism only.** It exists so the
> pre-pin playtest rooms under `server/data/` and the export/fixture corpus can still be replayed locally. It
> must not become the normal production restore policy: a deployment starts without it, and an unpinned room
> is held there, not reinterpreted.

## 1. Three identities, kept apart

| Identity | Where | Who writes it | Changes when | What it answers |
|---|---|---|---|---|
| **Client build** | `CLIENT_BUILD_ID` (client), `--build` / `BUILD_ID` (server), `SetupGame.build` (deal-build pin #1252) | the client (deal); each process (its own) | every deployment, CSS-only ones included; `"dev"` on both sides in practice | `build-skew` (#1206): may these two talk. Deal-build pin: may this server keep *appending* to this room. |
| **Rules revision** `variants.rules` (#1443) | the deal's variants | the client | when a house rule is changed at a table | a switch the reducer *branches on* (`sellBuySellInForce`); every value supported at once. Not a compatibility boundary. |
| **Rules-engine version** `SetupGame.rules_engine_version` (**new**) | the deal's payload | **the server**, over whatever the client sent | only when a deployment changes what stored logs *mean*; bumped by hand, with a changelog line | whether this engine may *rebuild* this log at all. |

## 2. Origin (Part 1 inventory)

`SetupGame.build` originates **client-side** (`App.tsx` 11558/11571: `build: CLIENT_BUILD_ID`, default `"dev"`). The server never stamps it; `RoomSession.submit` only refuses a deal whose build is not the server's own and, on later moves, refuses when `dealtBuild() !== options.build`. That check runs in `submit` — i.e. *after* `roomFor` → `restore` → `rebuild` has already replayed the whole log under the running reducer. So the deal-build pin prevented further moves, never reinterpretation; and with both sides on `"dev"` it never fired. All 17 stored logs say `build: "dev"` or carry no build.

`rules_engine_version` originates in `RoomSession.submit` step 6: `stampRulesEngineVersion` replaces any client value with `RULES_ENGINE_VERSION` before `mintLogEntry`. The client's number (999, 0, −1) is overwritten; a non-integer claim is refused at the server's schema door (`int?`) before the session is reached. Proven at the session level (test 2) and end-to-end through the compiled server over a websocket (scratch e2e: client sent 999, disk holds 1).

## 3. Persistence

The pin lives *inside the log*: in the `SetupGame` entry's canonical-JSON payload, in `server/data/<code>.log.jsonl` (via `createFileLogStore`), in every export (`sandbox-log-*.json`), in every fixture. It is read from the **effective** log (`effectiveActions`), so a reverted deal pins nothing and the next deal pins afresh. Nothing is stored beside the log; nothing can be separated from it.

## 4. Every check point

| Rebuild path | Where the boundary is asked | Result if refused |
|---|---|---|
| Server restart / first load (`gameServer.roomFor` → `RoomSession.restore` → `rebuild`) | `rebuild()`, before the first `RoomEngine.apply` | room held: seeded engine, `incompatibility` set, warning logged once |
| `RevertTo` (= rebuild, #1233) | same `rebuild()` | a held room never reaches it (`submit` answers `incompatible` first); a live room re-checks on every revert |
| `discardAfter` (store rejected an append) | same `rebuild()` | same |
| `replayLog()` — CLI, golden/replay tests | first line of `replayLog`, before `new RoomEngine`'s first `apply` | throws `ReplayIncompatibleError` |
| `submit` on a held room | step 1a, right after build-skew, before the deal-build pin, nonce, staleness, `settleOwed` | `incompatible` frame; nothing appended |
| `catchUp` on a held room (every hello / reconnect) | first line | `incompatible` frame; no entries handed out |
| Live reconnect to an in-memory room | **not asked** — `catchUp` rebuilds nothing | — |
| Client-side `gameHistory.ts` / `roundReplay.ts` (`new RoomEngine` directly) | not asked — they replay entries the server already handed out under build-skew equality | — |

Under refusal the log array is not touched, not re-serialised, not appended, and the file on disk is byte-for-byte what was loaded (e2e check). No alternate board is built: the engine stays at its seed, which is the state "nothing has been interpreted".

## 5. The four lifecycle cases

- **A. Live in-memory reconnect.** `roomFor` returns the existing session; hello → `catchUp` → `catch-up` frame. No rebuild, no compatibility check, no new failure. A frontend build change alone is still only `build-skew` (#1206) — unchanged.
- **B. Server restart, same rules version.** `restore` → `rebuild` finds `compatible {1}` → replays → identical digest (test 3, e2e (b)). A different *server build* with the same rules version still rebuilds; the deal-build pin (#1252) then refuses further moves with `refused`, exactly as before — not `incompatible` (test 9).
- **C. New deployment carrying a different `SUPPORTED_RULES_ENGINE_VERSIONS` loads an old game.** `rebuild` finds `incompatible {v, supported}` → **held**: no `apply`, no append, no rewrite, warning at restore; every hello answers `incompatible {reason, pinnedRulesEngineVersion, supportedRulesEngineVersions, build}`; every submit (moves, deals, `RevertTo`, retried nonces) answers the same; the client shows the sentence and closes the link for good (reconnecting cannot change the answer). Recovery = a server that carries the pinned version. Same holds for a legacy log under the server policy, with `pinnedRulesEngineVersion: null`.
- **D. `RevertTo`.** Rebuilds through the same `rebuild()`, under the same engine; the deal entry is not touched so the pin survives (test 4: digest after revert equals digest after the deal, pin still 1). Nothing "upgrades": a revert on a held room is refused before it is appended; on a live room the re-check sees the same pin.

## 6. Legacy policy (explicit, visible, tested)

A missing or non-integer `rules_engine_version` is **`legacy`**, never "current" (`rulesEngineVersionOf` → `null`; `replayCompatibility` → `{kind:"legacy"}`). What to do with it is a stated `ReplayPolicy`:

- `SERVER_REPLAY_POLICY = { legacyLogs: "refuse" }` — default of `replayLog`, `RoomSession`, and `createGameServer`. A legacy room is held.
- `DEVELOPMENT_CORPUS_POLICY = { legacyLogs: "development-corpus" }` — passed **by name** in `replayGolden.test.ts`, `replayJunoCV4.test.ts`, `replayJuno3XD.test.ts` (with a comment saying why) and by `server/src/replayCli.ts` (which prints a `LEGACY LOG` banner on stderr). Also reachable for a **local** server: `start.ts --legacy-logs development-corpus` (or `LEGACY_LOGS=…`); any other value refuses to start; the startup line and a per-room warning say legacy rooms are being admitted.
- A deal pinned to a **foreign** version is refused under *every* policy (test "opt-in admits legacy only", e2e (e)). The opt-in admits the unpinned, never the differently pinned.
- Newly dealt rooms are always pinned (tests 1–2; e2e (a)).

**Design choice to flag:** with the default policy, the eight rooms currently in `server/data/` (all legacy) will be *held* by the next server you start, and players will see the incompatibility sentence. Start the local server with `--legacy-logs development-corpus` to keep playtesting them; a deployment should not. I did not migrate or re-pin any stored log.

## 7. What the user and the server see

- **Server log at restore:** `  <code> is HELD, not rebuilt: pinned rules-engine version 999, this server supports [1] (#1520). <reason>` — or for legacy: `pinned rules-engine version none (legacy)`. Under the opt-in: `  <code> is a LEGACY room … admitted under --legacy-logs development-corpus …`. Startup line now prints `rules engine version 1 (supports [1])` and the legacy policy in force.
- **Server log per refused frame:** the existing #1218 line: `  incompatible: p-bob sent WaterfallBuyLowest — <reason>`.
- **Wire:** new `ServerMessage` kind `incompatible` (`utils/serverProtocol.ts`).
- **Client (`serverLink` → `onIncompatible` → `App.tsx` banner):** `This game was dealt under rules engine version 999; this server supports version 1. It cannot be continued here without reinterpreting its history, so it is left untouched. (Pinned rules version: 999; this server supports 1.)` Legacy: `This game was dealt before rules-engine versioning and carries no version. It is not reinterpreted under the current rules. A local server may admit it explicitly (--legacy-logs development-corpus); otherwise start a new game. (Pinned rules version: none; …)`. The link closes and does not reconnect (terminal, like a seat refusal, #1346); pending submissions resolve `null`.
- **CLI:** `LEGACY LOG: …` banner on stderr for unpinned exports; `INCOMPATIBLE: …` and exit 3 for a foreign pin.

## 8. Files

New: `frontend/src/gameEngine/rulesVersion.ts` (#1520: constants, `ReplayCompatibility`, `ReplayPolicy`, `rulesEngineVersionOf`, `replayCompatibility`, `replayRefusal`, `stampRulesEngineVersion`, `ReplayIncompatibleError`), `frontend/src/utils/rulesVersion.test.ts` (15 tests), this file.
Modified: `gameEngine/gameSetup.ts` (field), `gameEngine/messageSchema.ts` (`int?`), `gameEngine/replayLog.ts` (policy param, refuse-before-apply), `gameEngine/index.ts` (exports), `utils/roomSession.ts` (stamp at mint; `rebuild` guard; `incompatibility`/`incompatible`/`rulesEngineVersion()`/`replayCompatibility()`; `submit` 1a; `catchUp` guard; `replayPolicy` option), `utils/serverProtocol.ts` (`IncompatibleResponse`), `utils/serverLink.ts` (`onIncompatible`, terminal case), `App.tsx` (banner), `utils/replayGolden.test.ts` / `replayJunoCV4.test.ts` / `replayJuno3XD.test.ts` (explicit corpus policy), `server/src/gameServer.ts` (`legacyLogs` option, restore warnings), `server/src/start.ts` (`--legacy-logs`, startup line), `server/src/replayCli.ts` (policy, banner, exit 3).
Untouched: `frontend/src/utils/audio.ts` (pre-existing local change), all stored logs and fixtures.

## 9. Test results (targeted; full suite is yours)

- `rulesVersion.test.ts`: 15/15 — tests 1–10 of the brief plus: headless `replayLog` refuses a foreign pin under every policy before feeding the reducer; legacy refused by default / admitted by the corpus policy; session-level `replayPolicy` opt-in admits legacy only; a new room is never legacy. The "never replayed" proofs use **two independent instruments**: `jest.spyOn(RoomEngine.prototype, "apply")` (not entered) and a counting `chartInjections` provider (reducer never fed).
- Also green: `roomSession`, `messageSchema`, `serverLink`, `serverProtocol`, `replayGolden`, `replayJunoCV4`, `replayJuno3XD`, `logRevert`, `divergenceWatch`, `presence`, `hostJoinFlow`, `forcedSignAndRadioBar`, `seatColor`, `seatPin`, `turnAuthority`.
- Both typechecks clean (`frontend` `tsc --noEmit`; `server` `tsc -p`).
- End-to-end through the compiled server over websockets (scratch script, not committed): fresh deal stamped 1 over a client's 999; same-version restart → catch-up; version 999 → `incompatible` on hello / move / RevertTo, file byte-identical; legacy → `incompatible` with null pin, file untouched; `legacyLogs: "development-corpus"` → restores; 999 still held under the opt-in.
- Server smoke test: 5 pre-existing failures in the room-doc/chat frames (`a write sent before the hello…`, `a joiner appears in the roster`, …) reproduce identically on the Batch-4 commit `53222c7`; the log-path checks pass on both. Not caused here.

## 10. Corpus sweep (Part 9)

17 stored logs (5 exports under `frontend/`, 4 fixtures, 8 in `server/data/`): **0 versioned, 16 legacy, 1 undealt** (`sandbox-log-JUNO-Y8V.json`: its effective log reverts the deal — nothing to interpret, no opinion, applied 0 before and after). Under `SERVER_REPLAY_POLICY` all 16 legacy logs are refused before the first apply (`replayLog` throws `ReplayIncompatibleError`). Under `DEVELOPMENT_CORPUS_POLICY` all 17 replay to the **same state digest and the same applied count as the Batch-4 engine** (`53222c7`), so no golden or replay expectation changed and none needed re-pinning.

## Expected totals and command

351 suites / 5401 tests (baseline 350 / 5386 + `rulesVersion.test.ts` 15).

    cd frontend && npm test -- --watchAll=false
    cd frontend && npm run typecheck
    cd server && npm run build
