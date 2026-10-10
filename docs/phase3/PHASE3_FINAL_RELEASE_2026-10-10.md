# Phase 3 final release (2026-10-10) — PUBLISHED

The owner authorized this release on the condition that the verification and W3-F gates pass. They passed: see
[`W3F_CLOSURE_REPORT_2026-10-10.md`](W3F_CLOSURE_REPORT_2026-10-10.md).

**Release order:** backend, then the Play frontend, then the Ludum site.

**Scope limits:**
- No escrow contract was instantiated or modified.
- No JUNOX was sent.
- No governance transaction was executed.
- main is untouched.

Evidence is stored owner-locally, in two places:
- `1830-staging-ops/evidence/phase3-final-20261010T1101Z/`
- `target/phase3-final-frontend-deploy/`

## What is live

| Part | Release | Before (rollback target) |
|---|---|---|
| Source | `ludum/integration` @ `f9ab4c2d420c3415fb758e66f805efc0147e5780` (code = Phase-4 baseline `e63221ae`; W3-F docs on top) | `100d0ec1` (Ludum v1.1) |
| Backend (single host `i-01fe56536bf591382`) | `sh1-f9ab4c2-arm64-r1`, `sha256:45d401cfa01c0aed2cc40b543264fbc38040a7a76359106e42509f2b8d634519` | `sh1-669192e-arm64-r1`, `sha256:868f8f2bfbe0435a0594d9b5712591c45eb1aed996e50cab35cbd8160c3ea15e` (the rollback floor) |
| Play (Vercel `nda4/1830-juno-edition`) | `dpl_GHYQKNBofVnbhcmSs7qevVubhJ1L` (`https://1830-juno-edition-11a2ujsoj-nda4.vercel.app`, served `main.bb56ecdd.js`) | `dpl_HCTXa1afVQS3rVdMvyZiqYUVJmvT` (`https://1830-juno-edition-3g7q95qfa-nda4.vercel.app`) |
| Ludum (`cosmonought/ludum`, GitHub Pages) | main `f88afd7` (fast-forward from `11dce9e`); run `38047230484` "Publish Ludum (allow-list)" success | main `11dce9e` |

The escrow pin is unchanged: Escrow 2.1, `juno19vd5hphghprl2m8agchctyav8pmeh6p4x3vud6cfhd2y6ulwtf0s0jrk7x`, checksum
`c3bd0618…8219`, uni-7.

## Verification

### Backend
- **Before the switch:** a status check and a graceful stop, then the arm64 smoke test on the host: 7/7.
- **Deploy:** READY. healthz, readyz and origin TLS all return 200. No static credentials.
- **KMS role probe:** exit 0. The relayer, settlement, admission and REMEDY keys each signed and verified.
- **CORS / origin regression:** 49/49.
- **Ludum v1.1 live API checks:** 38/38. These cover:
  - routes refused while signed out;
  - exact ACAO;
  - reviewer-only moderation;
  - display names.

### Play bundle scans (local build and served bundle)
- **Present:** the 2.1 contract and checksum, `wss://play.netadao.org/gs`, the build SHA, `ludum.netadao.org`, and the hashed official `keplr-icon` asset.
- **Absent:** the 2.0 contract, `5ecc3022` and `dev_claim`.
- The local build carries no development claim and no source maps.

### Production browsers (real URLs, no host mapping)

| Browser | Result |
|---|---|
| Chrome | 32/32 |
| Firefox | 31/33 |

Both runs covered:
- the visitor lobby and its public lobby data;
- sign-up on Ludum with an Authorization Wallet;
- one shared session across both sites, and the HttpOnly cookie;
- Play's profile chip and menu, and Ludum's Your account page;
- sign-out and sign-in from each site, seen on the other;
- the plain wrong-password refusal;
- refusal of an open-redirect `?return=`;
- recovery;
- no sideways scroll at 390 px;
- no CSP violation and no unexpected console error.

**Firefox's two misses** came after recovery. The harness ran out of this IP's guest-session budget, and the server answered 429 with Retry-After. That is the account protection working as designed.

The recovery outcome was then proven at the API level, pausing for the rate limit (8/9 checks pass):
- recovery signed by another key gets the single refusal, `403 invalid-credential`;
- recovery with the account's wallet returns 200;
- the old password gets `403 invalid-credential`;
- the new password returns 200.

The ninth check expected a replayed recovery to get 409 or 403. It got 401 instead, because a successful recovery retires the temporary session. The replay was still refused. The operation-level `authorization-used` path is covered by server tests only.

### Ludum publishing
- Pages publishes from main only, through the allow-list workflow.
- Permissions are `contents: read`, `pages: write` and `id-token: write`.
- Dev paths return 404: `platform/tests`, `platform/tools`, READMEs, the workflow file and `design-system`.

### Test accounts (inert, staging)
- `p3vchd61da4` and `p3vfi829416` (browser runs)
- `p3vrc36184e` (recovery check)
- `lv11a398e99` and `lv11be695b4` (v1.1 API checks)

All test sessions were signed out.

## Rollback

**Backend.** Use `gs-host.ps1 -Command deploy -InstanceId i-01fe56536bf591382 -Digest sha256:868f8f2b…3ea15e -BuildId sh1-669192e-arm64-r1`.
- Do not go below `sh1-669192e-arm64-r1`: Ludum v1.1 journals display-name renames, and older images cannot restore them.
- No runtime document, environment variable or infrastructure change accompanied this release.
- The new RoomSummary fields are optional, and set-ante only rewrites the existing `ante_gross` before any deposit.
- **If the backend rolls back, roll Ludum back as well.** The Ludum site's native sign-up, sign-in and recover pages need this release's v1.2 routes.

**Play.** From `target/phase3-final-frontend-deploy/upload-f9ab4c2`, run `npx vercel@62.1.0 promote https://1830-juno-edition-3g7q95qfa-nda4.vercel.app`.
- That build has the earlier lobby and host screens and works against either backend.

**Ludum.** Run `git revert 34271ce` on main as a new commit, never a force-push. `f88afd7` only merged main's own `11dce9e`, so it needs no revert. The allow-list workflow then republishes.
- The v1.1 site works against either backend.

## Known limitations and defects (published as is)

- **Play sends no Content-Security-Policy and no frame-ancestors / X-Frame-Options.** This is pre-existing: no source in the repository has ever configured one for Play. Its responses carry only HSTS. The game-server API sends `nosniff` and `no-store`, and Ludum sends its own CSP.
  - **Recommendation:** add a header policy for Play in a separate reviewed change, at minimum `frame-ancestors 'none'` and `nosniff`.
- **Any with an ante is blocked**, because Escrow 2.1 requires an exact seat count. The correction is an early Phase-4 task, and Escrow 2.1 stays unchanged.
- **A second escrow is still possible from a non-Play client.** It stays unbound and cancellable (the A-4 duplicate design).
- **No real Keplr wallet and no real Juno transaction was verified in Phase 3.** Funded games, settlement, REMEDY and disputes are Phase-4 playtesting.
