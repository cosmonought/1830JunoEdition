// server/src/identity/mode.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.8, §12.1): GS_MODE, AND THE CONFIGURATIONS PRODUCTION REFUSES
// ==================================================================
//
// `GS_MODE` (or `--mode`) is REQUIRED: "development" or "production", no default. Missing, invalid, or given twice
// with two values: the server refuses to start (exit 2).
//
// PRODUCTION FAILS CLOSED -- exit 2 with a named reason, never "ignored with a warning" -- on any of:
//   --insecure-local-identity, or INSECURE_LOCAL_IDENTITY set at all;
//   LEGACY_LOGS / --legacy-logs other than "refuse";
//   --explain-divergence / EXPLAIN_DIVERGENCE (per-field digests are a local-play diagnostic);
//   an empty GS_ALLOWED_ORIGINS, or any http: origin in it;
//   GS_TRUSTED_PROXY_HOPS absent (a wrong client address would throttle everybody, so it is never guessed).
//
// DEVELOPMENT is loopback-only by construction: GS_TRUSTED_PROXY_HOPS must be 0 (or absent), and every allowed
// origin must be loopback -- the CRA dev server's two origins when GS_ALLOWED_ORIGINS is absent.

import { isLoopbackOrigin, parseAllowedOrigins } from "./origins";

export type GsMode = "development" | "production";

export interface ServerConfig {
  mode: GsMode;
  allowedOrigins: string[];
  trustedProxyHops: number;
  legacyLogs: "refuse" | "development-corpus";
  explainDivergence: boolean;
  /** Lines the banner prints about what was implied or defaulted. */
  notes: string[];
}

export type ServerConfigResult = { ok: true; config: ServerConfig } | { ok: false; reason: string };

export const DEFAULT_DEVELOPMENT_ORIGINS: readonly string[] = Object.freeze(["http://localhost:3000", "http://127.0.0.1:3000"]);
export const MAX_TRUSTED_PROXY_HOPS = 8;

/** `--name value` or `--name=value`; `undefined` when absent; an array when given more than once. */
function flag(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((arg, at) => {
    if (arg === name) values.push(argv[at + 1] ?? "");
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  });
  return values;
}

function single(argv: readonly string[], env: string | undefined, name: string, envName: string): { value?: string; conflict?: string } {
  const given = flag(argv, name);
  const values = [...(env !== undefined ? [env] : []), ...given];
  const distinct = [...new Set(values)];
  if (distinct.length > 1) return { conflict: `${envName} and ${name} disagree (${distinct.map((v) => `"${v}"`).join(" vs ")})` };
  return { value: distinct[0] };
}

export function resolveServerConfig(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ServerConfigResult {
  const fail = (reason: string): ServerConfigResult => ({ ok: false, reason });
  const notes: string[] = [];

  const modeArg = single(argv, env.GS_MODE, "--mode", "GS_MODE");
  if (modeArg.conflict) return fail(modeArg.conflict);
  if (modeArg.value === undefined || modeArg.value === "") {
    return fail('GS_MODE is not set. It is required and has no default: GS_MODE=development (local, loopback only) or GS_MODE=production (or --mode).');
  }
  if (modeArg.value !== "development" && modeArg.value !== "production") {
    return fail(`GS_MODE must be "development" or "production", not "${modeArg.value}".`);
  }
  const mode: GsMode = modeArg.value;

  const legacy = single(argv, env.LEGACY_LOGS, "--legacy-logs", "LEGACY_LOGS");
  if (legacy.conflict) return fail(legacy.conflict);
  const legacyLogs = legacy.value ?? "refuse";
  if (legacyLogs !== "refuse" && legacyLogs !== "development-corpus") {
    return fail(`--legacy-logs must be "refuse" or "development-corpus", not "${legacyLogs}".`);
  }

  const originsArg = single(argv, env.GS_ALLOWED_ORIGINS, "--allowed-origins", "GS_ALLOWED_ORIGINS");
  if (originsArg.conflict) return fail(originsArg.conflict);
  const parsedOrigins = parseAllowedOrigins(originsArg.value);
  if (!parsedOrigins.ok) return fail(parsedOrigins.reason);

  const hopsArg = single(argv, env.GS_TRUSTED_PROXY_HOPS, "--trusted-proxy-hops", "GS_TRUSTED_PROXY_HOPS");
  if (hopsArg.conflict) return fail(hopsArg.conflict);
  let hops: number | null = null;
  if (hopsArg.value !== undefined) {
    if (!/^\d{1,2}$/.test(hopsArg.value) || Number(hopsArg.value) > MAX_TRUSTED_PROXY_HOPS) {
      return fail(`GS_TRUSTED_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUSTED_PROXY_HOPS}, not "${hopsArg.value}".`);
    }
    hops = Number(hopsArg.value);
  }

  const insecureFlag = argv.includes("--insecure-local-identity") || flag(argv, "--insecure-local-identity").length > 0;
  const insecureEnv = env.INSECURE_LOCAL_IDENTITY !== undefined;
  const explainFlag = argv.includes("--explain-divergence");
  const explainEnv = env.EXPLAIN_DIVERGENCE !== undefined;

  if (mode === "production") {
    if (insecureFlag) return fail("production refuses --insecure-local-identity (LIVE-2 §4.8).");
    if (insecureEnv) return fail("production refuses INSECURE_LOCAL_IDENTITY (set to anything at all) (LIVE-2 §4.8).");
    if (legacyLogs !== "refuse") return fail(`production refuses --legacy-logs ${legacyLogs}; only "refuse" (LIVE-2 §4.8, §9.4).`);
    if (explainFlag || explainEnv) return fail("production refuses --explain-divergence / EXPLAIN_DIVERGENCE (a local-play diagnostic).");
    if (parsedOrigins.origins.length === 0) return fail("production needs GS_ALLOWED_ORIGINS: the exact https origin(s) the game is served from.");
    const plain = parsedOrigins.origins.find((origin) => !origin.startsWith("https:"));
    if (plain !== undefined) return fail(`production refuses a non-https allowed origin ("${plain}").`);
    if (hops === null) {
      return fail("production needs GS_TRUSTED_PROXY_HOPS set explicitly (0 = the TCP peer; N = the N-th X-Forwarded-For entry from the right).");
    }
    return { ok: true, config: { mode, allowedOrigins: parsedOrigins.origins, trustedProxyHops: hops, legacyLogs, explainDivergence: false, notes } };
  }

  /* development */
  if (hops !== null && hops !== 0) return fail("development refuses GS_TRUSTED_PROXY_HOPS other than 0: development identity is loopback-only.");
  const origins = parsedOrigins.origins.length > 0 ? parsedOrigins.origins : [...DEFAULT_DEVELOPMENT_ORIGINS];
  if (parsedOrigins.origins.length === 0) notes.push(`allowed origins defaulted to ${origins.join(", ")}`);
  const remote = origins.find((origin) => !isLoopbackOrigin(origin));
  if (remote !== undefined) return fail(`development refuses a non-loopback allowed origin ("${remote}"). Never point a tunnel at a development server.`);
  if (insecureFlag || insecureEnv) notes.push("--insecure-local-identity / INSECURE_LOCAL_IDENTITY is obsolete: development identity is GS_MODE=development");
  return { ok: true, config: { mode, allowedOrigins: origins, trustedProxyHops: 0, legacyLogs, explainDivergence: true, notes } };
}
