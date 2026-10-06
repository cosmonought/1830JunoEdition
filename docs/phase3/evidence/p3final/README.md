# Phase 3 final account / wallet identity — §9 RED reproduction

**Defect (owner §9 / §2):** through `caad745` the account kept a "verified payout wallet" that followed whichever
wallet was last linked at any seat (`moneyTables.ts` persisted every grant-authorized link through `associateWallet`).
Switching Keplr to another wallet and linking it at a second table silently changed the wallet the account showed as
its own — the menu's "Payout wallet", the trust facts' "verified wallet", and the wallet that then linked without
"Confirm it's you". A wallet was answering part of "who is this account".

**Test:** `server/src/identity/p3FinalWalletSwitch.test.ts` — written only against what both builds expose
(`POST /gs/api/account/me`: `wallet` at caad745, `authorizationWallet` here) so the same file runs on both.

| Build | Result | File |
|---|---|---|
| `caad745` (detached worktree, same test file) | **RED** — the account's wallet went `null → Wallet A → Wallet B` | `wallet_switch_RED_caad745.tap` |
| this branch | **GREEN** — the Authorization Wallet is unchanged by both links | `wallet_switch_GREEN.tap` |

Reproduce (PowerShell, from the repo root):

```powershell
git worktree add ..\red-caad745 caad745
Copy-Item server\src\identity\p3FinalWalletSwitch.test.ts ..\red-caad745\server\src\identity\
Push-Location ..\red-caad745\frontend; npm ci; Pop-Location
Push-Location ..\red-caad745\server; npm ci; npm run build; node --test dist/server/src/identity/p3FinalWalletSwitch.test.js; Pop-Location
```

**Fix:** the profile no longer stores any game wallet (`associateWallet` / `profileWallet` / `forgetWallet` removed); an
account has exactly one designated Authorization Wallet, changed only by the two-signature replacement; seat links write
nothing to the account. The open table's account guard (`frontend/src/utils/tableAccountGuard.ts`) additionally makes a
change of the BROWSER's account under an open table (another tab signing in/out) a forced question instead of a silent
re-seat; a Keplr account switch never triggers it.
