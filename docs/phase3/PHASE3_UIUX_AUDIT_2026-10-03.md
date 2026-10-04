<!--
PROVENANCE (repository header added by the Phase-3 reconciliation pass, 2026-10-03; not part of the audit):
- Source: the completed Phase-3 UI/UX audit, delivered as chat text on 2026-10-03 (attachment
  "Pasted text(20261003-071127).txt"). SHA-256 of the attachment as received: f1068dea6d9d611480b6d7e643ccce77b3b1e283fc286eac6d90e79da84d32a5
- The audit read the local checkout at `live6/live-closure-candidate-w1` = 7b1a956b1eeef31ad17ec6b08b475c4649747f6a.
- Normalization: the attachment's first line, a one-sentence chat preamble ("I'll audit the frontend and project
  docs read-only and build the Phase 3 player-facing backlog, without changing anything.") and the blank line after
  it were dropped. Everything from "PHASE 3 UI/UX BACKLOG: COMPLETE" to the end is byte-for-byte the attachment,
  except that a final newline was added (the attachment ends without one).
  SHA-256 of the preserved body below this comment: bb64eb1a3afccb1d958eda68fab2845744f20a152850b3245aa3d892cff02567
- Authority: this is the authoritative statement of the known Phase-3 backlog. Do not edit its conclusions.
  Dispositions live in PHASE3_AUDIT_RECONCILIATION.md; the execution plan in PHASE3_EXECUTION_PLAN.md.
-->

PHASE 3 UI/UX BACKLOG: COMPLETE

**Scope.** Nothing was changed: no files, commits, pushes, tests or AWS access.
- **Code checked:** the local checkout, `live6/live-closure-candidate-w1` at `7b1a956`. Its frontend source matches the newest branches; those branches add only test files.
- **Ledgers read:** `RULES_HARDENING_BACKLOG.md` Part C (the U-items) and Part F, and the open, playtest and owner-decision entries of `VISUAL_FLOURISH_BACKLOG.md`.
- **Project docs read:** the Phase 6.5 register (K-, H-, RR- and SBS-items), the modal series, the scaling and zoom docs, the App.tsx decomposition audit, ESCROW-4, JX-3A, JX-6A, and the UI-parity docs for the Delayed Auction (DA-6), Gentle Rust (GR-3) and Unpredictable Revenue (UR-6) variants.
- **Spot checks:** about 25 open items were checked against current source. Those confirmed in code are marked (code✓).
- **Not read:** GitHub issues. This session can't reach the repository's API.

**Key:** [D] known defect · [UX] known UX improvement · [PT] needs playtest discovery · [R] already resolved · ★ likely to set future component boundaries

---

**1. Game shell / overall layout ★**
- [UX] U-16: the action bar still carries a temporary fit probe (`useStickyFitProbe`, code✓). Someone has to decide whether the step panels move back into the bar, then remove the probe.
- [UX] The game screen has no heading or status region. This blocks the Batch 4B focus work.
- [D] A-14: the status dock's height is fixed at 96 px because its observer never attaches (found by code reading).
- [D] A-21: the hex indicators are misplaced at any uiScale other than 1.
- [D] A-13: tutorials reset on every mount.
- [UX] The game id isn't shown anywhere, and the "UI build #640" stamp is stale (code✓).
- [UX] Log export is only available through the hidden Ctrl+Shift+L. A visible "Copy game log" button is wanted, including on the crash screen.

**2. Auction / privates ★**
- [D] K-02 / U-26: the main bid control refuses raising your own standing bid ("One bid per private company", code✓).
- [D] K-15: the contest's "Drop out… refunded in full" button is wrong under the rule that a passer stays in the contest (code✓). The label, its behaviour and the bidder list all need changing.
- [UX] While a contest is live, other seats' controls aren't greyed out, and nothing shows how close the contest is to ending (`passes_since_raise`).
- [D] H-04: a double-click on the dashboard sends twice, because the in-flight latch doesn't cover it.
- [D] I-1: a second B&O par press after a reconnect produces an error banner.
- [D] I-2: the "not reached the table yet" note can flash after a send that did land.
- [UX] The auction prompt's handoff state has no focusable control. It's blocked on the same product decision as the home-station prompt.
- [UX] There's no standing "auction owed" indicator. When the first 5-train cancels the Delayed Auction, it only appears as a log line.
- [D] DA6-O1: the auction tutorial page "When everybody passes" is wrong.
- [R] The B&O par prompt (H-02), the all-pass narration, the Blood Price surfaces (U-42) and the Delayed Auction blurb (D-56) are fixed.

**3. Stock round ★**
- [D] U-23 / K-19: the first-Stock-Round sale ban is restated inside the panel, and its tooltip calls rulebook §5.1 a house rule (code✓).
- [D] U-25: the par ladder, affordability, share source and multi-buy limit are computed locally rather than read from the rules engine, and a source holding 0% still offers Buy.
- [D] U-39 / K-07: in Level Playing Field, a legal fifth certificate can't be sold into the Bank Pool, because the panel keeps its own 50% cap (code✓).
- [UX] ★ SBS-1/2: the panel forces a sell → Pass → buy walk, and ending a turn takes two Pass presses. The target is one Pass/End Turn control, and it depends on the owner's OD-A-4 ruling.
- [D] K-12: Auto-Buy never checks cash, so it stalls. SBS-5: Auto-Buy passes before checking the must-sell rule.
- [UX] The must-sell hold is shown only in tooltips.
- [D] K-18 / U-36: the sold-out price-rise log line describes a further, hypothetical rise, because the mirror is written before the line is built (code✓).
- [D] K-22 / U-37: a float isn't logged until the corporation's first Operating Round turn.
- [D] I-3: the 400 px prompt pointer overlaps the Private Companies card.
- [UX] R4: the typed offer form is lost if a send is dropped.
- [PT] S-4: the UI may be stricter than the engine about turn stages.
- [R] The player-to-player private trade (K-01 / U-19), the greyed sale of an unparred share (K-08 / U-24) and the duplicate funding prompt (K-10) are fixed.

**4. Operating round / action bar ★**
- [UX] ★ K-13 / U-22: End Turn, Skip and Buy stay enabled while an Operating Round offer is pending. They should be disabled on every seat, with the hold's sentence.
- [D] A-17: Run Trains is marked as run even when nothing was sent.
- [D] A-8: the JK chip shows outside the Operating Round.
- [D] DH-1: the D&H owner's Tokens step is never auto-skipped in later turns. This is routed to the rules batch.
- [PT] U-2 / A-3: the bar sticking on the previous step. U-12: a purchase tagged with the wrong step. U-13: a laid tile appearing, then vanishing.
- [R] SI-H01: on the hosted path the bar shows the live step.

**5. Track / tile interaction ★**
- [D] U-38: tile numbers voided by the errata still show on the hex face, in the Tiles reference tab and in the "no upgrade" toast (code✓).
- [D] A-7: a home-station click opens the tile ring.
- [D] The tile picker has no Escape key (code✓).
- [UX] Open tile-animation items from the visual backlog: overlays not staged (D-13), the first-frame switch (D-12), pixel seams (D-16/D-30), the whole-board repaint cost (D-17), and the OO reservation marker (D-35).
- [PT] The tile ring's first facing on a tokened upgrade, plus the tile-animation timing items.
- [R] The terrain-cost copy (RR-2) and canonical tile names in the log and picker are fixed.

**6. Tokens / stations ★**
- [D] K-21 / U-32: the home-station prompt still says "has floated" although it now appears at the first Operating Round turn (code✓). Skip stays live during placement.
- [UX] ★ A-2 / H5: a watching seat that isn't president gets the home-station form or a scrim with no exit. This needs a product decision.
- [D] A-5: a reload between the D&H tile lay and the station makes the free station unreachable.
- [PT] DH-2: whether the D&H modal re-offers the free station later.
- [UX] The Rules Reference marks Lay Track as the current step while the home token is owed.

**7. Route building / display ★**
- [D] K-11: a hand-drawn route set below the maximum is offered, then refused.
- [D] K-26: the route tooltip says revenue is withheld before the dividend choice is made.
- [UX] U-17 / K-06: there's no control for bypassing a city on a route; the engine already supports it.
- [UX] S6-13: the panel's route validators duplicate the engine's, so click-by-click feedback can disagree with the engine.
- [UX] RR-1: the copy implies a human must demonstrate a better route.
- [R] S6-15 and S6-16 are fixed by rules v12, which is in this checkout but not merged to `main`.

**8. Dividends**
- [D] GR-1: a refused derived withhold is still logged (Gentle Rust variant).
- [PT] U-14: an undo from Buy Trains showed the wrong dividend figure; it's waiting on a log. The dividend and route-pulse animation timings also need watching.

**9. Train buying / emergency / discard ★**
- [D] U-21: the room's Rescind button still sends the old chain-era `RescindTrainOffer`, which pinned boards refuse (code✓). The train-sale panel doesn't read the engine's refusal (`trainSaleRefusal`).
- [UX] U-20 / U-21 / K-05: the private-purchase panel offers corporation-owned privates, and the proposer has no rescind control for train or private offers.
- [D] K-25: the emergency modal says "Bank Depot" when the train is in the Bank Pool.
- [D] A-9: the emergency modal can't be closed.
- [UX] ★ U-4 / U-5 / U-6: the emergency-funding and discard UIs are minimal. The table needs one "waiting on X" surface for every pending offer.
- [UX] RR-4 and RR-7: forced-purchase and emergency-sale copy.

**10. Presidency / share exchange**
- [D] K-20 / U-33: there's no log line when the presidency changes, and no stated tie-break reason.
- [D] U-35: the M&H exchange uses a client-side check (`resolvePrivateExchange`, code✓) instead of the engine's (`mhExchangeRequestRefusal`).
- [D] K-17: a queued M&H exchange is logged as executed.
- [UX] K-03: there's no choice between IPO and Bank Pool for the M&H share, though the owner ruled it required.
- [UX] K-04: no M&H request during an Operating Round.
- [UX] No queued, executed or cancelled status for an exchange, and no "gotcha" copy for it.

**11. Round / status information ★**
- [D] K-16: the Priority Deal tooltip can name the wrong opener mid-round.
- [D] One-shot notices (the Phase 3 modal, rust) are lost on reload.
- [UX] The rules-engine hold sentence (U-22) should show on every seat. The Rules Reference has no game-over state. U-10 (the clock, live vs async play) stays deferred.
- [PT] H-05: the Delayed Auction arming line on every seat. U-34: the dynamic operating order.

**12. Player / company information / ledger**
- [D] K-23 / U-27: after a bank break the ledger shows "$0 remaining", "$-20" and more than 100% paid out (code✓).
- [D] U-41 / U-43: post-game statistics errors; these need owner review.
- [D] H-06: on a tie, only the first player gets the WINNER badge.
- [UX] U-7 and U-8 (palette, colour wash) and the GR-3 "traded" vs "rusted" label are owner calls.

**13. Modals / dialogs ★**
- [R] 15 surfaces use the native dialog element, with a focus trap and their own Escape policies.
- [UX] ★ Batch 4B: after acknowledging Private Revenue or Fleet Loss, focus lands on the page body. This needs a policy for one notice following another, plus a game-screen heading.
- [UX] The seat PIN dialog and tutorials aren't native dialogs. The intro overlay's scale contract is unsettled. Whether the portal/inert layer is still needed is undecided.
- [D] A-20: several native modals stacking at once.
- [PT] Firefox and Safari behaviour.

**14. Error / validation feedback ★**
- [UX] ★ One error-banner slot has about 28 writers, cleared by matching exact text. It needs a unified banner model.
- [D] S10-1: reducer refusals are still answered "applied", so the shell's REFUSED receipt never fires in room play.
- [D] U-30: replayed stock refusals carry no reason (code✓).
- [UX] U-29: refused private and train purchases look like a button that did nothing.
- [UX] ING-2 and I-6: generic refusal wording, and client wording that differs from the server's.
- [UX] The in-flight latch covers only the action bar and the Stock Round panel. The dashboard, token and tile confirms, the private-power modal, route edits and consent answers can double-send.

**15. Animation / audio**
- [PT] Every visual flourish batch (VF-1 to VF-8, the warning marks, the audio wiring) is implemented but unwatched: 47 PLAYTEST items, 21 recorded owner decisions.
- [UX] The 23 OPEN entries in that backlog are mostly low priority:
  - timers keep running off-screen;
  - the row glide has never been observed;
  - the phase flip is silent;
  - the Ledger tab doesn't receive the rust or discard animation;
  - the static badge icons aren't built;
  - the auction card hand-writes its palette.
- [D] A-19: background radio stays ducked.

**16. Mobile / responsive / scaling**
- [R] The default scale is 100%, pinch zoom works again, and nothing overflows horizontally at 360–430 px on the lobby, waiting room, Host Game, Rules Reference, Ledger, Rail Map or Auction tab.
- [UX] At narrow widths the Host Game footer sits below the fold. The scale readout doesn't say whether the player chose the value or the app guessed it. A scale chosen in private browsing is lost on reload. Breakpoints ignore the zoom.
- [PT] No real device, iOS, Android or Firefox testing has been done. Untested: 44 px touch targets at reduced scale, Ctrl+wheel zoom, and the in-game Stock Round and Operating Round screens at phone width.

**17. Accessibility / readability**
- [UX] Host Game lacks descriptive text links (`aria-describedby`), and its radio group ignores Home/End. The focus outline hides the tab accent.
- [PT] No screen-reader testing has been done.

**18. Lobby / session / start-game flow**
- [D] A-12: Game Over's "Leave" goes to the sandbox gate, not the Lobby.
- [D] A-10: the auto-close timer restarts on refresh.
- [D] A-11: Close Room reappears while scrubbing.
- [UX] U-40: the "Project 18XX" naming pass. U-15: the Keplr logo. DA6-n: name-case drift. The waiting room's extra description line awaits an owner decision.
- [R] Public rooms with Join and Watch, the waiting-room layout, and Host Game Escape and focus are done.

**19. Spectating / reconnect / recovery ★**
- [UX] I-1 / R4: forms don't show that a submission is still queued on the link.
- [D] U-45: two tabs can both reach Keplr, creating a duplicate escrow.
- [PT] The recovery scenarios R1–R12 (refresh, network loss, two tabs, second device, stale modal, divergence banner).
- No host succession and no clock for an absent seat; these are recorded limits.

**20. Money / escrow UI**
- [UX] U-44: the server writes times as "HH:MM UTC" while the client shows unlabelled local times.
- [UX] JX-3A E-1, E-2, E-3, B-3: a stale wallet proof still shows "Wallet linked"; replacing a wallet takes two Keplr prompts; expiry messages are generic; a Keplr rejection can read as "unknown".
- [UX] JX-6C: the browser should re-read the chain before a Challenge. JX-6E: the dispute confirm gives no deadline time, and the band shows no dispute record.
- [UX] S10-12: an owner-authored Terms page is needed before the first real deposit.
- [D] K-24: the no-money table's placeholder payout and Close Room tooltip. The on-chain copy itself appears to be fixed.
- [R] I-4: a dispute's evidence now reads the live board.

**21. Rules Reference / tutorials**
- [R] The redesign is implemented.
- [D] Copy defects:
  - DA6-O2: must-sell lacks the curable-only qualifier;
  - RR-3 and RR-5 to RR-7;
  - the home-station timing text (U-32);
  - the presidency tie rule (U-33);
  - the M&H gotcha (U-35);
  - the exact-$5 revenue rounding tie (UR-F20);
  - the hand-copied step-label table (S10-14).

**Gate item:** U-28, the retrospective UI-parity audit of Batches 1–6, is still OPEN and will probably add items. Part F says every Part C item must be fixed, shown obsolete or ruled on by the owner. Deferring one to polish doesn't count.

---

**Highest-risk unresolved interaction systems**
1. **Pending offers and holds** across seats (U-6, U-20, U-21, U-22, K-05, K-13). Nearly every seat and every control is affected.
2. **The action dock and turn gate.** There are nine separate whose-turn derivations, the sticky step (U-2), the fit probe (U-16), the dock height (A-14) and A-17.
3. **The map interaction controller.** Tile lay, tokens, home station, private powers and the bypass control share one state (A-7, H5, U-17).
4. **The Stock Round panel's local rules copies** (U-23, U-25, U-39, the SBS walk). The panel is 4,374 lines.
5. **The auction dashboard** (K-02, K-15, the contest freeze, double-send).
6. **The M&H exchange flow** (five parts of U-35).
7. **The notice and modal layer:** chaining, focus, notices lost on reload, stacking.
8. **The error and refusal model:** the banner slot, S10-1, U-29/U-30, latch coverage.

**Settle before the frontend refactor:** each item below decides a component the App.tsx audit already proposes.
- the action-dock model (M16), including the single Pass/End Turn control (OD-A-4);
- the notice/modal layer policy (M7) and the game-screen heading;
- the map-interaction controller (M11), including the H5 watcher decision;
- the pending-offer/hold surface (M15);
- the unified error banner and in-flight latch scope;
- the status dock and header (M9/M17);
- the room gate with the waiting room and money panel, plus the endgame and settlement band (M5/M10).

**Leave for Phase 4 playtest discovery:**
- all 47 animation and audio PLAYTEST items;
- the retests U-1, U-2, U-9, U-12, U-13 and U-14;
- H-05, DH-2, S-4, the tile-ring facing and K-12's stall;
- recovery R1–R12 and the Rules Reference checkpoints;
- real-device, mobile, Firefox/Safari, touch and screen-reader behaviour;
- whether the Delayed Auction's 5-train cancellation can be reached by legal play.

**Approximate workload:** about **70–115 hours**.

| Area | Hours |
|---|---|
| Interaction and rules-sync (auction, Stock Round, OR offers, M&H, routes, tokens) | 30–45 |
| Shell surfaces (dock, status, banner, modal/notice policy) | 12–20 |
| Copy, narration and Rules Reference | 8–12 |
| Money and wallet UX | 6–10 |
| Responsive and accessibility | 6–12 |
| Animation residuals | 3–6 |
| U-28 audit and statistics residuals | 6–10 |

That is well above the roadmap's 31–50 hours for Phases 9–10, and it excludes whatever Phase 4 turns up.

The roadmap, `PROJECT_CANONICAL_CONTEXT.md` and Part F still put UI/UX after the Phase 7 refactor. They'll need updating to match the new order. I can also save this backlog as a Project doc or a repository ledger entry if you want it on record.

MAJOR APP.TSX REFACTOR:
DEFER UNTIL PHASE 3 + PHASE 4 STABILIZATION
