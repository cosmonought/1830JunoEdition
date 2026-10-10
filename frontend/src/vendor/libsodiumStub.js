// frontend/src/vendor/libsodiumStub.js
//
// PHASE 4 SECURITY HEADERS: Play's build replaces `libsodium-wrappers-sumo` with this stub (`config-overrides.js`,
// `resolve.alias`), as Ludum's cosmjs build does (`platform/vendor/build/sodium-stub.js`). `@cosmjs/crypto` imports
// libsodium only for Ed25519, Argon2id and XChaCha20-Poly1305; Play never uses them (Keplr holds every key and signs;
// consent keys are secp256k1, hashes are sha256). libsodium's start-up compiles WebAssembly at load, which Play's CSP
// refuses (`script-src 'self'`, no 'wasm-unsafe-eval'). Any use is a loud error, never a silent wrong answer.
function refused() {
  throw new Error("libsodium is not bundled in Play (Ed25519 / Argon2id / XChaCha20 are unused; the CSP refuses WebAssembly)");
}
module.exports = new Proxy({ ready: Promise.resolve() }, { get: (t, k) => (k in t ? t[k] : k === "__esModule" || k === "default" ? undefined : refused) });
