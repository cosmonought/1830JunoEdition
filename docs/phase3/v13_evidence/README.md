# v13_evidence: the scratch reproductions behind `V13_SCOPE_VERIFICATION.md`

These files are inert evidence, deliberately not live tests:
- **The `.txt` suffix** keeps every tool (jest, tsc, eslint) from picking them up.
- **They pin today's v12 behaviour.** Several assert defects as current behaviour, so they must not run as regressions.
- **When v13 lands they will intentionally fail.** The v13 implementation should turn each into a real regression with v13 expectations.

## To run one

Copy it under `frontend/src/__v13_scratch__/<dir>/` (the relative imports assume that depth), drop the `.txt`, and run it alone:

```bash
cd frontend
CI=true npx react-app-rewired test --watchAll=false src/__v13_scratch__/<dir>/<file>.test.ts
```

## The files

All were run on `6455b6e` (rules v12) on 2026-10-03, one at a time.

| File | Dir | Result | Covers |
|---|---|---|---|
| `od2Sbs.test.ts.txt` | `od2` | 16/16 pass | OD-2 v12 Pass semantics, and a model of the one-Pass change; SBS-3; SBS-4; the chart's par and Brown zones |
| `od4AutomaticBankruptcy.test.ts.txt` | `od4` | 9/9 pass | OD-4 reproductions R1–R5 and vectors V2–V6, with a prototype of the insolvency bound |
| `dh1LaterTurnTokens.test.ts.txt` | `dhgr` | 1/1 pass | DH-1 through a `RoomSession` |
| `gr1RefusedDerivedWithhold.test.ts.txt` | `dhgr` | 2/2 pass | GR-1 / S10-27 through a `RoomSession`; GR-1b on the shell path |
| `d18d22TileUpgrades.test.ts.txt` | `tiles` | 3/3 pass | D-18 and D-22 against the real placement authority, plus an independent geometry check |
