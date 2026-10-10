# Play security headers (Phase 4, 2026-10-10)

Play (`play.netadao.org`, Vercel project `nda4/1830-juno-edition`, root `frontend`) now sends an enforced
Content-Security-Policy and `X-Content-Type-Options: nosniff` from `frontend/vercel.json`. Before this change it sent
neither, and no frame protection either. `frontend/src/utils/securityHeaders.test.ts` pins the policy.

## Policy

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | |
| `script-src` | `'self'` | The CRA bundle only. No inline script, no eval, no WebAssembly. |
| `style-src` | `'self' 'unsafe-inline'` | Play mounts `<style>` elements whose text is built at run time (`zoomAwareMediaCss(..., uiScale)` and about a dozen component sheets), so hashes cannot cover them. This applies to styles only. |
| `img-src` | `'self' data:` | The rail map draws a `data:image/svg+xml` image. |
| `font-src`, `manifest-src` | `'self'` | |
| `media-src` | `'self'`, the seven radio stations in `utils/audio.ts`, and `fluxfm.streamabc.net` and `*.rcs.revma.com` | Two of the stations redirect to those last two hosts. |
| `connect-src` | `'self' wss://play.netadao.org https://d3d68n2c5eingb.cloudfront.net https://juno.api.t.stavr.tech` | The same-origin `/gs` API, the game server's WebSocket, and the pinned Juno RPC and REST. **If the escrow pin's `rpc` or `rest` changes, this list must change with it.** |
| `worker-src`, `frame-src`, `object-src` | `'none'` | |
| `base-uri`, `form-action` | `'self'` | |
| `frame-ancestors` | `'self' https://netadao.org https://www.netadao.org https://academy.netadao.org https://fork.netadao.org https://ludum.netadao.org` | See "Embedding" below. |
| `upgrade-insecure-requests` | | |

### libsodium is no longer in the bundle

`@cosmjs/crypto` imports libsodium, which compiles WebAssembly as soon as the page loads. Under `script-src 'self'` that
compile is refused, and the refusal surfaced as an uncaught `RuntimeError`.

Play never uses the libsodium-backed classes (Ed25519, Argon2id, XChaCha20), because Keplr signs. `config-overrides.js`
therefore replaces the package with `src/vendor/libsodiumStub.js`, which throws if anything ever calls it. Ludum's cosmjs
build does the same.

### Embedding

The Neta DAO radio script (`netadao.org/radio/radio.js`, which Ludum and the Neta DAO sites load) runs a "shell". When the
radio is on, a link to a family site opens that site in an iframe so the music keeps playing. The family is `www`,
`academy`, `fork`, `ludum` and `play` under `netadao.org`. So Play may be framed by those origins and by itself, and by
nothing else.

`X-Frame-Options` is not sent. It cannot name several origins, and every current browser follows `frame-ancestors` instead.

## Evidence

**Local harness: the real server, the fake chain and a stand-in Keplr**
- Room, Host and Waiting Room flow, enforced policy: 60/60 in both Chrome and Firefox.
- No CSP violations and no page exceptions.

**Real Keplr extension, with no wallet loaded** (0.13.52 in Chrome, 0.13.49 in Firefox), against both local and live Play:
- `window.keplr` is injected and its API is complete.
- A page-to-extension round trip answers: "Users need to create their accounts first".
- The only report is Keplr's own bundled `long.js` probing WebAssembly inside `try`/`catch`. It falls back to plain JavaScript, so no function is lost, and no exemption was added for it.

**Live, Report-Only stage** (deployment from `78924d84`)
- No reports in either browser.
- Juno RPC and REST return 200.
- `wss` opens.
- All seven radio streams reach `canplay`.

**Live, enforced stage** (`dpl_AFpLxMX1oSS2vvzmdk9vxjZUnGj2` from `f9b8bde9`)
- The header is present on `/`, room links and 404s.
- All the Report-Only checks pass again with no violation.
- Framing from `ludum.netadao.org` loads Play; framing from `example.com` is refused.
- The account flows on Play and Ludum pass: sign-up, sign-in and sign-out, the wrong-password refusal, profile, open-redirect refusal and recovery.
- Live host flow: Host a Game opened the Waiting Room at a 2 JUNOX ante, and Cancel table then closed the table. Nobody anted and nothing reached Juno.

**Not exercised live:** a funded game, play after Start, and real Keplr signing. All three need JUNOX and a wallet, and they belong to the Phase-4 playtest. Gameplay start under the enforced policy was covered by the local harness.

## Rollback

There are two options:
- Promote the previous deployment with `npx vercel@62.1.0 promote <url>`, run from an upload directory that holds `.vercel/project.json`:
  - Report-Only stage: `https://1830-juno-edition-jxwv7wby8-nda4.vercel.app`.
  - Before any headers (the Phase 3 release, `dpl_GHYQKNBofVnbhcmSs7qevVubhJ1L`): `https://1830-juno-edition-11a2ujsoj-nda4.vercel.app`.
- Revert `frontend/vercel.json` to `Content-Security-Policy-Report-Only` and redeploy.

The libsodium stub can stay either way, because no Play path uses libsodium.
