# AI Architecture Notes — Index

Extracted design commentary for **1830: Juno Edition** (React/Canvas frontend, Rust/CosmWasm
backend, Firebase middleware). This directory is the archive that source files used to carry
inline. Code keeps a 1–2 line comment naming the note; the reasoning lives here.

> **One exception to per-file numbering:** the five rail-map modules
> (`HexGridRenderer.tsx`, `hexCanvasPrimitives.ts`, `hexGeometry.ts`, `TileGraphics.ts`,
> `hexBoardData.ts`) share a **single** `#N` space, because the monolith split moved code *and* its
> notes out of one original file. All five are anchored `HexGridRenderer.tsx #N`.

## How to use this

Source comments reference notes by number, e.g. `// see design note #481`. Every note in this
directory is anchored as **`<source file> #<N>`**, so:

- `Ctrl+F` for `#481` lands on the note.
- The file prefix disambiguates — numbering is **per source file**, so `#3` in `Lobby.tsx` and
  `#3` in `App.tsx` are unrelated notes. Always search the number; the prefix tells you which
  one you found.
- A few notes carry letter suffixes (`#591b`, `#537a`, `#549a`). These are follow-up passes on
  the base note and are filed immediately after it.
- Superseded notes are retained and marked **`[superseded by #N]`** rather than deleted. The
  reasoning trail is the point.

## Domain files

| File | Covers |
|---|---|
| [state_machine.md](state_machine.md) | Round types, Operating Round sub-phase cursor, turn gating, auto-skip, float events, home stations, undo/revert semantics |
| [sandbox_reducer.md](sandbox_reducer.md) | The local reducer's charter, the Operating Round machine, determinism under replay, and the fixtures (`sandboxSession.ts`, `sandboxState.ts`) |
| [firebase_middleware.md](firebase_middleware.md) | Event-sourced room log, replay drain, setup event, presence, chat transport, the chain/Firestore boundary, room codes, Firebase config |
| [canvas_rendering.md](canvas_rendering.md) | The rail map renderer: radial tile selector, board veil/dimming, cursor modes, tile preview, the camera, margin labels, layer order, route overlays |
| [hex_tile_math.md](hex_tile_math.md) | Bezier track splines, the hand-authored artwork catalog, the 13-slot placement engine, station/token docking geometry, board data and palettes |
| [stock_market.md](stock_market.md) | Par values, IPO vs bank pool pricing, market chart marks and moves, stock round cards |
| [contract_economy.md](contract_economy.md) | Treasuries, token pricing, train purchase and the depot queue, emergency funding, bankruptcy, private companies, the waterfall auction |
| [routing_pathfinding.md](routing_pathfinding.md) | Route drafting, waypoints and bridging, revenue centres vs hexes, train capacity, auto-route |
| [ui_shell_layout.md](ui_shell_layout.md) | Tabs, top ticker and activity feed, dock height reservation, turn notifications, inline styles |
| [session_keys_wallet.md](session_keys_wallet.md) | Wallet and `x/authz` session keys, spectator/read-only mode, viewer identity, sandbox identity |

## Recurring principles

These arguments appear across many notes and are worth reading once:

1. **One question, one answer.** The project's most common bug class is two values that are
   supposed to encode the same fact drifting apart (`#559`, `#576`, `#580`, `#587`, `#601`).
   When a rule needs enforcing twice, share the predicate rather than reimplementing it.
2. **Gate at the dispatch, not on the button.** Disabled controls are a courtesy; the guarantee
   is the check inside `runGameplayAction`. See `App.tsx #23`, `#536`.
3. **Ignorance permits — usually.** `null` means "not asked" and must be distinguished from a
   real `0`. Which direction is safe depends on the cost of each mistake: see `#293b` and
   `#433` for the same field being read the opposite way in two places, deliberately.
4. **Derive the question, do not latch it.** State derived from the board cannot go stale,
   cannot be raised twice, and cannot survive the thing that resolved it (`#565`, `#416`).
5. **The contract is the authority.** The frontend may pre-check to save a signature and a gas
   fee, never to become a second rulebook. A client-side copy of a rule can only drift.
6. **Fire on the edge, not on the condition.** Effects that dispatch must compare against a
   previous-value ref, or they re-broadcast on every render until the next poll lands.
7. **If the reducer needs it to decide, it travels in the message.** Context (`ctx`) is only for
   things identical on every client by construction — the map, the era. A shared fact derived from a
   per-browser value diverges silently under replay: `sandboxSession.ts #549` (the actor), `#553`
   (the par ladder), `#579` (the price) are the same bug three times.
8. **A value that must be correct, read from a field nothing writes.** The other repeat offender:
   `sandboxSession.ts #411`, `#431`, `#621` and `#642` are one defect in four places. Stamp every
   bookkeeping value where the round opens, together, so a reader sees the whole opening position.
9. **A UI quoting a transaction the state does not perform.** The renderer drew $80 while the
   reducer charged $20 (`#432`); the modal promised the president's money and nothing took it
   (`#333`); the badge promised an auto-award nothing performed (`#336`). When a surface describes an
   action, something must actually do it.
10. **Sort comparators must be total.** `NaN` or an incomparable pair makes `sort` produce an order
    that is not an order — which lands the Operating Round cursor on a corporation that has already
    operated (`#468`, `#646`).

## Batch status

| Batch | Scope | State |
|---|---|---|
| 0 | Scaffold this directory | Done |
| 1 | `frontend/src/App.tsx` | Done |
| 2 | Firebase middleware (`sandboxSession`, `sandboxState`, `sandboxRoom`, `config/firebase`, `actionLog`, `feed`) | Done |
| 3 | Canvas rendering + tile math (incl. the Phase 0 legacy fold) | Done |
| 4 | Stock market + trading UI | Pending |
| 5 | Remaining frontend files | Pending |
| 6 | Rust contract backend | Pending |

Test files (`src/tests.rs`, `frontend/src/**/*.test.ts`) are out of scope by decision — they
are self-documenting.
