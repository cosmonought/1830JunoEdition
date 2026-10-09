// server/src/ludum/origins.test.ts
//
// LUDUM v1 (Lane A): `GS_LUDUM_ORIGINS` -- https-only, exact, no wildcards; refused in production when invalid; delivered
// in AWS mode by the runtime document's optional `ludum_origins` (no `user_data` change), never by the environment there.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolveServerConfig } from "../identity/mode";
import { awsStartupReferences, parseAwsRuntimeConfig, AwsRuntimeConfigError } from "../aws/runtime/runtimeConfig";
import { createGameServer } from "../gameServer";
import { BUILD } from "../rooms/testSupport";

const PROD = { GS_MODE: "production", GS_ALLOWED_ORIGINS: "https://play.example", GS_TRUSTED_PROXY_HOPS: "1" };

describe("LUDUM origins: GS_LUDUM_ORIGINS (identity/mode.ts)", () => {
  test("absent or empty: none; exact https origins are kept, deduplicated, and never merged into allowedOrigins", () => {
    for (const value of [undefined, "", "  "]) {
      const resolved = resolveServerConfig([], { ...PROD, ...(value !== undefined ? { GS_LUDUM_ORIGINS: value } : {}) });
      assert.ok(resolved.ok);
      assert.deepEqual(resolved.config.ludumOrigins, []);
    }
    const resolved = resolveServerConfig([], { ...PROD, GS_LUDUM_ORIGINS: "https://ludum.example, https://ludum.example,https://other.example" });
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.config.ludumOrigins, ["https://ludum.example", "https://other.example"]);
    assert.deepEqual(resolved.config.allowedOrigins, ["https://play.example"]);
  });

  test("production refuses (exit-2 reason) every entry that is not an exact https origin", () => {
    for (const bad of [
      "http://ludum.example",
      "https://*.example",
      "*",
      "null",
      "https://ludum.example/",
      "https://LUDUM.example",
      "https://ludum.example:443",
      "https://ludum.example/me",
      "https://ludum.example,",
      "ludum.example",
      "ftp://ludum.example",
    ]) {
      const resolved = resolveServerConfig([], { ...PROD, GS_LUDUM_ORIGINS: bad });
      assert.equal(resolved.ok, false, bad);
      if (!resolved.ok) assert.match(resolved.reason, /GS_LUDUM_ORIGINS/);
    }
    const conflict = resolveServerConfig(["--ludum-origins", "https://a.example"], { ...PROD, GS_LUDUM_ORIGINS: "https://b.example" });
    assert.equal(conflict.ok, false);
  });

  test("development takes loopback Ludum origins only", () => {
    const ok = resolveServerConfig([], { GS_MODE: "development", GS_LUDUM_ORIGINS: "http://localhost:8000" });
    assert.ok(ok.ok);
    assert.deepEqual(ok.config.ludumOrigins, ["http://localhost:8000"]);
    assert.equal(resolveServerConfig([], { GS_MODE: "development", GS_LUDUM_ORIGINS: "https://ludum.example" }).ok, false);
  });

  test("createGameServer refuses a non-https Ludum origin in production (defence in depth)", () => {
    assert.throws(
      () => createGameServer({ port: 0, build: BUILD, identity: { mode: "production", allowedOrigins: ["https://play.example"], ludumOrigins: ["http://ludum.example"], trustedProxyHops: 0 } }),
      /ludum origin refused/,
    );
  });
});

describe("LUDUM origins: the runtime document's `ludum_origins` (aws/runtime/runtimeConfig.ts)", () => {
  const V2 = {
    format: "18COSMOS/AWS-RUNTIME/v2",
    environment: "prod",
    region: "us-east-1",
    pool: "p1",
    generation: 1,
    game_table: "gs-prod-game-g1",
    identity_table: "gs-prod-identity",
    ledger_table_arn: "arn:aws:dynamodb:us-east-1:222222222222:table/gs-prod-ledger",
    escrow: null,
    routes: {},
  };

  test("optional in v2: absent reads exactly as before (none); exact https origins are taken", () => {
    assert.deepEqual(parseAwsRuntimeConfig(V2).ludumOrigins, []);
    assert.deepEqual(parseAwsRuntimeConfig({ ...V2, ludum_origins: [] }).ludumOrigins, []);
    assert.deepEqual(parseAwsRuntimeConfig({ ...V2, ludum_origins: ["https://ludum.netadao.org"] }).ludumOrigins, ["https://ludum.netadao.org"]);
  });

  test("a bad entry refuses the start; v1 does not know the field", () => {
    for (const bad of [["http://ludum.example"], ["https://*.example"], ["https://ludum.example/"], [7], "https://ludum.example", Array(9).fill("https://a.example")]) {
      assert.throws(() => parseAwsRuntimeConfig({ ...V2, ludum_origins: bad }), AwsRuntimeConfigError, JSON.stringify(bad));
    }
    const { routes: _routes, ...v1 } = V2;
    assert.throws(() => parseAwsRuntimeConfig({ ...v1, format: "18COSMOS/AWS-RUNTIME/v1", ludum_origins: ["https://ludum.example"] }), /unknown field ludum_origins/);
  });

  test("in AWS storage mode GS_LUDUM_ORIGINS / --ludum-origins is refused: the document is the one source", () => {
    const arn = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/prod/runtime/p1";
    assert.ok(awsStartupReferences([], { GS_AWS_CONFIG_PARAMETER: arn }, "production").ok);
    const env = awsStartupReferences([], { GS_AWS_CONFIG_PARAMETER: arn, GS_LUDUM_ORIGINS: "https://ludum.example" }, "production");
    assert.equal(env.ok, false);
    if (!env.ok) assert.match(env.reason, /ludum_origins/);
    assert.equal(awsStartupReferences(["--ludum-origins", "https://ludum.example"], { GS_AWS_CONFIG_PARAMETER: arn }, "production").ok, false);
  });
});
