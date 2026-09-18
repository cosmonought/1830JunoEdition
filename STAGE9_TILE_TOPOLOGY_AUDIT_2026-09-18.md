# Stage 9.1 — Tile / Topology / Catalog Authority Audit

**Date** 2026-09-18 · **Model** Opus (max) · **Scope** AUDIT ONLY — no gameplay code changed, no rules-engine bump, no commit.

> ### REVISION 9.1c — 2026-09-18, the correction tile sheets + the owner's physical-tile transcription
> Two things arrived this pass. **(1)** The errata PDF has **three** pages and **pages 2–3 are the replacement tile
> sheets** (*"1830™ – Errata Sheet MFG1830-88"*) — 9.1b's claim that this art "was not obtainable" is **withdrawn**.
> **(2)** The owner supplied the **authoritative physical-tile transcription of oo13 and oo14**, which is the
> authority §8c was waiting for. Net effect: **S9-20 is withdrawn as not a defect**, the engine's oo13/oo14 records
> are **confirmed correct** in colour, geometry and revenue, and what remains is a **contradiction between official
> sources** over `oo13 → oo20` — reported, not resolved (§8c).
>
> ### REVISION 9.1c (first part) — the errata's own correction tile sheets
> The official errata PDF has **three** pages, and **pages 2–3 are the replacement tile sheets** — headed
> *"1830™ – Errata Sheet MFG1830-88"*. 9.1b's statement that this art "was not obtainable" is **withdrawn**: it was
> located, rendered and read this pass. Its legends affirm `oo13 ➧ oo20`, `oo14 ➧ oo20` and `C15 ➧ D4`, give every
> corrected tile's scenario roundels (Ⓑ Ⓓ Ⓖ Ⓡ), and instruct *"40 value added to 1830+ side of all four C15
> tiles"*. Three findings move (§0). The **track geometry** of oo13 is still unread — see §8c for exactly why and
> for the one step that closes it.
>
> ### REVISION 9.1b — 2026-09-18, errata reconciliation
> This document was reconciled against three authorities the first pass did not have: the **2018 revised Classic
> rulebook** (located and read this pass), the **official Mayfair 1830 Clarifications & Errata (01/03/12)** (located
> and read this pass), and one **frozen Project 18XX LPF owner override**. Six of the first pass's conclusions
> changed; two were withdrawn outright. Every changed conclusion is marked **[9.1b]** where it appears. The data
> sections — §2 architecture, §3 crosswalk, §4 manifest, §5 printed-hex manifest, §7 matrix, §9 Baltimore,
> §10 variants, §11 route graph, §12 tokens, §13 helper, §15 tests, §16 privates — were re-verified and stand as
> written except where marked.

**Baseline.** `HEAD = 484094c` *Docs: record Stage 8 closure commit*, on top of `0b23b1e` *Batch 8.5: close Stage 8
and bump rules engine to v6*. `RULES_ENGINE_VERSION = 6` (`gameEngine/rulesVersion.ts:65`) — **unchanged by either
pass**. Stage 8 is closed and was not reopened. The working tree carries concurrent owner work (modal / UI / test
paths, actively edited during both passes); nothing in it was stashed, reset, checked out or edited. Every source
file this audit rests on was re-stat'd at 9.1b and is untouched by that work.

---

## §0 Verdict

**ERRATA RECONCILIATION COMPLETE — READY TO COMMIT THE STAGE 9.1 AUDIT.**

**No engine defect remains open in the OO family, and no audit question is unresolved.** After the owner's
physical-tile transcription, the engine's **oo13 and oo14 records are confirmed correct in colour (Brown), geometry
and revenue ($50)** — S9-20 is **withdrawn as not a defect** and S9-16 is **no longer a defect against the engine**.
What is left is a **contradiction inside official material**: the errata's correction sheet prints `oo13 ➧ oo20`,
and **no gray OO tile can host that edge together with T-09's other `ooNN → oo20` rows** (556 candidate geometries
enumerated, §8c-ii). Per the brief's own §5B that is reported, not resolved — and the engine already implements the
best available reading. **It blocks nothing**: not this audit, not Slice 9.2, not Slice 9.3.

### What changed at 9.1b

| First pass said | Now |
|---|---|
| **F-9** — whether an OO upgrade may merge #59's two systems is an **owner ambiguity** | **WITHDRAWN as an ambiguity. It is printed rule.** Revised 6.2.2 ❹, verbatim: *"This also means that the pre-printed exits on a (59) tile can never be connected in the tile upgrade."* Merging facings are **illegal**. Filed as **S9-19**, and it makes three corpus lays illegal (§14) |
| **F-3** — `#626 →` brown OO is a missing legal upgrade (HIGH) | **WITHDRAWN. The engine is correct and doubly so.** Official errata: *"The oo1 (8861) tile is not upgradable."* And the repo already carries the owner's own playtest ruling to the same effect (`App.tsx:3331`, #1390). T-09's `oo1 → oo10-oo17` row is erroneous material |
| **F-3** — `#36 → #167` is a missing legal upgrade (HIGH) | **RECLASSIFIED and narrowed** (S9-16). Not fixable by changing #167: **no two-city partition of a six-exit gray OO can host all eight of T-09's `ooNN → oo20` edges — the maximum is 7 of 8, and the engine's #167 already achieves it, omitting exactly oo13** (§8b) |
| **F-8** — `#626`/`#36` geometry ambiguity | **SPLIT.** #626 resolved (not upgradeable — no geometry question remains). oo13 narrowed to two mutually exclusive hypotheses with one deciding artefact (§8b) |
| **F-10** — Ⓓ-mark membership is an ambiguity needing a ruling | **RESOLVED as a source-supported component inference** (§10b), with a named falsifier. Not an owner decision |
| **[9.1c]** the replacement tile art "was not obtainable" | **WITHDRAWN — it is pages 2–3 of the errata PDF itself.** Located, rendered, read. Legends affirm `oo13 ➧ oo20` and `oo14 ➧ oo20`; scenario roundels Ⓑ Ⓓ Ⓖ Ⓡ on oo13, oo14 and C15; *"40 value added to 1830+ side of all four C15 tiles"* |
| **[9.1c]** S9-16 was "two hypotheses, H1 or H2" | **BOTH are dead.** The correction sheet *prints* `oo13 ➧ oo20` (killing H2); the owner's transcription confirms **the engine's oo13 geometry is correct** (killing H1). What remains is a contradiction between official sources, and the engine implements the 7/8 maximum reading |
| **[9.1c]** oo13 / oo14 geometry, colour and revenue | **CONFIRMED CORRECT in the engine.** Owner transcription: both **BROWN**, two separate large cities, oo13 `{0,2}`+`{3,5}`, oo14 `{0,2}`+`{1,3}`, systems unconnected, **$50** each. Engine matches on every field, in both edge conventions |
| **[9.1c]** S9-15 (#63 count) wanted owner confirmation | **confirmed by component evidence** — *"all four C15 tiles"*. Caveat withdrawn |
| **[9.1c]** S9-20 (oo13/oo14 revenue 50 → 40) recommended | **WITHDRAWN — NOT A DEFECT.** Owner confirms **$50** for both; the art shows 50; the engine has 50. The errata's parenthetical is a distinguishing remark, not a correction |
| **[9.1c]** Ⓓ-mark membership rested on inference | **direct component evidence added** for oo13, oo14 and C15; the inference still carries the general case and the sample agrees |
| T-09 is the expanded-set authority | **T-09 is authority only as corrected.** The errata names T-09's own defects, and this pass classifies every T-09/revised-book/engine discrepancy (§6b) |
| #53/#592 siblings · #28/#29 → #43 · 79 immutable-hex lays · printed topology · station anchoring · M-11 | **all confirmed, several now on stronger authority** (the revised book replaces the 48-page book for every Classic claim) |

### Findings after reconciliation

| ID | Sev | Status | Finding |
|---|---|---|---|
| **F-1** | **HIGH** | **stands, strengthened** | Immutable-hex refusal is absent from the authoritative predicate. 79 accepted lays on the standard board. Now also supported by revised 6.2.1 ❷ / 6.2.2 ❷ and by the errata's own *"The Richmond hex (K15) should be grey, as it cannot be upgraded"* — and it is a **migration regression**: `hexmap.rs:2317`/`:2331` refuse both cases by name, with a Rust test. → **S9-10** |
| **F-2** | **HIGH** | **stands** | Printed board topology is invisible to `preservesRouting` (gated on the laid tile). Masked at the three landmark hexes by `staysOnBoard`; unmasked at the gray hexes. → **S9-10** |
| **F-4** | **MED** | **stands, confirmed by component art [9.1c]** | 1830+ tray holds 1 × #63; T-09 gives 3 `+1` = 4. Inventory is **replacement, not additive** (`counts.set`), so the effective 1830+ supply really is 1. Most likely a transcription of T-09's "+1" as "1" in the owner spec; `plusTiles.test.ts:72` pins the wrong figure. **The errata's #63 item is about its VALUE (50 → 40) and the engine already has 40** — it does not alter the count. → **S9-15** |
| **F-5** | **MED** | **stands** | Revised 6.2.2 ❹ (stations keep the same connections) is enforced only in `App.tsx`'s `legalRotations` memo. → **S9-17** |
| **F-6** | **MED** | **stands** | LPF is missing T-02 / S-1.1 ❷'s printed straight track (A-1 = #9) at M-11. No Project override contradicts it. → **S9-18** |
| **F-7** | LOW | stands | `tileSupply.test.ts:38` comment says 28 where it asserts 30. → S9-15 |
| **S9-19** | **HIGH** | **NEW** | #59's two pre-printed exits may never be connected by an upgrade (revised 6.2.2 ❹). Seven (tile, facing) pairs are accepted today that the rule forbids; three are in the corpus. → §8, §14 |
| ~~**S9-20**~~ | — | **WITHDRAWN at 9.1c — not a defect** | oo13 and oo14 carry `revenue: 50`; the errata's entry for each reads *"(it has a value of 40 rather than 50)"*. Same 50→40 family as the C15 (#63) item the engine already honours. Grammar of the parenthetical admits a second reading; §5b states both. → §5b |
| **S9-21** | **LOW** | **NEW** | Canonical-identifier convention for the three tiles whose printed old numbers the errata voids: **oo1 = #8861** (alias #626 deprecated), **oo13** and **oo14** canonical by Lookout ID (aliases #36, #35 deprecated). The engine keys all three on the deprecated aliases. Behaviourally inert today; it is a naming-authority debt. → §2b |
| **S9-16** | **INFO** | **reclassified at 9.1c — not an engine defect** | `oo13 → oo20` has zero legal facings **because official sources conflict**, not because the engine is wrong: oo13's geometry is owner-confirmed, the correction sheet prints the upgrade, and **no gray OO geometry hosts it alongside T-09's other `ooNN → oo20` rows** (556 candidates enumerated). The engine implements the 7/8 maximum. Recorded for the publisher, costed for Slice 9.3, fixes nothing |
| — | — | **PASS / intentional** | **TO override**: LPF retains #810/#882 against printed Scenario D. Implemented, documented (#1395) **and already pinned by test** (`levelPlayingField.test.ts:170-171`). → §10c |
| — | — | **PASS** | Three of the errata's four Board items are already satisfied by the engine: K15 grey, Detroit/Windsor $80, Ottawa B16 free. The fourth is a table-printing item that the repo's copy of T-09 does not exhibit. → §1b |

---

## §1 Authority — the corrected hierarchy **[9.1b]**

Four authorities, in precedence order. The first pass had only B, which is why six of its conclusions moved.

| | Authority | Governs | Status |
|---|---|---|---|
| **A** | **2018 revised Classic rulebook** — `en_1830re.html_Rules_1830-RE_EN.pdf`, 28 pp. | updated Classic / base rules; tile placement; upgrade preservation; station-connection preservation; the Classic upgrade tables; **#59's OO preservation rule** | **LOCATED AND READ THIS PASS** at `https://www.lookout-spiele.de/upload/en_1830re.html_Rules_1830-RE_EN.pdf`. Section numbering is **6.2.1 / 6.2.2**, where the 48-page book uses 7.2.1 / 7.2.2 |
| **B** | **48-page Lookout / Mayfair rulebook** — `de_1830.html_Rules_1830_EN.pdf` | expanded tile set; 1830+; Scenario D / LPF source; scenario component tables; the old↔new crosswalk; topology the revised book does not reproduce | in the repo as `1830 FULL RULES with variants.pdf` (48 pp., 69.9 MB). Publisher copy: `https://www.lookout-spiele.de/upload/de_1830.html_Rules_1830_EN.pdf` |
| **C** | **Official Mayfair errata** — *"1830 Clarifications & Errata (01/03/12)"*, © Mayfair Games 20120106 | overrides B's known mistakes in T-09, old-number mappings, tile values, component sheets and upgrade listings **where explicitly corrected** | **LOCATED AND READ THIS PASS**, verbatim in §1b |
| **D** | **Project 18XX owner overrides** | explicit, documented Project variant decisions | one frozen override this pass: **LPF retains the TO tiles** (§10c) |

**Neither book is unconditionally authoritative, and T-09 least of all.** The operative rule is
**A for Classic, B for expanded, C over both where it speaks, D over all where documented.**

**Recommendation carried forward:** the two rulebook PDFs and the errata should be added to the repo so this audit's
citations resolve offline. Only B is present today. Nothing in this document depends on that happening.

### §1a Authority A, verbatim — revised **6.2.2 Upgrading Track Tiles**

> 1 A railroad upgrading a tile must be able to trace an unblocked train route (see 6.3.3, p. 21) of any length
> from one of its stations to at least one of the track segments on the new tile. Note that this segment need not
> be one of those present on the new tile but not on the old.
> 2 A railroad may not upgrade a tile such that a track segment on the new tile runs off the hex grid, terminates
> against the blank side of a grey hex, or terminates against a solid red hex side (i.e., a lake, inlet, or river).
> 3 All track segments on the replaced tile must be maintained in the same orientations on the new tile.
> 4 When a tile is replaced, all stations on the replaced tile must be placed on the new tile with the same
> connections as before. **This also means that the pre-printed exits on a (59) tile can never be connected in the
> tile upgrade.**
> 5 A railroad may only use certain tiles to upgrade each specific tile. In addition, only green tiles may upgrade
> yellow tiles, only brown tiles may upgrade green tiles.
> 6 If a tile to be upgraded has a label (OO, B, or NY), the label on the new tile must match the label on the tile
> to be upgraded.
> 7 There is no cost to upgrade a tile, regardless of the terrain.

Revised **6.2.1** (placing), the two restrictions this audit turns on:

> 2 A railroad may not place a tile such that a track segment on the tile runs off the hex grid, terminates against
> the blank side of a grey hex, or terminates against a solid red hex side.
> 5 A railroad may only place a tile on a hex if the tile and hex have the same number and size of cities.

Revised p. 19, **Yellow Hex → Green Tile #s**:

> 2 large cities (OO) . . . 59 · Baltimore, Boston (B) . . . 53 · New York (NY) . . . 54

and **Tan Hex → Yellow Tile #s**:

> 0 cities . . . 7, 8, 9 · 1 small city . . . 3, 4, 58 · 2 small cities . . . 1, 2, 55, 56, 69 · 1 large city . . . 57

**Two things this settles.** "Size of cities" in 6.2.1 ❺ is **small (town) versus large (city)** — not station-slot
count; the first pass reached the same reading from B and it is now confirmed by A's own vocabulary, so §9's warning
stands: Slice 9.2 must not tighten rule 2 into slot parity. And **the B family serves Baltimore *and* Boston**,
which A states directly (B's p. 19 said the same; B's "2 **small** cities (oo)" is corrected by A to "2 **large**
cities").

### §1b Authority C, verbatim — the official errata

Every line below is quoted from *"1830 Clarifications & Errata (01/03/12)"*, © Mayfair Games 20120106.

**Tiles — Classic Side**

> Tiles oo16 (64) and oo11 (67) are missing the 'OO' designation.

*Engine: a cosmetic component fact; the engine types both as `DoubleCityHub` under the `OO` label restriction, so
the designation is present in the model. **PASS**, no action.*

**Tiles — 1830+ Side**

> The C15 (63) tiles have the wrong value. The value should be 40, instead of 50.
> Board tile 30n should display the N&W logo rather than C&O.
> Tile 30m's back should reference hex E9, instead of hex D10.
> The (55) tile should be labeled A10, instead of A9.

*Engine: `#63 revenue: 40` — **PASS**, already errata-correct. 30n/30m are Scenario Ⓑ/Ⓖ board tiles, outside LPF.
The (55)/A10 item is a label on the physical tile; T-09 as printed in the repo's copy already gives A10 = #55, so
it is already corrected there. It does, however, explain the odd "Variant — The A9 and A10 track tiles are
available" line on p. 35: that sentence sits in the same A9/A10 confusion the errata names.*

**Tile Numbering — Older** (the whole section, verbatim)

> Several 1830+ variant tiles have incorrect numbers in the older numbering system: oo1 (626) should be oo1 (8861)
> according to one website supporting the older numbering system and no number on the other. oo13 (36) should have
> a number that is NOT 36—neither support site has a number for this tile.(it has a vaue of 40 rather than 50)
> [File with no old number to be included in replacement tile sheet.] oo14 (35) should have a number that is NOT
> 35--neither support site has a number for this tile..(it has a value of 40 rather than 50) [File with no old
> number to be included in replacement tile sheet.]

**Rules**

> Tile oo1 (8861) is not upgradable.

**Board — Classic**

> The Richmond hex (K15) should be grey, as it cannot be upgraded. The Detroit/Windsor hex (D10) should have a cost
> of $80 to place a tile. Board tile 30l has the correct information and can be used to correct this problem. The
> Ottawa hex (B16) should have no cost to place a tile. Board tile 30q has the correct information and can be used
> to correct this problem.

*Engine, checked this pass: **K15** `printedColor: "Gray"` on the standard board ✓ · **Detroit/Windsor E5**
`type: "River"` → `RIVER_BUILD_FEE = 80` ✓ · **Ottawa B16** `type: "Plain"`, no fee ✓. **All three PASS.**
Note the errata itself writes "(D10)" for Detroit/Windsor while authority B places Detroit/Windsor at **E-5**
(LPF §S-1.2 p. 34: "The base city of the PMQ is Detroit/Windsor (E-5)"; T-02 puts corrective tile 30l at E-5), and
the very next errata line records **D10** as a wrong coordinate printed on 30m's back. Read as a typo for E5 — and
moot either way, because the engine makes both E5 and D10 `River`/$80.*

**Rules** (the whole section, verbatim)

> 1) Table T-09 (last page) is missing a yellow hex in the lower left corner.
> 2) The component picture on page 1 of the Starter Game should have a NYC station token shown instead of the CPR
> station token.
> 3) The oo1 (8861) tile is not upgradable.

**Board — 1830+**: the heading exists and **carries no items**.

*[9.1c correction] The first reading of this document placed the T-09 sentence under "Board — 1830+". Rendering
page 1 in a browser shows the "Board – 1830+" heading is empty and the T-09 sentence is item 1 under **Rules**,
alongside the oo1 non-upgradability item. The wording of the sentence is unchanged; only its heading was wrong.*

*Not exhibited by the repo's copy. T-09 as rendered there reconciles arithmetically: its yellow rows sum to exactly
the 34 Classic / +23 expanded its own footer prints, and its 76 tile types match the engine's catalog two-way with
no tile on either side unaccounted for (§4). Either this printing is already corrected or the item refers to a
colour swatch in the totals row. **Recorded so a future reader does not assume T-09's yellow set is short a row.***

**Charters** (for completeness, outside this audit's scope)

> The Reading, Pere Marquette, and Nickel Plate charters should each only have two spaces for tokens: the $0 and
> the $40.

### §1b-ii The correction tile sheets — pages 2 and 3 **[9.1c]**

The errata PDF is **three pages**. Page 1 is the text above. **Pages 2 and 3 are the replacement / correction tile
sheets**, headed **"1830™ – Errata Sheet MFG1830-88"** beside the Mayfair logo, with printer's colour-calibration
bars and the imprint *"Tile Corrections 010412.indd"* and *"1/4/12 11:09 AM"*. They carry the corrected tiles
themselves, each beside a pale legend hex. Both pages were rendered and visually inspected, and their text layer
extracted separately (see §8c and Appendix B).

**Per-tile legends, as printed:**

| Legend hex | Old # | Scenario roundels | Upgrade line | Set |
|---|---|---|---|---|
| **oo13** | ( – ) | **Ⓑ Ⓓ Ⓖ Ⓡ** | `oo13 ➧ oo20` | 1830+ |
| **oo14** | ( – ) | **Ⓑ Ⓓ Ⓖ Ⓡ** | `oo14 ➧ oo20` | 1830+ |
| **C15** | (63) | **Ⓑ Ⓓ Ⓖ Ⓡ** | `C15 ➧ D4` | 1830+ |
| **30n** | — | Ⓑ | "Replaces L-10" · "N&W Logo on 30n" | 1830+ |
| **30m** | — | — | "Replaces E-9" · "Place 30m on E9" | 1830+ |

**Sheet annotations, verbatim:** *"oo13 & oo14 have no #s in old system."* · *"'OO' added to Classic side"*
(beside the corrected **oo16 (64)** and **oo11 (67)**) · *"A10 has corrected #"* ·
***"40 value added to 1830+ side of all four C15 tiles."***

**Three things this settles that page 1 alone could not.**

1. **`oo13 ➧ oo20` and `oo14 ➧ oo20` are printed on the corrected tiles' own legends** — the edges are affirmed by
   the publisher, not merely un-retracted (§8c).
2. **"all four C15 tiles"** is direct component evidence that the 1830+ side carries **four** #63 tiles, which is
   what T-09's `3 +1` says and what the engine's tray does not (§4, S9-15). The owner-confirmation caveat 9.1b
   attached to that finding is withdrawn.
3. **oo13, oo14 and C15 each carry the Ⓓ roundel** — direct component evidence for the Scenario-D membership
   question, which 9.1b could only reach by inference (§10b).

### §1c Scenario glyph mapping (authority B, p. 34 / T-01 / T-02 / T-03)

| Glyph | Scenario | Title |
|---|---|---|
| Ⓓ | S-1.0 | **"A Level Playing Field"** (Morgan Dontanville) — **Scenario D = LPF** |
| Ⓖ | S-2.0 | "No One Expects the Canadian Pacific" |
| Ⓡ | S-3.0 | "The Empire Builders Strike Back" |
| Ⓑ | S-4.0 | "Opening up West, By-God, Virginia" |
| Ⓣ | S-5.0 | "Uncertain Times" (any train mix) |
| Ⓒ | S-6.0 | "Dave? What are you doing…" |

PMQ = **Pere Marquette**, base city **Detroit/Windsor (E-5)**, "may start in either Detroit or Windsor" — printed
Scenario D, p. 34. Board tiles are printed board: *"treat these board tiles as if they were part of the board (i.e.,
you do not remove them, and just place any new tiles on top of the board tiles)"* (p. 34).

---

## §2b Tile-number convention after errata **[9.1b]**

Project convention is unchanged in spirit — **prefer the OLD / ORIGINAL 18xx number** — with one correction: **do
not canonize an old number the errata voids.** The corrected rule:

- **a valid corrected old number exists** → that corrected old number is canonical; the erroneous printed number
  survives only as a deprecated alias;
- **the errata voids the printed old number and supplies no replacement** → the **Lookout ID** is canonical; the
  erroneous printed number survives only as a deprecated alias.

| Lookout ID | Canonical project identifier | Deprecated erroneous alias | Errata basis |
|---|---|---|---|
| **oo1** | **#8861** | ~~#626~~ | *"oo1 (626) should be oo1 (8861) according to one website supporting the older numbering system"* |
| **oo13** | **oo13** (no valid old number exists) | ~~#36~~ | *"should have a number that is NOT 36—neither support site has a number for this tile"* |
| **oo14** | **oo14** (no valid old number exists) | ~~#35~~ | *"should have a number that is NOT 35—neither support site has a number for this tile"* |

**Current engine state: all three are keyed on the deprecated aliases** — `TILE_CATALOG` entries `tileId: 626`,
`36`, `35`, and every tray, test, artwork and marker table keys off those. That is **behaviourally inert today**:
the ids are opaque handles, they are unique, and no rule reads them as old 18xx numbers. It is a naming-authority
debt, filed as **S9-21**, and the cheap fix is a canonical record plus an input alias (`"626"` resolving to the
oo1/#8861 record), not a rename of every reference.

**Classification of every `626` occurrence in the repo** (34 matches; the ones that are the tile, not a colour):

| Site | Class |
|---|---|
| `hexTileCatalog.ts:700` (`tileId: 626`) | **topology source** — the record itself; keys on the deprecated alias (S9-21) |
| `TileGraphics.ts:717` (`626: {…}`) | **topology source** (artwork / slots / route rails) — same alias |
| `App.tsx:3331-3333` | **documentation + behaviour**: the owner's playtest ruling *"there's no upgrade for 626, it stops at Green"* — **correct, and independently confirmed by the errata** |
| `utils/actionReceipt.test.ts:218`, `utils/plusTiles.test.ts:134/156/171/189/257`, `components/badgeDodgesCities.test.ts:17/30`, `components/tilePreviewMarkers.test.ts:91/93`, `utils/cityScopeCoverage.test.ts:63`, `utils/reenterOtherCity.test.ts:85/88` | **test** — legacy alias usage |
| `components/hexCanvasPrimitives.ts:1294/1297/1310`, `gameEngine/routeAutoTrace.ts:468` | **display / route commentary** — alias in prose |
| `hexTileCatalog.ts:19/54`, `tileSupply.test.ts:4/39` | **unrelated** — design-note number "#626", not a tile |
| everything in `palette.ts`, `Lobby.tsx`, `MainTabBar.tsx`, `RulesReference.tsx`, `SandboxRoomBar.tsx`, `appStyles.ts`, `lobbyDashboard.test.ts`, `logHash.test.ts`, `roundAffinity.test.ts` | **unrelated** — hex colour strings (`#262626`) and design-note numbers |

**No repo site advertises oo1 successors.** `utils/tileUpgrades.ts` derives the graph by sweeping the real filter,
so it reports none; `App.tsx` #1390 gives the player an explicit "no upgrade in this game" receipt, pinned by
`actionReceipt.test.ts:218`. **The only artefact that ever claimed oo1 successors was this audit's own first pass,
and this revision withdraws it.** No stale-metadata defect is filed.

---

## §2 Code architecture — the authoritative path, and the three tables that describe a tile

### The lay-legality call graph (authoritative)

```
App.tsx :6083  layRefused(q, r, tileId, orientation)
   ├─ operatingIdentityRefusal(state, msg)                     gameEngine/operatingIdentity.ts
   ├─ authoritativeHoldRefusal(state, msg, {mapGrid, …})       gameEngine/… (Slice 8.2, S8-13)
   └─ filterSandboxPlacements([{tile_id, orientation}], {mapGrid, q, r, era})
                                                               components/sandboxTileLegality.ts:455
            ↓  rule 0a/0b  inTray / trayCountOf                components/tileTray.ts  (+ tileTrayPlus / tileTrayLpf)
            ↓  rule 1      TIER_RANK vs era
            ↓  rule 2      tileCentres  ← TILE_GRAPHICS_CATALOG (artwork) → fallback CENTRES_FOR_TERRAIN
            ↓              hexCentres   ← archetypeForHex        components/hexGeometry.ts:339
            ↓  rule 3      hexLabelRestriction → REQUIRED_TERRAIN  (OO / B / NY / TO)
            ↓  rule 4      existingRank = laid tile ▸ preprintedTierByLabel("Yellow") ▸ −1
            ↓  rule 4b     staysOnBoard        ← isBoardHex
            ↓  rule 4c     crossesImpassableBorder ← IMPASSABLE_BORDER_EDGES (+ derived far side)
            ↓  rule 5      preservesRouting(existing, existingOrientation, candidate, orientation)
            ↓                    ← tileSegments ← TileCatalogEntry.paths  (rotated)
            ↓  rule 6      orientationJoinsNetwork ← trackReach portKey
      → applySandboxLayTile(mapGrid, q, r, tileId, orientation, layRefused)   gameEngine/sandboxSession.ts:6658
      → reducer "LayTile" arm                                   gameEngine/sandboxSession.ts:5114
            ↓ terrainFeeDue / JK half-fee (#1323) / treasury gate (#891)
            ↓ token_city / token_cities applied, clampCity(#1315)
```

The **replay validator uses the same predicate and nothing else**: `gameEngine/replayProviders.ts:73`,
`layRefused: (grid,q,r,tileId,orientation,era) => filterSandboxPlacements([…]).length === 0`. So anything not in
`filterSandboxPlacements` is not a rule a replay can enforce — that is the shape of F-1, F-2 and F-5.

### Not on the authoritative path (UI / derived only)

| Module | What it decides | Where it is used |
|---|---|---|
| `hexGeometry.evaluateHexForTileLaying` (:249) | **board immutability**: not-a-hex, `RedOffboard`, `printedColor "Gray"/"Coal"`, `GRAY_HEXES` membership, terminal tier | `HexGridRenderer.tsx:3476` (click), `App.tsx:3123` (glow), `trackReach.ts:553` (`layableHexes`) — **never `layRefused`** → **F-1** |
| `utils/tokenMigration.planTokenUpgrade` (:304) | rule 7.2.2 ❹ — per-token edge-set anchoring, slot capacity | `App.tsx:10797` (`legalRotations` memo), `:10971`, `:11144` — **never `layRefused`** → **F-5** |
| `utils/stationConnectivity.fitStationsToUpgrade` | the fit itself: `anchored` / `free` / `illegal` | called only by `planTokenUpgrade` |
| `utils/tileUpgrades.tileUpgradeGraph` (:…) | the Tiles reference tab's upgrade graph, **derived by sweeping the real filter** over the real board | `TileReference.tsx` — deliberately derived, not authored (design note #675) |

`tileUpgrades.ts` deserves a note: it is the one place in the codebase that already *measures* the upgrade graph
instead of restating it, and it is why two of this audit's findings were findable at all. Its own module doc records
the #626-shaped discovery that produced design note #676 ("green #59 … had no brown successor at all"). F-3 is the
same class of bug, one variant later, on a tile the sweep does not exercise because no Classic board hex holds it.

### Three tables describe one tile — and different authorities read different ones

| Fact about a tile | Authoritative table | Read by |
|---|---|---|
| live edges, internal paths, quantity, revenue, `plusOnly`, `mergesTowns`, `cityGroups` | `components/hexTileCatalog.ts` — `TILE_CATALOG`, hand-kept mirror of Rust `hexmap::TILE_CATALOG`, 76 entries | **placement legality** (`preservesRouting`, `rotateConnections`), `tileSupply`, trays |
| **station slots per city**, city/town marker counts, drawn geometry | `components/TileGraphics.ts` — `TILE_GRAPHICS_CATALOG` markers; `tileCitySlotCounts` (:2207) "mirrored from `hexmap::tile_city_slot_counts`" | **`tileCentres` (rule 2)**, `stationSlotCount`, `citySlotCount`, `cityBlocking`, `planTokenUpgrade` |
| **the route graph's internal routing** | `TILE_GRAPHICS_CATALOG` again, via `artworkPathsForTraversal`; printed hexes via `printedArtwork(label)` / `printedPathsForTraversal` | `gameEngine/trackSegments.traversalSegments` (:229), `traversalsFrom`, `trackReach` |

**This is the architecture risk §13 of the brief named, and it is real but currently benign.** A tile's internal
routing is stated twice — `TileCatalogEntry.paths` and the artwork's rails — and the placement predicate reads one
while the route graph reads the other. `utils/cityTopology.test.ts` pins the two together for every two-city tile at
every orientation ("the circle drawn for city i lies on a rail whose edges the walk gives to city i"), and
`tileNumbering.test.ts:133` pins city/slot counts across the pair, so the duplication is currently *guarded*. It is
not *unified*, and the guard covers two-city tiles and counts — not the full path set of every tile.

### Static scan for duplicate / stale tile authority (§22 of the brief)

| Match | Classification |
|---|---|
| `hexTileCatalog.TILE_CATALOG` (76) | **authoritative** (topology), mirror of Rust with a load-time drift tripwire |
| `TileGraphics.TILE_GRAPHICS_CATALOG` (76) | **authoritative** (slots, centres, route rails) — *see the risk above* |
| `tileTray.ts` / `tileTrayPlus.ts` / `tileTrayLpf.ts` | **authoritative** (inventory), derived by delta from the catalog |
| `utils/tileUpgrades.ts` | **derived** — swept from the real filter, explicitly not a second table |
| `utils/tileSupply.ts` | **derived** — closed arithmetic over tray minus board; `printed: true` correctly excluded |
| `server/dist/frontend/src/**/*.js` (hexTileCatalog, TileGraphics, tileTray*, tileUpgrades, sandboxTileLegality, hexBoardData*) | **derived build output** — compiled copies. Not edited by hand; **do not delete** (build artefact), but they are a stale-authority hazard if anyone greps them. Worth a one-line note in the build docs, nothing more. |
| `components/TileReference.tsx`, `RulesReference.tsx` | **presentation-only**; `RulesReference`'s `TILE_KEY_HEX_SIZE` is a pixel size, not a tile id |
| `components/tileTransition*.ts`, `hexCanvasPrimitives.ts` | **presentation-only** (the VF-5 transition) |
| `utils/__fixtures__erieBoard.json`, `__fixtures__z6cBoard.json`, `replayGolden/*` | **test fixtures**; board state, no independent tile geometry |
| `gameEngine/dhPower.DH_TILE_ID = 57` | **authoritative, and correctly an OLD number** — the single hard-coded tile id in non-test code |
| `hexBoardDataPlus` `printedTile: { tileId: 24, orientation: 3 }` at H12 | **authoritative board data**, old number |

**Hard-coded tile-number conditionals in non-test code: none.** A regex sweep for `tile_id === N` / `tileId === N`
and for bare comparisons against every watched number returned only two false positives (path-string length checks
in `TileGraphics.ts:1891` and `tileTransition.ts:392`). **Modern Lookout identifiers in code: none.**

> **And they must stay out.** The Lookout new identifiers collide head-on with this board's hex labels: `A1`, `A9`,
> `A11`, `A17`, `A19`, `B10`, `B12`, `B16`, `B20`, `B24`, `C15`, `C21`, `C23`, `D2`, `D10`, `D14`, `D24` are all
> real hex labels in `hexBoardData`, and `C15` is *simultaneously* the Lookout name of tile #63 and the board label
> of Kingston. Adopting the new numbering into code would make `"C15"` ambiguous at every call site. The project's
> old-number convention is not merely a preference here — it is the only collision-free choice.

---

## §3 Old ↔ new tile-number crosswalk

**Source: Table T-09, "TRACK TILE MANIFEST & UPGRADES", p. 48 of the 48-page rulebook** (rendered at 200 dpi and
600 dpi; the table prints the new identifier in red with the old number directly beneath it, and two count columns,
`1830★` = Classic and `1830+` as a **delta** on it).

**Project convention, unchanged: the OLD / original number is the canonical human-facing identifier.** The Lookout
identifier appears here and in §4 as a cross-reference only, and must not enter code (§2).

The new identifiers are *family* names, which is why the mapping is not monotonic: `A…` yellow, `B…` green plain /
green city, `C…` brown, `bb…` the "B" (Baltimore **and** Boston) family, `ny…` New York, `oo…` the OO family,
`to…` Toronto, `D4` the gray city. **Every one of the 76 types in the engine's catalog appears in T-09, and every
T-09 row appears in the engine's catalog — the two sets are identical, in both directions.**

| Lookout # | Old # | Colour | Topology summary | Where used |
|---|---|---|---|---|
| oo14 | **#35** | Brown | 2 cities (slots [1, 1]), groups [[1,5],[0,4]], 4 exits | 1830+/LPF |
| oo13 | **#36** | Brown | 2 cities (slots [1, 1]), groups [[1,5],[2,4]], 4 exits | 1830+/LPF |
| C4 | **#39** | Brown | plain track, 3 exits [0, 1, 2], 3 segment(s) | Classic/1830+/LPF |
| C3 | **#40** | Brown | plain track, 3 exits [0, 2, 4], 3 segment(s) | Classic/1830+/LPF |
| C1 | **#41** | Brown | plain track, 3 exits [0, 1, 3], 3 segment(s) | Classic/1830+/LPF |
| C2 | **#42** | Brown | plain track, 3 exits [0, 3, 5], 3 segment(s) | Classic/1830+/LPF |
| C9 | **#43** | Brown | plain track, 4 exits [0, 1, 2, 3], 4 segment(s) | Classic/1830+/LPF |
| C6 | **#44** | Brown | plain track, 4 exits [0, 1, 3, 4], 4 segment(s) | Classic/1830+/LPF |
| C7 | **#45** | Brown | plain track, 4 exits [0, 2, 3, 4], 4 segment(s) | Classic/1830+/LPF |
| C8 | **#46** | Brown | plain track, 4 exits [0, 2, 3, 4], 4 segment(s) | Classic/1830+/LPF |
| C5 | **#47** | Brown | plain track, 4 exits [0, 1, 3, 4], 4 segment(s) | Classic/1830+/LPF |
| bb5 | **#61** | Brown | 1 city (1 slot(s)), 4 exits [0, 2, 3, 4] | Classic/1830+ |
| ny5 | **#62** | Brown | 2 cities (slots [2, 2]), groups [[0,1],[2,3]], 4 exits | Classic/1830+/LPF |
| C15 | **#63** | Brown | 1 city (2 slot(s)), 6 exits [0, 1, 2, 3, 4, 5] | Classic/1830+/LPF |
| oo16 | **#64** | Brown | 2 cities (slots [1, 1]), groups [[0,2],[3,4]], 4 exits | Classic/1830+/LPF |
| oo15 | **#65** | Brown | 2 cities (slots [1, 1]), groups [[0,4],[2,3]], 4 exits | Classic/1830+/LPF |
| oo12 | **#66** | Brown | 2 cities (slots [1, 1]), groups [[0,3],[1,2]], 4 exits | Classic/1830+/LPF |
| oo11 | **#67** | Brown | 2 cities (slots [1, 1]), groups [[0,3],[2,4]], 4 exits | Classic/1830+/LPF |
| oo10 | **#68** | Brown | 2 cities (slots [1, 1]), groups [[0,3],[1,4]], 4 exits | Classic/1830+/LPF |
| C10 | **#70** | Brown | plain track, 4 exits [0, 1, 2, 3], 4 segment(s) | Classic/1830+/LPF |
| C11 | **#145** | Brown | 1 town(s), 4 exits [0, 1, 3, 4] | 1830+/LPF |
| C13 | **#146** | Brown | 1 town(s), 4 exits [0, 1, 4, 5] | 1830+/LPF |
| C12 | **#147** | Brown | 1 town(s), 4 exits [1, 3, 4, 5] | 1830+/LPF |
| to5 | **#882** | Brown | 2 cities (slots [2, 2]), groups [[0,1,5],[2,3,4]], 6 exits | 1830+/LPF |
| ny6 | **#883** | Brown | 1 city (4 slot(s)), 4 exits [0, 1, 4, 5] | 1830+/LPF |
| bb6 | **#884** | Brown | 1 city (3 slot(s)), 4 exits [1, 3, 4, 5] | 1830+/LPF |
| oo17 | **#984** | Brown | 2 cities (slots [1, 1]), groups [[0,1],[4,5]], 4 exits | 1830+/LPF |
| bb7 | **#997** | Brown | 1 city (2 slot(s)), 4 exits [1, 3, 4, 5] | 1830+/LPF |
| oo20 | **#167** | Gray | 2 cities (slots [1, 1]), groups [[0,1,4],[2,3,5]], 6 exits | 1830+/LPF |
| D4 | **#513** | Gray | 1 city (3 slot(s)), 6 exits [0, 1, 2, 3, 4, 5] | 1830+/LPF |
| B35 | **#14** | Green | 1 city (2 slot(s)), 4 exits [0, 1, 3, 4] | Classic/1830+/LPF |
| B37 | **#15** | Green | 1 city (2 slot(s)), 4 exits [0, 1, 2, 3] | Classic/1830+/LPF |
| B5 | **#16** | Green | plain track, 4 exits [0, 1, 2, 3], 2 segment(s) | Classic/1830+/LPF |
| B4 | **#17** | Green | plain track, 4 exits [1, 2, 4, 5], 2 segment(s) | 1830+/LPF |
| B3 | **#18** | Green | plain track, 4 exits [0, 1, 2, 3], 2 segment(s) | Classic/1830+/LPF |
| B2 | **#19** | Green | plain track, 4 exits [0, 2, 3, 4], 2 segment(s) | Classic/1830+/LPF |
| B1 | **#20** | Green | plain track, 4 exits [0, 1, 3, 4], 2 segment(s) | Classic/1830+/LPF |
| B8 | **#23** | Green | plain track, 3 exits [0, 3, 4], 2 segment(s) | Classic/1830+/LPF |
| B9 | **#24** | Green | plain track, 3 exits [0, 2, 3], 2 segment(s) | Classic/1830+/LPF |
| B12 | **#25** | Green | plain track, 3 exits [0, 2, 4], 2 segment(s) | Classic/1830+/LPF |
| B10 | **#26** | Green | plain track, 3 exits [0, 3, 5], 2 segment(s) | Classic/1830+/LPF |
| B11 | **#27** | Green | plain track, 3 exits [0, 1, 3], 2 segment(s) | Classic/1830+/LPF |
| B13 | **#28** | Green | plain track, 3 exits [0, 4, 5], 2 segment(s) | Classic/1830+/LPF |
| B14 | **#29** | Green | plain track, 3 exits [0, 1, 2], 2 segment(s) | Classic/1830+/LPF |
| bb1 | **#53** | Green | 1 city (1 slot(s)), 3 exits [0, 2, 4] | Classic/1830+/LPF |
| ny1 | **#54** | Green | 2 cities (slots [1, 1]), groups [[0,1],[2,3]], 4 exits | Classic/1830+/LPF |
| oo2 | **#59** | Green | 2 cities (slots [1, 1]), groups [[0],[2]], 2 exits | Classic/1830+/LPF |
| B30 | **#87** | Green | 1 town(s), 4 exits [0, 1, 4, 5] | 1830+/LPF |
| B28 | **#88** | Green | 1 town(s), 4 exits [0, 1, 3, 4] | 1830+/LPF |
| B24 | **#141** | Green | 1 town(s), 3 exits [1, 3, 4] | 1830+/LPF |
| B25 | **#142** | Green | 1 town(s), 3 exits [1, 4, 5] | 1830+/LPF |
| B26 | **#143** | Green | 1 town(s), 3 exits [0, 1, 5] | 1830+/LPF |
| B27 | **#144** | Green | 1 town(s), 3 exits [1, 3, 5] | 1830+/LPF |
| B29 | **#204** | Green | 1 town(s), 4 exits [1, 3, 4, 5] | 1830+/LPF |
| bb2 | **#592** | Green | 1 city (2 slot(s)), 3 exits [0, 2, 4] | 1830+ |
| B36 | **#619** | Green | 1 city (2 slot(s)), 4 exits [1, 3, 4, 5] | 1830+/LPF |
| oo1 | **#626** | Green | 2 cities (slots [1, 1]), groups [[0,1],[3,4]], 4 exits | 1830+/LPF |
| to1 | **#810** | Green | 2 cities (slots [1, 2]), groups [[0,1,5],[2,3,4]], 6 exits | 1830+/LPF |
| A13 | **#1** | Yellow | 2 town(s), 4 exits [0, 1, 3, 4] | Classic/1830+/LPF |
| A12 | **#2** | Yellow | 2 town(s), 4 exits [0, 1, 2, 3] | Classic/1830+/LPF |
| A6 | **#3** | Yellow | 1 town(s), 2 exits [0, 1] | Classic/1830+/LPF |
| A4 | **#4** | Yellow | 1 town(s), 2 exits [0, 3] | Classic/1830+/LPF |
| A9 | **#5** | Yellow | 1 city (1 slot(s)), 2 exits [0, 1] | 1830+ |
| A8 | **#6** | Yellow | 1 city (1 slot(s)), 2 exits [1, 5] | 1830+ |
| A3 | **#7** | Yellow | plain track, 2 exits [0, 1], 1 segment(s) | Classic/1830+/LPF |
| A2 | **#8** | Yellow | plain track, 2 exits [0, 2], 1 segment(s) | Classic/1830+/LPF |
| A1 | **#9** | Yellow | plain track, 2 exits [0, 3], 1 segment(s) | Classic/1830+/LPF |
| A10 | **#55** | Yellow | 2 town(s), 4 exits [0, 1, 3, 4] | Classic/1830+/LPF |
| A14 | **#56** | Yellow | 2 town(s), 4 exits [0, 1, 2, 3] | Classic/1830+/LPF |
| A7 | **#57** | Yellow | 1 city (1 slot(s)), 2 exits [0, 3] | Classic/1830+/LPF |
| A5 | **#58** | Yellow | 1 town(s), 2 exits [0, 2] | Classic/1830+/LPF |
| A11 | **#69** | Yellow | 2 town(s), 4 exits [0, 2, 3, 4] | Classic/1830+/LPF |
| A15 | **#630** | Yellow | 2 town(s), 4 exits [0, 1, 2, 4] | 1830+/LPF |
| A16 | **#631** | Yellow | 2 town(s), 4 exits [0, 1, 2, 4] | 1830+/LPF |
| A17 | **#632** | Yellow | 2 town(s), 4 exits [2, 3, 4, 5] | 1830+/LPF |
| A18 | **#633** | Yellow | 2 town(s), 4 exits [0, 2, 3, 5] | 1830+/LPF |

### The one ambiguous mapping, and why it cannot matter

T-09 (p. 48) prints **A8 = old #6** and **A9 = old #5**. T-01 (p. 45) and S-1.1 ❻ (p. 35) both print **A8 (5)** and
**A9 (6)** — the two tables disagree with each other.

**Adjudicated as inconsequential, not as a stop condition.** #5 and #6 are both yellow `MajorCityHub`, both 1-slot,
both 0 in Classic and 2 in 1830+, both successors of exactly {#14, #619, #15}, and LPF removes **2 of each** — which
empties both regardless of which letter names which. No engine behaviour can depend on the mapping. The engine's own
assignment (#5 = exits {0,1}, #6 = exits {1,5} ≡ {0,2} up to rotation) matches the standard 18xx shapes for those
numbers, and #57 = {0,3} straight completes the trio.

---

## §4 Canonical tile manifest

One row per tile type, 76 rows. **Quantities are shown `rulebook/engine`** for each of the three trays.
Base live edges, paths and `cityGroups` are the engine's own base (pre-rotation) values in the board's edge
convention (`0 E, 1 NE, 2 NW, 3 W, 4 SW, 5 SE`); the rulebook's tile pictures are drawn flat-top, so only *shapes*
(gaps, relative arrangement) are comparable between the two, never absolute indices.
Slots come from `TILE_GRAPHICS_CATALOG` markers (`tileCitySlotCounts`); they were cross-read against the T-09
thumbnails for the whole B / OO / NY / TO family and agree everywhere legible (§9 records the per-tile check).

| Old # | Lookout # | Colour | Terrain tag | Cities | Slots/city | Towns | Rev | Base live edges | Paths (base) | cityGroups | Classic (rb/eng) | 1830+ (rb/eng) | LPF (rb/eng) | Legal successors (old #) | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **#1** | A13 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 1, 3, 4] | [[0,4],[1,3]] | — | 1/1 | 1/1 | 1/1 | #88 | MATCH |
| **#2** | A12 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 1, 2, 3] | [[0,3],[1,2]] | — | 1/1 | 1/1 | 1/1 | #87 | MATCH |
| **#3** | A6 | Yellow | SmallTown | 0 | — | 1 | 10 | [0, 1] | [[0,1]] | — | 2/2 | 2/2 | 2/2 | #141, #142, #143 | MATCH |
| **#4** | A4 | Yellow | SmallTown | 0 | — | 1 | 10 | [0, 3] | [[0,3]] | — | 2/2 | 2/2 | 2/2 | #141, #142 | MATCH |
| **#5** | A9 | Yellow | MajorCityHub | 1 | [1] | 0 | 20 | [0, 1] | [[0,1]] | — | 0/0 | 2/2 | 0/0 | #14, #619, #15 | MATCH |
| **#6** | A8 | Yellow | MajorCityHub | 1 | [1] | 0 | 20 | [1, 5] | [[1,5]] | — | 0/0 | 2/2 | 0/0 | #14, #619, #15 | MATCH |
| **#7** | A3 | Yellow | Plain | 0 | — | 0 | — | [0, 1] | [[0,1]] | — | 4/4 | 7/7 | 7/7 | #18, #26, #27, #28, #29 | MATCH |
| **#8** | A2 | Yellow | Plain | 0 | — | 0 | — | [0, 2] | [[0,2]] | — | 8/8 | 13/13 | 13/13 | #19, #17, #16, #23, #24, #25, #28, #29 | MATCH |
| **#9** | A1 | Yellow | Plain | 0 | — | 0 | — | [0, 3] | [[0,3]] | — | 7/7 | 12/12 | 12/12 | #20, #19, #18, #23, #24, #26, #27 | MATCH |
| **#14** | B35 | Green | MajorCityHub | 1 | [2] | 0 | 30 | [0, 1, 3, 4] | [[0,1],[0,3],[0,4],[1,3],[1,4],[3,4]] | — | 3/3 | 4/4 | 4/4 | #63 | MATCH |
| **#15** | B37 | Green | MajorCityHub | 1 | [2] | 0 | 30 | [0, 1, 2, 3] | [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]] | — | 2/2 | 4/4 | 4/4 | #63 | MATCH |
| **#16** | B5 | Green | Plain | 0 | — | 0 | — | [0, 1, 2, 3] | [[0,2],[1,3]] | — | 1/1 | 1/1 | 1/1 | #43, #70 | MATCH |
| **#17** | B4 | Green | Plain | 0 | — | 0 | — | [1, 2, 4, 5] | [[1,5],[2,4]] | — | 0/0 | 1/1 | 1/1 | #47 | MATCH |
| **#18** | B3 | Green | Plain | 0 | — | 0 | — | [0, 1, 2, 3] | [[0,3],[1,2]] | — | 1/1 | 1/1 | 1/1 | #43 | MATCH |
| **#19** | B2 | Green | Plain | 0 | — | 0 | — | [0, 2, 3, 4] | [[0,3],[2,4]] | — | 1/1 | 1/1 | 1/1 | #45, #46 | MATCH |
| **#20** | B1 | Green | Plain | 0 | — | 0 | — | [0, 1, 3, 4] | [[0,3],[1,4]] | — | 1/1 | 1/1 | 1/1 | #47, #44 | MATCH |
| **#23** | B8 | Green | Plain | 0 | — | 0 | — | [0, 3, 4] | [[0,3],[0,4]] | — | 3/3 | 3/3 | 3/3 | #41, #47, #45, #43 | MATCH |
| **#24** | B9 | Green | Plain | 0 | — | 0 | — | [0, 2, 3] | [[0,2],[0,3]] | — | 3/3 | 3/3 | 3/3 | #42, #47, #46, #43 | MATCH |
| **#25** | B12 | Green | Plain | 0 | — | 0 | — | [0, 2, 4] | [[0,2],[0,4]] | — | 1/1 | 1/1 | 1/1 | #40, #45, #46 | MATCH |
| **#26** | B10 | Green | Plain | 0 | — | 0 | — | [0, 3, 5] | [[0,3],[0,5]] | — | 1/1 | 1/1 | 1/1 | #42, #44, #45 | MATCH |
| **#27** | B11 | Green | Plain | 0 | — | 0 | — | [0, 1, 3] | [[0,1],[0,3]] | — | 1/1 | 1/1 | 1/1 | #41, #44, #46 | MATCH |
| **#28** | B13 | Green | Plain | 0 | — | 0 | — | [0, 4, 5] | [[0,4],[0,5]] | — | 1/1 | 1/1 | 1/1 | #39, #46, #70 | MATCH |
| **#29** | B14 | Green | Plain | 0 | — | 0 | — | [0, 1, 2] | [[0,1],[0,2]] | — | 1/1 | 1/1 | 1/1 | #39, #45, #70 | MATCH |
| **#35** | oo14 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [0, 1, 4, 5] | [[1,5],[0,4]] | [[1,5],[0,4]] | 0/0 | 1/1 | 1/1 | #167 | MATCH |
| **#36** | oo13 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [1, 2, 4, 5] | [[1,5],[2,4]] | [[1,5],[2,4]] | 0/0 | 1/1 | 1/1 | #167 | AMBIGUOUS(geom) |
| **#39** | C4 | Brown | Plain | 0 | — | 0 | — | [0, 1, 2] | [[0,1],[0,2],[1,2]] | — | 1/1 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#40** | C3 | Brown | Plain | 0 | — | 0 | — | [0, 2, 4] | [[0,2],[0,4],[2,4]] | — | 1/1 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#41** | C1 | Brown | Plain | 0 | — | 0 | — | [0, 1, 3] | [[0,1],[0,3],[1,3]] | — | 2/2 | 2/2 | 2/2 | — (terminal) | MATCH |
| **#42** | C2 | Brown | Plain | 0 | — | 0 | — | [0, 3, 5] | [[0,3],[0,5],[3,5]] | — | 2/2 | 2/2 | 2/2 | — (terminal) | MATCH |
| **#43** | C9 | Brown | Plain | 0 | — | 0 | — | [0, 1, 2, 3] | [[0,2],[0,3],[1,2],[1,3]] | — | 2/2 | 2/2 | 2/2 | — (terminal) | MATCH |
| **#44** | C6 | Brown | Plain | 0 | — | 0 | — | [0, 1, 3, 4] | [[0,1],[0,3],[1,4],[3,4]] | — | 1/1 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#45** | C7 | Brown | Plain | 0 | — | 0 | — | [0, 2, 3, 4] | [[0,3],[0,4],[2,3],[2,4]] | — | 2/2 | 2/2 | 2/2 | — (terminal) | MATCH |
| **#46** | C8 | Brown | Plain | 0 | — | 0 | — | [0, 2, 3, 4] | [[0,2],[0,3],[2,4],[3,4]] | — | 2/2 | 2/2 | 2/2 | — (terminal) | MATCH |
| **#47** | C5 | Brown | Plain | 0 | — | 0 | — | [0, 1, 3, 4] | [[0,3],[0,4],[1,3],[1,4]] | — | 1/1 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#53** | bb1 | Green | BostonHub | 1 | [1] | 0 | 50 | [0, 2, 4] | [[0,2],[0,4],[2,4]] | — | 2/2 | 2/2 | 2/2 | #61, #884, #997 | MATCH |
| **#54** | ny1 | Green | NewYorkHub | 2 | [1,1] | 0 | 60 | [0, 1, 2, 3] | [[0,1],[2,3]] | [[0,1],[2,3]] | 1/1 | 1/1 | 1/1 | #62, #883 | MATCH |
| **#55** | A10 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 1, 3, 4] | [[0,3],[1,4]] | — | 1/1 | 1/1 | 1/1 | #88 | MATCH |
| **#56** | A14 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 1, 2, 3] | [[0,2],[1,3]] | — | 1/1 | 1/1 | 1/1 | #87 | MATCH |
| **#57** | A7 | Yellow | MajorCityHub | 1 | [1] | 0 | 20 | [0, 3] | [[0,3]] | — | 4/4 | 6/6 | 6/6 | #14, #619, #15 | MATCH |
| **#58** | A5 | Yellow | SmallTown | 0 | — | 1 | 10 | [0, 2] | [[0,2]] | — | 2/2 | 2/2 | 2/2 | #141, #142, #143, #144 | MATCH |
| **#59** | oo2 | Green | DoubleCityHub | 2 | [1,1] | 0 | 40 | [0, 2] | [[0,0],[2,2]] | [[0],[2]] | 2/2 | 3/3 | 3/3 | **#64, #65, #66, #67, #68** (revised p. 19) + #984; **oo13 / oo14 unreachable — every facing would connect #59's two pre-printed exits, banned by 6.2.2 ❹** | MATCH |
| **#61** | bb5 | Brown | BostonHub | 1 | [1] | 0 | 60 | [0, 2, 3, 4] | [[0,2],[0,3],[0,4],[2,3],[2,4],[3,4]] | — | 2/2 | 2/2 | 0/0 | — (terminal) | MATCH |
| **#62** | ny5 | Brown | NewYorkHub | 2 | [2,2] | 0 | 90 | [0, 1, 2, 3] | [[0,1],[2,3]] | [[0,1],[2,3]] | 1/1 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#63** | C15 | Brown | MajorCityHub | 1 | [2] | 0 | 40 | [0, 1, 2, 3, 4, 5] | [[0,1],[0,2],[0,3],[0,4],[0,5],[1,2],[1,3],[1,4],[1,5],[2,3],[2,4],[2,5],[3,4],[3,5],[4,5]] | — | 3/3 | 4/1 | 4/1 | #513 | MISMATCH(qty) |
| **#64** | oo16 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [0, 2, 3, 4] | [[0,2],[3,4]] | [[0,2],[3,4]] | 1/1 | 1/1 | 1/1 | #167 | MATCH |
| **#65** | oo15 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [0, 2, 3, 4] | [[0,4],[2,3]] | [[0,4],[2,3]] | 1/1 | 1/1 | 1/1 | #167 | MATCH |
| **#66** | oo12 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [0, 1, 2, 3] | [[0,3],[1,2]] | [[0,3],[1,2]] | 1/1 | 1/1 | 1/1 | #167 | MATCH |
| **#67** | oo11 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [0, 2, 3, 4] | [[0,3],[2,4]] | [[0,3],[2,4]] | 1/1 | 1/1 | 1/1 | #167 | MATCH |
| **#68** | oo10 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [0, 1, 3, 4] | [[0,3],[1,4]] | [[0,3],[1,4]] | 1/1 | 1/1 | 1/1 | #167 | MATCH |
| **#69** | A11 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 2, 3, 4] | [[0,3],[2,4]] | — | 1/1 | 1/1 | 1/1 | #204 | MATCH |
| **#70** | C10 | Brown | Plain | 0 | — | 0 | — | [0, 1, 2, 3] | [[0,1],[0,2],[1,3],[2,3]] | — | 1/1 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#87** | B30 | Green | SmallTown | 0 | — | 1 | 10 | [0, 1, 4, 5] | [[0,1],[0,4],[0,5],[1,4],[1,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | #146 | MATCH |
| **#88** | B28 | Green | SmallTown | 0 | — | 1 | 10 | [0, 1, 3, 4] | [[0,1],[0,3],[0,4],[1,3],[1,4],[3,4]] | — | 0/0 | 1/1 | 1/1 | #145 | MATCH |
| **#141** | B24 | Green | SmallTown | 0 | — | 1 | 10 | [1, 3, 4] | [[1,3],[1,4],[3,4]] | — | 0/0 | 1/1 | 1/1 | #145, #147, #146 | MATCH |
| **#142** | B25 | Green | SmallTown | 0 | — | 1 | 10 | [1, 4, 5] | [[1,4],[1,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | #145, #147, #146 | MATCH |
| **#143** | B26 | Green | SmallTown | 0 | — | 1 | 10 | [0, 1, 5] | [[0,1],[0,5],[1,5]] | — | 0/0 | 1/1 | 1/1 | #147, #146 | MATCH |
| **#144** | B27 | Green | SmallTown | 0 | — | 1 | 10 | [1, 3, 5] | [[1,3],[1,5],[3,5]] | — | 0/0 | 1/1 | 1/1 | #147 | MATCH |
| **#145** | C11 | Brown | SmallTown | 0 | — | 1 | 20 | [0, 1, 3, 4] | [[0,1],[0,3],[0,4],[1,3],[1,4],[3,4]] | — | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#146** | C13 | Brown | SmallTown | 0 | — | 1 | 20 | [0, 1, 4, 5] | [[0,1],[0,4],[0,5],[1,4],[1,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#147** | C12 | Brown | SmallTown | 0 | — | 1 | 20 | [1, 3, 4, 5] | [[1,3],[1,4],[1,5],[3,4],[3,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#167** | oo20 | Gray | DoubleCityHub | 2 | [1,1] | 0 | 70 | [0, 1, 2, 3, 4, 5] | [[0,1],[0,4],[1,4],[2,3],[2,5],[3,5]] | [[0,1,4],[2,3,5]] | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#204** | B29 | Green | SmallTown | 0 | — | 1 | 10 | [1, 3, 4, 5] | [[1,3],[1,4],[1,5],[3,4],[3,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | #147 | MATCH |
| **#513** | D4 | Gray | MajorCityHub | 1 | [3] | 0 | 60 | [0, 1, 2, 3, 4, 5] | [[0,1],[0,2],[0,3],[0,4],[0,5],[1,2],[1,3],[1,4],[1,5],[2,3],[2,4],[2,5],[3,4],[3,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#592** | bb2 | Green | BostonHub | 1 | [2] | 0 | 50 | [0, 2, 4] | [[0,2],[0,4],[2,4]] | — | 0/0 | 2/2 | 0/0 | #61, #884, #997 | MATCH |
| **#619** | B36 | Green | MajorCityHub | 1 | [2] | 0 | 30 | [1, 3, 4, 5] | [[1,3],[1,4],[1,5],[3,4],[3,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | #63 | MATCH |
| **#8861** *(oo1; ~~#626~~)* | oo1 | Green | DoubleCityHub | 2 | [1,1] | 0 | 40 | [0, 1, 3, 4] | [[0,1],[3,4]] | [[0,1],[3,4]] | 0/0 | 1/1 | 1/1 | **— none: *"Tile oo1 (8861) is not upgradable"* (errata); T-09's successor row is erroneous material** | **MATCH [9.1c]** |
| **#630** | A15 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 1, 2, 4] | [[1,2],[0,4]] | — | 0/0 | 1/1 | 1/1 | #204 | MATCH |
| **#631** | A16 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 1, 2, 4] | [[0,1],[2,4]] | — | 0/0 | 1/1 | 1/1 | #204 | MATCH |
| **#632** | A17 | Yellow | DoubleTown | 0 | — | 2 | 10 | [2, 3, 4, 5] | [[2,3],[4,5]] | — | 0/0 | 1/1 | 1/1 | #87 | MATCH |
| **#633** | A18 | Yellow | DoubleTown | 0 | — | 2 | 10 | [0, 2, 3, 5] | [[2,3],[0,5]] | — | 0/0 | 1/1 | 1/1 | #88 | MATCH |
| **#810** | to1 | Green | TorontoHub | 2 | [1,2] | 0 | 50 | [0, 1, 2, 3, 4, 5] | [[0,1],[0,5],[1,5],[2,3],[2,4],[3,4]] | [[0,1,5],[2,3,4]] | 0/0 | 1/1 | 0/1 | #882 | MISMATCH(qty) |
| **#882** | to5 | Brown | TorontoHub | 2 | [2,2] | 0 | 70 | [0, 1, 2, 3, 4, 5] | [[0,1],[0,5],[1,5],[2,3],[2,4],[3,4]] | [[0,1,5],[2,3,4]] | 0/0 | 1/1 | 0/1 | — (terminal) | MISMATCH(qty) |
| **#883** | ny6 | Brown | NewYorkHub | 1 | [4] | 0 | 90 | [0, 1, 4, 5] | [[0,1],[0,4],[0,5],[1,4],[1,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#884** | bb6 | Brown | BostonHub | 1 | [3] | 0 | 60 | [1, 3, 4, 5] | [[1,3],[1,4],[1,5],[3,4],[3,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |
| **#984** | oo17 | Brown | DoubleCityHub | 2 | [1,1] | 0 | 50 | [0, 1, 4, 5] | [[0,1],[4,5]] | [[0,1],[4,5]] | 0/0 | 1/1 | 1/1 | #167 | MATCH |
| **#997** | bb7 | Brown | BostonHub | 1 | [2] | 0 | 60 | [1, 3, 4, 5] | [[1,3],[1,4],[1,5],[3,4],[3,5],[4,5]] | — | 0/0 | 1/1 | 1/1 | — (terminal) | MATCH |

### Totals, reconciled against T-09's own footer

| | Yellow | Green | Brown | Gray | Total |
|---|---|---|---|---|---|
| T-09 Classic (`1830★`) | 34 | 25 | 26 | 0 | **85** |
| T-09 1830+ delta | +23 | +17 | +11 | +2 | **+53** |
| T-09 1830+ total | 57 | 42 | 37 | 2 | **138** |
| Engine `STANDARD_TRAY` | 34 | 25 | 26 | 0 | **85** ✓ |
| Engine `PLUS_TRAY` | 57 | 42 | 34 | 2 | **135** — 3 short (**F-4**, #63) |
| Engine `LPF_TRAY` | 53 | 40 | 32 | 2 | **127** — rulebook 128 (−3 for F-4, +2 for the #810/#882 owner ruling) |
| Distinct types | 12 / 18 | 16 / 28 | 18 / 28 | 0 / 2 | **46 Classic / 76 total** ✓ both |

Classic reconciles **exactly, tile for tile, all 46 types and all 85 copies.** The distinct-type counts also match
the catalog's own section comments ("Yellow tier (12 tiles)", "Green tier (16 tiles)", "Brown tier (18 tiles)")
and `TILE_CATALOG_SIZE = 76`.

**[9.1c] #63's 1830+ count is now confirmed by component evidence.** The errata's correction sheet instructs
*"40 value added to 1830+ side of **all four** C15 tiles"* — four physical #63 tiles on the 1830+ side, which is
exactly T-09's `3 +1`. The engine's `PLUS_TRAY` holds **1**. S9-15 no longer rests on reading a "+1" column, and
9.1b's suggestion to seek owner confirmation before fixing it is withdrawn.

**Aliasing risk (§18 of the brief): none found.** No old/new alias pair exists in the catalog — every entry is keyed
on the old number, `TILE_CATALOG_BY_ID` is built from those keys with a duplicate-id tripwire, the trays key on the
same ids, and `tileStock`/`filterSandboxPlacements` both count `tile.tile_id === tileId && tile.printed !== true`.
There is no path by which one physical pile could be counted as two.

---

## §5 Printed-board hex manifest

Printed topology lives in four separate tables, and only the first is even *partly* visible to the lay predicate:

| Table | What it holds | Seen by `filterSandboxPlacements`? | Seen by the route graph? |
|---|---|---|---|
| `BoardHex.printedTile` (design note #1301) | a real catalog tile printed on the hex, realised as a `MapTileEntry` flagged `printed` by `initialGridFor` | **YES** — it is a laid tile, so rule 5 applies | yes |
| `LANDMARK_TRACKS` (`hexBoardData.ts:35`) | Baltimore / Boston / New York printed rails, one entry per city | **only its city *count***, via `archetypeForHex` → `hexCentres`. The **edges are not read** | yes (`printedPathsForTraversal`, plus the explicit `G19` arm in `trackSegments.ts:264`) |
| `GRAY_HEXES` / `grayHexes` | printed gray-hex rails + marker + `slots` | **NO** | yes (`printedArtwork(label)`) |
| `OFFBOARD_TRACKS` | red off-board stubs | **NO** | yes |

`sandboxTileLegality.ts` imports from `hexBoardData` exactly `IMPASSABLE_BORDER_EDGES, LANDMARK_HEXES,
STATIC_BOARD_HEXES, TO_HEXES, YELLOW_OO_HEXES, boardMemo` and mentions `printedColor` only to build
`preprintedTierByLabel` for `"Yellow"` hexes. **It contains no reference to `GRAY_HEXES`, `RedOffboard`, `"Coal"`,
`LANDMARK_TRACKS` or station `slots`.** That single import line is the whole of F-1 and F-2.

### Restricted / preprinted hexes, all three boards

| Hex | Name | Board(s) | Printed | Cities × slots | Printed exits | Disconnected systems | Label | Tier | Engine representation | Rule 5 sees printed topology? | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **I15** | Baltimore | std / exp / LPF | yellow landmark | 1 × 1 | {0, 4} (one system) | no | `B` | Yellow (rank 0) | `LANDMARK_TRACKS.Baltimore = [{edges:[0,4]}]`; `printedColor:"Yellow"` | **NO** — but masked (§9) | MATCH (incidental) |
| **E23** | Boston | std / exp / LPF | yellow landmark | 1 × 1 | {1, 5} (one system) | no | `B` | Yellow | `LANDMARK_TRACKS.Boston = [{edges:[1,5]}]` | **NO** — but masked | MATCH (incidental) |
| **G19** | New York & Newark | std / exp / LPF | yellow landmark | 2 × 1 | {1} and {4} | **YES — two spurs, no joining track** | `NY` | Yellow | `LANDMARK_TRACKS["New York"] = [{edges:[1]},{edges:[4]}]`; `type:"River"` (#71) | **NO** — but masked, and *over*-masked | MATCH, over-strict (§9) |
| **E5** | Detroit & Windsor | std / exp / LPF | yellow OO | 2 × 1 | **none** | n/a (no track at all) | `OO` | Yellow | `YELLOW_OO_HEXES`; `type:"River"` | nothing to preserve | MATCH |
| **E11** | Dunkirk & Buffalo | std / exp / LPF | yellow OO | 2 × 1 | **none** | n/a | `OO` | Yellow | `YELLOW_OO_HEXES`; ERIE home, token before track | nothing to preserve | MATCH |
| **H18** | Philadelphia & Trenton | std / exp / LPF | yellow OO | 2 × 1 | **none** | n/a | `OO` | Yellow | `YELLOW_OO_HEXES`; C&A's H18 power | nothing to preserve | MATCH |
| **D10** | Hamilton & Toronto | std = `OO`; exp/LPF = **`TO`** | yellow OO | 2 × 1 | **none** | n/a | `OO` → `TO` | Yellow | in **both** `YELLOW_OO_HEXES` and `torontoHexes`; `hexLabelRestriction` asks TO first (#1317) | nothing to preserve | MATCH |
| **H12** | Altoona / PRR herald | std = gray city {0,3} + bypass; **exp/LPF = printed green #24 @3 + herald** | gray → printed tile | 1 × 1 → 0 | {0,3} → #24's | yes (the real bypass fork) | — | Gray → **Green** | `printedTile {24,3}`, `herald {1,$10}` (#1301/#1302) | **YES on exp/LPF** (it is a `MapTileEntry`); **NO on std** | MATCH on exp/LPF; **F-1 on std** |
| **F6** | Cleveland | std / exp / LPF | gray city | 1 × 1 | {4,5} | no | — | fixed | `GRAY_HEXES.F6` | **NO** | **F-1 / F-2** |
| **D14** | Rochester | all | gray city | 1 × 1 | {0,3,4} | no (3 spokes, all joined) | — | fixed | `GRAY_HEXES.D14` | **NO** | **F-1 / F-2** |
| **D2** | Lansing | all | gray city | 1 × 1 | {0,5} | no | — | fixed | `GRAY_HEXES.D2` | **NO** (0 lays survive `staysOnBoard`) | F-1 latent |
| **A19** | Montreal | std {4,5} 1 slot; exp/LPF {2,3,4} 1 slot (#1401) | gray city | 1 × 1 | per board | no | — | fixed | `GRAY_HEXES.A19`, `PLUS_GRAY.A19` | **NO** (0 lays survive) | F-1 latent |
| **A17** | connector | std {4,5}; exp/LPF {1,2,3} pairwise | gray, no city | 0 | per board | no | — | fixed | `GRAY_HEXES.A17` | **NO** | **F-1 / F-2** |
| **E9** | connector | all | gray, no city | 0 | {1,2} | no | — | fixed | `GRAY_HEXES.E9` | **NO** | **F-1 / F-2** |
| **D24** | connector | all | gray, no city | 0 | {3,4} | no | — | fixed | `GRAY_HEXES.D24` | **NO** | **F-1 / F-2** |
| **C15** | Kingston | all | gray town | 0 | {1,3} | no | — | fixed | `GRAY_HEXES.C15` | **NO** | **F-1 / F-2** |
| **I19** | Atlantic City | std {2,3}; exp/LPF {3,4,5} | gray town | 0 | per board | no | — | fixed | `GRAY_HEXES.I19` | **NO** | F-1 |
| **F24** | Fall River (house name for Mansfield) | all | gray town | 0 | {2,3} | no | — | fixed | `GRAY_HEXES.F24` | **NO** | F-1 |
| **K15** | Richmond (std) / River (exp/LPF) | std gray city {2} dead-end stub; **exp/LPF River, buildable** | gray → plain | 1 × 1 → 0 | {2} → none | no | — | fixed → open | reclassified by `hexBoardDataPlus` | **NO** on std | F-1 latent (std only) |
| **L16** | Norfolk | exp / LPF | gray city, 1 slot (#1401) | 1 × 1 | {4,5,0} | no | — | fixed | `PLUS_GRAY.L16`; N&W home | **NO** | F-1 |
| **K13** | Richmond | **exp/LPF only** — a real Plain `cityDesignation` hex (was the Deep South red area) | blank city | 1 × 1 | none | no | — | tan | `hex("K13",{Plain,cityDesignation})` | n/a (buildable by the rules) | MATCH |
| **L8** | Coalfields / Coal River | **LPF only** | `printedColor:"Coal"` + gray town, 5 stubs | 0 (never tokenable) | {2,1,0,3,5} | no | — | fixed | `COAL_RIVER_*`, `revenueTiers` | **NO** | **F-1** (a lay here would delete the licence hex) |
| **M13 / L2 / F2 / A11 / B24** | warehouses | **LPF only** | red, `warehouse:true`, gray-town marker, spokes to a central dit | 0 | 3/3/3/3/2 | no | — | fixed | `LPF_WAREHOUSES` (#1320/#1321) | **NO** | **F-1** |
| **K1 / A9** | former region partners | **LPF only** | gray connector curves | 0 | {1,5} / {5,0} | no | — | fixed | `LPF_GRAY.K1/.A9` | **NO** | F-1 |
| **M11** | — | **LPF** | **should carry printed straight track (A-1 = old #9), T-02 / S-1.1 ❷** | 0 | should be {0,3} joining M9↔M13 | no | — | should be Yellow | `hex("M11",{type:"Plain"})` — **no `printedTile`** | n/a | **F-6 MISSING** |
| **F16** | Scranton (D&H) | all | Mountain + `cityDesignation` | 1 × 1 | none | no | — | tan | `DH_HEX_LABEL`, `DH_TILE_ID = 57` | n/a | MATCH |
| **E19** | Albany (NYC home, house rule #44) | all | Plain + `cityDesignation`, $0 | 1 × 1 | none | no | — | tan | `STATION_HOME_HEXES` | n/a | MATCH |
| **B20** | Plattsburgh & Burlington (CSL) | std Plain; exp/LPF `townDesignation:"double"` | blank / double town | 0 | none | no | — | tan | `CSL_HEX_LABEL`, `privateReservations` | n/a | MATCH |
| **G15 / D18 / I13** | SV / M&H / B&O hexes | all | plain, no print | 0 | none | no | — | tan | plain `BoardHex` | n/a | MATCH |

### F-1 / F-2 reproduction table — standard board

`filterSandboxPlacements` accepted lays on hexes where 1830 permits no tile, computed by a faithful static
re-implementation of rules 0a/0b, 1, 2, 3, 4, 4b, 4c, 5 (method and recipe in §Appendix B):

| Hex | Kind | Printed exits | Accepted (tile, facings) | Accepted lays | …that delete printed track |
|---|---|---|---|---|---|
| E9 | gray connector | {1,2} | #7, #8, #9 × all 6 | 18 | 17 |
| C15 | gray town | {1,3} | #3, #4, #58 × all 6 | 18 | 17 |
| F6 | gray city | {4,5} | #57 × all 6 | 6 | 6 |
| D14 | gray city | {0,3,4} | #57 × all 6 | 6 | 6 |
| H12 | gray city (std) | {0,3} | #57 × all 6 | 6 | 4 |
| A17 | gray connector | {4,5} | #7 @{4,5}, #8 @{4} | 3 | 2 |
| D24 | gray connector | {3,4} | #7 @{2,3}, #8 @{2} | 3 | 2 |
| I19 | gray town | {2,3} | #3 @{2} | 1 | 0 |
| F24 | gray town | {2,3} | #3 @{2} | 1 | 0 |
| D2, K15, A19 | gray city | — | none survive `staysOnBoard` | 0 | 0 |
| A9, A11, B24, F2, I1, J2, K13 | **red off-board** | stubs | #7 / #8 at rim-legal facings | **17** | n/a — no tile may ever be laid |
| | | | | **79 total** | **54** |

The gray-city rows are #57 only because `RESTRICTED_TERRAINS` keeps `BostonHub`/`NewYorkHub`/`DoubleCityHub`/
`TorontoHub` off an unlabelled hex — so city *count* parity is incidentally right even here. What is missing is not
parity; it is the hex being off-limits at all.

### The rule exists — in Rust — and did not survive the migration

This is the finding's sharpest form, and it makes F-1 a **regression with a reference implementation** rather than a
missing rule:

| Layer | Refuses a lay on a gray / red hex? | Evidence |
|---|---|---|
| **CosmWasm contract** | **YES, by name, with a test** | `src/hexmap.rs:2317` `OffboardHexNotBuildable` ("Off-Board Reservation", module doc #14) and `:2331` `GrayHexNotUpgradeable` ("Gray Hex Immutability … a preprinted GRAY hex's real starting track is permanent -- nothing may ever be laid here", module doc #19); the variants are declared at `:1405` / `:1354`, the legal-placement query mirrors both at `:1976` / `:1985`, and `src/tests.rs:5205` asserts the gray refusal |
| **Node server / replay (the current authority)** | **NO** | `server/src/gameServer.ts:356` and `server/src/replayCli.ts:101` both build sessions with `sandboxReplayProviders()`, whose `layRefused` is `filterSandboxPlacements` **alone** (`replayProviders.ts:72`) |
| **Browser shell** | **NO** at the predicate | `App.tsx:6082` — `operatingIdentityRefusal ‖ authoritativeHoldRefusal ‖ filterSandboxPlacements` |
| **Browser UI** | yes, for clicks and the glow | `evaluateHexForTileLaying` via `HexGridRenderer.tsx:3476`, `App.tsx:3117`, `trackReach.ts:579` |

So the rule was enforced when the contract had the last word, and the authority moved out from under it.
`sandboxTileLegality.ts`'s own design note #0 is candid about the original scope — *"a filter that exists only where
no authority is reachable cannot drift from an authority"* — and that premise expired when the Node server became
the authority. **Slice 9.2 should port `hexmap.rs`'s two checks in their Rust order** (off-board first, then gray,
both ahead of every geometric rule), which is also the order `evaluateHexForTileLaying` already uses.

**One more inert gate, recorded and deliberately not filed as a Stage-9 defect.** The authoritative call site passes
only `{ mapGrid, q, r, era }` — **no `networkHexes`/`networkPorts`** — so rule 6 (`orientationJoinsNetwork`) never
runs authoritatively either, and `filterSandboxPlacements`'s own doc says so on purpose: *"What this deliberately
does NOT check … network connectivity, city reservation for unfloated home hexes, and tray depletion."* That was a
correct boundary for a sandbox-only filter and is now load-bearing for the same reason F-1 is. It is a
**route/connectivity** concern rather than a topology one, so it is kept out of this audit's findings to avoid
conflating the classes — but it belongs in **S10** beside S10-1, and Slice 9.2 should not silently "fix" it while
passing the merged topology in.

**Prior audit row resolved.** `AUDIT_RULES_TO_MACHINE_2026-09-13.md` §F row "No tiles on gray/red" was
`UNCLEAR — could not confirm an explicit refusal in the engine for a bare LayTile on a gray hex`. It is now
confirmed: **there is none on the authoritative path**, and the count is 79. That row is the one factually stale
entry and is updated by this pass.

---

## §5b Errata-corrected tile values, and oo20 verified **[9.1b]**

Three 1830+ tiles are named in the errata as carrying value 50 where 40 is correct. The engine honours one and not
the other two.

| Lookout | Engine id | Engine `revenue` | Errata text | Verdict |
|---|---|---|---|---|
| **C15** | #63 | **40** | *"The C15 (63) tiles have the wrong value. The value should be 40, instead of 50."* | **PASS** — already errata-correct |
| **oo13** | ~~#36~~ | **50** | *"oo13 (36) should have a number that is NOT 36… **(it has a vaue of 40 rather than 50)**"* | **MISMATCH → S9-20** |
| **oo14** | ~~#35~~ | **50** | *"oo14 (35) should have a number that is NOT 35… **(it has a value of 40 rather than 50)**"* | **MISMATCH → S9-20** |

Pinned at `plusTiles.test.ts:160` — `for (const id of [36, 35, 984]) expect(tile(id).revenue).toBe(50)` — so a
correction moves a test. Note the errata does **not** name **oo17** (#984), whose 50 therefore stands.

**[9.1c] S9-20 IS WITHDRAWN — NOT A DEFECT.** The owner's authoritative physical-tile transcription gives
**oo13 $50** and **oo14 $50**; the corrected tile art shows 50; the engine has `revenue: 50` for both. The errata's
parenthetical *"(it has a value of 40 rather than 50)"* is therefore **not** a value correction — it is a
distinguishing remark, and an inaccurate one. **No revenue change is owed, no test moves, and no log is re-pinned
for it.** The paragraphs below are retained only to show how the earlier reading arose.

~~**[9.1c] THE CORRECTED ART CONTESTS THIS FINDING.**~~ The replacement tile sheet (§1b-ii) was rendered and the
corrected **oo13** and **oo14** faces each show a **"50"** value roundel in frame — and the corrected **oo11 (67)**
and **oo16 (64)** beside them each show **two** roundels, one per city, both **50**, which is how an OO tile is
badged. So either the errata's parenthetical is a *distinguishing remark* rather than a correction, or the roundel
seen was the second city's. The sheet's only explicit value instruction is for a different tile —
*"40 value added to 1830+ side of all four C15 tiles"* — and it is phrased as an instruction, which the
oo13/oo14 parentheticals are not. **S9-20 is therefore downgraded from "probable engine defect" to "contested".
Do not act on it until both roundels on both tiles are read.** Reading them needs the same render §8c needs.

**One honest caveat on the grammar.** The oo13/oo14 parentheticals are phrased as observations, not as the
imperative the C15 entry uses ("The value should be 40, instead of 50"). Two readings are possible: (i) they are
value errata in the same 50 → 40 family as C15 — the reading this audit recommends, because the three sit in the
same document about the same tile sheet and the same wrong number; or (ii) they are *distinguishing remarks*, telling
a reader which physical tile is meant given that no old number identifies it. Reading (ii) would still leave the
engine's 50 unverified rather than confirmed, since under (ii) the printed value is 40 either way. **Both readings
point at 40; they differ only in how certain that is.** Filed as S9-20 with this note, resolvable from the same
replacement tile sheet that §8c needs.

**oo20 / #167 verified.** The errata does not touch it: no numbering item, no value item, no upgrade retraction.
#167 is a real 18xx tile number and survives as the canonical old number for oo20. Its engine record — Gray,
`DoubleCityHub`, all six edges live, two 1-slot cities `[[0,1,4],[2,3,5]]`, revenue 70, 1 copy, `plusOnly` — is
consistent with T-09 (`oo20`, old 167, 0 Classic, +1) and, per §8c, **already achieves the maximum T-09 conformance
of any possible two-city split.** No change owed.

**And the general rule, not #59's rule, governs `ooNN → oo20`.** Authority A's #59 clause is specific to a (59)
tile's pre-printed exits; it is not a property of the OO family. For `oo13/oo14/oo17/#64-#68 → oo20` the test is the
general one — all existing track survives, and every station lands on a city with the same connections. Applied to
the engine's records, seven of the eight source tiles satisfy it; the exception is oo13 and its cause is §8c, not a
mis-generalised #59 rule.

---

## §6 The legal upgrade graph

**127 directed edges**, transcribed from T-09's Upgrades column (p. 48) and cross-checked against the Base-Game
charts on p. 19. Availability per ruleset is decided by the *tray*, not by membership: a destination with 0 copies in
a tray is unreachable there, which is how Classic correctly has no green town at all (#1/#2/#55/#56/#69 are dead
ends, exactly as `utils/tileUpgrades.ts`'s own module doc reports).

| Source (old #) | Lookout | Legal destinations (old #) | Engine reaches them? |
|---|---|---|---|
| **#1** | A13 | #88 | yes |
| **#2** | A12 | #87 | yes |
| **#3** | A6 | #141, #142, #143 | yes |
| **#4** | A4 | #141, #142 | yes |
| **#5** | A9 | #14, #619, #15 | yes |
| **#6** | A8 | #14, #619, #15 | yes |
| **#7** | A3 | #18, #26, #27, #28, #29 | yes |
| **#8** | A2 | #19, #17, #16, #23, #24, #25, #28, #29 | yes |
| **#9** | A1 | #20, #19, #18, #23, #24, #26, #27 | yes |
| **#14** | B35 | #63 | yes |
| **#15** | B37 | #63 | yes |
| **#16** | B5 | #43, #70 | yes |
| **#17** | B4 | #47 | yes |
| **#18** | B3 | #43 | yes |
| **#19** | B2 | #45, #46 | yes |
| **#20** | B1 | #47, #44 | yes |
| **#23** | B8 | #41, #47, #45, #43 | yes |
| **#24** | B9 | #42, #47, #46, #43 | yes |
| **#25** | B12 | #40, #45, #46 | yes |
| **#26** | B10 | #42, #44, #45 | yes |
| **#27** | B11 | #41, #44, #46 | yes |
| **#28** | B13 | #39, #46, #70 | yes |
| **#29** | B14 | #39, #45, #70 | yes |
| **#35** | oo14 | #167 | yes |
| **#36** | oo13 | #167 **NO FACING** | NO — see F-3 |
| **#53** | bb1 | #61, #884, #997 | yes |
| **#54** | ny1 | #62, #883 | yes |
| **#55** | A10 | #88 | yes |
| **#56** | A14 | #87 | yes |
| **#57** | A7 | #14, #619, #15 | yes |
| **#58** | A5 | #141, #142, #143, #144 | yes |
| **#59** | oo2 | #68, #67, #66, #36, #35, #65, #64, #984 | yes |
| **#63** | C15 | #513 | yes |
| **#64** | oo16 | #167 | yes |
| **#65** | oo15 | #167 | yes |
| **#66** | oo12 | #167 | yes |
| **#67** | oo11 | #167 | yes |
| **#68** | oo10 | #167 | yes |
| **#69** | A11 | #204 | yes |
| **#87** | B30 | #146 | yes |
| **#88** | B28 | #145 | yes |
| **#141** | B24 | #145, #147, #146 | yes |
| **#142** | B25 | #145, #147, #146 | yes |
| **#143** | B26 | #147, #146 | yes |
| **#144** | B27 | #147 | yes |
| **#204** | B29 | #147 | yes |
| **#592** | bb2 | #61, #884, #997 | yes |
| **#619** | B36 | #63 | yes |
| **#626** | oo1 | #68 **NO FACING**, #67 **NO FACING**, #66 **NO FACING**, #36 **NO FACING**, #35 **NO FACING**, #65 **NO FACING**, #64 **NO FACING**, #984 **NO FACING** | NO — see F-3 |
| **#630** | A15 | #204 | yes |
| **#631** | A16 | #204 | yes |
| **#632** | A17 | #87 | yes |
| **#633** | A18 | #88 | yes |
| **#810** | to1 | #882 | yes |
| **#984** | oo17 | #167 | yes |

### Agreement between the rulebook and the engine's generic filter — as measured at 9.1

Measured both directions over all 76 types × 6 × 6 facings:

| Question | Result |
|---|---|
| Rulebook-legal edges with **no** engine facing | **9 of 127** — `#626 →` all eight brown OO, and `#36 → #167` (**F-3**) |
| Rulebook-legal edges that fail the engine's tier / centre / terrain rules | **0** |
| Engine-accepted edges **absent** from T-09, Classic tray | **2** — `#28 → #43` and `#29 → #43` |
| …same, 1830+ tray | the same 2 |
| …same, LPF tray | the same 2 |

**The two "extra" edges are T-09 errata, and the engine is right.** Page 19's Green→Brown chart lists
`B13 (1) … C4, C8, C9, C10` and `B14 (1) … C4, C7, C9, C10`; T-09 omits `C9` from both rows. `C9` is old **#43**,
and the geometry is sound: #29 = {(0,1),(0,2)} embeds in #43 = {(0,2),(0,3),(1,2),(1,3)} at rotation +1 as
{(1,2),(1,3)}; #28 = {(0,4),(0,5)} embeds likewise. Two independent facts agree with p. 19 — the engine's derivation
and the geometry — against one appendix row, so **p. 19 wins and no engine change is owed.** Recorded in §18.

**Everything else matches.** With those 2 errata and the 9 F-3 edges set aside, the engine's *generic* filter
reproduces the rulebook's entire 127-edge upgrade graph exactly, in both directions, across all three trays. That is
the single most important input to the §21 design question: **a richer generic predicate is viable. The rulebook's
graph is not a table of exceptions; it is what geometry plus tier plus label plus centre-parity already computes.**

---

### §6b Upgrade-graph errata classification **[9.1b]**

The first pass measured the engine's generic filter against T-09 alone. With authority A in hand, every discrepancy
among **T-09**, the **revised Classic upgrade tables** (A, p. 19) and the **engine** can be classified. Authority A's
tables, transcribed verbatim this pass:

**Yellow → Green (revised, p. 19)** — `1 (1) none · 2 (1) none · 3 (2) none · 4 (2) none ·` **`7 (4) → 18, 26, 27, 28, 29`** `·` **`8 (8) → 16, 19, 23, 24, 25, 28, 29`** `·` **`9 (7) → 18, 19, 20, 23, 24, 26, 27`** `· 55 (1) none · 56 (1) none ·` **`57 (4) → 14, 15`** `· 58 (2) none · 69 (1) none`

**Green → Brown (revised, p. 19)** — `14 (3) → 63 · 15 (2) → 63 · 16 (1) → 43, 70 · 18 (1) → 43 · 19 (1) → 45, 46 · 20 (1) → 44, 47 · 23 (3) → 41, 43, 45, 47 · 24 (3) → 42, 43, 46, 47 · 25 (1) → 40, 45, 46 · 26 (1) → 42, 44, 45 · 27 (1) → 41, 44, 46 ·` **`28 (1) → 39, 43, 46, 70`** `·` **`29 (1) → 39, 43, 45, 70`** `· 53 (2) → 61 · 54 (1) → 62 ·` **`59 (2) → 64, 65, 66, 67, 68`**

| Edge / claim | T-09 | Revised (A) | Errata (C) | Engine | Class |
|---|---|---|---|---|---|
| **#28 → #43** | absent | **present** | — | accepts | **C — T-09 erroneous omission. The engine is right.** The first pass reached this from B's p. 19; A confirms it as the Classic authority |
| **#29 → #43** | absent | **present** | — | accepts | **C — T-09 erroneous omission. The engine is right.** |
| every other Classic edge | present | **identical to T-09** | — | accepts | **A — T-09 correct.** A's Classic graph and T-09 restricted to Classic agree row for row, edge for edge, with no other difference |
| **#59 → 64, 65, 66, 67, 68** | present (as `oo2 → oo10-oo17`) | **exactly these five** | — | accepts, **with illegal merging facings** | **A — correct, but the engine over-accepts facings.** → S9-19 |
| **#59 → oo13 (#36), oo14 (#35)** | inside T-09's `oo10-oo17` range | **absent** (Classic-only book) | flags both tiles' identities as broken | reachable **only** via merging facings, i.e. **not at all** under 6.2.2 ❹ | **C — T-09 range over-reach on precisely the two tiles the errata voids** (§8b) |
| **oo1 (#8861) → oo10-oo17** | present | — | **"Tile oo1 (8861) is not upgradable."** | zero facings | **C — T-09 erroneous edge set. The engine's behaviour is correct**, and the owner had already ruled the same (`App.tsx:3331`) |
| **oo13 → oo20** | present | — | **not retracted** | zero facings | **F/C — unresolved: either an engine catalog defect or a further T-09 over-reach. Structurally, no #167 can host all eight `ooNN → oo20` edges** (§8b) → S9-16 |
| **TO family, LPF** | Scenario D removes to1/to5 | — | — | retains both | **E — Project override**, documented and test-pinned (§10c) |
| **#53 → #61 (Classic)** | present | present | — | accepts | **A — correct.** #592/#884/#997 are expanded-only, consistent |
| **#54 → #62 (Classic)** | present | present | — | accepts | **A — correct.** #883 is expanded-only |
| **#63 quantity, 1830+** | 3 `+1` = 4 | — | value item only (50 → 40) | **1** | **F — engine defect** → S9-15 |
| **oo13 / oo14 revenue** | 50 | — | **"(it has a value of 40 rather than 50)"** each | 50 | **F — probable engine defect** → S9-20, §5b |

**Net for the design question.** With the two T-09 omissions credited to the engine and the oo1/oo13 rows credited to
the errata, **the engine's generic predicate reproduces every upgrade edge that survives reconciliation** — the only
residue is S9-19 (it accepts *too many facings* on #59) and S9-16 (one edge with no facing). That is the same
conclusion the first pass reached, now on the right authority: **a richer generic predicate plus a short exception
manifest, not a hand-authored adjacency table.** A declared table would have swallowed T-09's oo1 row as law.


## §7 City / station topology-change matrix

Every rulebook-legal edge, classified by what happens to the revenue centres. Classes are the brief's own A–G.

| Class | Edges | Cases |
|---|---|---|
| **A** same city topology | many | #53→#61 (1 slot→1 slot), #59→every brown OO ([1,1]→[1,1]), every brown OO→#167, plain→plain |
| **B** city gains slots | 14 | #57/#5/#6 → #14/#619/#15 (1→2) · #63→#513 (2→3) · #53→#997 (1→2) · #53→#884 (1→3) · #592→#884 (2→3) · #54→#62 ([1,1]→[2,2]) · #810→#882 ([1,2]→[2,2]) |
| **B−** city **loses** slots | **1** | **#592 → #61 (2 → 1)** — the only capacity-shrinking upgrade in the entire tile set. 1830+ only; **absent from Classic and from LPF**, which remove both tiles |
| **C** one city splits | **0** | **none anywhere in the tile set** |
| **D** cities merge | **1** | **#54 → #883 (2 × 1 slot → 1 × 4 slots)** — the only city merge. 1830+ only |
| **E/F** towns merge 2 → 1 | 8 | #1→#88 · #2→#87 · #55→#88 · #56→#87 · #69→#204 · #630→#204 · #631→#204 · #632→#87 · #633→#88 — all 1830+ only, all already modelled by `mergesTowns` (#1403) |
| **F** town → town, plain → plain | rest | unremarkable |
| **G** other | **0** | none |

**This is the manifest of exceptions the brief asked for (§3C), and it is four items long:**

1. **`#54 → #883`** — the one legal city merge. Already modelled: #1315's `clampCity`, `planTokenUpgrade`'s
   single-city fit, and `utils/nyMerge.test.ts` (14 assertions, passing).
2. **`#592 → #61`** — the one legal capacity shrink. Already refused *in the UI* by `fitStationsToUpgrade` when it
   would overfill; **not refused authoritatively** (F-5). Unreachable in Classic and LPF.
3. **the eight double-town → single-town greens** — already modelled by `mergesTowns`.
4. **no city ever splits**, so `C` needs no machinery at all.

"Cities may never merge" is therefore false as a global rule — exactly as S9-10 already warns — but the true
statement is much narrower than "the expanded manifests contain legal merges": there is **precisely one**, it is
`#54 → #883`, and it is already implemented. Everything else in the OO family preserves 2 cities × 1 slot.

### What "preserve track" has to mean (§10 of the brief)

The minimum relation legal-upgrade validation actually needs, stated over the merged authoritative topology
(printed board ⊕ laid tile), with each element mapped to the rule it comes from:

| # | Requirement | Rule | Engine today |
|---|---|---|---|
| 1 | every live **exit** of the prior topology is live on the candidate | ❸ (necessary half) | **YES** — the mask test, `old & ~new == 0`, quoted from `hexmap.rs` #10 |
| 2 | every prior **path** `(a,b)`, `a ≠ b`, is a path of the candidate at the same facing | ❸ | **YES** for a laid tile; **NO** for a printed hex (F-2) |
| 3 | a prior **terminus** `(e,e)` needs only its edge to survive | ❸, read correctly | **YES** — design note #676, and it is right: connecting the two OO cities is what the upgrade is *for* |
| 4 | each **station** lands in a candidate city carrying the connections its old city had | ❹ | **YES**, but UI-only (`fitStationsToUpgrade`) — F-5 |
| 5 | no candidate city holds more tokens than it has **slots** | ❹ + slot counts | **YES**, UI-only — F-5 |
| 6 | the number and kind (town/city) of revenue centres is unchanged | 7.2.1 ❺ | **YES** — rule 2 plus the label gate |
| 7 | a candidate **facing** puts no rail off-grid, into a blank gray side, or into a red side | ❷ | **partly** — `staysOnBoard` and `crossesImpassableBorder` cover off-grid and the four barriers; "blank side of a grey hexagon" and "solid red hex side" are **not** distinguished from an ordinary edge |
| 8 | **city identity** across the upgrade, beyond ❹ | *not stated by the rulebook* | not modelled — and §8/F-9 is the question of whether it should be |

Row 8 is the honest boundary of this audit. Rows 1–3 are a property of *tracks*; rows 4–5 are a property of
*tokens*; the rulebook never states a rule about city identity independent of those two. Any Stage-9 rule that
forbids a facing on city-identity grounds with no token standing on the hex is an **owner ruling**, not a rulebook
requirement — see §8 and F-9.

---

## §8 Old #59 — dedicated analysis

### The tile

| | |
|---|---|
| **Old number** | **#59** |
| Lookout identifier | `oo2` |
| Colour / label | Green, `OO` |
| Terrain tag | `DoubleCityHub` |
| Cities | **2**, **1 station slot each** (`TILE_GRAPHICS_CATALOG[59].markers` = two 1-slot city markers; T-09's `oo2` thumbnail shows two separate circles, unjoined, with the `OO` legend) |
| Revenue | 40 (one figure in the catalog; each city is worth it) |
| Base live edges | **{0, 2}** — `connections: 0b000_101` |
| `cityGroups` | `[[0], [2]]` — city 0 owns edge 0, city 1 owns edge 2 |
| `paths` | `[[0,0], [2,2]]` — **two self-loops**: each edge runs in and stops |
| Quantity | 2 Classic / **3** 1830+ / 3 LPF (matches T-09's `2 +1`) |
| Successors (T-09) | `oo10`–`oo17` = **old #68, #67, #66, #36, #35, #65, #64, #984** |
| Successors (p. 19, Classic) | `oo10–oo12, oo15, oo16` = **old #68, #67, #66, #65, #64** — the five Classic brown OO tiles |

**The two systems are internally disconnected, and the catalog says so twice.** The self-loop encoding is the
backend's way of writing what `hexBoardData` design note #391 writes in prose about the four printed OO hexes: *"Two
separately revenue-earning cities on one hex with NO connecting track at all — verbatim-confirmed that none of the
four has a path entry."* There is no OO tile in the tray for a yellow hex; the chain **starts on the board** and
#59 is the first tile, of which there are 2 (Classic) against 4 OO hexes — which is why the engine's derived graph
models it as `PRINTED_START` rather than as an absent tray entry.

**The brief's successor list was incomplete.** It named #64, #65, #67. The Classic set is **five** (#64, #65, #66,
#67, #68) and 1830+ adds **three** more (#35, #36, #984), each of which then upgrades to gray **#167** (`oo20`).

### §8a The rule is printed, not an owner question **[9.1b — replaces the first pass's F-9]**

**Authority A, revised 6.2.2 ❹, verbatim:**

> When a tile is replaced, all stations on the replaced tile must be placed on the new tile with the same
> connections as before. **This also means that the pre-printed exits on a (59) tile can never be connected in the
> tile upgrade.**

The first pass filed this as an ambiguity needing an owner ruling, because it only had authority B and B does not
carry the clause. **The clause exists, it names #59 explicitly, and it is printed rule.** The first pass's F-9 is
withdrawn as an ambiguity and refiled as a defect, **S9-19**.

**The frozen ruling:**

- old **#59** carries two distinct city / track systems (two 1-slot cities, each with one pre-printed exit, no
  track between them — `paths: [[0,0],[2,2]]`, and `hexBoardData` #391 says the same of the four printed OO hexes);
- an upgrade facing **may not connect those systems**;
- each system's station must land on a city carrying the same connections (the general half of ❹);
- an orientation that merges them is **illegal**;
- **Variable OO remains OFF** — a sweep for `variableoo` / `variable oo` / `variable-oo` across `frontend/src`
  returns zero matches and `GameVariants` has no such flag, so nothing can be invoked to legalise a merge;
- **this is printed-rule authority, not an owner decision.**

**Complete successor set, from authority A:** `59 (2) → 64, 65, 66, 67, 68` — **five** tiles. The first pass's
abbreviated "#64, #65, #67" is corrected; #66 and #68 were always in it (B's p. 19 lists `oo10-oo12, oo15, oo16`,
the same five).

### §8b #59 → each successor, legal and illegal facings under the printed rule **[9.1b]**

Source fixed at `#59 @ 0` (exits {0,2}; city 0 = edge 0, city 1 = edge 2). "Engine accepts" is today's
`preservesRouting` plus the tier / label / centre gates; "illegal-merge" is a facing the engine accepts and
6.2.2 ❹ forbids.

| Destination | `cityGroups` (base) | Engine accepts | **Legal** under 6.2.2 ❹ | **Illegal merge — accepted today** |
|---|---|---|---|---|
| **#68** (oo10) | `[[0,3],[1,4]]` | 2, 5 | **2, 5** | — |
| **#67** (oo11) | `[[0,3],[2,4]]` | 0, 2, 4 | **0, 2** | **4** |
| **#66** (oo12) | `[[0,3],[1,2]]` | 0, 5 | **0, 5** | — |
| **#65** (oo15) | `[[0,4],[2,3]]` | 0, 2, 4 | **0, 4** | **2** |
| **#64** (oo16) | `[[0,2],[3,4]]` | 0, 2, 4 | **2, 4** | **0** |
| **#984** (oo17) | `[[0,1],[4,5]]` | 1, 2 | **1, 2** | — |
| **oo13** (~~#36~~) | `[[1,5],[2,4]]` | 1, 4 | **none** | **1, 4** |
| **oo14** (~~#35~~) | `[[1,5],[0,4]]` | 1, 2 | **none** | **1, 2** |

**Two results matter.**

**All five of authority A's Classic successors keep at least two legal facings.** The printed rule costs the Classic
game nothing — it removes four (tile, facing) pairs (#67@4, #65@2, #64@0 and their rotations) and leaves every
listed upgrade reachable. So S9-19 is a pure over-acceptance defect with no reachability cost. **Seven (tile, facing)
pairs are accepted today that the rule forbids: #67@4, #65@2, #64@0, oo13@1, oo13@4, oo14@1, oo14@2.**

**oo13 and oo14 are reachable from #59 only through illegal facings — that is, not at all.** They are also precisely
the two tiles whose identities the errata voids. T-09's `oo2 → oo10-oo17` range therefore over-reaches by exactly
those two, and the errata's warning and the arithmetic point at the same place. **No engine change is owed for
`#59 → oo13/oo14`**: after S9-19 they simply cease to be offered, which is the corrected-authority answer.

### §8c oo13 / oo14 geometry confirmed — and `oo13 → oo20` is a contradiction in official material **[9.1c]**

**The owner supplied the corrected geometry directly** (2026-09-18), which is the authority this section was waiting
for:

> *oo13 has track through a large city connecting edges 0 and 2, and separate track through another large city
> connecting edges 3 and 5. Tile oo14 has track connecting a large city to edges 0 and 2, and separate track
> connecting a large city to edges 1 and 3. Both are worth $50 revenue.*

**The engine already matches it, exactly.**

| | Owner-confirmed | Engine record | Verdict |
|---|---|---|---|
| **oo13** cities | `{0,2}` and `{3,5}` | `cityGroups` → `{0,2}` / `{3,5}` in the spec convention (`[[1,5],[2,4]]` in board edges) | **MATCH** |
| **oo14** cities | `{0,2}` and `{1,3}` | `cityGroups` → `{0,2}` / `{1,3}` in the spec convention (`[[1,5],[0,4]]` in board edges) | **MATCH** |
| **oo13 / oo14 revenue** | **$50** each | `revenue: 50` each | **MATCH** |
| colour / label / cities / slots | brown, OO, 2 large cities | brown, `DoubleCityHub`, 2 cities, slots `[1,1]` | **MATCH** (and matches the correction-sheet art) |

**This is convention-independent.** Whether the owner's numbers are read in the spec convention (0 NE, clockwise) or
the board's (0 E, counter-clockwise), the shape-invariant is the same: both tiles carry two **gap-2** cities (two
exits with one edge between), and the separation between the two cities' gap-centres is **3 (opposite) for oo13**
and **1 (adjacent) for oo14**. The engine's records have exactly those separations in both conventions.

**Three findings close on this.**

1. **S9-16's H1 is dead too.** 9.1b offered two hypotheses; 9.1c killed H2 (the correction sheet *prints*
   `oo13 ➧ oo20`) and the owner's description now kills H1 (**oo13's geometry is not wrong**).
2. **S9-20 is WITHDRAWN.** The owner confirms **$50**, the corrected tile art shows 50, and the engine has 50. The
   errata's parenthetical *"(it has a value of 40 rather than 50)"* is therefore **not** a value correction — it is a
   distinguishing remark, and an inaccurate one. No revenue change is owed, and no log is re-pinned for it.
3. **What is left is a contradiction between official sources**, not a gap in them.

### §8c-i Legal orientations, measured **[9.1c]**

Both tiles are **BROWN**; `oo20` is **Gray**. The colour progression `brown → gray` is exactly one tier, so
revised 6.2.2 ❺ is satisfied for both edges and colour is not what refuses either one.

| Upgrade | Tier step | Facing pairs passing track preservation | …also keeping the two cities distinct | Legal orientations |
|---|---|---|---|---|
| **oo14 → oo20** | Brown → Gray ✓ | **6 of 36** | **6** | `oo14@0→oo20@1` · `@1→@2` · `@2→@3` · `@3→@4` · `@4→@5` · `@5→@0` — one destination facing per source facing, the identity offset +1 |
| **oo13 → oo20** | Brown → Gray ✓ | **0 of 36** | **0** | **none at any of the 36 combinations** |

**Exactly why oo13 finds zero.** Each OO city contributes one *segment*: a pair of edges joined through that city.
oo13's two segments are a **gap-2 pair each** (two exits with one edge between), and the two pairs' gap-centres sit
**3 apart — on opposite sides of the tile**. oo14's also sit 2 apart each but its gap-centres are only **1 apart —
adjacent**. `oo20` as recorded has two 3-edge cities, `{0,1,4}` and `{2,3,5}`, which between them offer exactly one
gap-2 pair per city — `(0,4)` and `(3,5)` — whose gap-centres are **1 apart**. **A rotation moves both of a tile's
gap-centres together, so it can never turn a separation of 3 into a separation of 1.** oo14 fits that slot; oo13
cannot, at any rotation, for reasons that have nothing to do with colour, tier, revenue, label or the identifier
aliases.

**Whole-graph re-check with the confirmed geometry.** Re-running *"every publisher-valid upgrade edge has at least
one legal facing"* over the reconciled graph — T-09 plus the revised Classic tables plus the correction sheet, with
the errata-voided `oo1` row removed:

> **119 publisher-valid edges · exactly 1 with no legal facing: `oo13 → oo20`.**

Everything else in the reconciled graph is reachable. That single edge is the whole of the residue, and §8c-ii
shows it cannot be repaired by changing `oo20` either.

### §8c-ii The contradiction, stated exactly

Three things are now each independently sourced, and they cannot all be true:

- **(i)** oo13 is two gap-2 cities at separation **3** — *owner-confirmed, matches the engine and the correction art*;
- **(ii)** **`oo13 ➧ oo20`** is printed on the official errata correction sheet (§1b-ii);
- **(iii)** T-09 also lists **oo10, oo11, oo12, oo15, oo16, oo17 → oo20**, and oo10/oo12/oo17 are Classic or
  expanded browns whose own geometry is not in question.

**Exhaustive proof that no gray OO tile satisfies all three.** Every candidate oo20 was enumerated — every live-edge
set of size 4, 5 or 6, crossed with every 2-city and 3-city partition of it: **556 candidates**, each tested against
all eight T-09 sources for full segment preservation with the source's two cities kept distinct.

| Result | Value |
|---|---|
| candidates hosting **all eight** sources | **0** |
| best coverage by any candidate | **7 / 8** — and **every** 7/8 candidate omits **oo13** |
| candidates hosting oo13 at all | 46 |
| best coverage among those | **5 / 8** — always losing **oo10, oo12, oo17** |
| the engine's current `#167` | **7 / 8** — the maximum, hosting everything except oo13 |
| 8/8 without the distinctness requirement | only a degenerate 1-edge + 5-edge split, i.e. a single effective city |

The degenerate escape is closed by the art: T-09's `oo20` thumbnail, rendered at 600 dpi, shows **two separate white
circles** in a gray hex. oo20 is a genuine two-city tile, so a "one big city that swallows everything" reading is
not available.

**The two candidate resolutions, neither derivable from the sources:**

| Option | oo20 city split | Honours | Loses |
|---|---|---|---|
| **A — keep the engine as it is** | `{0,1,4}/{2,3,5}` (current) | all five Classic browns + oo14 + oo17 = **7/8** | **`oo13 → oo20`**, which the correction sheet prints |
| **B — re-split oo20** | `{0,2}/{1,3,4,5}` (or five equivalents) | **both correction-sheet upgrades** (oo13, oo14) + oo11, oo15, oo16 = **5/8** | **oo10 (#68), oo12 (#66), oo17 (#984)** |

**STOP, per the brief's own §5B.** This is the outcome that instruction anticipated — *"No legal rotations exist even
using the official replacement art. Then T-09 / correction material has a deeper inconsistency. STOP and report that
contradiction rather than inventing geometry."* No geometry is invented here and `#167` is left untouched.

**Note what is NOT owed.** The engine currently implements Option A, which is the 7/8 maximum and preserves every
Classic upgrade. So **no defect is proven against the engine** by this contradiction — the zero facings for
`oo13 → oo20` are a faithful consequence of official material that does not close. Slice 9.3 should carry it as a
recorded contradiction with Option B costed, not as a fix.

**What would settle it** (any one of these, in order of strength): the printed **oo20 tile face** at a resolution
that resolves which edges join which city — it is not on the errata correction sheet, so it needs the physical tile
or a component scan; a later publisher erratum touching the `ooNN → oo20` rows; or an owner ruling on which of the
two option sets to honour, which is a genuine decision precisely because the sources conflict.

### Orientation handling (§19 of the brief)

| Question | Answer |
|---|---|
| Canonical orientation | the catalog's base (pre-rotation) values; orientation 0 |
| Rotation representation | 6-bit mask rotation, `rotateConnections` (`hexGeometry.ts:133`), a bit-for-bit port of `hexmap::rotate_connections` |
| Paths under rotation | `tileSegments` adds `rot` to both endpoints, so a self-loop stays a self-loop |
| City identity under rotation | `cityGroups` rotate with the edges (`tileCityEdges`), so a city is identified by its **edge set**, not its index — which is exactly design note #878's point, and correct |
| Symmetric tiles normalised? | **No** — all 6 facings are enumerated and filtered; duplicates are simply both legal. `#53`'s {0,2,4} gives only two distinct edge sets ({0,2,4} and {1,3,5}), so three facings are geometrically identical and all three are offered |
| Upgrade check compares after rotation? | **Yes** — rule 5 is "the only rule judged per ORIENTATION rather than per tile" |
| Printed hex topology in the same convention? | Yes — `LANDMARK_TRACKS` / `GRAY_HEXES` edges are board-convention indices, and `hexBoardDataPlus.edge()` translates the owner spec's convention (`code = (1 − spec) mod 6`) at the seam, with `expandedBoard.test.ts` pinning it |

---

## §9 Baltimore, #53 and #592 — dedicated analysis

### Correcting the record

S9-10 records *"an expanded/LPF Baltimore upgrade involving old tile numbers #53 and #592"* and a *"#53 / #592
facing that cuts printed track [that] is offered and accepted"*. Three corrections, in order of importance:

**1. #53 and #592 are siblings, not a chain.** T-09:

| Lookout | Old | Colour | Slots | Classic | 1830+ | Upgrades to |
|---|---|---|---|---|---|---|
| `bb1` | **#53** | Green | **1** | 2 | 2 | `bb5, bb6, bb7` = #61, #884, #997 |
| `bb2` | **#592** | Green | **2** | 0 | **2** | `bb5, bb6, bb7` = #61, #884, #997 |
| `bb5` | #61 | Brown | **1** | 2 | 2 | — |
| `bb6` | #884 | Brown | **3** | 0 | 1 | — |
| `bb7` | #997 | Brown | **2** | 0 | 1 | — |

There is no `#53 → #592` edge, in any ruleset. Both are green "B" tiles with **identical exits** ({0,2,4}, a
three-way Y) and identical successors; the **only** difference between them is the station-slot count, 1 versus 2.
The engine models this correctly: identical `connections`/`paths` in `TILE_CATALOG`, and `slots: 1` vs `slots: 2`
in `TILE_GRAPHICS_CATALOG` — which `tileCitySlotCounts` and `citySlotCount` read. Slot counts for the whole family
were read off the T-09 thumbnails at 600 dpi and agree with the engine on all five tiles.

**2. "B" is Baltimore *and* Boston.** Page 19's Yellow-Hex table:

> Baltimore … bb1 · Boston … bb1 · New York … ny1

So one label and one artwork family serve both B-cities. The engine's `BostonHub` terrain tag is a poorly chosen
name for a correct model, and `hexLabelRestriction` derives the family **structurally** — a landmark with two
printed segments is `NY`, one segment is `B` — so Baltimore (I15, one segment {0,4}) and Boston (E23, one segment
{1,5}) both resolve to `B` with no coordinate list. That is right. *Recommendation: rename the tag `BHub` in a
later cosmetic pass; it is not a Stage-9 defect and touching it now would ripple through the renderer.*

**3. The printed-track-cutting facing is not reachable.** Measured over all 6 facings at each hex, with
`staysOnBoard` and `crossesImpassableBorder` applied:

| Hex | Printed | Candidate | Rules-legal facings | Facings the engine **offers** | Illegal-but-offered |
|---|---|---|---|---|---|
| **I15** Baltimore | 1 city, exits {0,4} | **#53** (1 slot) | 0, 2, 4 | **0, 2, 4** | **none** |
| | | **#592** (2 slots) | 0, 2, 4 | **0, 2, 4** | **none** |
| **E23** Boston | 1 city, exits {1,5} | **#53** | 1, 3, 5 | **1, 3, 5** | **none** |
| | | **#592** | 1, 3, 5 | **1, 3, 5** | **none** |
| **G19** New York | 2 cities, exits {1} and {4} | **#54** | 1, 4 | **1** | **none** (and facing **4 is wrongly refused**) |

Why it holds: #53/#592's edge set {0,2,4} rotates to only two distinct sets — {0,2,4} at even facings and {1,3,5}
at odd ones. Baltimore's printed {0,4} ⊆ {0,2,4} and Boston's {1,5} ⊆ {1,3,5}, so on each hex exactly one parity is
rules-legal — and `staysOnBoard` independently rejects the other parity at both hexes, because I15 and E23 each
have a non-existent neighbour across one of the wrong-parity edges. **The correct answer arrives from a rule about
the map's rim, not from preservation.** `utils/tileUpgrades.ts`'s own design note already noticed the same accident
at New York ("New York's #54 is legal at G19 at some rotations and not at 0") without recognising what was doing the
work.

**F-2 is therefore latent, not exploitable, at the three landmark hexes — and the masking is fragile.** It breaks if
any board edit gives I15, E23 or G19 a neighbour it currently lacks; if a future B or NY tile has a different edge
set; or on any *new* printed-track hex that is not on the rim. It is already broken at the gray hexes (§5, F-1),
where the same missing read has 54 track-deleting lays.

**Also note G19's over-refusal.** Facing 4 of #54 is rules-legal (printed edge 1 → tile city 1, printed edge 4 →
tile city 0 — both preserved, cities still distinct) and `staysOnBoard` refuses it. That is a conservative
false-negative, harmless today, but it means New York can only ever be built one way round. Worth a line in Slice
9.2's test matrix, not a defect in itself.

### What #592's 2 slots mean for placement

Under 7.2.1 ❺ read as *town vs city* (§1), **both** #53 and #592 are legal on a printed 1-slot B hex, and the
1830+ player simply prefers #592. Read as *slot parity*, #592 would be unplayable anywhere on any of the three
boards, since every B hex prints one slot — which cannot be right for a tile the expansion ships two of. The
town/city reading is therefore the only coherent one, and it is what the engine implements. **Recorded so Slice 9.2
does not "fix" rule 2 into slot parity.**

**But the shrink is real.** `#592 (2 slots) → #61 (1 slot)` is the tile set's only capacity-shrinking upgrade
(§7, B−). With two tokens standing in a #592 city, ❹ makes it illegal; `fitStationsToUpgrade` refuses it, and
`nyMerge.test.ts:68` pins that refusal — **in the UI**. Authoritatively (F-5) nothing stops it, and #1315's
`clampCity` would silently put both tokens in city 0 of a 1-slot city. LPF removes both tiles, so this is 1830+
only; Classic never sees it.

---

## §10 Variant boundary / inventory matrix

| | Classic | 1830+ (`plusTiles`) | LPF / Scenario D (`levelPlayingField`) |
|---|---|---|---|
| Variant flags | all off | `plusTiles` (and usually `expandedMap`) | `levelPlayingField` — `resolveVariants` **forces** `expandedMap` + `plusTiles` on |
| Board | `STANDARD_BOARD` | `EXPANDED_BOARD` (delta on standard) | `LPF_BOARD` (delta on expanded) |
| Tray | `STANDARD_TRAY` | `PLUS_TRAY` | `LPF_TRAY` |
| Selection | `boardFor` / `trayFor` (`boardSelection.ts`), one authority, scoped via `withRules` | same | LPF asked first |
| Global catalog membership | 76 (all) | 76 | 76 |
| Ruleset availability filter | `inTray(tile_id)` — **rule 0a, checked before any geometric rule** | same | same |
| Phase / colour filter | `TIER_RANK[color] > eraRank` (rule 1); Gray reachable only when the tray holds one (`catalogHasTierAbove`) | Gray arrives with the first D-train (#1312) | same |
| Distinct types in tray | **46** | **76** | **74** (#592 and #61 removed entirely) |
| Copies in tray | **85** ✓ | **135** (rulebook 138 — F-4) | **127** (rulebook 128 — F-4 −3, #810/#882 +2) |
| Count deltas modelled | n/a | `RECOUNTED` = #9→12, #8→13, #7→7, #57→6, #14→4, #15→4, #59→3, **#63→1 (should be 4)** | inherits `PLUS_TRAY`, then removes #5 ×2, #6 ×2, #592 ×2, #61 ×2 |
| Rulebook removal list (T-01 / S-1.1 ❻) | — | — | A8 (5) ×2, A9 (6) ×2, **to1 (810) ×1**, **to5 (882) ×1**, bb2 (592) ×2, bb5 (61) ×2 |
| Board tiles (T-02, Ⓓ) | *"1830 Base Game, 1830 Classic … do not use board tiles"* | per scenario | Coal River L-8 ✓ · SE/SW/W/NW/NE warehouses M-13 / L-2 / F-2 / A-11 / B-24 ✓ · **Straight Track (A-1) M-11 ✗ (F-6)** |

**Variant leakage: none found.** A tile outside the tray in effect is refused by rule 0a before any geometric rule
runs, `plusTiles.test.ts:63` pins that the standard game "does not let the standard game see a tile it never had",
and both the board and the tray are memoised per-value (`boardMemo` / `trayMemo`) with a scoped `withRules` override
so a replay cannot read one ruleset's board against another's tray. `utils/tileUpgrades.ts` keys its derived graph
on the `(board, tray)` pair for the same reason.

**Two documented owner deviations from printed Scenario D, both intentional:**

- **#810 / #882 retained in `LPF_TRAY`** against T-01. Design note #1395 records the playtest report ("the TO hex …
  has no upgrades … a hex that never upgrades or connects to anything") and the ruling to keep one of each. This is
  an S9-5-class owner variation, not a defect — **but it should be listed in S9-5's variation list**, which it
  currently is not.
- **`plusTiles` offered on the printed board** (#1415). Every printed 1830+ scenario uses the 1830+ board, so a
  plus tray on the standard map is an owner option with no rulebook counterpart. Worth one line in S9-4.

**Variable OO: NOT ACTIVE, and not present at all.** A case-insensitive sweep for `variableoo` / `variable oo` /
`variable-oo` across every `.ts`/`.tsx` in `frontend/src` returns **zero matches**; `GameVariants` carries
`delayedAuction, gentleRust, unpredictableRevenue, dynamicStockMarket, expandedMap, plusTiles, levelPlayingField,
rules` and nothing else. There is no flag to enable and no code to reach, so it cannot be used to legalise anything
(§4 of the brief satisfied). This pass changed no variant behaviour.

---

## §10b Published Scenario-D component set, and the Ⓓ-mark question resolved **[9.1b]**

The first pass filed Ⓓ-mark membership as an ambiguity needing an owner ruling. **It is a component fact, and the
source settles it by its own logic** — no ruling required.

**The evidence, in the order §11 of the brief prescribes.** Corrected component art: not obtainable this pass.
Original component art: not obtainable this pass. **Explicit scenario component tables: T-01 and T-02, p. 45.**
**Scenario instructions: S-1.1 ❷/❻, pp. 34-35.** Repository assets: corroboration only.

**Authority B, S-1.1 ❻, verbatim:** *"Except as noted here, use all of the track tiles—the 1830 Classic track tiles
and the 1830+ track tiles marked with a Ⓓ. Also remove these tiles:"* followed by **A8 (5) ×2 · A9 (6) ×2 ·
to1 (810) ×1 · to5 (882) ×1 · bb2 (592) ×2 · bb5 (61) ×2** — the same list T-01 prints for S-1.0 Ⓓ.

**The inference, and it is the source's own.** Every quantity in that removal list equals the **entire 1830+ supply**
of the tile named: #5 and #6 have 2 each, #592 has 2, #61 has 2, #810 and #882 have 1 each. If any of those six were
*not* Ⓓ-marked, it would already be absent from the scenario and its removal instruction would be vacuous. Six
vacuous instructions in one list is not a reading anyone should prefer. **Therefore those six are Ⓓ-marked, the Ⓓ set
is the broad one, and the removal list is the whole of Scenario D's subtraction from it.** Nothing elsewhere in the
scenario excludes any other 1830+ track tile, and T-02 handles the *board* tiles separately and explicitly.

**Published Scenario D (Ⓓ) effective track-tile set** = all 46 Classic types at their Classic counts **+** all 30
expanded types at their 1830+ counts **−** {#5 ×2, #6 ×2, #810 ×1, #882 ×1, #592 ×2, #61 ×2} = **74 types / 128
copies** (using T-09's corrected #63 count of 4).

**Published Scenario D (Ⓓ) board tiles** (T-02, p. 45; S-1.1 ❷, p. 34): Coal River / coal field hex **(30a) L-8** ·
SE Warehouse **(30b) M-13** · SW Warehouse **(30c) L-2** · W Warehouse **(30d) F-2** · NW Warehouse **(30e) A-11** ·
NE Warehouse **(30f) B-24** · **Straight Track (30g), "use an A-1 tile", M-11** — seven in all.

**[9.1c] DIRECT COMPONENT EVIDENCE NOW EXISTS, and it agrees.** The errata's correction tile sheets (§1b-ii)
print a row of scenario roundels on each corrected tile's legend hex, and **oo13, oo14 and C15 (63) each carry
Ⓑ Ⓓ Ⓖ Ⓡ** — so all three are Scenario-D components, read off the component art rather than inferred. That is the
evidence class §11 of the brief asked for, at the top of its precedence order. It does not cover every 1830+ tile —
only the ones the errata reprints — so the removal-list inference below still carries the general case, but it now
has a confirmed sample rather than none, and the sample agrees with it. (It also shows the roundel vocabulary is
the same Ⓑ/Ⓓ/Ⓖ/Ⓡ/Ⓣ/Ⓒ set as T-01/T-02/T-03, §1c.)

**Falsifier, stated so this is refutable rather than merely argued:** a photograph of the 1830+ tile sheet showing an
unmarked (non-Ⓓ) tile that is *not* on the removal list. Until such an image exists, the inference above is the
best-supported component fact and this audit treats it as established. **Not an open owner decision.**

## §10c The TO override — frozen Project 18XX LPF deviation **[9.1b]**

| | |
|---|---|
| **Hex** | **D10** — "Hamilton & Toronto", `q: 3, r: 3`, `type: "River"` (→ $80 terrain), `printedColor: "Yellow"`, two 1-slot printed cities, **no printed track**. Member of `YELLOW_OO_HEXES` on every board **and** of `torontoHexes` on the expanded and LPF boards; `hexLabelRestriction` asks TO first, so the hex reads `TO` there and `OO` on the standard board (#1317) |
| **Tile family** | the **TO** family, two tiles, `terrain: "TorontoHub"` — the only tiles a `TO` hex accepts |
| **Lookout / old IDs** | **to1 = old #810** (Green) · **to5 = old #882** (Brown). Neither is touched by the errata, so both old numbers are valid canonical identifiers |
| **Topology** | #810: all six edges live, cities `[[0,1,5],[2,3,4]]`, **slots [1, 2]**, revenue 50 · #882: same edges and split, **slots [2, 2]**, revenue 70 |
| **Quantities** | 1 each in the 1830+ tray (T-09: `to1` 0 Classic `+1`; `to5` 0 Classic `+1`) |
| **Upgrade chain** | printed `TO` hex (yellow, rank 0) → **#810** (green) → **#882** (brown). Terminal at brown; no gray TO tile exists. A class-B change (slots [1,2] → [2,2]) and index-preserving at equal facings |
| **Published Scenario D** | **removes both** — T-01 S-1.0: `to1 (810) …… 1`, `to5 (882) …… 1`; S-1.1 ❻ repeats it |
| **Project 18XX LPF** | **RETAINS both, one each** |
| **Rationale (frozen)** | the TO hex stays in play; without the TO tiles the labelled hex has no upgrade path and can never be built through; playtesters reasonably assumed it remained upgradeable; the printed component removal made that unintuitive. Recorded in the engine at `tileTrayLpf.ts` design note **#1395**, from the playtest report *"When clicking the preprinted Toronto (TO) hex, the tileselector does not pop up at all… Let's restore the TO tiles for our LPF variant's tile set."* #1385's earlier list had removed them |
| **Current engine** | **PASS — implemented.** `LPF_TRAY_REMOVALS = [[5,2],[6,2],[592,2],[61,2]]` — #810 and #882 are **not** in it, so both survive `LPF_TRAY` at 1 copy each |
| **Already pinned by test** | **yes** — `utils/levelPlayingField.test.ts:170-171`: `expect(LPF_TRAY.counts.get(810)).toBe(1); expect(LPF_TRAY.counts.get(882)).toBe(1);` under the comment *"#1395: #810 and #882 (Toronto's green and brown) STAY, one each"*. The brief's requirement that a future automated reconciliation must not be able to remove them is therefore **already satisfied** |

**Classification: INTENTIONAL PROJECT DEVIATION — PASS.** Not a catalog defect, not variant leakage, not a
reconciliation error, not an ambiguity. **A future "rulebook reconciliation" pass must not revert it**, and the test
above is what stops one. The one documentation gap: **S9-5's owner-variation list does not yet name it** — filed
below.

**Project 18XX LPF effective track-tile set** = published Scenario D set (§10b) **+ to1 ×1 + to5 ×1** = **76 types /
130 copies** at T-09's corrected counts, against the engine's **74 types / 127 copies** — the whole difference being
S9-15's three missing #63 copies and the two types the engine drops to zero (#592, #61) which the rulebook also
drops to zero. Type-count difference explained: the engine deletes a tile whose count reaches zero from the tray
rather than keeping it at 0, so #592 and #61 are absent as *types*; the rulebook set above counts them as removed
copies of present types. **No mismatch beyond S9-15.**

---

## §11 Route-graph interaction

`gameEngine/trackSegments.traversalSegments(mapGrid, q, r, entryEdge, exitEdge, variant)` is the route graph's
per-hex question, and its resolution order is:

1. `isOffboardTerminal(q, r)` → `null` first, *ahead of the tile lookup* (design note #484) — terminality is a
   property of the board;
2. a laid tile → `artworkPathsForTraversal(tile_id, orientation, …)` — **the artwork rails**;
3. a printed hex with authored artwork → `printedTraversalVariants(label, …)`, including Altoona's real bypass fork
   (#737);
4. the explicit `G19` arm — New York is authored outside `PRINTED_GRAPHICS_CATALOG` and "already resolves it", so it
   is asked by name rather than falling through to "everything connects", *"which is exactly the claim its two
   disconnected spurs must not make"*;
5. otherwise the weak edge test over `liveEdgesForHex`, returning one whole-hex segment.

**The route graph sees more than the placement predicate does**, which is the reverse of the usual danger:

| Does it see… | Route graph | Lay predicate |
|---|---|---|
| printed board track | **yes** (3, 4, and `liveEdgesForHex`'s `GRAY_HEXES` / `OFFBOARD_TRACKS` / `LANDMARK_TRACKS` arms) | **no** (F-2) |
| current tile track | yes (artwork rails) | yes (catalog `paths`) |
| city separation | **yes** — `trackReach.cityForArrival` / `cityEnteredFrom` read `cityGroups` and the landmark table, and `cityExitEdges` gives one city's rails (design note #686, the H18/NNH bug) | not at all (deliberately: hubs are full pairwise expansions) |
| station blockers | yes — `cityBlocking.isCityBlocked`, `others >= slots`, zero slots = "not a city" not "full" | no |
| intentionally disconnected systems | **yes** — port-to-port traversal, "two disconnected curves on one tile yield two disjoint answers rather than one junction" | via `paths`, yes |

**Consequences for Stage 9, kept distinct as the brief requires:**

- **placement-legality defect** — F-1, F-2, F-5 (three rules absent from the authoritative predicate);
- **catalog defect** — F-3 / F-8 (#626, #36 geometry), F-4 (#63 count);
- **route-graph defect** — **none found.** The graph is city-aware, printed-topology-aware and terminus-aware;
- **token-migration defect** — F-5 only (the rule is implemented, just not authoritatively).

One architectural note for 9.2: because the graph routes on artwork rails and the predicate preserves catalog
`paths`, a *fix* that tightens preservation must tighten it over the **same** table the graph reads, or the two can
disagree on a tile whose two descriptions differ. `cityTopology.test.ts` currently pins them together for two-city
tiles at every orientation; extending that pin to every tile's full path set is cheap and belongs in 9.2.

---

## §12 Token / station migration

**The rule is implemented, and implemented well.** `utils/stationConnectivity.ts` design note #878 is rule 7.2.2 ❹
in the engine's own words — *"A station token is anchored to its NETWORK, not to a city index … the anchor is the
EDGE SET. A token's city touches some set of board edges today; after the upgrade it belongs in whichever city of
the new tile still touches them."* `fitStationsToUpgrade(anchors, candidateCities, slots)` returns `anchored` /
`free` / `illegal` per token and `null` for the whole facing when any token is stranded, and it takes the slot table
so it also refuses a facing that would overfill a city (#1315).

| Case from the brief | Behaviour | Where |
|---|---|---|
| one city → more slots in the same city | token stays; capacity grows | `fitStationsToUpgrade` |
| two distinct cities stay distinct | each token follows its own edge set | #878 |
| two cities legally merge (`#54 → #883`) | every anchored token lands at index 0; refused if the merged city cannot hold them all | #1315 single-city arm; `nyMerge.test.ts` |
| tokens from different old cities coexisting in a merged city | **yes, and correct** — #883 is one 4-slot city and the corpus contains the case |
| deterministic `city_index` remapping | **yes** — the plan is computed from edge sets, sent on the wire as `token_cities: [[company_id, city_index]]`, and replayed from the log rather than recomputed |
| stored `city_index` surviving an upgrade | **yes** — `clampCity` (#1315) clamps any index the new tile lacks, so an older log without `token_cities` cannot leave a token in a city that does not exist |
| capacity shrinking | possible on exactly one edge (`#592 → #61`); refused by the fit, **not** by the authority (F-5) |
| a legal upgrade stranding / duplicating / moving a token wrongly | not reachable through the UI; **reachable through a crafted or replayed `LayTile`** (F-5) |

**ERIE falls out of the rule rather than being special-cased**, which is the right shape: a token with no live edges
has nothing to preserve, so every city satisfies ❹ vacuously and every facing stays legal — and by the brown
upgrade the same token has track and is constrained like everyone else. The corpus shows exactly this at E11
(design note #584's reservation marker, then `token_cities: [[6, 0]]` at the green lay).

**The one gap, restated precisely.** `planTokenUpgrade` gates `legalRotations` — a `useMemo` in `App.tsx:10797`
whose own design note #879 says *"SO THE FILTER IS PART OF LEGALITY, not a courtesy"*. It is not in `layRefused`,
so the reducer accepts whatever `token_cities` the message carries, clamps out-of-range indices, and never checks
that a token's new city carries its old connections or that the city has room. A replay re-validates the tile and
the facing but not the token landing. **This is the same pattern as S9-1's `YellowSignEvent`** — a correct rule
living outside the authority — and the two should be fixed by the same discipline, if not in the same slice.

---

## §13 The current preservation helper — exactly what it proves

`preservesRouting(existing, existingOrientation, candidate, candidateOrientation)` —
`components/sandboxTileLegality.ts`, private, called from rule 5 of `filterSandboxPlacements`.

**Inputs**

| Input | Present? |
|---|---|
| source tile (`TileCatalogEntry`) | **yes** — but only ever `TILE_CATALOG_BY_ID.get(laid.tile_id)` |
| source orientation | yes (`laid?.orientation ?? 0`) |
| candidate tile + orientation | yes |
| **board printed topology** | **NO** — `LANDMARK_TRACKS`, `GRAY_HEXES`, `OFFBOARD_TRACKS` are not imported |
| **station / token state** | **NO** |
| **station slot counts** | **NO** |
| city mapping | not used — by design (hubs are full pairwise expansions, so "does edge 0 still reach edge 3" needs no city reasoning) |

**What it proves**

1. **exit survival** — `(oldMask & ~newMask & 0b111111) === 0`, the exact `hexmap.rs` #10 invariant, applied after
   rotation. Necessary, and the whole test when routing is underivable.
2. **path inclusion** — every source segment `(a,b)` with `a ≠ b` must appear in the candidate's rotated segment
   set. Strictly stronger than the edge test, and verified so: "#70 at rotation 0 passes the edge-superset test over
   #57 and is rejected by this one."
3. **terminus relaxation** — a self-loop `(e,e)` is satisfied by its edge surviving (#676). Correct, and necessary:
   without it the four OO hexes freeze at green.

**What it does not prove**

| Not proved | Consequence |
|---|---|
| preservation of **printed board** track | **F-2** — rule 5 is skipped entirely when `existing` is `undefined`, which is every first lay over a printed hex |
| that the hex may be built on at all | **F-1** — no `printedColor` / `RedOffboard` / `GRAY_HEXES` read |
| connected-component preservation **as such** | not needed for hub tiles (pairwise expansion makes it a set test); **is** the open question for the self-loop family (§8) |
| city attachment / city identity | not modelled; §7 row 8 |
| station landing (❹) and slot capacity | **F-5** — lives in `planTokenUpgrade`, outside the authority |
| ❷'s "blank side of a grey hexagon" / "solid red hex side" | only off-grid and the four named barriers are covered |

**Classification, against the brief's five options**

| Aspect | Verdict |
|---|---|
| the mask test | **correct generic invariant** — keep verbatim |
| segment inclusion over `paths` | **correct generic invariant, fed the wrong input** — it should receive the *merged* topology (printed ⊕ laid), not the laid tile alone. **"should remain generic but receive richer topology."** |
| the self-loop relaxation | **correct and load-bearing** — do not remove it; the OO chain depends on it |
| immutable-hex refusal | **missing rule, not a weak one** — belongs in the predicate, not in the helper |
| station anchoring | **correct invariant in the wrong place** — move `planTokenUpgrade` behind `layRefused` |
| city-identity constraint | **unknown until F-9 is ruled** — do not build machinery for it yet |
| per-tile special cases | **not needed.** §6 shows the generic filter already reproduces 127 of 127 rulebook edges up to two errata and the two catalog bugs. A `if (source === 59)` branch would be overfitting to a catalog defect. |

**Answer to §21 of the brief: A + C, with a four-item D, and explicitly not B.**

- **A — richer generic topology preservation** is the primary fix: give rule 5 the merged printed-⊕-laid topology
  and add the immutable-hex gate. That alone closes F-1, F-2 and G19's over-refusal.
- **C — explicit city-group lineage metadata** is needed only if F-9 is ruled "must stay distinct"; it is already
  half-present as `cityGroups` plus `fitStationsToUpgrade`'s edge-set anchoring, which *is* lineage metadata done
  right. Promote it into the authority (F-5) rather than inventing a second mechanism.
- **D — genuine special cases: four, all already named** (§7): `#54 → #883`, `#592 → #61`, the eight
  double-town greens, and "no city ever splits". Three of the four are implemented.
- **B — catalog-declared upgrade mappings: do not do this.** A hand-authored adjacency table would be a second
  source of truth for a graph the filter already computes correctly, and `utils/tileUpgrades.ts`'s module doc is
  four paragraphs of why that is the wrong shape here. It would also have *hidden* F-3 rather than exposed it.

---

## §14 Corpus exposure — READ-ONLY

13 log files scanned (`server/data/*.log.jsonl` plus the `__fixtures__` golden set; 12 distinct after resolving
duplicates). `RevertTo` is honoured with its own semantics — *"everything from `index` onward did not happen"*
(`gameEngine/logRevert.ts:3`) — which matters: a naive scan reports 21 phantom same-tier "upgrades" that are undo /
redo pairs.

| Log | Variants | Effective lays | Upgrade transitions |
|---|---|---|---|
| JUNO-FCJ | LPF | 95 | 39 |
| JUNO-Z6C | LPF | 83 | 32 |
| JUNO-CV4 | LPF | 15 | 2 |
| JUNO-CW7 | LPF | 5 | 0 |
| JUNO-7NZ, 8E8, G6J | LPF | 0 | 0 |
| JUNO-TQQ | **standard** | 0 | 0 |
| | | **198** | **73** |

**Every one of the 73 effective upgrade transitions passes the engine's v6 predicate** — correct tier step, exits
preserved, segments preserved. The corpus is internally consistent with the shipped rules, as Batch 8.5's own
reconciliation found.

**Zero lays on a hex that is immutable on that log's own board.** (Two rows look alarming on a standard-board hex
list and are not: `K13` is a real Plain `cityDesignation` city on the expanded board — it was the Deep South red
area only on the standard board — and `K15` is a River there, not gray Richmond. Both were re-checked per-log
against the board the log actually declares.) **So F-1 is latent in the corpus: no stored lay depends on it, and
closing it is corpus-neutral.**

### §14b The three transitions, re-adjudicated under the printed rule **[9.1b]**

At 9.1 these were "the F-9 exposure, legality unknown". Under revised 6.2.2 ❹ **all three are illegal**, and the
causes differ in a way that matters for Slice 9.3's scope.

| Log | Entry | Hex | Transition | Source `#59` | Destination cities | Connects #59's two exits? | Verdict | Cause |
|---|---|---|---|---|---|---|---|---|
| **JUNO-FCJ** | **640** | **E11** | `#59 @5 → oo14 @0` | exits {1,5}; cities `[5]`, `[1]`; segments `(5,5)`,`(1,1)` | `[[1,5],[0,4]]` — edges 5 **and** 1 both in city 0 | **YES** | **ILLEGAL** | **no legal form exists** — oo14 has **no** non-merging facing from #59 at any orientation |
| **JUNO-FCJ** | **1047** | **E5** | `#59 @4 → #65 @0` | exits {0,4}; cities `[4]`, `[0]` | `[[0,4],[2,3]]` — edges 4 **and** 0 both in city 0 | **YES** | **ILLEGAL** | **bad facing** — `#65 @2` and `#65 @4` were both legal from `#59 @4` |
| **JUNO-Z6C** | **399** | **E5** | `#59 @4 → oo13 @2` | exits {0,4}; cities `[4]`, `[0]` | `[[1,3],[0,4]]` — edges 4 **and** 0 both in city 0 | **YES** | **ILLEGAL** | **no legal form exists** — oo13 has **no** non-merging facing from #59 |

All three pass today's `preservesRouting` (mask and segment tests), which is exactly S9-19: the predicate has no
notion of which city an exit lands in, so a merge reads as an addition.

**Stations.** Each hex carried exactly **one** token at the upgrade, and in each case the `token_cities` plan put it
in a city that carries its old exit — so the *station* half of ❹ was satisfied every time. The violation is the
**track** half of the same clause: the two pre-printed exits became connected. Read from the logs:
FCJ E11 — 503 `PlaceHomeStation` ERIE at `city_index 1`, 555 `#59@5` → `token_cities [[6,0]]`, 640 `oo14@0` →
`[[6,0]]`. FCJ E5 — 899 PMQ home `city_index 1`, 988 `#59@4` → `[[9,0]]`, 1047 `#65@0` → `[[9,0]]`.
Z6C E5 — 343 PMQ home `city_index 1`, 378 `#59@4` → `[[9,0]]`, 399 `oo13@2` → `[[9,1]]`.

**Replay-semantic consequence, recorded and not acted on.** All three become **refusal-added** when S9-19 lands, so
Slice 9.2/9.3 will need a `RULES_ENGINE_VERSION` bump and two logs re-pinned (JUNO-FCJ, JUNO-Z6C). One of the three
(FCJ 1047) had a legal alternative facing of the very same tile; the other two had no legal form at all, because
their destinations are the two errata-voided tiles. **No log was modified. Nothing was re-pinned. No digest was
recomputed.**

### §14c Corpus exposure for the rest of the reconciled items **[9.1b]**

Re-scanned read-only, `RevertTo`-aware, across 12 logs / 198 effective lays / 73 effective upgrade transitions:

| Item | Corpus exposure |
|---|---|
| **oo1 (#8861 / ~~626~~)** | **JUNO-Z6C 163 lays `#626 @4` on H18 and it is never upgraded again.** Under the errata that is **correct play** — the tile is not upgradeable — and the engine's zero-facing behaviour matches. **No exposure; no re-pin.** The board simply ends with a green OO on H18 |
| **oo13 (~~#36~~)** | **JUNO-Z6C 399** lays it on E5 (illegal per §14b) and it is never upgraded again — the `oo13 → oo20` dead end, live on a board. Whether that dead end is correct is §8c's blocked question; **either way the lay itself is already illegal** for the #59 reason, so S9-16's outcome does not change this log's fate |
| **oo14 (~~#35~~)** | **JUNO-FCJ 640** lays it on E11 (illegal per §14b); never upgraded again. `oo14 → oo20` is legal in the engine (6 facings), so this is a dead end only because the game ended |
| **oo13 / oo14 revenue (S9-20)** | both tiles are on boards that ran to the end, so a 50 → 40 correction **changes recorded route revenue** on those two boards. This is the one reconciled item with an *arithmetic* replay consequence rather than a legality one — flag for Slice 9.3's re-pin plan |
| **TO family (§10c)** | `D10 #810 → #882` appears in **both** JUNO-FCJ (660 → 700) and JUNO-Z6C (549 → 564). The override is exercised, and both transitions are legal. **Corpus confirms the override is load-bearing: remove the TO tiles and these two boards lose a built hex.** |
| **M-11 (S9-18)** | **no lay on M11 in any log**, and no route recorded through it. Adding the printed rail is acceptance-changing in principle and **corpus-neutral in fact** |
| **#63 (S9-15)** | 4 lays of #63 across the corpus (FCJ J14 546 and H10 983; Z6C E19 384 and K13 435). Peak simultaneous #63 on a board: **2**. The tray is never exhausted, so raising 1 → 4 is **corpus-neutral** — and note that with the count at 1 the engine would have refused the *second* #63 in each log had the first still been on the board; it was not, because each was upgraded onward to #513 |
| **Immutable hexes (F-1)** | **zero** lays on a hex immutable on that log's own board. Corpus-neutral |
| **Printed topology (F-2)** | no first lay over a printed landmark hex used an illegal facing (`staysOnBoard` masked them). Corpus-neutral |
| **Station anchoring (F-5)** | every recorded `token_cities` landing is edge-consistent and single-token. Corpus-neutral |

## §15 Test-coverage audit

28 of the repo's 407 test files touch tile / topology concerns. The seven closest to this audit were run and
**all pass: 7 suites, 126 tests** (§Appendix A).

| Subject | Covered | Where |
|---|---|---|
| tile catalog identity, colour, city/slot agreement with artwork | **direct** | `tileNumbering.test.ts` ("every numbered tile is the tile that number means"; "keeps 15 and 59 distinct") |
| catalog city *i* = artwork city *i*, every two-city tile, every orientation | **direct** | `cityTopology.test.ts` |
| printed New York's per-city arrival | **direct** | `cityTopology.test.ts` ("edge 1 arrives at the first circle and edge 4 at the second") |
| tile counts, Classic and 1830+ | **direct**, but **pinned to the owner spec, not the rulebook** | `tileSupply.test.ts`, `plusTiles.test.ts:72` — this is why F-4 survived |
| upgrade graph: no tier skipping, brown terminal, #57 chain, OO/B/NY printed starts | **direct** | `tileUpgrades.test.ts` |
| orientation: legal-rotation derivation, preview rotation | **direct** | `previewRotation.test.ts`, `tileUpgrades.test.ts` |
| laid-tile segment preservation | **direct** | `tileUpgrades.test.ts`, `layAuthority.test.ts` |
| **printed-board track preservation on a first lay** | **UNTESTED** | — (**F-2**) |
| **immutable-hex refusal inside `layRefused`** | **UNTESTED** | `grayRedTrack.test.ts` covers gray/red *artwork and routing* and "refuses to let a route cross one" — never a lay (**F-1**) |
| OO cities, per-city reach | **direct** | `cityStartReach.test.ts`, `cityScopeCoverage.test.ts`, `stationTokenWall.test.ts` |
| city merges (`#54 → #883`), slot overfill refusal | **direct and thorough** | `nyMerge.test.ts` (14 assertions) |
| city splits | n/a — none exist | — |
| token migration, edge-set anchoring, ERIE | **direct and thorough** | `stationConnectivity.test.ts`, `tokenDestination.test.ts`, `previewTokenLanding.test.ts` |
| variant availability / leakage | **direct** | `plusTiles.test.ts`, `levelPlayingField.test.ts`, `rulesScope.test.ts`, `boardInEffect.test.ts` |
| private special tile lays | **indirect** | `layAuthority.test.ts`, `oneLayPerTurn.test.ts`, D&H covered in the Stage-7/8 suites; **S9-12 still open** |
| **old ↔ new number crosswalk** | **UNTESTED** | — no test references T-09 or any Lookout identifier |
| **#626 / #36 reachability** | **UNTESTED** | `tileUpgrades.test.ts` asserts "carries OO through to brown" for the *printed-start* chain, which routes through #59 and never exercises #626 (**F-3**) |
| **#59 merging facings** | **UNTESTED** | — (**F-9**) |
| LPF board tiles (warehouses, Coal River) | **direct**; the M11 straight track is **absent from both code and tests** | `levelPlayingField.test.ts` (**F-6**) |

**No new test file was added by this pass** (§23's preference). §Appendix C carries the probe as a fenced block so it
can be dropped into `src/utils/` at the start of Slice 9.2, when a failing assertion is wanted.

---

## §16 Private-company special hexes, cross-checked against the manifest

| Power | Hex | Board data | Tile involved | Does the special lay bypass ordinary topology preservation? | Verdict |
|---|---|---|---|---|---|
| **SV** | G15 | Mountain, no print | ordinary yellow | no special lay in this engine's model | n/a |
| **CSL** | B20 | std Plain; exp/LPF `townDesignation:"double"` | ordinary | `CSL_HEX_LABEL`, `privateReservations`; **the CSL lapse is modelled like the D&H's, which the rulebook states only for the D&H** | **S9-6, already open** — unchanged by this pass |
| **D&H** | F16 | Mountain + `cityDesignation` ("Scranton") | **`DH_TILE_ID = 57`** — correctly an old number; #57 is the only Classic yellow city tile, so "exactly one yellow tile" is right | **No bypass** — the lay goes through the ordinary arm; the power decides *whether* and *at what price*, not *what topology* | MATCH; **S9-12 (free station not judged by the D&H's rules at either lock) stays open** |
| | | | | the forfeit is indifferent to who built (#725, confirmed on report), and the F16 lay is *instead of* the normal lay | |
| **M&H** | D18 | Plain, no print | n/a — the M&H power is a share exchange | n/a (Slice 8.4, `mohawkExchange.ts`) | MATCH |
| **C&A** | H18 | **yellow OO** (Philadelphia & Trenton) | green #59 / #626, then a brown OO | no bypass | MATCH |
| **B&O** | I13 / I15 | I13 Plain; **I15 = Baltimore landmark** | #53 / #592 → #61 / #884 / #997 | no bypass; B&O's home is I15 (`STATION_HOME_HEXES`) | MATCH — and I15 is F-2's masked case (§9) |
| **NYC** | E19 (Albany) | Plain + `cityDesignation`, $0 printed | ordinary #57 → #14/#15/#619 → #63 → #513 | no bypass | MATCH — **house rule #44** (NYC homes at Albany E19, NNH at G19); recorded, not re-judged |
| **ERIE** | E11 | **yellow OO** (Dunkirk & Buffalo) | **green #59 laid over the printed OO hex**; ERIE may token *before* any track | the token rule is relaxed, **not** the tile rule: a tokenless token has no edges, so ❹ is vacuous and every facing stays legal — which is design note #878's general rule, not a named exception | **MATCH, and elegantly so** |
| **PMQ** | E5 under LPF | **yellow OO** (Detroit & Windsor) | #59 → brown OO | *"All rules about laying track for the Erie in the base game are to be applied to both the Erie and the PMQ in this scenario"* (p. 35) — the engine shares E5 the way ERIE shares E11 | MATCH |
| **JK** | any hex adjacent to L8 | LPF Coal River | ordinary tile at half terrain fee | `jkTileRefusal` + `jkHalfFee` (#1323); a key that fails the refusal refuses the **whole** lay rather than laying at full price | MATCH |

**On the brief's "NYC E19 can receive special yellow #57 disconnected from normal connectivity":** no such power
exists in this engine, and none is in the rulebook's private list — E19 is simply NYC's (house-ruled) home city
hex, and #57 is the only yellow city tile it can take. The disconnected-first-lay property the brief is reaching for
belongs to **ERIE at E11** (token before track), which is modelled. Recorded so the claim is not re-inherited.

**Answer to the brief's §15 question:** **no private power bypasses ordinary topology preservation in this engine.**
Every special lay routes through the same `layRefused` and the same `LayTile` arm; the powers modify cost, timing,
count and forfeit — never geometry. That is correct, and it also means F-1 / F-2 / F-5 apply uniformly to special
lays too, with no extra surface.

---

## §17 Proposed Stage-9 implementation slices **[9.1b — re-planned]**

The first pass proposed a "9.1b — owner rulings" gate. **That gate is gone**: the rulings it was waiting for came
from published sources this pass, and the one remaining unknown is a source-retrieval gap that blocks a single item
inside 9.3, not a slice boundary. Revised shape:

### 9.1 — audit / manifest / errata reconciliation — **COMPLETE** (this document)

### 9.2 — board-placement and topology authority — **Opus**

Make **board state and printed topology authoritative before touching any unusual catalog alias.** Four changes, one
slice, because they share one seam (`filterSandboxPlacements` / `layRefused`) and splitting them would leave the
predicate half-authoritative:

- **F-1 / S9-10 — immutable-hex authority.** Port `hexmap.rs`'s two checks in their Rust order (`:2317`
  `OffboardHexNotBuildable`, then `:2331` `GrayHexNotUpgradeable`), ahead of every geometric rule — the same order
  `evaluateHexForTileLaying` already uses. Do **not** duplicate that function: lift its Gate-1/2a/2b tests into one
  pure predicate both the UI and the authority ask, so the message and the refusal cannot drift. Port
  `src/tests.rs:5205`'s assertion with it. Covers gray, Coal, red off-board and non-hexes — and the errata's own
  *"The Richmond hex (K15) should be grey, as it cannot be upgraded"* is the rules citation.
- **F-2 / S9-10 — printed topology in the preservation predicate.** Add
  `priorTopologyAt(mapGrid, q, r) → { mask, segments, cities }` resolving **laid tile ▸ printed tile ▸
  `LANDMARK_TRACKS` ▸ `GRAY_HEXES` ▸ `OFFBOARD_TRACKS` ▸ nothing**, mirroring `liveEdgesForHex`'s and
  `archetypeForHex`'s existing fallback order exactly so no third classifier is born; feed rule 5 from it instead of
  from a `TileCatalogEntry`. This also un-masks G19's facing 4 and makes I15/E23's current correctness intentional
  rather than incidental. Keep revised 6.2.1 ❷ / 6.2.2 ❷ distinct from immutability: **illegal edge termination**
  (off-grid, blank grey side, solid red side) and **a hex that can never be built on** are two rules, and today only
  the off-grid third of the first is implemented (`staysOnBoard` plus the four named barriers).
- **F-5 / S9-17 — station anchoring in the authority.** Call the existing, already-pure `planTokenUpgrade` from
  `layRefused`; the shell keeps calling it for `legalRotations`. The future predicate needs **all three** of city
  connection preservation, slot capacity and token→city lineage — and all three are already implemented inside
  `fitStationsToUpgrade`; nothing new has to be designed, only re-sited.
- **F-6 / S9-18 — LPF's M-11 printed rail.** `printedTile: { tileId: 9, orientation: 0 }`, joining M9 ↔ M13.
  Verify the facing against the rendered board before committing. Mechanism already exists (#1301, precedent: the
  expansion's green #24 at H12).

Replay: refusal-added for F-1/F-2/F-5, **all three corpus-neutral** (§14c); F-6 is acceptance-changing for LPF but
also corpus-neutral. **Expect `RULES_ENGINE_VERSION` 6 → 7 at the end of 9.2.**

### 9.3 — expanded catalog, OO topology and identifiers — **Opus**

Kept separate from 9.2 deliberately: 9.2's changes are refusals with no corpus effect, while every item here either
re-pins a log or changes recorded revenue. Reviewing replay causality is far easier with that line drawn.

- **S9-19 — #59's two systems may never be connected** (revised 6.2.2 ❹). The seven (tile, facing) pairs in §8b stop
  being offered. All five Classic successors keep ≥2 legal facings, so nothing becomes unreachable. **Re-pins
  JUNO-FCJ and JUNO-Z6C** (three transitions, §14b).
- **S9-15 — #63 count 1 → 4** in `PLUS_TRAY`, and re-point `plusTiles.test.ts:72` at the rulebook rather than at
  the owner spec. **[9.1c] No owner confirmation needed**: the errata's correction sheet instructs *"40 value added
  to 1830+ side of **all four** C15 tiles"*, which is direct component evidence for four.
- ~~**S9-20 — oo13 / oo14 revenue**~~ **WITHDRAWN [9.1c].** Owner-confirmed **$50** for both; the engine is already
  correct. Nothing to implement, no test moves, no log re-pinned.
- **S9-21 — canonical identifiers.** Add a canonical record per tile (`oo1` = **#8861**, `oo13`, `oo14`) with the
  printed numbers as **deprecated input aliases** that resolve to it. Do not rename every reference; the ids are
  opaque handles and a rename would touch a dozen test and artwork tables for no behavioural gain.
- **oo1 non-upgradeability — metadata only, and probably nothing to do.** The behaviour is already correct and
  doubly authorised (errata + owner ruling #1390). If anything is owed it is a one-line catalog annotation saying
  *why* it has no successors, so the next reader does not file F-3 a third time.
- **S9-16 — `oo13 → oo20`: NOTHING TO IMPLEMENT. [9.1c]** oo13's geometry is owner-confirmed and the engine
  matches it; `#167` already achieves the 7/8 maximum; and no gray OO geometry exists that hosts this edge together
  with T-09's other `ooNN → oo20` rows. Carry it as a **recorded contradiction in official material**, with Option B
  costed (§8c-ii) in case the owner ever chooses to honour the correction sheet over T-09's oo10/oo12/oo17 rows.
  **Do not touch `#167` and do not touch oo13.**
- **Add the standing catalog invariant test:** *every upgrade edge that survives reconciliation has at least one
  legal facing, and no tile with a surviving successor is a dead end.* This is the durable fix — it would have caught
  the oo13 case the day the tile was added, and it turns the corrected upgrade graph into a machine-checked property
  instead of a document.
- **Add the TO-override regression pin** — already present at `levelPlayingField.test.ts:170-171`; extend its comment
  to cite printed Scenario D's removal so a future reconciliation reads the *reason* and not just the number.

### 9.4 — remaining Stage-9 targeted defects — **Opus**

**S9-13** (the chart walks one row per 10 %, not per certificate), **S9-11** (Blood Price arrival stamp) and
**S9-12** (the D&H's free station judged by the D&H's rules at both locks) can share one slice — all state/authority,
none topological. **S9-1** (`YellowSignEvent` client-authoritative) stays **separate**: it is the same *pattern* as
S9-17 but a different subsystem, and bundling an event-authority change with a stock-chart change makes a bisect
harder. **S9-6** (the CSL lapse, which the rulebook states only for the D&H) is an owner ruling, not code.

### Model recommendation

| Slice | Model | Why |
|---|---|---|
| 9.1 / 9.1b | **Opus** (done) | tracing, manifest, source reconciliation; no architecture choice |
| **9.2** | **Opus** | the representation question answered itself: the board already has four printed-topology tables and one canonical fallback order, and the fix is to read them in that order. One new resolver, two call-site moves, one board datum |
| **9.3** | **Opus** | a count, two revenues, a facing constraint, an identifier record and one blocked item. All mechanical once §8c is unblocked |
| **9.4** | **Opus** | four independent, well-specified defects |

**Fable is not warranted anywhere in Stage 9.** The brief's own bar — two materially different valid
representations for city lineage / topology preservation, with code evidence unable to choose — **is not met.**
Token→city lineage already has one natural and implemented representation (`stationConnectivity`'s edge-set anchor,
design note #878), printed topology has one natural fallback order, and the #59 constraint is a printed rule with
one reading. The single genuinely open question (§8c) is a **missing photograph**, not a design fork, and its answer
space has exactly two options with a known consequence each.

---

## §18 Ambiguities and stop conditions after reconciliation **[9.1b]**

The brief lists seven stop conditions. **One fires, narrowly and by source retrieval.**

| Stop condition | Assessment |
|---|---|
| official errata cannot be located / authenticated | **DOES NOT FIRE.** Located and read: *"1830 Clarifications & Errata (01/03/12)"*, © Mayfair Games 20120106, quoted verbatim in §1b. Its content matches the brief's account of it independently and in detail — oo1 → 8861, oo1 not upgradable, oo13/oo14 numbers voided with no replacement, and the oo13/oo14 value note the brief also anticipated |
| **corrected oo13 geometry cannot be established** | **[9.1c] DOWNGRADED — no longer a source-retrieval failure.** The correction sheet exists, was located inside the errata PDF (pages 2–3), was rendered and read, and **prints the `oo13 ➧ oo20` upgrade**. What remains is a rendering-resolution gap on one tile's rails, closed by opening that PDF locally (§8c). Original 9.1b assessment retained below for the record. ~~**FIRES, scoped to one item.**~~ The errata voids oo13's number, supplies no replacement, and does not retract `oo13 → oo20`. The engine's geometry is independently authored from the owner spec (not contaminated by historical #36) and cannot host that edge; §8c narrows it to two mutually exclusive hypotheses and names the one deciding artefact — **the replacement tile sheet art for oo13**, not obtainable this pass. **Blocks one item inside Slice 9.3. Blocks neither this audit nor Slice 9.2. Reported as a source-retrieval gap, NOT converted into an owner decision.** |
| oo20 geometry cannot be established | **DOES NOT FIRE.** #167 is untouched by the errata, its old number is valid, and §8c shows its split already maximises T-09 conformance |
| Ⓓ-mark membership cannot be established | **DOES NOT FIRE.** Established as a component fact from the removal list's own logic (§10b), with a stated falsifier. Not an owner decision |
| TO tile identities cannot be established | **DOES NOT FIRE.** to1 = #810, to5 = #882, both valid old numbers, both untouched by the errata; hex, topology, quantities and chain in §10c |
| two competing live tile catalogs, authority undeterminable | **DOES NOT FIRE.** Three tables, each with an unambiguous and documented consumer set (§2); cross-pinned by `cityTopology.test.ts` and `tileNumbering.test.ts`. A duplication to narrow, not an unresolved authority |
| a corpus transition cannot be adjudicated | **DOES NOT FIRE.** All three #59 transitions are now adjudicated — **illegal** — with causes separated (§14b) |

### Register after reconciliation

| Was | Now |
|---|---|
| **F-8** — `#626`/`#36` geometry ambiguity | **#626 half withdrawn** (no geometry question survives — the tile is not upgradeable). **oo13 half → S9-16**; at 9.1c the artefact is found and its legend read, leaving only the rails unread |
| **F-9** — OO merge ambiguity | **WITHDRAWN as an ambiguity → S9-19, printed rule** |
| **F-10** — Ⓓ-mark ambiguity | **WITHDRAWN as an ambiguity → resolved component fact (§10b)** |
| A8/A9 ↔ #5/#6 mapping conflict (T-09 vs T-01/S-1.1) | **still a rulebook conflict, still inconsequential** — and the errata's *"The (55) tile should be labeled A10, instead of A9"* shows the A9/A10/A8 labelling was a known defect of that print run, which also explains p. 35's odd "Variant — The A9 and A10 track tiles are available" line |
| T-09 vs p. 19 on `#28/#29 → #43` | **resolved by authority A**: the revised book lists `28 → 39, 43, 46, 70` and `29 → 39, 43, 45, 70`. T-09 omission; the engine is right |
| the 28-page book is absent from the repo | **located and read** (URL in §1). Still absent as a *file*; adding it plus the errata is recommended, and nothing here depends on it |

### TRUE OPEN OWNER DECISIONS

**None.** Two items would benefit from a one-line owner confirmation but neither is blocking and neither is a rules
question:

1. ~~**S9-15** — confirm #63's count~~ **[9.1c] CLOSED**: *"40 value added to 1830+ side of all four C15 tiles"* is
   direct component evidence for four. No owner input needed.
2. ~~**S9-20** — the oo13/oo14 value~~ **[9.1c] CLOSED**: the owner's physical-tile transcription confirms **$50**
   for both, matching the engine. Withdrawn as not a defect.

**One item is recorded rather than decided**, and it is not a question about this engine: `oo13 → oo20` is printed on
the official correction sheet and is unsatisfiable alongside T-09's other `ooNN → oo20` rows by **any** gray OO
geometry (§8c-ii). The engine implements the 7/8 maximum. If the owner ever wants the correction sheet honoured
instead, Option B is costed in §8c-ii — it trades oo10, oo12 and oo17 for oo13. That is a preference between
conflicting official rows, not a defect and not a blocker.

### PRINTED / ERRATA FACTS — settled, not decisions

- #59's two pre-printed exits can never be connected by an upgrade (revised 6.2.2 ❹).
- #59's successors are exactly #64, #65, #66, #67, #68 (revised p. 19).
- **oo1 (#8861) is not upgradable** (errata, Rules) — and the owner had independently ruled the same from playtest.
- printed old **#626** is erroneous for oo1; the corrected old number is **#8861**.
- printed old **#36** is erroneous for oo13, with no valid replacement.
- printed old **#35** is erroneous for oo14, with no valid replacement.
- `oo13 → oo20` is **not** retracted by the errata and remains a listed expanded-set upgrade.
- `#28 → #43` and `#29 → #43` are legal (revised p. 19); T-09 omits them.
- C15 (#63) is worth **40**, not 50 (errata) — the engine already has 40.
- K15 grey and unupgradeable; Detroit/Windsor costs $80; Ottawa B16 costs nothing (errata, Board — Classic) — all
  three already satisfied by the engine.
- Scenario-D component marks are component facts, and the Ⓓ track-tile set is established at §10b.

### PROJECT 18XX OWNER OVERRIDES — frozen

- **LPF retains the TO tiles (to1/#810, to5/#882) although published Scenario D removes them** (§10c). Rationale
  recorded; implemented; test-pinned. **A future reconciliation must not revert it.**
- (pre-existing, unchanged) `plusTiles` is offered on the printed board (#1415); NYC homes at Albany E19 (#44).

---

## §19 Findings ledger **[9.1b — F-1…F-10 disposition]**

| First-pass ID | Disposition | Now |
|---|---|---|
| **F-1** immutable-hex authority | **survives, wording strengthened** | **S9-10.** Rules citation added (revised 6.2.1 ❷ / 6.2.2 ❷ and the errata's K15 line); still a migration regression against `hexmap.rs:2317/:2331`; still 79 accepted lays, 54 destroying printed track; corpus-neutral |
| **F-2** printed-board topology | **survives unchanged** | **S9-10.** Independent of the withdrawn Baltimore example; reachable by a legal board edit even though `staysOnBoard` masks the three landmark hexes today |
| **F-3** oo1 + oo13 dead ends | **SPLIT, one half WITHDRAWN** | **oo1 half: withdrawn.** Errata: *"The oo1 (8861) tile is not upgradable"*; owner ruling #1390 agrees; engine correct; **no stale metadata anywhere in the repo** — the only artefact that claimed oo1 successors was this audit's first pass. **oo13 half: → S9-16**, narrowed and BLOCKED (§8c) |
| **F-4** #63 quantity | **survives, cause identified** | **S9-15.** Inventory is replacement, not additive, so the effective 1830+ supply really is 1 against T-09's 4. The errata's #63 item is about value and the engine already honours it |
| **F-5** station anchoring / slots | **survives unchanged** | **S9-17.** Now cited to revised 6.2.2 ❹ rather than the 48-page book |
| **F-6** LPF M-11 | **survives unchanged** | **S9-18.** Re-checked against T-02 and S-1.1 ❷; no Project override contradicts it; corpus-neutral |
| **F-7** test comment drift | survives | S9-15 |
| **F-8** oo1/oo13 geometry ambiguity | **SPLIT: half withdrawn, half narrowed** | see F-3 |
| **F-9** OO merge ambiguity | **WITHDRAWN as ambiguity → filed as a defect** | **S9-19**, printed rule, seven illegal (tile, facing) pairs, three corpus transitions |
| **F-10** Ⓓ-mark ambiguity | **WITHDRAWN** | resolved component fact (§10b) |

### Newly filed

| ID | Sev | Finding |
|---|---|---|
| **S9-19** | **HIGH** | #59's two pre-printed exits may never be connected by an upgrade (revised 6.2.2 ❹). Seven (tile, facing) pairs accepted today are illegal; three corpus transitions become refusal-added |
| ~~**S9-20**~~ | — | **WITHDRAWN at 9.1c.** Owner's physical-tile transcription confirms **$50** for oo13 and oo14; engine already correct. The errata's parenthetical is a distinguishing remark, not a value correction |
| **S9-21** | **LOW** | Canonical-identifier debt: oo1 = **#8861**, oo13 and oo14 canonical by Lookout ID; the engine keys all three on the errata-voided printed numbers. Behaviourally inert; fix with a canonical record plus input aliases |
| **S9-16** | **INFO** | **Reclassified at 9.1c: not an engine defect.** `oo13 → oo20` has zero legal facings because official sources conflict — oo13's geometry is owner-confirmed, the correction sheet prints the upgrade, and no gray OO geometry hosts it alongside T-09's other rows (556 candidates). Engine implements the 7/8 maximum |

### Withdrawn

- **F-3 (oo1 half)** — the engine's behaviour is correct under both the errata and the owner's own ruling.
- **F-9** — not an ambiguity; it is printed rule, refiled as S9-19.
- **F-10** — not an ambiguity; resolved as a component fact.
- **F-8 (oo1 half)** — no geometry question survives for a tile that cannot be upgraded.

### Exception manifest — re-checked after errata **[9.1b]**

The first pass's manifest **stands unchanged**. Re-verified against every reconciled item: oo1's
non-upgradeability only *removes* edges; the #59 rule constrains *facings*, not topology classes; the TO retention's
`#810 → #882` is already class **B** (slots [1,2] → [2,2]); the oo13/oo14 identifier and value corrections touch no
city topology. So:

1. **`#54 → #883`** — the only city **merge** in the whole tile set (2 × 1 slot → 1 × 4 slots; 1830+ only). Already
   implemented and thoroughly tested (`nyMerge.test.ts`).
2. **`#592 → #61`** — the only **capacity shrink** (2 slots → 1; 1830+ only, absent from Classic and LPF). Refused
   correctly by `fitStationsToUpgrade`, not refused authoritatively (S9-17).
3. **the eight double-town → single-town greens** — already modelled by `mergesTowns` (#1403).
4. **no city anywhere ever splits** — class C needs no machinery at all.

"All city merges are illegal" remains **false**, and the true statement remains narrow: one legal merge, one legal
shrink, eight legal town merges, zero splits — plus, now, one printed prohibition that is *not* a merge rule but a
rule about one specific tile's exits (S9-19).

---

## Appendix A — Validation run

Audit-only, per the brief's §30: no full Jest, no gameplay code touched, `RULES_ENGINE_VERSION` untouched.

```
$ cd frontend && CI=true npx react-app-rewired test --watchAll=false \
    --testPathPattern="(tileNumbering|cityTopology|tileUpgrades|plusTiles|tileSupply|nyMerge|stationConnectivity)"

PASS src/utils/plusTiles.test.ts (22.5 s)
PASS src/utils/stationConnectivity.test.ts
PASS src/components/tileNumbering.test.ts
PASS src/utils/nyMerge.test.ts
PASS src/utils/tileUpgrades.test.ts
PASS src/utils/cityTopology.test.ts
PASS src/utils/tileSupply.test.ts

Test Suites: 7 passed, 7 total
Tests:       126 passed, 126 total
Time:        70.476 s
```

Baseline green, consistent with Batch 8.5's own full-suite gate. No typecheck or build was run: this pass changed
no TypeScript.

**Independent verification.** The three load-bearing findings were re-derived from scratch by a second pass that did
not see this document's numbers, including a **dynamic** check: the real module graph was transpiled with the repo's
own `tsc` outside the repo, `evaluateHexForTileLaying` was patched to throw, and all 279 (hex × era) combinations
were swept through the real `filterSandboxPlacements` — **2,962 placements offered, `evaluateHexForTileLaying`
called 0 times**, and the per-hex acceptance counts reproduced this document's F-1 table exactly (F6 6, E9 18,
H12 6, D14 6, C15 18, A17 3, D24 3, I19 1, F24 1; red A9 1, A11 3, B24 1, F2 3, I1 3, J2 3, K13 3). The 36-facing
sweeps for F-3 were likewise run twice — once in Python, once with the five real function bodies extracted verbatim
and transpiled — with identical results (0/36 for all nine cases; controls `#59 → #64` 18/36 and `#66 → #167`
12/36). The tray totals were computed both from the parsed catalog and from the repo's own compiled
`tileTrayPlus.js`: 85 / 135, identical. **So the static re-implementation in Appendix B is confirmed against the
shipped modules, not merely transcribed from them.**

### Addendum — 9.1b sources, method and validation

**Sources used at 9.1b, with exact provenance**

| Authority | Retrieved from | What was taken |
|---|---|---|
| **2018 revised Classic rulebook (A)** | `https://www.lookout-spiele.de/upload/en_1830re.html_Rules_1830-RE_EN.pdf` | §6.2.1 ❷/❺, §6.2.2 ❶–❼ verbatim; p. 19's Tan-Hex, Yellow-Hex, Yellow→Green and Green→Brown tables verbatim, every row |
| **Official Mayfair errata (C)** | `https://images10.newegg.com/UploadFilesForNewegg/itemintelligence/Luster%20Leaf/1830_errata1446080716979.pdf` — *"1830 Clarifications & Errata (01/03/12)"*, © Mayfair Games 20120106 | Tiles (Classic and 1830+), Tile Numbering — Older, Rules, Board (Classic and 1830+), Charters — all verbatim in §1b |
| **48-page rulebook (B)** | the repo's `1830 FULL RULES with variants.pdf`; publisher copy at `https://www.lookout-spiele.de/upload/de_1830.html_Rules_1830_EN.pdf` | unchanged from the first pass |

**[9.1c — this claim is withdrawn.] The replacement tile art is pages 2 and 3 of the errata PDF itself**, headed
*"1830™ – Errata Sheet MFG1830-88"*. 9.1b searched for it as a separate artefact and never opened the PDF's own
image content — a research error, not a source gap. At 9.1c both sheets were **rendered in the built-in browser and
visually inspected**, and their text layer extracted separately; §1b-ii records the legends and annotations and §8c
what they decide.

**How the 9.1c pass was run, and its limit.** The PDF was opened in the browser pane
(`.../1830_errata1446080716979.pdf`), the page thumbnails confirmed three pages, page 1 was re-read to correct the
T-09 attribution (§1b), and pages 2–3 were magnified until individual tiles filled the frame. Partway through, the
pane entered a stuck CSS-scaled zoom state — screenshots began timing out, clicks were refused with *"frame owner is
CSS-transformed (scaled); it was not dispatched"*, scroll began acting as zoom, and neither `resize_window` nor a
fresh `preview_start` cleared it. **Colour, label, city count and every legend hex were read before that; the tile
rails were not.** The tile sheets carry a real text layer (they are vector art, not a scan), which is how the
legends were confirmed independently of the pixels.

**What would close it in one step:** save the errata PDF into one of the connected folders and render pages 2–3
with `pdftoppm` at 300–600 dpi, exactly as the 48-page rulebook was rendered in the first pass. That resolves
oo13's and oo14's rails and both value roundels in a single sitting.

**Method.** Both PDFs were read through the fetch tool with prompts demanding verbatim transcription rather than
summary; where a first response paraphrased, it was re-queried section by section until it quoted. **One
paraphrase was caught and discarded this way** — an early reading attributed the errata's "Board — 1830+" text to
the wrong place; the targeted re-query returned the section verbatim (*"Table T-09 (last page) is missing a yellow
hex in the lower left corner."*) and that is what §1b records. Engine-side work reused the 9.1 extraction
(`$HOME/s9/*.py`) plus new disposable scripts in **`$HOME/s91b/`**, outside the repo: `oo.py` (spec-convention
cross-check and the oo13→oo20 facing sweep), `oo20b.py` (the exhaustive partition enumeration behind §8c's table)
and `adj.py` (the corpus re-adjudication in §14b).

**Validation at 9.1b.** No test was run: this pass changed no TypeScript and added no test. The 9.1 run (7 suites,
126 tests, all passing) stands as the characterization baseline, and **every source file the audit rests on was
re-stat'd and is untouched** by the owner's concurrent modal/UI work — `sandboxTileLegality.ts` 2026-09-14,
`hexTileCatalog.ts` 2026-09-11, `tileTrayPlus.ts` 2026-09-07, `hexBoardDataLpf.ts` 2026-09-15,
`tokenMigration.ts` 2026-09-11. The F-1 / F-2 / F-5 code anchors were re-checked in place and are unchanged.

## Appendix B — Method, and how to re-run it

**Rulebook.** The 48-page PDF's pages 2–43 and 45–48 carry no text layer. Pages 19, 34, 35, 45 and 48 were rendered
with `pdftoppm -png -r 200` (and p. 48 again at `-r 600`, then cropped and magnified per tile row) and read as
images. Native thumbnail resolution in T-09 is roughly 70 × 80 px, which is legible for **colour, circle count and
circle grouping** and **not** legible for per-city exit assignment on the OO family — hence F-8 being an ambiguity
rather than a defect.

**Engine extraction.** Disposable scripts in `$HOME/s9/` **outside the repo** (`extract.py`, `markers.py`,
`check.py`, `graph.py`, `deep.py`, `matrix.py`, `expose.py`, `gen.py`, `corpus4.py`). They parse
`hexTileCatalog.TILE_CATALOG` and `TileGraphics.TILE_GRAPHICS_CATALOG` (brace-matched, comments stripped), then
re-implement — faithfully, line for line against the source read in §13 — `rotateConnections`, `tileSegments`,
`preservesRouting`, the tray deltas, `staysOnBoard` and `crossesImpassableBorder`, and cross-check them against the
T-09 transcription in `t09.json`.

**Confidence in the re-implementation.** It is now **confirmed dynamically against the shipped modules**
(Appendix A), and independently it reproduces the
rulebook's 127-edge upgrade graph up to exactly the two p.19/T-09 errata and the two catalog bugs, and agrees
with `tileUpgrades.test.ts`'s assertions about the real filter's derived graph (#57 → both green cities, both green
cities → #63, OO carried through to brown, New York carried through to brown). The F-1/F-2 claims additionally rest
on a *negative* that needs no arithmetic at all and is verifiable by one grep: `sandboxTileLegality.ts` imports from
`hexBoardData` only `IMPASSABLE_BORDER_EDGES, LANDMARK_HEXES, STATIC_BOARD_HEXES, TO_HEXES, YELLOW_OO_HEXES,
boardMemo`, and mentions `printedColor` on two lines, both inside `preprintedTierByLabel`'s `"Yellow"` filter.

**Corpus.** `RevertTo { index }` means "everything from `index` onward did not happen" (`logRevert.ts:3`), i.e.
**exclusive**. Getting this off by one inflates the transition count from 73 to 101 and manufactures 21 phantom
same-tier "upgrades"; both numbers appear in the working notes and only the exclusive one is correct.

## Appendix C — Probe test, for Slice 9.2 to drop in

Deliberately **not** added to the repo by this pass. Drop into `frontend/src/utils/stage9Probe.test.ts` when a
failing assertion is wanted; it is expected to fail on F-1 and F-2 today.

```ts
/** @jest-environment node */
import { filterSandboxPlacements } from "../components/sandboxTileLegality";
import { GRAY_HEXES, STATIC_BOARD_HEXES, LANDMARK_TRACKS } from "../components/hexBoardData";
import { localCatalogPlacements } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";

const BARE: MapGridResponse = { game_id: 0, tiles: [] };
const at = (label: string) => STATIC_BOARD_HEXES.find((h) => h.label === label)!;

describe("F-1: an immutable hex refuses every tile, authoritatively", () => {
  for (const label of Object.keys(GRAY_HEXES)) {
    it(`${label} (printed gray) accepts nothing`, () => {
      const { q, r } = at(label);
      for (const era of ["Yellow", "Green", "Brown"] as const) {
        expect(filterSandboxPlacements(localCatalogPlacements(), { mapGrid: BARE, q, r, era })).toHaveLength(0);
      }
    });
  }
  for (const hex of STATIC_BOARD_HEXES.filter((h) => h.type === "RedOffboard")) {
    it(`${hex.label} (red off-board) accepts nothing`, () => {
      const out = filterSandboxPlacements(localCatalogPlacements(), {
        mapGrid: BARE, q: hex.q, r: hex.r, era: "Yellow",
      });
      expect(out).toHaveLength(0);
    });
  }
});

describe("F-2: a first lay over a printed landmark preserves its printed track", () => {
  it.each([["Baltimore", "I15", [0, 4]], ["Boston", "E23", [1, 5]]] as const)(
    "%s keeps its printed exits at every offered facing",
    (name, label, printed) => {
      const { q, r } = at(label);
      const offered = filterSandboxPlacements(localCatalogPlacements(), {
        mapGrid: BARE, q, r, era: "Green",
      });
      expect(offered.length).toBeGreaterThan(0);
      // The assertion that must hold for the RIGHT reason, not because of staysOnBoard:
      expect(LANDMARK_TRACKS[name].flatMap((s) => [...s.edges]).sort()).toEqual([...printed].sort());
    },
  );
});
```

## Appendix D — Files inspected and files changed

### Inspected (read-only)

**Rulebook** — `1830 FULL RULES with variants.pdf` pp. 1, 19, 34, 35, 44, 45, 48.

**Authoritative topology / legality**
`frontend/src/components/hexTileCatalog.ts` (897) · `components/sandboxTileLegality.ts` (562) ·
`components/hexBoardData.ts` (739) · `components/hexBoardDataPlus.ts` (244) · `components/hexBoardDataLpf.ts` (226) ·
`components/hexGeometry.ts` (1103, selected ranges) · `components/hexContractTypes.ts` (selected) ·
`components/tileTray.ts` (85) · `components/tileTrayPlus.ts` (34) · `components/tileTrayLpf.ts` (61) ·
`components/TileGraphics.ts` (2320, catalog block + `tileCitySlotCounts` + `slotOffsets`) ·
`utils/tileUpgrades.ts` (270) · `utils/tileSupply.ts` (77) · `utils/tokenMigration.ts` (439, selected) ·
`utils/stationConnectivity.ts` (130) · `gameEngine/boardSelection.ts` (52) · `gameEngine/initialGrid.ts` (35) ·
`gameEngine/trackSegments.ts` (394, selected) · `gameEngine/trackReach.ts` (export map) ·
`gameEngine/stationTokens.ts` (1026, selected) · `gameEngine/cityBlocking.ts` (selected) ·
`gameEngine/sandboxSession.ts` (`applySandboxLayTile`, the `LayTile` arm) · `gameEngine/replayProviders.ts` (selected) ·
`gameEngine/gameVariants.ts` (selected) · `gameEngine/rulesVersion.ts` (selected) · `gameEngine/logRevert.ts` (selected) ·
`gameEngine/dhPower.ts` (selected) · `gameEngine/levelPlayingField.ts` (selected) ·
`App.tsx` — **read only**, at `:388-398`, `:6080-6130`, `:10745-10800`, `:14370-14400` (the `layRefused` composition
and the `legalRotations` memo; required for the duplicate-authority audit, per the brief's §29) ·
`components/RulesReference.tsx` — grep only, never opened for editing.

**Tests** — `tileNumbering`, `cityTopology`, `tileUpgrades`, `plusTiles`, `tileSupply`, `nyMerge`,
`stationConnectivity`, `levelPlayingField`, `grayRedTrack` (headers / assertion names).

**Corpus** — `server/data/*.log.jsonl` (8) and `frontend/src/utils/__fixtures__/**/*.log.jsonl` (4), read-only.

**Docs** — `RULES_HARDENING_BACKLOG.md` (S9-10 and the S9-* index) ·
`AUDIT_RULES_TO_MACHINE_2026-09-13.md` (§F rows 335-341).

### Changed by this pass

1. **`STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md`** — created at 9.1; **revised at 9.1b** (front matter, §0, §1,
   §1a-§1c, §2b, §5b, §6b, §8a-§8c, §10b, §10c, §14b, §14c, §17, §18, §19 and this appendix). The data sections are
   unchanged and re-verified.
2. **`RULES_HARDENING_BACKLOG.md`** — S9-10 refined (found case corrected, #59 clause re-marked pending F-9,
   exception manifest added, F-1…F-10 filed); no item marked RESOLVED.
3. **`AUDIT_RULES_TO_MACHINE_2026-09-13.md`** — §F row "No tiles on gray/red": `UNCLEAR` → `MISSING`, with the
   confirmed count. One row; nothing else touched.

**No gameplay code was modified. No test was added or modified. `RULES_ENGINE_VERSION` remains 6. No commit was
made. Nothing was stashed, reset, checked out or cleaned.**
