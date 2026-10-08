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
//      LIVE-4 (L4-3) MOVED BOTH, DELIBERATELY: client protocol 1 became implemented, so `client_protocols` went from [0]
//      to [0, 1] -- and that is the only field that moved (proved below: the L4-2 keys come back with [0]).

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
 *  + `hashlib.sha256`) from the literal descriptor below. L4-3: `client_protocols` [0, 1] (was [0]). Route v12 R12-2:
 *  rules 12 reading [12] (was 11 / [11]); settlement still [10, 11]. Route v12 R12-3: settlement certified [10, 11, 12].
 *  Phase 3 W3-K: rules 13 reading [13] (was 12 / [12]); settlement still [10, 11, 12]. Phase 3's dedicated v13
 *  certification: settlement certified [10, 11, 12, 13]. Phase 3 escrow 2.1 release readiness (2026-10-08): the canonical
 *  escrow checksum is the certified 2.1.0 artifact's (`c3bd0618…`), no longer 2.0.0's. */
const THIS_BUILD_NO_ESCROW_TEXT =
  '{"client_protocols":[0,1],"escrow_abi_checksums":["c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219"],' +
  '"escrow_deployments":[],"financial_protocols":[],"format":"18COSMOS/DEPLOYMENT-CAPABILITY/v1","hosted_protocols":[1],' +
  '"rules":{"certified":[10,11,12,13],"current":13,"supported":[13]},"settlement_codecs":["18JUNO/v1"]}';
const THIS_BUILD_NO_ESCROW_KEY = "dc1-a9aea13a21fbc921a315ab25";
/** This build serving the ESCROW-3B fixture deployment (`escrow3bSupport.PIN`), cross-checked the same way. Phase 3's
 *  escrow 2.1 (financial protocol 4) moved it by `financial_protocols` alone; the no-escrow key lists no financial
 *  protocol and did not move. */
const THIS_BUILD_FIXTURE_KEY = "dc1-28fab6d8333d24d3271c408d";
/** The same two keys before the escrow 2.1 checksum pin (Phase 3 FP4 source through 8c4dca9: the canonical checksum was
 *  2.0.0's `5ecc3022…`): the pin moved them by the checksum ALONE (`asPre21Pin` gives them back exactly). Computed
 *  independently (Python, as above) from the same descriptors with the 2.0.0 checksum. */
const PRE21_NO_ESCROW_KEY = "dc1-e8d0b4792a7ba07e67199ad2";
const PRE21_FIXTURE_KEY = "dc1-30d893675c773e9b609699e7";
/** escrow 2.0.0's artifact: the canonical checksum before the 2.1 pin. */
const ESCROW_2_0_0 = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8";
/** A capability as the build made it before the escrow 2.1 pin: the canonical checksum list, and every served pin's code
 *  checksum, were escrow 2.0.0's. Every historical reconstruction below starts from it. */
const asPre21Pin = (capability: DeploymentCapability): DeploymentCapability =>
  deploymentCapability({
    ...capability,
    escrow_abi_checksums: [ESCROW_2_0_0],
    escrow_deployments: capability.escrow_deployments.map((served) => ({ ...served, pin: { ...served.pin, code_checksum: ESCROW_2_0_0 } })),
  });
/** The fixture key at Phase 3's v13 certification (financial protocol 3): the FP4 bump moved it. */
const V13CERT_FIXTURE_KEY = "dc1-32fcc4967978e78f10874490";
/** A capability as the build made it before financial protocol 4 (the historical reconstructions below): a served
 *  deployment then carried financial protocol 3; a capability serving none lists no financial protocol either way. */
const asFp3 = (capability: DeploymentCapability): DeploymentCapability => (capability.financial_protocols.length === 0 ? capability : deploymentCapability({ ...capability, financial_protocols: [3] }));
/** The same two keys at Phase 3 W3-K (rules 13, settlement still [10, 11, 12]): the v13 certification moved them by
 *  certifying 13 alone. */
const W3K_NO_ESCROW_KEY = "dc1-390107d5e7024f4a9180efeb";
const W3K_FIXTURE_KEY = "dc1-d01c50c4a70d0dc14cdf915d";
const RULES_13_UNCERTIFIED = { current: 13, supported: [13], certified: [10, 11, 12] } as const;
/** The same two keys at Route v12 R12-3 (rules 12, settlement [10, 11, 12]): W3-K's v13 moved them on the rules axis alone. */
const R12_3_NO_ESCROW_KEY = "dc1-41eb96a737cd33aa90a62808";
const R12_3_FIXTURE_KEY = "dc1-63af8114005a5f202d7d349c";
const RULES_12_CERTIFIED = { current: 12, supported: [12], certified: [10, 11, 12] } as const;
/** The same two keys at Route v12 R12-2 (rules 12, settlement still [10, 11]): R12-3's certification moved them. */
const R12_2_NO_ESCROW_KEY = "dc1-ade748b9407a3db380e5ed72";
const R12_2_FIXTURE_KEY = "dc1-eb48b18e50d46d0c50807710";
const RULES_12_UNCERTIFIED = { current: 12, supported: [12], certified: [10, 11] } as const;
/** The same two keys through LIVE-4 (L4-3 .. R12-1), on rules 11: Route v12 R12-2 moved them on the rules axis alone. */
const LIVE4_NO_ESCROW_KEY = "dc1-68c4b829b3a20e63f3e55cde";
const LIVE4_FIXTURE_KEY = "dc1-4308649847947d1d12ccdd41";
const RULES_11 = { current: 11, supported: [11], certified: [10, 11] } as const;
/** The same two keys as L4-1 / L4-2 pinned them, when this build accepted the legacy wire only (`client_protocols`
 *  [0]). Kept so the L4-3 move is visible, and proved to be client_protocols' alone. */
const L4_2_NO_ESCROW_KEY = "dc1-5e141a8b20871e5069520928";
const L4_2_FIXTURE_KEY = "dc1-0b0a7d27f1daf0017372b2a9";

describe("L4-1: the moved constants are the shared ones, unchanged", () => {
  test("hosted 1 and financial 4 (3 until Phase 3's escrow 2.1), re-exported from escrow/moneyContinuation.ts as the very same values", () => {
    assert.equal(PIN_TYPES_AGREE, true);
    assert.equal(money.HOSTED_PROTOCOL_VERSION, 1);
    assert.equal(money.FINANCIAL_PROTOCOL_VERSION, 4);
    assert.equal(money.HOSTED_PROTOCOL_VERSION, shared.HOSTED_PROTOCOL_VERSION);
    assert.equal(money.FINANCIAL_PROTOCOL_VERSION, shared.FINANCIAL_PROTOCOL_VERSION);
    assert.equal(shared.HOSTED_PROTOCOL_CHANGELOG[shared.HOSTED_PROTOCOL_CHANGELOG.length - 1].version, 1);
    assert.equal(shared.FINANCIAL_PROTOCOL_CHANGELOG[shared.FINANCIAL_PROTOCOL_CHANGELOG.length - 1].version, 4);
    assert.equal(shared.CLIENT_PROTOCOL_CHANGELOG[shared.CLIENT_PROTOCOL_CHANGELOG.length - 1].version, shared.CLIENT_PROTOCOL_VERSION);
  });

  test("the money continuation identity and its reader are the shared ones: one function, not a copy", () => {
    assert.equal(money.MONEY_CONTINUATION_FORMAT, "18COSMOS/MONEY-CONTINUATION/v1");
    assert.equal(money.MONEY_CONTINUATION_FORMAT, sharedIdentity.MONEY_CONTINUATION_FORMAT);
    assert.equal(money.isMoneyContinuationIdentity, sharedIdentity.isMoneyContinuationIdentity);
  });

  test("ESCROW-4's continuation identity is exactly what it was but for the rules and the financial protocol: rules 13 (11 until Route v12 R12-2, 12 until W3-K), hosted 1, financial 4 (3 until Phase 3's escrow 2.1), 18JUNO/v1", () => {
    assert.deepEqual({ ...money.THIS_DEPLOYMENT }, { supportedRules: [13], certifiedRules: [10, 11, 12, 13], hostedProtocol: 1, financialProtocol: 4, settlementCodecs: ["18JUNO/v1"] });
    assert.deepEqual(money.currentMoneyContinuation(), { format: "18COSMOS/MONEY-CONTINUATION/v1", rules_engine_version: 13, hosted_protocol: 1, financial_protocol: 4, settlement_codec: "18JUNO/v1" });
    /* FP4 is a drain: a money game of protocol 3 (an escrow 2.0.0 game) is not continued by this build. */
    const fp3 = money.moneyContinuationVerdict({ ...money.currentMoneyContinuation(), financial_protocol: 3 });
    assert.equal(fp3.continues ? "continues" : fp3.why, "financial-protocol");
    /* Route v12 R12-3 certified 12 for settlement, so this build's own money identity continued again (at R12-2 it was
       `rules-not-certified`). Phase 3 W3-K's v13 was NOT certified, so it was `rules-not-certified` again until Phase 3's
       dedicated v13 certification added 13: this build's own money identity continues once more. */
    assert.deepEqual(money.moneyContinuationVerdict(money.currentMoneyContinuation()), { continues: true });
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
      for (const financial of [2, 3, 4]) {
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
  test("no escrow backend: this build's facts, no financial protocol, the legacy wire and client protocol 1; the golden key", () => {
    const capability = thisDeploymentCapability([]);
    /* `rules.supported` is [11]: a second entry would be a dual-support rules bump, allowed only with a
       replay-equivalence certificate (OD-L4-2) -- and it moves this key. */
    assert.deepEqual(JSON.parse(JSON.stringify(capability)), {
      format: "18COSMOS/DEPLOYMENT-CAPABILITY/v1",
      rules: { current: 13, supported: [13], certified: [10, 11, 12, 13] },
      hosted_protocols: [1],
      financial_protocols: [],
      settlement_codecs: ["18JUNO/v1"],
      escrow_abi_checksums: ["c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219"],
      escrow_deployments: [],
      client_protocols: [0, 1],
    });
    assert.equal(capabilityCanonicalText(capability), THIS_BUILD_NO_ESCROW_TEXT);
    assert.equal(compatibilityKey(capability), THIS_BUILD_NO_ESCROW_KEY);
  });

  test("L4-3 moved the key by client_protocols ALONE: [0] gives back L4-2's keys; nothing else of this build moved", () => {
    /* Proved on the rules L4-3 was made on (11); Route v12 R12-2's later move is pinned by the next test. */
    for (const [pins, now, before] of [
      [[] as DeploymentPin[], LIVE4_NO_ESCROW_KEY, L4_2_NO_ESCROW_KEY],
      [[PIN] as DeploymentPin[], LIVE4_FIXTURE_KEY, L4_2_FIXTURE_KEY],
    ] as const) {
      const capability = deploymentCapability({ ...asFp3(asPre21Pin(thisDeploymentCapability(pins))), rules: RULES_11 });
      assert.equal(compatibilityKey(capability), now);
      assert.notEqual(now, before, "the key moved");
      const legacyOnly = deploymentCapability({ ...capability, client_protocols: [0] });
      assert.equal(compatibilityKey(legacyOnly), before, "with the legacy wire only, the L4-2 key comes back exactly");
      /* The canonical texts differ in `client_protocols` and nowhere else. */
      const nowText = JSON.parse(capabilityCanonicalText(capability)) as Record<string, unknown>;
      const beforeText = JSON.parse(capabilityCanonicalText(legacyOnly)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(nowText).filter((field) => JSON.stringify(nowText[field]) !== JSON.stringify(beforeText[field])), ["client_protocols"]);
      assert.deepEqual([beforeText.client_protocols, nowText.client_protocols], [[0], [0, 1]]);
    }
  });

  test("Route v12 R12-2 moved both keys on the rules axis ALONE: rules 11 gives back the LIVE-4 keys exactly", () => {
    for (const [pins, now, before] of [
      [[] as DeploymentPin[], PRE21_NO_ESCROW_KEY, LIVE4_NO_ESCROW_KEY],
      [[PIN] as DeploymentPin[], V13CERT_FIXTURE_KEY, LIVE4_FIXTURE_KEY],
    ] as const) {
      const capability = asFp3(asPre21Pin(thisDeploymentCapability(pins)));
      assert.equal(compatibilityKey(capability), now);
      const atEleven = deploymentCapability({ ...capability, rules: RULES_11 });
      assert.equal(compatibilityKey(atEleven), before, "with rules 11, the LIVE-4 key comes back exactly");
      const nowText = JSON.parse(capabilityCanonicalText(capability)) as Record<string, unknown>;
      const beforeText = JSON.parse(capabilityCanonicalText(atEleven)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(nowText).filter((field) => JSON.stringify(nowText[field]) !== JSON.stringify(beforeText[field])), ["rules"]);
    }
  });

  test("Route v12 R12-3 moved both keys again, by certifying 12 alone: rules 12 certified [10, 11] gives back the R12-2 keys exactly", () => {
    for (const [pins, r12_3, before] of [
      [[] as DeploymentPin[], R12_3_NO_ESCROW_KEY, R12_2_NO_ESCROW_KEY],
      [[PIN] as DeploymentPin[], R12_3_FIXTURE_KEY, R12_2_FIXTURE_KEY],
    ] as const) {
      const capability = deploymentCapability({ ...asFp3(asPre21Pin(thisDeploymentCapability(pins))), rules: RULES_12_CERTIFIED });
      assert.equal(compatibilityKey(capability), r12_3);
      const uncertified = deploymentCapability({ ...capability, rules: RULES_12_UNCERTIFIED });
      assert.equal(compatibilityKey(uncertified), before, "with 12 uncertified, the R12-2 key comes back exactly");
    }
  });

  test("Phase 3 W3-K moved both keys again, on the rules axis ALONE: rules 12 certified [10, 11, 12] gives back the R12-3 keys exactly", () => {
    for (const [pins, w3k, before] of [
      [[] as DeploymentPin[], W3K_NO_ESCROW_KEY, R12_3_NO_ESCROW_KEY],
      [[PIN] as DeploymentPin[], W3K_FIXTURE_KEY, R12_3_FIXTURE_KEY],
    ] as const) {
      const capability = deploymentCapability({ ...asFp3(asPre21Pin(thisDeploymentCapability(pins))), rules: RULES_13_UNCERTIFIED });
      assert.equal(compatibilityKey(capability), w3k);
      const atTwelve = deploymentCapability({ ...capability, rules: RULES_12_CERTIFIED });
      assert.equal(compatibilityKey(atTwelve), before, "with rules 12, the R12-3 key comes back exactly");
      const w3kText = JSON.parse(capabilityCanonicalText(capability)) as Record<string, unknown>;
      const beforeText = JSON.parse(capabilityCanonicalText(atTwelve)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(w3kText).filter((field) => JSON.stringify(w3kText[field]) !== JSON.stringify(beforeText[field])), ["rules"]);
      // At W3-K v13 was supported and NOT yet certified: the settlement list was the R12-3 literal.
      assert.deepEqual(w3kText.rules, { certified: [10, 11, 12], current: 13, supported: [13] });
    }
  });

  test("Phase 3's dedicated v13 certification moved both keys again, by certifying 13 alone: rules 13 certified [10, 11, 12] gives back the W3-K keys exactly", () => {
    for (const [pins, now, before] of [
      [[] as DeploymentPin[], PRE21_NO_ESCROW_KEY, W3K_NO_ESCROW_KEY],
      [[PIN] as DeploymentPin[], V13CERT_FIXTURE_KEY, W3K_FIXTURE_KEY],
    ] as const) {
      const capability = asFp3(asPre21Pin(thisDeploymentCapability(pins)));
      assert.equal(compatibilityKey(capability), now);
      const uncertified = deploymentCapability({ ...capability, rules: RULES_13_UNCERTIFIED });
      assert.equal(compatibilityKey(uncertified), before, "with 13 uncertified, the W3-K key comes back exactly");
      const nowText = JSON.parse(capabilityCanonicalText(capability)) as Record<string, unknown>;
      const beforeText = JSON.parse(capabilityCanonicalText(uncertified)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(nowText).filter((field) => JSON.stringify(nowText[field]) !== JSON.stringify(beforeText[field])), ["rules"]);
      // v13 is supported AND certified; the two lists stay separate fields.
      assert.deepEqual(nowText.rules, { certified: [10, 11, 12, 13], current: 13, supported: [13] });
    }
  });

  test("Phase 3's escrow 2.1 (financial protocol 4) moved the fixture key by financial_protocols ALONE: [3] gives back the v13-certification key; the no-escrow key did not move", () => {
    const capability = asPre21Pin(thisDeploymentCapability([PIN]));
    assert.equal(compatibilityKey(capability), PRE21_FIXTURE_KEY);
    const fp3 = asFp3(capability);
    assert.equal(compatibilityKey(fp3), V13CERT_FIXTURE_KEY, "with financial protocol 3, the v13-certification key comes back exactly");
    const nowText = JSON.parse(capabilityCanonicalText(capability)) as Record<string, unknown>;
    const beforeText = JSON.parse(capabilityCanonicalText(fp3)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(nowText).filter((field) => JSON.stringify(nowText[field]) !== JSON.stringify(beforeText[field])), ["financial_protocols"]);
    assert.deepEqual([beforeText.financial_protocols, nowText.financial_protocols], [[3], [4]]);
    /* A pool of each protocol is a different pool: a protocol-3 (escrow 2.0.0) pool and this one never share a key. */
    assert.notEqual(PRE21_FIXTURE_KEY, V13CERT_FIXTURE_KEY);
    assert.equal(compatibilityKey(asPre21Pin(thisDeploymentCapability([]))), PRE21_NO_ESCROW_KEY);
  });

  test("Phase 3 escrow 2.1 release readiness: the certified 2.1.0 checksum pin moved BOTH keys by the checksum ALONE -- escrow 2.0.0's gives back the FP4-source keys exactly", () => {
    for (const [pins, now, before] of [
      [[] as DeploymentPin[], THIS_BUILD_NO_ESCROW_KEY, PRE21_NO_ESCROW_KEY],
      [[PIN] as DeploymentPin[], THIS_BUILD_FIXTURE_KEY, PRE21_FIXTURE_KEY],
    ] as const) {
      const capability = thisDeploymentCapability(pins);
      assert.equal(compatibilityKey(capability), now, capabilityCanonicalText(capability));
      assert.deepEqual(capability.escrow_abi_checksums, ["c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219"]);
      const pre = asPre21Pin(capability);
      assert.equal(compatibilityKey(pre), before, "with escrow 2.0.0's checksum, the FP4-source key comes back exactly");
      assert.notEqual(now, before, "the key moved: a 2.1-pinned pool and an FP4-source pool never share a key");
      const nowText = JSON.parse(capabilityCanonicalText(capability)) as Record<string, unknown>;
      const beforeText = JSON.parse(capabilityCanonicalText(pre)) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(nowText).filter((field) => JSON.stringify(nowText[field]) !== JSON.stringify(beforeText[field])),
        pins.length === 0 ? ["escrow_abi_checksums"] : ["escrow_abi_checksums", "escrow_deployments"],
        "only the checksum moved (in the canonical list and, when served, in the served pin)",
      );
    }
  });

  test("serving the ESCROW-3B fixture deployment: financial 4 appears with it (3 until Phase 3's escrow 2.1), and the key moves", () => {
    const capability = thisDeploymentCapability([PIN]);
    assert.deepEqual(capability.financial_protocols, [4]);
    assert.deepEqual(capability.hosted_protocols, [1]);
    assert.deepEqual(capability.escrow_deployments.map((served) => served.pin), [PIN]);
    assert.notEqual(compatibilityKey(capability), THIS_BUILD_NO_ESCROW_KEY);
    assert.equal(compatibilityKey(capability), THIS_BUILD_FIXTURE_KEY, capabilityCanonicalText(capability));
  });

  test("a money game at this build's rules is continued where its escrow is served, `financial-protocol` where none is (the v13 certification restored LIVE-4's answer); a no-money game is", () => {
    /* Route v12 R12-2 left rules 12 uncertified, so this answered `rules-not-certified` on both; R12-3 certified 12, so it
       was LIVE-4's answer again. Phase 3 W3-K's v13 was NOT settlement-certified, so a money identity at the current rules
       answered `rules-not-certified` again, served escrow or not -- the designed consequence. Phase 3's dedicated v13
       certification restores LIVE-4's answer: continued where the escrow is served, `financial-protocol` where none is. */
    const facts = { formats: { record: "current", log: "current", fin: "current", tickets: "current", intents: "current" } as const, identity: { kind: "undealt" } as const, money: { kind: "record" as const, mci: money.currentMoneyContinuation(), deployment: PIN } };
    assert.equal(canonicalWhy(continuationVerdict(facts, thisDeploymentCapability([PIN]))), "continues");
    assert.equal(canonicalWhy(continuationVerdict(facts, thisDeploymentCapability([]))), "not-continued/financial-protocol");
    const dealtNow = { formats: { record: "current", log: "current" } as const, identity: sharedIdentity.gameIdentityOfDeal({ rules_engine_version: 13, build: "dev" }), money: null };
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
