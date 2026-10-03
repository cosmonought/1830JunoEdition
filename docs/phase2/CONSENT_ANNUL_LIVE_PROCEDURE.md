# Phase 2 · Session 4 — live test: cancel by agreement (consent annul)

**Status:** a PROCEDURE. **Not executed.** Written 2026-10-03 on `phase2/single-host-live-procedures`.
**Runs on:** the JX-1 contract on uni-7, served by the single host (`JX1_SINGLE_HOST_SETUP.md` accepted).
**Do not run without the owner's GO ("GO P2-ANNUL").**

"Cancel by agreement" is the product name ("Agree to cancel this game"); the contract message is `AnnulByConsent`. It is
the only way a **dealt** money game ends early without play, a dispute or the liveness rule: every seat agrees, and every
seat gets its **net** deposit back. The server can never do it alone (`moneyLifecycle.ts` `POST_DEAL_REFUSAL`), and
neither can the admin, the creator or the resolver (contract test `annul.rs`
`neither_the_admin_nor_the_creator_can_annul_alone`).

## 1. What is proven, and what this live test adds

| Already certified (source / contract) | This live test proves |
|---|---|
| Contract `tests/annul.rs`: every seat must sign; success from IN_PROGRESS refunds net antes only; from SETTLEABLE at the settlement's seq; a newer checkpoint voids older annul signatures; bad / foreign-domain / duplicate / out-of-range signatures refused; a repeat refused; works while paused; only IN_PROGRESS or SETTLEABLE; a rotated seat must sign with its new key. `vectors.rs`: Python-generated annul signatures verify on chain | the browser-held consent keys sign the exact on-chain ANNUL digest on two real devices |
| Server `escrow4Money.test.ts` "ANNUL: each seat's signature is collected…": collection, a wrong-seq signature refused `wrong-key`, one annul relayed with every seat's signature, FIN `closed`, view `annulled` | the server's collection and the single host's relayer submit ONE `AnnulByConsent` that lands on uni-7 |
| Relayer `relayer.ts`: an annul is `moot` when the trusted sequence moved, `done` when ANNULLED; it is ready while paused | the KMS-signed relayer transaction, its journal and RELAYQ# lifecycle, on the real ledger |
| — | the exact refunds, the treasury's subsidy, the contract's zero delta, and the server's convergence (`FIN closed`, route `annul_by_consent`) |

**Scope of the live run:** ONE fresh 2-seat **live** table, minimum ante, annulled from **IN_PROGRESS** right after the
deal checkpoint. The SETTLEABLE variant and the stale-signature case are covered by the tests above and are **not run
live** (they would need a full game or a round boundary).

## 2. Authority: which key does what

| Actor / key | Role in the annul | Signs on chain? |
|---|---|---|
| **Seat consent key** (one per seat per table; made in the seat's browser at deposit, kept in IndexedDB `1830juno.money_keys.v1`, never sent; its public key registered with the server at "Confirm it's you" and written on chain by the Join as the seat's `consent_pubkey`) | **The only authority.** Signs `ANNUL = SHA-256("18JUNO/ANNUL/v1" ‖ domain ‖ u64(trusted_seq))`, 64-byte low-s r‖s, over a digest the browser computes itself from a chain read of the game's `domain` and `trusted_seq` (`moneyActions.ts` `agreeToAnnul`) | no — an off-chain signature carried inside the relayer's message |
| **Seat wallet (Keplr)** | **Not involved.** It made the deposit and is the refund destination (`seat.wallet`). No Keplr prompt appears for the annul: the button is "Sign my agreement", not "Continue in Keplr" | no |
| **Hosted session** of each seated player | carries the signature to `POST /gs/api/money/annul`; needs the seat's signed-in session, **no sensitive re-authentication** (owner ruling OD-4-2: the consent-key signature is the authority) | — |
| **Server** | verifies each signature against the seat's CURRENT on-chain `consent_pubkey`, which must also be a key this player registered (`seatSignatureProblem`); collects them **in memory** per (game, trusted_seq, domain, seat count); when every chain seat has signed, writes ONE durable `annul` chain intent (`annulInstanceOf`, keyed by the set of keys) | no (it makes no annul signature; the settlement key is not used) |
| **Relayer `<RELAYER>`** (KMS) | submits `{"annul_by_consent":{"chain_game_id":N,"consents":[{seat_index,signature}…]}}`; pays the gas | yes — the Cosmos transaction only |
| Admin / creator / resolver | none | — |

## 3. Preconditions

| # | Precondition | Proof |
|---|---|---|
| AN-P1 | JX-1 accepted (A-1…A-16); escrow active, relayer usable, `HostHealthProblems` 0 | `JX1_SINGLE_HOST_SETUP.md` §7; `gs-host status` |
| AN-P2 | `set-operator-plan --to-relayer <RELAYER>` READY (balance ≥ the planning reserve) | the command |
| AN-P3 | `paused` false, and **no admin pause planned during the test** (an annul works while paused, but keep it out of JX-7 E's pause window to keep evidence separate) | `jx1b_verify verify` / the Game query |
| AN-P4 | Two test wallets `KA` (host / creator) and `KB`, each in **its own browser profile** on its own signing device, each ≥ **2.1 JUNOX** free (2.0 ante + fees) beyond any concurrent table | `jx1b_verify account` |
| AN-P5 | Both players signed in, hosted identity profiled, "Confirm it's you" done for this table; each seat's consent key created **on the device that will sign** (if a seat must sign elsewhere, "Use this device for signing" + the wallet's `SetConsentKey` FIRST, then re-check AN-P8) | the room's money view: `chainConsentKey` = the key the device holds |
| AN-P6 | **No deploy, stop or restart of the host from the first signature until the chain shows ANNULLED** (collected signatures are memory-only) | owner hold on `gs-host` |
| AN-P7 | Testers agree the **play rule**: after the deal, make **no move that crosses a round boundary** (stay in the private auction) — a new checkpoint moves `trusted_seq` and voids collected signatures | briefing |
| AN-P8 | Before the first signature: the deal checkpoint is **confirmed** on chain and no other checkpoint intent of this game is pending | §4 step 5 |

**Record before the run (one height):** balances of `KA`, `KB`, `<JX1_TREASURY>`, `<JX1>` (the contract), `<RELAYER>`.

## 4. Steps

| # | Actor | Action | Expected |
|---|---|---|---|
| 1 | KA | Create a **2-max live** money table at the minimum ante (2 JUNOX); link wallet; deposit (Keplr `create_game`, one coin 2,000,000 ujunox) | chain: FUNDING, seat 0 = KA, `net_deposit` 1,950,000; 50,000 to the treasury in the same tx |
| 2 | KB | Join the table; link wallet; deposit (Keplr `join`, with the server's admission) | chain: FUNDED, seat 1 = KB; another 50,000 to the treasury |
| 3 | KA | Start (the relayer submits `start`) | chain: IN_PROGRESS; FIN `in-progress`; roster frozen (permanent once Start is on chain) |
| 4 | both | Play only inside the private auction (AN-P7) | the relayer posts the **deal checkpoint** automatically |
| 5 | operator | Read `junod q wasm contract-state smart <JX1> '{"game":{"chain_game_id":N}}'` and `gamesDoctor aws money <game_id> --chain --aws-config <P1ARN>` | `state` `in_progress`; `latest_checkpoint` = the deal checkpoint; `trusted_seq` = its seq (`= T`); every checkpoint intent of the game `confirmed`; none pending |
| 6 | KB | In the room: "Agree to cancel this game" → confirm → "Sign my agreement" (no Keplr prompt) | the answer: "Your agreement is recorded (1 of 2)…"; view `annulSigned` = [1]; **chain unchanged** (IN_PROGRESS) — unanimity: one seat cannot force it |
| 7 | KA | The same, within a few minutes | "Every player agreed: the cancellation is on its way to Juno."; host log `AUDIT money.annul-relayed` (game_id, chain_game_id, `trusted_seq` = T, intent_id) |
| 8 | relayer | (automatic) submits the annul intent; journals the attempt; broadcasts | `RELAYQ#<RELAYER>` holds it while live; then the tx confirms (≈ 1–2 blocks) |
| 9 | server | (automatic) observes the chain | FIN `closed` (`chain-closed`, state ANNULLED, route `annul_by_consent`); the annul intent `confirmed`; `RELAYQ#<RELAYER>` empty for this game; room view `settlement.status` `annulled`, headline "The game was annulled; deposits came back." |
| 10 | operator | Capture evidence (§6) | as §5 |

**Expected time:** ≈ 20–25 min (steps 1–3 ≈ 10, the deal checkpoint ≈ 2–5, signatures ≈ 2, relay and confirmation ≈ 1–2,
evidence ≈ 5). Well inside the 3600 s liveness window.

## 5. Expected on-chain / server state transition and balances

**Chain (`Game` query):** `in_progress` → **`annulled`** (terminal); `pool` 0; `outcome` =
`{ route: "annul_by_consent", amounts: ["1950000","1950000"], dust: "0", distributed: "3900000", bond_returned: "0", bond_to_pool: "0" }`.
Tx wasm attributes: `action=annul_by_consent`, `chain_game_id=N`, `state=annulled`; two bank sends of 1,950,000 ujunox,
to `KA` and to `KB`; **no send to the treasury**.

**Server:** FIN `in-progress` → `closed`, `chain_outcome` route `annul_by_consent`. The annul intent `pending` → `in-flight`
→ `confirmed` with exactly one confirmed attempt (ledger `ATTI#` / `TXID#` match: `JOURNAL MATCH`). Any later checkpoint
intent for this game resolves `moot` and is never signed; a later seal is recorded but nothing is submitted. The room's
gameplay is not closed by the chain (play may continue with no money); no money action is offered any more, and
"Your deposits" no longer lists the table.

**Balances (ujunox; `f(x)` = the actual fee of tx x from `junod q tx`):**

| Account | Δ over the whole test |
|---|---|
| `KA` | −2,000,000 + 1,950,000 − f(create_game) = **−50,000 − f(create_game)** |
| `KB` | **−50,000 − f(join)** |
| `<JX1_TREASURY>` | **+100,000** (the two subsidies; the fee on each deposit is not refunded) |
| `<JX1>` contract | **0** (game pool 0; global invariant: balance = Σ open pools + Σ disputed bonds) |
| `<RELAYER>` | −f(start) − f(deal checkpoint) − f(annul_by_consent) (≈ 0.03 JUNOX each; estimates — record the actuals) |

Players pay **no** fee for the annul itself.

## 6. Evidence to capture (into `<D>\p2-annul\`)

| # | Evidence | Source |
|---|---|---|
| E-1 | balances of KA, KB, treasury, contract, relayer — before (one height) and after (one height) | `jx1b_verify account` / `junod q bank balances` |
| E-2 | `Game` query before the first signature (`trusted_seq` = T, deal checkpoint) and after (ANNULLED, outcome) | `junod q wasm contract-state smart` |
| E-3 | the create, join, start, deal-checkpoint and annul tx results (fees, wasm attributes, bank events) | `junod q tx <hash>` |
| E-4 | the room money view after step 6 (`annulSigned` [1], chain IN_PROGRESS) and after step 9 (`annulled`) | DevTools `/gs/api/money/*` responses / screenshots |
| E-5 | `gamesDoctor aws money <game_id> --chain --json` after step 9: FIN `closed` / `annul_by_consent`; the annul intent `confirmed`, one attempt; `JOURNAL MATCH`; `ROSTER MATCH`; `CHAIN BINDING MATCH`; RELAYQ# membership none | OPER |
| E-6 | the exact signed relayer tx: `gamesDoctor aws money <game_id> --tx-bytes <annul intent_id>` → `frontend/scripts/jx2VerifyTx.js` (the message's contract, `chain_game_id`, two consents; no funds) | OPER, offline |
| E-7 | host log lines: `AUDIT money.annul-relayed` and the chain-closed observation; no `held`, `chain-inconsistent` or `backend-refused` | `/gs/staging/host` |
| E-8 | `RELAYQ#<RELAYER>` Count 0 (strong) after step 9 | the S0.3 query |

## 7. Refusal and failure conditions

| Condition | What happens | Funds at risk | Action |
|---|---|---|---|
| Only one seat signs | the chain stays IN_PROGRESS; nothing is relayed | none | expected at step 6; if the second never signs, the game continues (or ends by play / liveness) |
| `trusted_seq` moved between the signatures (a checkpoint landed: a round boundary or the seal) | the server starts a new collection (old-seq signatures dropped); a relayed intent becomes `moot` ("the trusted sequence moved … the seats sign again") | none | both seats sign again at the new seq; record it as a deviation |
| Host restarted / redeployed during collection | the in-memory collection is lost | none | both seats sign again (AN-P6 exists to avoid this) |
| A seat moved its signing key after signing | that signature is dropped (no longer the seat's current key) | none | that seat signs again with the new key |
| `key-not-registered` (409) | the seat's on-chain key was not registered from this account / device | none | "Use this device for signing" (re-auth + wallet `SetConsentKey`), then sign |
| `wrong-key` (409) | the signature is not by the seat's current key over this digest (stale view, other device) | none | reload; sign from the device holding the current key |
| `held` (409) / no "annul" action offered | the table is held for operator review: the server relays nothing | none | STOP: diagnose the hold (`gamesDoctor aws money`); the players' chain exits (liveness) stay available |
| `wrong-state` (409) | the chain game is not IN_PROGRESS / SETTLEABLE (e.g. DISPUTED: only the resolver's Resolve Annul applies; or already terminal) | none | STOP: record the state |
| `not-verified` (503) / `store` (503) | the backend is not verified against the chain / a store write failed | none | retry after `gs-host status` is ready; STOP if repeated |
| The annul intent is `held` (a simulation refusal or a contradiction) | nothing is broadcast after the refusal | none | STOP: E-5 + E-6; do not retry by hand |
| The relayer is below reserve / unusable | the intent waits | none | top up / restore the relayer; it lands later |
| A LivenessSettle lands first (only if the test stalled > 1 h) | the game goes SETTLEABLE or CANCELLED; the annul becomes moot | none | record; the test is void — rerun with a fresh table |
| Outcome amounts ≠ 1,950,000 each, a treasury send in the annul tx, or contract Δ ≠ 0 | — | **investigate** | STOP; preserve E-1…E-8 |

## 8. Cleanup and end state

- **Chain:** the game ANNULLED (terminal; every later game message refused). The contract's balance back to its
  pre-test value. `paused` unchanged (false). No admin action was taken, so nothing to undo.
- **Server:** FIN `closed`; no pending intent for the game; `RELAYQ#<RELAYER>` empty; `HostHealthProblems` 0.
- **Room:** testers stop playing and close it; it has no money effect any more.
- **Browsers:** the table's consent keys stay in each profile's IndexedDB, scoped to that table and now powerless (the
  game is terminal); signing out removes them, as usual.
- **Wallets:** `KA` / `KB` keep their refunds (1,950,000 each) for later tables.

Record: append to the Session-4 record (Project `claude/PHASE2_SESSION4_<date>.md`): the table above filled, the
evidence paths, the actual fees.
