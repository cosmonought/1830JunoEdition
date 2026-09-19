# Playtest triage — `JUNO-G6J`, first tunnelled playtest, 8 September 2026

Two players on two machines, through ngrok (`PLAYTEST_NGROK.md`). Nine actions in, still in the auction.
One finding, and it is a real one.

---

## 25 — the auction's all-pass paid on the client and not on the server

**REPORTED:** both players passed, the cheapest private dropped $5 as it should, and the banner appeared:

```
This tab has drifted from the room — its board no longer matches the server's (at action 8). Reload to resync.
[divergence] drifted — index 8: server 432adf2449f67779, client 7608b9f5e5acee30
             — fields: player_cash, virtual_bank_vgp
[divergence] client player_cash = [{"p-lzjh2r6u":"1100"},{"p-fdsq3jbg":"1105"}]
[divergence] client virtual_bank_vgp = "9550"
```

**THE LOG SETTLED IT WITHOUT ANYBODY GUESSING.** `server/data/JUNO-G6J.log.jsonl` replayed headless:

| | `p-lzjh2r6u` | `p-fdsq3jbg` | bank |
|---|---|---|---|
| client | 1100 | 1105 | 9550 |
| server | 1070 | 1085 | 9600 |
| delta | **+30** | **+20** | **−50** |

$30 is the SV, C&S and D&H, whose owner had bought all three. $20 is the M&H, won on the 115 bid at index 4.
$50 is one round of private income, and the sum is zero — not a lost update but a transfer one side made and
the other did not. **The client was right.** 1830 pays private income when the table passes out an auction
round, and the server's copy of the game never paid it.

**WHERE IT WENT.** `applySandboxWaterfallAction` returns `allPassed` and does not perform the payout — it
cannot, and says so at `sandboxSession.ts:1771`: *"the waterfall atom does not carry `private_companies`. The
caller runs `applyPrivateRevenue`."* Same contract as `charges` (#334a) and `won` (#303). The difference is
where each is composed:

| reported by the reducer | composed in `App.tsx` | composed in `RoomEngine` |
|---|---|---|
| `charges` | yes | yes |
| `won` (+ the C&A's PRR share) | yes | yes |
| `allPassed` → private income | **yes** | **no** |

Phase 2 moved the first two into `replayLog.ts` when the auction went onto the server. The third was left at
its call site — `App.tsx:5827` — which the server does not run. The browser paid; the server did not.

**IT IS #685's LESSON THROUGH A THIRD DOOR.** #685: *"one place, on the one transition that opens an
Operating Round, replayed identically by every client."* #1059 then found there were two such transitions and
not one, and split `openOperatingRound` out to hold both. There are **three**: the auction's all-pass pays
private income too, whether or not the markdown lands on a round number (#337). The Operating Round path was
never at risk — `openOperatingRound` calls `applyPrivateRevenue` inside the reducer (`sandboxSession.ts:355`),
so the server has always paid that one correctly.

### Fixed

`replayLog.ts`, in `RoomEngine.apply`, immediately after the `won` loop and inside the same atom block —
design note #1281:

```ts
if (result.allPassed) {
  this.state = applyPrivateRevenue(this.state)?.state ?? this.state;
}
```

**After `won`, never before.** The $0 branch of the markdown hands the private to the next seat inside this
same all-pass, and that new owner is owed the payout; paying first would pay the previous owner, or nobody.
`App.tsx` orders it the same way.

**VERIFIED AGAINST THE ROOM'S OWN LOG**, which is the point of keeping it: replaying `JUNO-G6J` through the
rebuilt server now gives `1100 / 1105 / 9550` — the client's figures exactly. `npm run smoke` passes.

### Still open — the fault *under* the fault

**THERE ARE TWO COMPOSITION LAYERS, AND THIS IS THE SECOND TIME THEY HAVE DRIFTED.** `replayLog.ts:10` says
it holds *"the only call site of `applySandboxAction` in the project (#536: one order of operations for every
client)"*, and that sentence is no longer true: `App.tsx:6001` calls it as well, and `App.tsx:5738` calls
`applySandboxWaterfallAction`. The live client and the server compose the same reducer's reports twice, by
hand, and nothing fails when only one of them is taught a new rule — the divergence check catches it, but
only in a real game, and only after somebody has played into it.

The fix above closes this instance. The class stays open until the live client goes through `RoomEngine` too,
or until something makes the two layers fail to compile when they disagree. Worth its own number.

### Not covered by a test yet

No test would have caught this: the reducer's unit tests exercise `applySandboxWaterfallAction`, which is
correct in isolation, and nothing asserts that `RoomEngine` and `App.tsx` compose its reports identically. A
regression test belongs at the engine: replay an all-pass through `replayLog` and assert the bank paid.
