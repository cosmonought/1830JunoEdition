// server/src/live4CanonicalModel.test.ts
//
// LIVE-4 (L4-1): the server half of the canonical compatibility model's pins (the pure half is
// `frontend/src/utils/live4CanonicalModel.test.ts`).
//   1. The constants that moved out of `escrow/moneyContinuation.ts` are the shared ones, re-exported unchanged: hosted
//      1, financial 3, the money identity and its reader; ESCROW-4's `THIS_DEPLOYMENT` and the identity a money game is
//      created with are exactly what they were.
//   2. The shared types agree with the server's: the deployment pin is ESCROW-3B's `FinancialDeploymentPin`, and every
//      conflict maps to an existing `FinancialHoldCode`.
//   3. The canonical verdict's money branch reproduces ESCROW-3A's `moneyContinuationVerdict`, reason for reason, over a
//      grid of identities and deployments (the generalization from scalars to sets changes no answer).
//   4. This build's own capability and its key are pinned: with no escrow backend, and serving the ESCROW-3B fixture
//      deployment. A change that moves either key must change this file, so it is visible in review.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import * as shared from "../../frontend/src/gameEngine/protocolVersions";
import * as sharedIdentity from "../../frontend/src/gameEngine/compat/continuationIdentity";
import { gameContinuationIdentity, type GameIdentityFacts } from "../../frontend/src/gameEngine/compat/continuationIdentity";
import {
  capabilityCanonicalText,
  compatibilityKey,
  deploymentCapability,
  servedDeployment,
  DEPLOYMENT_CAPABILITY_FORMAT,
  DEPLOYMENT_FACT_FIELDS,
  DEPLOYMENT_KEY_FIELDS,
  type DeploymentCapability,
  type DeploymentPin,
} from "../../frontend/src/gameEngine/compat/deploymentCapability";
import type { EscrowCodecId } from "../../frontend/src/gameEngine/escrow/escrowCodec";
import { CONFLICT_HOLD_CODES, continuationVerdict, type ContinuationVerdict } from "../../frontend/src/gameEngine/compat/continuationVerdict";
import * as money from "./escrow/moneyContinuation";
import type { FinancialDeploymentPin, FinancialHoldCode } from "./escrow/moneyLifecycle";
import { CANONICAL_JUNO_ESCROW_CHECKSUMS } from "./escrow/juno/junoConfig";
import { PIN } from "./escrow/escrow3bSupport";
import { thisDeploymentCapability } from "./deploymentCapability";

/* Compile-time: the shared pin IS the server's pin, and every conflict is recorded under a hold code the money
   lifecycle already has. A drift on either side makes `npm run build` report an error (exit 2). The server's tsconfig
   still emits on error, so the same two facts are ALSO checked at run time below -- a drift fails `npm test` too. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const PIN_TYPES_AGREE: Same<FinancialDeploymentPin, DeploymentPin> = true;
const HOLD_CODES_EXIST: Readonly<Record<keyof typeof CONFLICT_HOLD_CODES, FinancialHoldCode>> = CONFLICT_HOLD_CODES;

/** This build, no escrow backend: computed independently (Python `json.dumps(sort_keys=True, separators=(",", ":"))`
 *  + `hashlib.sha256`) from the literal descriptor below. */
const THIS_BUILD_NO_ESCROW_TEXT =
  '{"client_protocols":[0],"escrow_abi_checksums":["5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"],' +
  '"escrow_deployments":[],"financial_protocols":[],"format":"18COSMOS/DEPLOYMENT-CAPABILITY/v1","hosted_protocols":[1],' +
  '"rules":{"certified":[10,11],"current":11,"supported":[11]},"settlement_codecs":["18JUNO/v1"]}';
const THIS_BUILD_NO_ESCROW_KEY = "dc1-5e141a8b20871e5069520928";
/** This build serving the ESCROW-3B fixture deployment (`escrow3bSupport.PIN`), cross-checked the same way. */
const THIS_BUILD_FIXTURE_KEY = "dc1-0b0a7d27f1daf0017372b2a9";

describe("L4-1: the moved constants are the shared ones, unchanged", () => {
  test("hosted 1 and financial 3, re-exported from escrow/moneyContinuation.ts as the very same values", () => {
    assert.equal(PIN_TYPES_AGREE, true);
    assert.equal(money.HOSTED_PROTOCOL_VERSION, 1);
    assert.equal(money.FINANCIAL_PROTOCOL_VERSION, 3);
    assert.equal(money.HOSTED_PROTOCOL_VERSION, shared.HOSTED_PROTOCOL_VERSION);
    assert.equal(money.FINANCIAL_PROTOCOL_VERSION, shared.FINANCIAL_PROTOCOL_VERSION);
    assert.equal(shared.HOSTED_PROTOCOL_CHANGELOG[shared.HOSTED_PROTOCOL_CHANGELOG.length - 1].version, 1);
    assert.equal(shared.FINANCIAL_PROTOCOL_CHANGELOG[shared.FINANCIAL_PROTOCOL_CHANGELOG.length - 1].version, 3);
    assert.equal(shared.CLIENT_PROTOCOL_CHANGELOG[shared.CLIENT_PROTOCOL_CHANGELOG.length - 1].version, shared.CLIENT_PROTOCOL_VERSION);
  });

  test("the money continuation identity and its reader are the shared ones: one function, not a copy", () => {
    assert.equal(money.MONEY_CONTINUATION_FORMAT, "18COSMOS/MONEY-CONTINUATION/v1");
    assert.equal(money.MONEY_CONTINUATION_FORMAT, sharedIdentity.MONEY_CONTINUATION_FORMAT);
    assert.equal(money.isMoneyContinuationIdentity, sharedIdentity.isMoneyContinuationIdentity);
  });

  test("ESCROW-4's continuation identity is exactly what it was: rules 11, hosted 1, financial 3, 18JUNO/v1", () => {
    assert.deepEqual({ ...money.THIS_DEPLOYMENT }, { supportedRules: [11], certifiedRules: [10, 11], hostedProtocol: 1, financialProtocol: 3, settlementCodecs: ["18JUNO/v1"] });
    assert.deepEqual(money.currentMoneyContinuation(), { format: "18COSMOS/MONEY-CONTINUATION/v1", rules_engine_version: 11, hosted_protocol: 1, financial_protocol: 3, settlement_codec: "18JUNO/v1" });
    assert.equal(money.moneyContinuationVerdict(money.currentMoneyContinuation()).continues, true);
    assert.equal(money.isMoneyContinuationIdentity(money.currentMoneyContinuation()), true);
  });

  test("every conflict maps to a FinancialHoldCode the lifecycle already records; the pins have the same fields", () => {
    assert.deepEqual(Object.keys(HOLD_CODES_EXIST).sort(), ["deployment-conflict", "financial-record-missing", "identity-conflict"]);
    assert.deepEqual(Object.values(CONFLICT_HOLD_CODES).sort(), ["binding-mismatch", "continuation-incompatible", "financial-record-missing"]);
    /* At run time as well as at compile time: each hold code is a member of the lifecycle's `FinancialHoldCode` union
       (read from its source), and ESCROW-3B's own pin carries exactly the shared pin's fields. */
    const lifecycle = fs.readFileSync(path.join(repoRoot(), "server", "src", "escrow", "moneyLifecycle.ts"), "utf8");
    const union = lifecycle.slice(lifecycle.indexOf("export type FinancialHoldCode ="), lifecycle.indexOf("export interface FinancialHold "));
    assert.ok(union.length > 200, "found the FinancialHoldCode union");
    for (const code of Object.values(CONFLICT_HOLD_CODES)) assert.ok(union.includes(`| "${code}"`), `${code} is a FinancialHoldCode`);
    assert.deepEqual(Object.keys(PIN).sort(), [...DEPLOYMENT_KEY_FIELDS, ...DEPLOYMENT_FACT_FIELDS].sort());
  });
});

describe("L4-1: the canonical money branch reproduces ESCROW-3A's verdict, reason for reason", () => {
  const moneyGame = (identity: GameIdentityFacts, mci: unknown) => ({
    formats: { record: "current", log: "current", fin: "current", tickets: "current", intents: "current" } as const,
    identity,
    money: { kind: "record" as const, mci, deployment: PIN },
  });
  const poolOf = (d: money.DeploymentContinuation): DeploymentCapability =>
    deploymentCapability({
      format: DEPLOYMENT_CAPABILITY_FORMAT,
      rules: { current: Math.max(...d.supportedRules), supported: d.supportedRules, certified: d.certifiedRules },
      hosted_protocols: [d.hostedProtocol],
      financial_protocols: [d.financialProtocol],
      settlement_codecs: d.settlementCodecs as readonly EscrowCodecId[],
      escrow_abi_checksums: CANONICAL_JUNO_ESCROW_CHECKSUMS,
      escrow_deployments: [servedDeployment(PIN)],
      client_protocols: [0],
    });
  const escrow3a = (stored: unknown, d: money.DeploymentContinuation): string => {
    const verdict = money.moneyContinuationVerdict(stored, d);
    return verdict.continues ? "continues" : `not-continued/${verdict.why}`;
  };
  const canonical = (verdict: ContinuationVerdict): string => (verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`);

  const deployments: money.DeploymentContinuation[] = [];
  for (const supportedRules of [[11], [12], [11, 12]]) {
    for (const certifiedRules of [[10, 11], [10], [11, 12]]) {
      for (const hostedProtocol of [1, 2]) {
        for (const financialProtocol of [2, 3, 4]) deployments.push({ supportedRules, certifiedRules, hostedProtocol, financialProtocol, settlementCodecs: ["18JUNO/v1"] });
      }
    }
  }
  const identities: unknown[] = [];
  for (const rules of [10, 11, 12]) {
    for (const hosted of [1, 2]) {
      for (const financial of [2, 3]) {
        for (const codec of ["18JUNO/v1", "18GNO/v1"]) identities.push({ format: money.MONEY_CONTINUATION_FORMAT, rules_engine_version: rules, hosted_protocol: hosted, financial_protocol: financial, settlement_codec: codec });
      }
    }
  }
  const malformed: unknown[] = [null, {}, [], "11", { ...money.currentMoneyContinuation(), extra: 1 }, { ...money.currentMoneyContinuation(), financial_protocol: 0 }, { ...money.currentMoneyContinuation(), settlement_codec: "18JUNO/v2" }, { ...money.currentMoneyContinuation(), format: "18COSMOS/MONEY-CONTINUATION/v2" }];

  test("a funding table (no deal yet): the same answer, and the same reason, for every identity on every deployment", () => {
    let compared = 0;
    for (const d of deployments) {
      for (const stored of [...identities, ...malformed]) {
        assert.equal(canonical(continuationVerdict(moneyGame({ kind: "undealt" }, stored), poolOf(d))), escrow3a(stored, d), JSON.stringify({ stored, d }));
        compared += 1;
      }
    }
    assert.equal(compared, deployments.length * (identities.length + malformed.length));
    assert.ok(compared > 1000);
  });

  test("a dealt game: the same continues-or-not always; a different reason only in the two documented cases", () => {
    const reasons = new Set(["not-continued/malformed", "not-continued/rules-not-supported", "not-continued/rules-not-certified", "not-continued/hosted-protocol", "not-continued/financial-protocol", "not-continued/settlement-codec"]);
    const differences = new Map<string, number>();
    for (const d of deployments) {
      /* A valid identity is dealt under its own rules and hosted protocol (the dealing identity); a malformed one sits on
         a deal of 11 / 1, the only deal this build makes. */
      for (const stored of [...identities, ...malformed]) {
        const valid = money.isMoneyContinuationIdentity(stored);
        const gci = valid ? gameContinuationIdentity(stored.rules_engine_version, stored.hosted_protocol) : gameContinuationIdentity(11, 1);
        const answer = canonical(continuationVerdict(moneyGame({ kind: "dealt", gci }, stored), poolOf(d)));
        const old = escrow3a(stored, d);
        assert.equal(answer === "continues", old === "continues", JSON.stringify({ stored, d }));
        if (answer !== "continues") assert.ok(reasons.has(answer), answer);
        /* The deal is read before the money (preflight §7.1), so two derived reasons can differ, and only these:
           (1) the rules are supported but uncertified AND the deal's hosted protocol is not read: the hosted protocol is
               named first;
           (2) the money identity is malformed AND the deal itself is not played or read here: the deal's reason is
               named first. */
        if (answer !== old) {
          const pair = `${old} -> ${answer}`;
          differences.set(pair, (differences.get(pair) ?? 0) + 1);
          const documented =
            (old === "not-continued/rules-not-certified" && answer === "not-continued/hosted-protocol") ||
            (!valid && old === "not-continued/malformed" && (answer === "not-continued/rules-not-supported" || answer === "not-continued/hosted-protocol"));
          assert.ok(documented, `${pair} for ${JSON.stringify({ stored, d })}`);
        }
      }
    }
    assert.ok(differences.has("not-continued/rules-not-certified -> not-continued/hosted-protocol"), "difference (1) is exercised");
    assert.ok(differences.has("not-continued/malformed -> not-continued/rules-not-supported"), "difference (2) is exercised");
  });
});

describe("L4-1: this build's capability and its key (visible in review when either moves)", () => {
  test("no escrow backend: this build's facts, no financial protocol, the legacy client wire only; the golden key", () => {
    const capability = thisDeploymentCapability([]);
    /* `rules.supported` is [11]: a second entry would be a dual-support rules bump, allowed only with a
       replay-equivalence certificate (OD-L4-2) -- and it moves this key. */
    assert.deepEqual(JSON.parse(JSON.stringify(capability)), {
      format: "18COSMOS/DEPLOYMENT-CAPABILITY/v1",
      rules: { current: 11, supported: [11], certified: [10, 11] },
      hosted_protocols: [1],
      financial_protocols: [],
      settlement_codecs: ["18JUNO/v1"],
      escrow_abi_checksums: ["5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"],
      escrow_deployments: [],
      client_protocols: [0],
    });
    assert.equal(capabilityCanonicalText(capability), THIS_BUILD_NO_ESCROW_TEXT);
    assert.equal(compatibilityKey(capability), THIS_BUILD_NO_ESCROW_KEY);
  });

  test("serving the ESCROW-3B fixture deployment: financial 3 appears with it, and the key moves", () => {
    const capability = thisDeploymentCapability([PIN]);
    assert.deepEqual(capability.financial_protocols, [3]);
    assert.deepEqual(capability.hosted_protocols, [1]);
    assert.deepEqual(capability.escrow_deployments.map((served) => served.pin), [PIN]);
    assert.notEqual(compatibilityKey(capability), THIS_BUILD_NO_ESCROW_KEY);
    assert.equal(compatibilityKey(capability), THIS_BUILD_FIXTURE_KEY, capabilityCanonicalText(capability));
  });

  test("a money game this build creates continues on it, and only where its escrow is served", () => {
    const facts = { formats: { record: "current", log: "current", fin: "current", tickets: "current", intents: "current" } as const, identity: { kind: "undealt" } as const, money: { kind: "record" as const, mci: money.currentMoneyContinuation(), deployment: PIN } };
    assert.deepEqual(continuationVerdict(facts, thisDeploymentCapability([PIN])), { kind: "continues" });
    assert.equal(canonicalWhy(continuationVerdict(facts, thisDeploymentCapability([]))), "not-continued/financial-protocol");
    const dealtNow = { formats: { record: "current", log: "current" } as const, identity: sharedIdentity.gameIdentityOfDeal({ rules_engine_version: 11, build: "dev" }), money: null };
    assert.deepEqual(continuationVerdict(dealtNow, thisDeploymentCapability([])), { kind: "continues" });
    assert.deepEqual(continuationVerdict(dealtNow, thisDeploymentCapability([PIN])), { kind: "continues" });
  });

  test("names no build: the new server module reads no BUILD_ID and takes no build input", () => {
    const code = fs.readFileSync(path.join(repoRoot(), "server", "src", "deploymentCapability.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(code.includes("export function thisDeploymentCapability("));
    assert.equal(/build/i.test(code), false);
  });
});

function canonicalWhy(verdict: ContinuationVerdict): string {
  return verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`;
}

/** The repository root, found from the compiled test's own location (as `escrow4Money.test.ts` finds it). */
function repoRoot(): string {
  let repo = __dirname;
  while (!fs.existsSync(path.join(repo, "contracts", "escrow")) || !fs.existsSync(path.join(repo, "server", "src", "escrow"))) {
    const up = path.dirname(repo);
    if (up === repo) throw new Error("the repository root was not found");
    repo = up;
  }
  return repo;
}
