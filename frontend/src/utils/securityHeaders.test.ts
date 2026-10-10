/** @jest-environment node */
// PHASE 4 SECURITY HEADERS: Play's response headers (`frontend/vercel.json`, Vercel's root directory is `frontend`).
//
// The policy is Play's ACTUAL runtime dependencies and nothing more:
//   script-src 'self'         the CRA bundle only: no inline script (the runtime chunk is not inlined), no eval, no
//                             WebAssembly (libsodium is stubbed out of the bundle: `config-overrides.js`).
//   style-src 'unsafe-inline' Play mounts <style> elements whose text is computed at run time (`zoomAwareMediaCss(...,
//                             uiScale)` and a dozen component sheets), so hashes cannot cover them. Styles only.
//   connect-src               the same-origin /gs API, the game server's WebSocket, and the pinned Juno RPC / REST.
//   media-src                 the radio stations in `utils/audio.ts` and the hosts two of them redirect to.
//   frame-ancestors           Play itself and the Neta DAO family sites, whose radio shell (netadao.org/radio/radio.js,
//                             FAMILY = www / academy / fork / ludum / play .netadao.org) loads a family page in an
//                             iframe so the music keeps playing. X-Frame-Options cannot name several origins, so it is
//                             not sent: frame-ancestors governs every browser that matters.
const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
import { RADIO_STATIONS, RADIO_STREAM_URL } from "./audio";

const FRONTEND = path.join(__dirname, "..", "..");
const config = JSON.parse(fs.readFileSync(path.join(FRONTEND, "vercel.json"), "utf8")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
const all = config.headers.find((rule) => rule.source === "/(.*)");
const header = (key: string) => all?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value ?? null;
const CSP = header("Content-Security-Policy") ?? "";
const directives = new Map(CSP.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
  const [name, ...sources] = part.split(/\s+/);
  return [name, sources] as const;
}));
const sources = (name: string) => directives.get(name) ?? [];
const hostAllowed = (directive: string, url: string) => {
  const { protocol, host } = new URL(url);
  return sources(directive).some((s) => s === `${protocol}//${host}` || (s.startsWith(`${protocol}//*.`) && host.endsWith(s.slice(`${protocol}//*`.length))));
};
/** Radio hosts that answer with a redirect to another host (checked 2026-10-10): CSP checks the redirect target too. */
const RADIO_REDIRECT_TARGETS = ["https://fluxfm.streamabc.net/x", "https://n03-us.rcs.revma.com/x", "https://n02-us.rcs.revma.com/x"];

describe("Play's security headers (frontend/vercel.json)", () => {
  it("applies to every path, with nosniff", () => {
    expect(all).toBeDefined();
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    /* Enforced (stage 2), after the Report-Only stage ran clean on the live site in Chrome and Firefox. */
    expect(header("Content-Security-Policy-Report-Only")).toBeNull();
    expect(CSP).not.toBe("");
  });

  it("scripts: the bundle only -- no inline, no eval, no WebAssembly, no wildcard", () => {
    expect(sources("default-src")).toEqual(["'self'"]);
    expect(sources("script-src")).toEqual(["'self'"]);
    expect(CSP).not.toMatch(/'unsafe-eval'|'wasm-unsafe-eval'|'strict-dynamic'/);
    for (const [name, list] of Array.from(directives.entries())) expect([name, list.filter((s) => ["*", "https:", "http:", "wss:", "ws:", "blob:"].includes(s))]).toEqual([name, []]);
    expect(sources("object-src")).toEqual(["'none'"]);
    expect(sources("base-uri")).toEqual(["'self'"]);
    expect(sources("form-action")).toEqual(["'self'"]);
    expect(sources("frame-src")).toEqual(["'none'"]);
    expect(sources("worker-src")).toEqual(["'none'"]);
  });

  it("'unsafe-inline' is for styles only (run-time <style> sheets), never scripts", () => {
    expect(sources("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(sources("img-src")).toEqual(["'self'", "data:"]);
    expect(sources("font-src")).toEqual(["'self'"]);
  });

  it("connect-src: the same-origin API, the game server's WebSocket and the pinned Juno endpoints, nothing else", () => {
    expect(sources("connect-src")).toEqual(["'self'", "wss://play.netadao.org", "https://d3d68n2c5eingb.cloudfront.net", "https://juno.api.t.stavr.tech"]);
  });

  it("media-src: every radio station in utils/audio.ts, and the hosts they redirect to", () => {
    expect(sources("media-src")[0]).toBe("'self'");
    for (const url of [RADIO_STREAM_URL, ...RADIO_STATIONS.map((station) => station.url), ...RADIO_REDIRECT_TARGETS]) {
      expect([url, hostAllowed("media-src", url)]).toEqual([url, true]);
    }
  });

  it("frame-ancestors: Play and the Neta DAO family's radio shell only; no X-Frame-Options (it cannot name several origins)", () => {
    expect(sources("frame-ancestors")).toEqual(["'self'", "https://netadao.org", "https://www.netadao.org", "https://academy.netadao.org", "https://fork.netadao.org", "https://ludum.netadao.org"]);
    expect(header("X-Frame-Options")).toBeNull();
  });

  it("libsodium (WebAssembly at load) is aliased to a stub that refuses every use", () => {
    const overrides = fs.readFileSync(path.join(FRONTEND, "config-overrides.js"), "utf8");
    expect(overrides).toContain('"libsodium-wrappers-sumo": path.resolve(__dirname, "src/vendor/libsodiumStub.js")');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require("../vendor/libsodiumStub.js");
    expect(stub.__esModule).toBeUndefined();
    expect(() => stub.crypto_sign_detached()).toThrow(/not bundled in Play/);
  });
});
