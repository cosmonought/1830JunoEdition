import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
orig = s

def rep(a, b, count=1):
    global s
    assert s.count(a) == count, ("anchor count", s.count(a), a[:80])
    s = s.replace(a, b)

DOC = "`STAGE8_AUTHORITY_DESIGN_2026-09-16.md`"

# --- S8-1 -----------------------------------------------------------------
rep("""indices above as the expected divergences.

**S8-2. Presidency tie""",
"""indices above as the expected divergences.
**Stage-8 design pass (2026-09-16, """ + DOC + """ §2).** Confirmed by code; on the version-5 corpus the three
indices above **no longer exist** (3XD is refused from 140 and frozen from 290; FCJ diverges from 83) and the one
surviving sold-out rise at an OR opening — server/JUNO-FCJ 885, PRR 90 → 100 — leaves the queue unchanged because PRR
already led, so the repair moves nothing in the present corpus. The mechanism is proved on every OR-bearing final
board by handing `buildOperatingOrder` an overlay pricing the leader at $1: positions win, the overlay is ignored.
Repair frozen as **Slice 8.1** with S8-3 / S8-4: one `settleOperatingQueue` at the end of `applySandboxActionInner`,
after the rise is committed to `market_positions` — frozen operated prefix, not-yet-operated tail re-sorted on current
positions, membership fixed at the opening; the #746a overlays retire. Fable High (cursor semantics).

**S8-2. Presidency tie""")

# --- S8-2 -----------------------------------------------------------------
rep("""`presidencyTransfer.test.ts` has no tie-order case.

**S8-3.""",
"""`presidencyTransfer.test.ts` has no tie-order case.
**Stage-8 design pass (""" + DOC + """ §4).** Helper frozen: `presidentFor(company, seating)` with
`seating = state.player_addresses`; challengers strictly above the incumbent; among tied top challengers the smallest
clockwise seat distance from the incumbent; `settlePresidencies` and Stage 5's `presidentAfterSale` both pass the
roster. No stored log contains a two-challenger tie (every presidency change in the corpus has one challenger), so
the repair is replay-semantic only on a tie. Also found: the `ExchangePrivate` arm never calls `settlePresidencies`
(recorded under S8-10). **Slice 8.3, Opus.**

**S8-3.""")

# --- S8-3 -----------------------------------------------------------------
rep("""and with the market-token "operated stack" drawing (#1296), which derives "operated" from the index.

**S8-4.""",
"""and with the market-token "operated stack" drawing (#1296), which derives "operated" from the index.
**Stage-8 design pass (""" + DOC + """ §2.4–2.6).** Decided (owner confirmation R4 owed): the not-yet-operated tail
is re-sorted from `market_positions` at one settle point after every entry; the operated prefix and the operating
corporation are never displaced; the round's membership is frozen at the opening (a corporation that floats between
turns via the M&H exchange joins the next OR, §5.3). #1296's "operated = prefix" stays true. The corpus contains no
mid-OR price movement of a not-yet-operated corporation (the only engine path is Stage 5's forced sale of another
corporation's shares). **Slice 8.1.**

**S8-4.""")

# --- S8-4 -----------------------------------------------------------------
rep("""Detail: sort risers by current price desc (then §6.0 tie-break) before moving; pin with a two-riser test
(`soldOutRise.test.ts` covers one riser only).""",
"""Detail: sort risers by current price desc (then §6.0 tie-break) before moving; pin with a two-riser test
(`soldOutRise.test.ts` covers one riser only). **Stage-8 design pass:** confirmed — `withArrival` stamps the arrival
in walk order, so two risers into one cell stack in `public_companies` order; no two risers share a cell anywhere in
the corpus. **Slice 8.1** (mechanical; Opus-safe on its own).""")

# --- S8-5 -----------------------------------------------------------------
rep("""**S8-5. Home token is placed at float during the Stock Round, not at the start of the corporation's first operating turn.**
Status `DEFERRED` — needs an owner ruling (keep as a documented house rule, or move). Rulebook §6.3.1;""",
"""**S8-5. Home token is placed at float during the Stock Round, not at the start of the corporation's first operating turn.**
Status `OPEN` — **owner ruling 2026-09-16 (Stage-8 brief): move the obligation to the start of the corporation's
first operating turn** (was `DEFERRED` pending that ruling). Design: """ + DOC + """ §5 (state model), §8 (corpus
divergence table), §9 (replay strategy) — **Slice 8.2, Fable High**, absorbing S8-6, S8-12 and S8-13. Rulebook §6.3.1;""")
rep("""Delayed-Auction and herald-home (#1302) paths must be re-checked with whichever choice is made.

**S8-6.""",
"""Delayed-Auction and herald-home (#1302) paths must be re-checked with whichever choice is made.
**Stage-8 design pass — corpus facts (sweep `_to_delete/stage8_sweep.json`).** All 44 stored `kind: "home"`
entries are Stock Round entries on the corporation's own home hex; the 19 applied ones sit immediately after the
float; between each applied placement and that corporation's first OR turn **no entry lays, tokens or runs through
the home hex**, so re-timing the token changes no route or station legality and no OR order anywhere in the corpus.
Frozen model: the obligation is derived on the cursor (OR ∧ operating corporation ∧ floated ∧ non-herald ∧ no token);
the hold is turn-local (only that president's controls; nothing in a Stock Round; `nextDerivedAction` silent);
#769 / #769a seat mechanics retire; the four holds move in front of the chart step (S8-13); reservation code
(`homeReservationStands`) is already rulebook-correct and unchanged. Replay: version-6 reducer refuses an SR-time
placement outright; the development corpus replays through a `legacyHomeTokens: "defer-to-first-turn"` adapter
(4.6's `legacyExcessTrains` shape, D-9) that supplies the players' recorded hex / circle at the first turn — CV4
goldens re-baseline field-only (tokens absent between float and first turn), Z6C's 7.5 freeze lifts at 34 and 3XD's
at 290 (re-pins with reasons at Slice 8.2). Without the adapter every completed-game fixture would freeze at its
first OR turn (CV4 at 27). Owner confirmation R3 owed on the adapter rule.

**S8-6.""")

# --- S8-6 -----------------------------------------------------------------
rep("""claiming the corpus contains no wrong-hex placement — bump anyway if any stored entry would now be refused.

**S8-7.""",
"""claiming the corpus contains no wrong-hex placement — bump anyway if any stored entry would now be refused.
**Stage-8 design pass:** swept — **no stored placement is off its home hex** (44 / 44 on `homeHexesFor`), so the
validation refuses nothing historical. Predicate frozen (""" + DOC + """ §5.4): hex ∈ `homeHexesFor`; circle = the
hex's one city, or for Erie **either** free circle (not only the badge-nearest one `homeReservedCityIndex` holds
against others); no tile required on E11 / E19 (§6.3.1 note); the D&H free station (`kind: "dh"`, 3XD 115) shares the
arm and is exempt from the home rules (and should stop being prepended at `station_token_hexes[0]`). **Slice 8.2.**

**S8-7.""")

# --- S8-10 ----------------------------------------------------------------
rep("""**S8-10. M&H exchange always takes the IPO share before the pool.**
Status `OPEN` — audit m6. Rulebook p.11 ("from the bank or the pool"). Notes: `resolvePrivateExchange`,
`ExchangePrivate` arm. Replay: replay-semantic if a `source` is added (default must reproduce today's choice) —
bump. Detail: add `source: "ipo" | "pool"` to `ExchangePrivate`; default IPO for legacy entries.""",
"""**S8-10. M&H exchange always takes the IPO share before the pool.**
Status `OPEN` — audit m6. Rulebook p.11 ("from the bank or the pool"). Notes: `resolvePrivateExchange`,
`ExchangePrivate` arm. Replay: replay-semantic if a `source` is added (default must reproduce today's choice) —
bump. Detail: add `source: "ipo" | "pool"` to `ExchangePrivate`; default IPO for legacy entries.
**Stage-8 design pass (2026-09-16, """ + DOC + """ §6) — the finding is wider than the source.** The message
**already carries `source: "Ipo" | "Bank"`** (`messageSchema.ts`; 3XD 288 records `Ipo`), so no default is needed.
What is wrong is that the reducer's arm (`sandboxSession.ts` `isExchangePrivateMsg`) applies the message and
re-derives nothing: ownership, the 60 % cap, the certificate limit, share availability (`applyPrivateExchange` clamps
with `Math.max(0, …)`, so an empty pile **mints** a share), the corporation (`company_id` is message-carried),
`keep_open` (on the wire — a client could keep the M&H open), the timing window (rulebook p.27: the owner's own SR
turn or between turns in either round), the float threshold (`applyFloatThreshold` runs only in the `BuyStock` arm —
**corpus: 3XD 288 takes NYC's IPO 50 → 40 %, 60 % out, and NYC does not float until 289's purchase**) and the
presidency (`settlePresidencies` not called; §5.4 "immediately"). Ingress asks only "is the M&H yours"
(`roomMessageRefusal`). Frozen design: `privateExchangeRefusal` asked by the reducer and by `turnRefusal`; the arm
then exchanges, settles the float through a shared `settleFloat`, and settles the presidency with the S8-2 helper;
no seat, pass-streak or purchase change (owner ruling R1 — proposed default: an interjection); pool offered as a
choice (owner ruling R2). Replay: 3XD 288 transient only (NYC floats one entry earlier). **Slice 8.4, Opus** once
R1 / R2 are ruled (Fable if R1 ≠ default).""")

# --- S8-12 ----------------------------------------------------------------
rep("""Replay: refusal-added at ingress only (the reducer already
refuses) — no board changes; sweep anyway before claiming no stored proposal sits under a home-token hold.""",
"""Replay: refusal-added at ingress only (the reducer already
refuses) — no board changes; sweep anyway before claiming no stored proposal sits under a home-token hold.
**Stage-8 design pass: absorbed into Slice 8.2** (""" + DOC + """ §5.7) — the hold's new definition (turn-local, on
the cursor) and its ingress sentence are one predicate (`homeStationHold`) consumed by the reducer, `turnRefusal`
(fourth hold, after the offer hold) and `nextDerivedAction`. Swept: no stored proposal sits under a home-token hold;
the entries that DO sit under one are S8-13's sales.

**S8-13. The chart step runs before the holds, so a held `SellStock` moves `market_positions` for a sale the core refuses.**
Status `OPEN` — **newly proven by the Stage-8 design pass (2026-09-16)**. Notes: `applySandboxActionAfterAuction`
runs `applySandboxMarketAction` before `applySandboxActionCore` (#1197); the chart's `saleRefused` asks
`stockSaleRefusal`, which contains no hold; the discard (#1530), funding (#1540), offer (#1590) and home (#763) holds
are asked only in the core. Corpus: **server/JUNO-FCJ 904, 911, 918, 932** — `SellStock` entries sent after N&W
floated at 902 with its home owed; each changes `market_positions` and nothing else (the core refused the sale). The
same shape is latent for a player ↔ player trade offer standing in a Stock Round (D-24) and for a discard owed. Rule:
a refused message moves nothing (#748a / #1019). Repair (Slice 8.2): the four holds move in front of the chart step,
in their existing order, and return the board by identity before the chart is asked. Replay: replay-semantic on FCJ
(the four moves disappear) — part of the Stage-8 bump. Test: a held `SellStock` leaves `market_positions` identical.""")

# --- S10-21 cross-reference -----------------------------------------------
rep("""award still mints; `moneyConservation.test.ts` now pins that on a hand-built board) and S8-5 (moving the home token
to the first OR turn would change Z6C's replay again — the characterization will announce it).""",
"""award still mints; `moneyConservation.test.ts` now pins that on a hand-built board) and S8-5 (moving the home token
to the first OR turn would change Z6C's replay again — the characterization will announce it). **Stage-8 design pass
(""" + DOC + """ §8):** under Slice 8.2 with the deferral adapter, the freeze lifts at 34 (B&O floated at 33 owes
nothing in a Stock Round) and the recorded 32 choice is supplied at B&O's first OR turn; how far Z6C then replays is
measured at implementation and the characterization is re-pinned there.""")

# --- Part C: U-32 .. U-35 -------------------------------------------------
rep("""callers for no rules reason. Retire it with S10-8's type cleanup. `OPEN` (no user-visible effect).

---

## Part D""",
"""callers for no rules reason. Retire it with S10-8's type cleanup. `OPEN` (no user-visible effect).

**U-32.** (S8-5 / S8-6 / S8-12 / S8-13; filed by the Stage-8 design pass, 2026-09-16 — pending Slice 8.2) **Home
station at the start of the corporation's first OR turn — STATE VISIBILITY + LEGALITY SYNC + RULES REFERENCE.**
The home-station prompt (`HomeStationPrompt`, raised from `pendingHomeTokens` in `App.tsx`) moves from the Stock
Round purchase that floated the corporation to the opening of that corporation's first Operating turn; the Stock
Round no longer waits on it and no other seat is held. While the operating president owes the token, every control
of that seat except the placement is disabled with the hold's sentence (the same surface as the discard / funding /
offer holds, U-5 / U-4 / U-22) and the Activity Log names whose home is owed; the lit hexes / circles come from
`homePlacementRefusal` (Erie: either free circle of E11; LPF C&O: either home hex; no tile needed on E11 / E19).
The Rules Reference's home-station paragraph must say "at the start of its first operating turn" and drop any
"when it floats" wording. `OPEN` (UI, after Slice 8.2).

**U-33.** (S8-2; filed by the Stage-8 design pass — pending Slice 8.3) **Presidency clockwise tie-break — STATE
VISIBILITY + RULES REFERENCE.** When two or more challengers tie above the outgoing president, the presidency-change
line says who took it and why ("closest clockwise from the former president", U-30's WHY family); the Rules
Reference §5.4 paragraph states the tie rule. `OPEN` (UI, after Slice 8.3).

**U-34.** (S8-1 / S8-3 / S8-4; filed by the Stage-8 design pass — pending Slice 8.1) **Dynamic operating order —
STATE VISIBILITY.** The turn-order strip, the "next corporation" read (`App.tsx` 1300) and the market-token operated
/ active stacks (#1296) re-render from the settled queue after every action: the operated prefix never moves, the
not-yet-operated tail may. No new control; verify no shell code caches the opening order (the re-entrancy key
`utils/turnGuard` reads the state's index and is unaffected). `OPEN` (UI, after Slice 8.1).

**U-35.** (S8-10; filed by the Stage-8 design pass — pending Slice 8.4) **M&H exchange window and source — LEGALITY
SYNC + RULES REFERENCE (+ NEW ACTION under ruling R2).** The powers panel / flow modal must ask the reducer's
`privateExchangeRefusal` (not the client-side `resolvePrivateExchange` alone) so an exchange refused at the lock —
outside the window, under a hold, over the certificate limit, no share in the named pile — is never presented as
live; under R2 the modal offers Bank Pool as an alternative source when both piles hold a share; the Rules
Reference's M&H card states the window ("your own Stock Round turn, or between turns in either round") and the
no-sale-before-par rule already enforced by U-24. `OPEN` (UI, after Slice 8.4).

---

## Part D""")

assert s != orig
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("backlog edited; delta lines:", s.count("\n") - orig.count("\n"))
