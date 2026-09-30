/** @jest-environment node */
//
// ==================================================================
//  LIVE-4 (L4-1): THE CANONICAL COMPATIBILITY MODEL -- T-19, THE PURE HALF OF T-24, THE VERDICTS
// ==================================================================
//
// WHAT THIS FILE PROVES, against the pure modules only (no room, no socket, no store -- those are L4-2 / L4-3 / L4-4):
//   1. the version axes: hosted 1, financial 3 (ESCROW-4's), client 1, each equal to its changelog's last row; the
//      rules engine and settlement certification untouched;
//   2. T-19, the capability key: an independent golden; identical descriptors give identical keys; every semantic
//      field moves the key on its own; no diagnostic does, and none can be smuggled in; the serialization does not
//      depend on the order anything was built in;
//   3. the gameplay continuation identity from the deal: absent hosted protocol is 1, a bad one is malformed, an
//      unpinned deal is legacy, and the build is never read;
//   4. the continuation verdict: every class, format facts first (newer is never corruption), conflicts only for
//      contradictory verified facts, and nothing a build could veto;
//   5. the pure half of T-24: the serving and drain decision around the flip and the 7-day deadline, money apart;
//   6. the client verdict, protocol 0 included.
// The server half (the moved constants still re-exported, ESCROW-3A's money verdict reproduced reason for reason, this
// build's own key) is `server/src/live4CanonicalModel.test.ts`.

import {
  ACCEPTED_CLIENT_PROTOCOLS,
  ANNOUNCED_CLIENT_PROTOCOL,
  CLIENT_PROTOCOL_CHANGELOG,
  CLIENT_PROTOCOL_VERSION,
  FINANCIAL_PROTOCOL_CHANGELOG,
  FINANCIAL_PROTOCOL_VERSION,
  HOSTED_PROTOCOL_CHANGELOG,
  HOSTED_PROTOCOL_VERSION,
  LEGACY_CLIENT_PROTOCOL,
  type ProtocolChangelogRow,
} from "../gameEngine/protocolVersions";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS, rulesEngineVersionOf } from "../gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../gameEngine/settlementAppraisal";
import type { ReplayEntry } from "../gameEngine/replayLog";
import { escrowInstanceKey, type EscrowBindingV2 } from "../gameEngine/escrow/escrowModel";
import { sha256Hex } from "../gameEngine/sha256";
import {
  ABSENT_HOSTED_PROTOCOL,
  GAME_CONTINUATION_FORMAT,
  MONEY_CONTINUATION_FORMAT,
  gameContinuationIdentity,
  gameIdentityOfDeal,
  gameIdentityOfEntries,
  gameplayIdentityOfMoney,
  isMoneyContinuationIdentity,
  type GameIdentityFacts,
  type MoneyContinuationIdentity,
} from "../gameEngine/compat/continuationIdentity";
import {
  CAPABILITY_FIELDS,
  COMPATIBILITY_KEY_PREFIX,
  DEPLOYMENT_CAPABILITY_FORMAT,
  DeploymentCapabilityError,
  capabilityCanonicalText,
  compatibilityKey,
  deploymentCapability,
  deploymentKey,
  releaseCompatibilityKey,
  servedDeployment,
  type DeploymentCapability,
  type DeploymentPin,
  type ReleaseDescriptor,
} from "../gameEngine/compat/deploymentCapability";
import {
  CONFLICT_HOLD_CODES,
  GAME_ARTIFACTS,
  NO_MONEY_DRAIN_MS,
  continuationVerdict,
  dealingIdentity,
  formatFactOf,
  noMoneyDrainDeadline,
  serveDecision,
  type ArtifactFormats,
  type ChainAttestedFacts,
  type ContinuationVerdict,
  type GameContinuationFacts,
  type MoneyFacts,
  type PoolServingState,
  type ServedGameFacts,
} from "../gameEngine/compat/continuationVerdict";
import { MAX_ANNOUNCED_RULES, clientVerdict, parseClientAnnouncement, type ClientVerdict } from "../gameEngine/compat/clientCompatibility";
import { readStripped } from "./sourceScan";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Escrow 2.0.0, the canonical wasm (PROJECT_CANONICAL_CONTEXT §D.3), and a synthetic second code checksum. */
const CODE_A = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8";
const CODE_X = "ab".repeat(32);
const CONTRACT_A = "juno14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9skjuwg8";
const CONTRACT_B = "juno1qg5ega6dykkxc307y25pecuufrjkxkaggkkxh7nad0vhyhtuhw3sqaa3c5";

const pinOf = (contract: string, facts: Partial<DeploymentPin> = {}): DeploymentPin => ({
  backend: "juno-cosmwasm",
  codec: "18JUNO/v1",
  chain_id: "uni-7",
  network_class: "testnet",
  contract_address: contract,
  code_checksum: CODE_A,
  denom: "ujunox",
  ...facts,
});
const PIN_A = pinOf(CONTRACT_A);
const PIN_B = pinOf(CONTRACT_B);

/** The T-19 base: every set deliberately out of order, and every field movable on its own. */
const keyBase = (): DeploymentCapability => ({
  format: DEPLOYMENT_CAPABILITY_FORMAT,
  rules: { current: 11, supported: [11, 12], certified: [10, 11] },
  hosted_protocols: [1],
  financial_protocols: [3],
  settlement_codecs: ["18JUNO/v1", "18GNO/v1"],
  escrow_abi_checksums: [CODE_X, CODE_A],
  escrow_deployments: [servedDeployment(PIN_B), servedDeployment(PIN_A)],
  client_protocols: [0, 1],
});

/** Computed independently (Python: `json.dumps(sort_keys=True, separators=(",", ":"))` over the sorted sets, then
 *  `hashlib.sha256`), so it pins `canonicalJson`, the SHA-256 and the key's prefix and length together. */
const GOLDEN_TEXT =
  '{"client_protocols":[0,1],"escrow_abi_checksums":["5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8",' +
  '"abababababababababababababababababababababababababababababababab"],"escrow_deployments":[{"key":"13:juno-cosmwasm|5:uni-7|' +
  '63:juno14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9skjuwg8","pin":{"backend":"juno-cosmwasm","chain_id":"uni-7",' +
  '"code_checksum":"5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8","codec":"18JUNO/v1","contract_address":' +
  '"juno14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9skjuwg8","denom":"ujunox","network_class":"testnet"}},{"key":' +
  '"13:juno-cosmwasm|5:uni-7|63:juno1qg5ega6dykkxc307y25pecuufrjkxkaggkkxh7nad0vhyhtuhw3sqaa3c5","pin":{"backend":' +
  '"juno-cosmwasm","chain_id":"uni-7","code_checksum":"5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8",' +
  '"codec":"18JUNO/v1","contract_address":"juno1qg5ega6dykkxc307y25pecuufrjkxkaggkkxh7nad0vhyhtuhw3sqaa3c5","denom":"ujunox",' +
  '"network_class":"testnet"}}],"financial_protocols":[3],"format":"18COSMOS/DEPLOYMENT-CAPABILITY/v1","hosted_protocols":[1],' +
  '"rules":{"certified":[10,11],"current":11,"supported":[11,12]},"settlement_codecs":["18GNO/v1","18JUNO/v1"]}';
const GOLDEN_KEY = "dc1-5414f9b2a65a2ce9ec031d09";

/** A pool like this build with the Juno backend configured, as L4-1 wrote it (the legacy wire only, i.e. before L4-3);
 *  the client-verdict cases below use `LIVE4` (`[0, 1]`) where protocol 1 matters. */
const POOL = deploymentCapability({
  format: DEPLOYMENT_CAPABILITY_FORMAT,
  rules: { current: 11, supported: [11], certified: [10, 11] },
  hosted_protocols: [1],
  financial_protocols: [3],
  settlement_codecs: ["18JUNO/v1"],
  escrow_abi_checksums: [CODE_A],
  escrow_deployments: [servedDeployment(PIN_A)],
  client_protocols: [0],
});
const withPool = (change: Partial<DeploymentCapability>): DeploymentCapability => deploymentCapability({ ...POOL, ...change });
const NO_BACKEND = withPool({ financial_protocols: [], escrow_deployments: [] });

const CURRENT: ArtifactFormats = Object.freeze({ record: "current", log: "current" });
const MONEY_FORMATS: ArtifactFormats = Object.freeze({ record: "current", log: "current", fin: "current", tickets: "current", intents: "current" });

const dealt = (rules = 11, hosted = 1): GameIdentityFacts => ({ kind: "dealt", gci: gameContinuationIdentity(rules, hosted) });
const mci = (change: Partial<MoneyContinuationIdentity> = {}): MoneyContinuationIdentity => ({
  format: MONEY_CONTINUATION_FORMAT,
  rules_engine_version: 11,
  hosted_protocol: 1,
  financial_protocol: 3,
  settlement_codec: "18JUNO/v1",
  ...change,
});
const moneyRecord = (identity: unknown = mci(), deployment: DeploymentPin | null = PIN_A): MoneyFacts => ({ kind: "record", mci: identity, deployment });
const game = (identity: GameIdentityFacts, money: MoneyFacts = null, formats?: ArtifactFormats): GameContinuationFacts => ({
  formats: formats ?? (money === null ? CURRENT : MONEY_FORMATS),
  identity,
  money,
});
/** `chain`: what the chain reported this run, per deployment key (nothing read by default). */
const verdictOf = (
  facts: GameContinuationFacts,
  capability: DeploymentCapability = POOL,
  chain: ReadonlyArray<readonly [string, ChainAttestedFacts]> = [],
  legacyLogs: "refuse" | "development-corpus" = "refuse",
): ContinuationVerdict => continuationVerdict(facts, capability, { chainFacts: new Map(chain) }, { legacyLogs });
/** The chain's answer for contract A, as configured in POOL. */
const CHAIN_READ_A = [[deploymentKey(PIN_A), { code_checksum: CODE_A, denom: "ujunox" }]] as const;
const classOf = (verdict: ContinuationVerdict): string => (verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`);

/* ================================================================================================= */
/* 1. THE VERSION AXES                                                                                */
/* ================================================================================================= */

describe("the protocol axes (L4-1 §A)", () => {
  const lastRow = (changelog: ReadonlyArray<ProtocolChangelogRow>) => changelog[changelog.length - 1];
  const consecutive = (changelog: ReadonlyArray<ProtocolChangelogRow>, first: number) => changelog.map((row) => row.version).every((version, at) => version === first + at);

  it("keep ESCROW-4's values: hosted 1, financial 3; the new client protocol starts at 1 over the legacy 0", () => {
    expect(HOSTED_PROTOCOL_VERSION).toBe(1);
    expect(FINANCIAL_PROTOCOL_VERSION).toBe(3);
    expect(CLIENT_PROTOCOL_VERSION).toBe(1);
    expect(LEGACY_CLIENT_PROTOCOL).toBe(0);
  });

  it("each constant equals its changelog's last row, and the rows count up by one", () => {
    expect(lastRow(HOSTED_PROTOCOL_CHANGELOG).version).toBe(HOSTED_PROTOCOL_VERSION);
    expect(lastRow(FINANCIAL_PROTOCOL_CHANGELOG).version).toBe(FINANCIAL_PROTOCOL_VERSION);
    expect(lastRow(CLIENT_PROTOCOL_CHANGELOG).version).toBe(CLIENT_PROTOCOL_VERSION);
    expect(consecutive(HOSTED_PROTOCOL_CHANGELOG, 1)).toBe(true);
    expect(consecutive(FINANCIAL_PROTOCOL_CHANGELOG, 1)).toBe(true);
    expect(consecutive(CLIENT_PROTOCOL_CHANGELOG, LEGACY_CLIENT_PROTOCOL)).toBe(true);
    for (const changelog of [HOSTED_PROTOCOL_CHANGELOG, FINANCIAL_PROTOCOL_CHANGELOG, CLIENT_PROTOCOL_CHANGELOG]) {
      expect(Object.isFrozen(changelog)).toBe(true);
      for (const row of changelog) {
        expect(Object.isFrozen(row)).toBe(true);
        expect(row.note.length).toBeGreaterThan(80);
      }
    }
  });

  it("the rows say what each version is: ESCROW-4's financial 3 and its money-only record schema; the legacy wire", () => {
    expect(lastRow(FINANCIAL_PROTOCOL_CHANGELOG).note).toMatch(/^ESCROW-4:/);
    expect(lastRow(FINANCIAL_PROTOCOL_CHANGELOG).note).toMatch(/`record_schema: 2`, written for money tables only/);
    expect(FINANCIAL_PROTOCOL_CHANGELOG[1].note).toMatch(/admitted_until_secs/);
    expect(lastRow(HOSTED_PROTOCOL_CHANGELOG).note).toMatch(/does not move this axis/);
    expect(lastRow(HOSTED_PROTOCOL_CHANGELOG).note).toMatch(/read as 1 \(LIVE-4 OD-L4-1\)/);
    expect(CLIENT_PROTOCOL_CHANGELOG[0].note).toMatch(/never sent `reload`, `route` or close 4426/);
    expect(lastRow(CLIENT_PROTOCOL_CHANGELOG).note).toMatch(/`cr` \(the bundle's supported rules engines; required/);
  });

  it("L4-3: this build speaks protocol 1 and still serves the legacy wire (listed => implemented)", () => {
    /* L4-1 held these at [0] / 0 until the change that implements protocol 1; L4-3 is that change (the announcement,
       the verdict at the upgrade and per game, `reload` / `route` / 4426, the explicit `error` case). */
    expect(ACCEPTED_CLIENT_PROTOCOLS).toEqual([LEGACY_CLIENT_PROTOCOL, CLIENT_PROTOCOL_VERSION]);
    expect(ACCEPTED_CLIENT_PROTOCOLS).toEqual([0, 1]);
    // The bundle announces protocol 1, and its own server accepts what it announces (preflight §5.1's invariant).
    expect(ANNOUNCED_CLIENT_PROTOCOL).toBe(CLIENT_PROTOCOL_VERSION);
    expect(ANNOUNCED_CLIENT_PROTOCOL).toBe(1);
    expect(ACCEPTED_CLIENT_PROTOCOLS).toContain(ANNOUNCED_CLIENT_PROTOCOL);
    expect(Object.isFrozen(ACCEPTED_CLIENT_PROTOCOLS)).toBe(true);
  });

  it("moves nothing on the rules axis: rules engine 11, supported [11], settlement certified [10, 11] (12 / [12] since Route v12 R12-2)", () => {
    /* LIVE-4 moved no rules version; Route v12 R12-2's replacing bump did (11 -> 12), and replaced the one supported
       version, as every bump before it -- it is not a dual-support bump. */
    expect(RULES_ENGINE_VERSION).toBe(12);
    /* A second supported version is a dual-support rules bump: allowed only with a replay-equivalence certificate
       (OD-L4-2), after which the list is a literal that certificate's test owns. */
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([12]);
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).toEqual([10, 11]);
  });
});

/* ================================================================================================= */
/* 2. T-19: THE CAPABILITY KEY                                                                         */
/* ================================================================================================= */

describe("T-19: the deployment capability and its compatibility key", () => {
  it("matches the independent golden: the canonical text, and dc1- + 24 hex of its SHA-256", () => {
    expect(capabilityCanonicalText(keyBase())).toBe(GOLDEN_TEXT);
    expect(compatibilityKey(keyBase())).toBe(GOLDEN_KEY);
    expect(GOLDEN_KEY).toBe(COMPATIBILITY_KEY_PREFIX + sha256Hex(GOLDEN_TEXT).slice(0, 24));
    expect(GOLDEN_KEY).toMatch(/^dc1-[0-9a-f]{24}$/);
  });

  it("identical semantic descriptors give the identical key, however many times and from whichever copy", () => {
    const first = keyBase();
    const second = JSON.parse(JSON.stringify(keyBase())) as DeploymentCapability;
    expect(second).not.toBe(first);
    expect(compatibilityKey(first)).toBe(compatibilityKey(second));
    expect(compatibilityKey(deploymentCapability(first))).toBe(compatibilityKey(first));
    expect(compatibilityKey(first)).toBe(compatibilityKey(first));
  });

  it("is independent of construction order: key insertion order, set order and deployment order", () => {
    const b = keyBase();
    const reordered = {
      client_protocols: [1, 0],
      escrow_deployments: [
        { pin: { denom: "ujunox", code_checksum: CODE_A, contract_address: CONTRACT_A, network_class: "testnet", chain_id: "uni-7", codec: "18JUNO/v1", backend: "juno-cosmwasm" }, key: deploymentKey(PIN_A) },
        { pin: { ...PIN_B }, key: deploymentKey(PIN_B) },
      ],
      escrow_abi_checksums: [CODE_A, CODE_X],
      settlement_codecs: ["18GNO/v1", "18JUNO/v1"],
      financial_protocols: [3],
      hosted_protocols: [1],
      rules: { certified: [11, 10], supported: [12, 11], current: 11 },
      format: DEPLOYMENT_CAPABILITY_FORMAT,
    } as DeploymentCapability;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(b)); // the orders really differ
    expect(capabilityCanonicalText(reordered)).toBe(capabilityCanonicalText(b));
    expect(compatibilityKey(reordered)).toBe(GOLDEN_KEY);
    // Sets sort numerically, never as text: [11, 9, 10] is [9,10,11], not ["10","11","9"].
    expect(capabilityCanonicalText({ ...b, rules: { ...b.rules, certified: [11, 9, 10] } })).toContain('"certified":[9,10,11]');
  });

  /* One entry per semantic leaf. `covers` names the leaves a mutation moves besides its own path. */
  const MUTATIONS: ReadonlyArray<{ path: string; covers?: readonly string[]; refused?: true; mutate: (b: DeploymentCapability) => DeploymentCapability }> = [
    { path: "format", refused: true, mutate: (b) => ({ ...b, format: "18COSMOS/DEPLOYMENT-CAPABILITY/v2" as unknown as typeof DEPLOYMENT_CAPABILITY_FORMAT }) },
    { path: "rules.current", mutate: (b) => ({ ...b, rules: { ...b.rules, current: 12 } }) },
    { path: "rules.supported", mutate: (b) => ({ ...b, rules: { ...b.rules, supported: [11, 12, 13] } }) },
    { path: "rules.certified", mutate: (b) => ({ ...b, rules: { ...b.rules, certified: [10, 11, 12] } }) },
    { path: "hosted_protocols", mutate: (b) => ({ ...b, hosted_protocols: [1, 2] }) },
    { path: "financial_protocols", mutate: (b) => ({ ...b, financial_protocols: [2, 3] }) },
    { path: "settlement_codecs", mutate: (b) => ({ ...b, settlement_codecs: ["18JUNO/v1"] }) },
    { path: "escrow_abi_checksums", mutate: (b) => ({ ...b, escrow_abi_checksums: [CODE_A] }) },
    { path: "escrow_deployments[]", mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(PIN_A)] }) },
    { path: "escrow_deployments[].pin.backend", covers: ["escrow_deployments[].key"], mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(pinOf(CONTRACT_A, { backend: "gno-realm" })), servedDeployment(PIN_B)] }) },
    { path: "escrow_deployments[].pin.chain_id", covers: ["escrow_deployments[].key"], mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(pinOf(CONTRACT_A, { chain_id: "uni-6" })), servedDeployment(PIN_B)] }) },
    { path: "escrow_deployments[].pin.contract_address", covers: ["escrow_deployments[].key"], mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(pinOf("juno1anotherescrowcontract")), servedDeployment(PIN_B)] }) },
    { path: "escrow_deployments[].pin.codec", mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(pinOf(CONTRACT_A, { codec: "18GNO/v1" })), servedDeployment(PIN_B)] }) },
    { path: "escrow_deployments[].pin.network_class", mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(pinOf(CONTRACT_A, { network_class: "local" })), servedDeployment(PIN_B)] }) },
    { path: "escrow_deployments[].pin.code_checksum", mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(pinOf(CONTRACT_A, { code_checksum: CODE_X })), servedDeployment(PIN_B)] }) },
    { path: "escrow_deployments[].pin.denom", mutate: (b) => ({ ...b, escrow_deployments: [servedDeployment(pinOf(CONTRACT_A, { denom: "ujuno" })), servedDeployment(PIN_B)] }) },
    { path: "client_protocols", mutate: (b) => ({ ...b, client_protocols: [1] }) },
  ];

  it("moves on every semantic field, each on its own, and no two changes collide", () => {
    const baseKey = compatibilityKey(keyBase());
    const seen = new Map<string, string>([[baseKey, "base"]]);
    for (const mutation of MUTATIONS) {
      const changed = mutation.mutate(keyBase());
      if (mutation.refused) {
        expect(() => compatibilityKey(changed)).toThrow(DeploymentCapabilityError);
        continue;
      }
      const key = compatibilityKey(changed);
      expect({ path: mutation.path, moved: key !== baseKey }).toEqual({ path: mutation.path, moved: true });
      expect({ path: mutation.path, collidesWith: seen.get(key) ?? null }).toEqual({ path: mutation.path, collidesWith: null });
      seen.set(key, mutation.path);
    }
    // A second change to the same field moves it again (client protocols: retiring 0 and adding 2 both move it).
    expect(compatibilityKey({ ...keyBase(), client_protocols: [0, 1, 2] })).not.toBe(baseKey);
  });

  it("covers every leaf of the canonical descriptor -- a new field without a mutation fails here", () => {
    const leaves = new Set<string>();
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        if (value.every((entry) => typeof entry !== "object" || entry === null)) leaves.add(path);
        else value.forEach((entry) => walk(entry, `${path}[]`));
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`);
        return;
      }
      leaves.add(path);
    };
    walk(deploymentCapability(keyBase()), "");
    const covered = new Set<string>();
    for (const mutation of MUTATIONS) {
      covered.add(mutation.path);
      for (const also of mutation.covers ?? []) covered.add(also);
    }
    const uncovered = Array.from(leaves).filter((leaf) => !covered.has(leaf));
    expect(uncovered).toEqual([]);
    expect(leaves.size).toBeGreaterThanOrEqual(16);
    expect(Object.keys(deploymentCapability(keyBase())).sort()).toEqual([...CAPABILITY_FIELDS].sort());
  });

  it("no diagnostic moves the key: two releases that differ only in diagnostics are one pool", () => {
    const a: ReleaseDescriptor = { capability: keyBase(), diagnostics: { build_id: "build-a", client_build_id: "bundle-a", commit: "031593e", built_at: "2026-09-28T00:00:00Z", ui_build_note: 1, identity_schema: 4, juno_config_format: "18COSMOS/JUNO-BACKEND/v2", keys: { relayer_address: "juno1relayera", settlement_key_ids: [1], admission_pubkey: "02aa" } } };
    const b: ReleaseDescriptor = { capability: keyBase(), diagnostics: { build_id: "build-b", client_build_id: "bundle-b", commit: "ffffffff", built_at: "2027-01-01T00:00:00Z", ui_build_note: 99, identity_schema: 5, juno_config_format: "18COSMOS/JUNO-BACKEND/v3", keys: { relayer_address: "juno1relayerb", settlement_key_ids: [2, 3], admission_pubkey: "03bb" } } };
    const bare: ReleaseDescriptor = { capability: keyBase(), diagnostics: { build_id: "dev", client_build_id: "dev" } };
    expect(releaseCompatibilityKey(a)).toBe(GOLDEN_KEY);
    expect(releaseCompatibilityKey(b)).toBe(GOLDEN_KEY);
    expect(releaseCompatibilityKey(bare)).toBe(GOLDEN_KEY);
  });

  it("refuses a diagnostic smuggled into the capability rather than hashing or dropping it, at every level", () => {
    const b = keyBase();
    const smuggled: unknown[] = [
      { ...b, build_id: "build-a" },
      { ...b, rules: { ...b.rules, build: "build-a" } },
      { ...b, escrow_deployments: [{ ...servedDeployment(PIN_A), build: "x" }] },
      { ...b, escrow_deployments: [{ key: deploymentKey(PIN_A), pin: { ...PIN_A, relayer_address: "juno1relayer" } }] },
    ];
    for (const capability of smuggled) {
      expect(() => compatibilityKey(capability as DeploymentCapability)).toThrow(/unknown field/);
    }
  });

  it("refuses rather than repairs whatever is not canonical-able", () => {
    const b = keyBase();
    const refused: Array<[string, unknown]> = [
      ["a duplicate", { ...b, hosted_protocols: [1, 1] }],
      ["a duplicate deployment", { ...b, escrow_deployments: [servedDeployment(PIN_A), servedDeployment(PIN_A)] }],
      ["a key that is not its pin's", { ...b, escrow_deployments: [{ key: deploymentKey(PIN_B), pin: PIN_A }] }],
      ["current not supported", { ...b, rules: { ...b.rules, current: 13 } }],
      ["no supported rules", { ...b, rules: { current: 11, supported: [], certified: [] } }],
      ["no hosted protocol", { ...b, hosted_protocols: [] }],
      ["no client protocol", { ...b, client_protocols: [] }],
      ["a codec not carried", { ...b, settlement_codecs: ["18GNO/v1"] }],
      ["an unknown codec id (a build id cannot ride in as a set value)", { ...b, settlement_codecs: ["18GNO/v1", "18JUNO/v1", "build-031593e"] }],
      ["a codec id spelt another way", { ...b, settlement_codecs: ["18GNO/v1", "18juno/v1"] }],
      ["code not spoken", { ...b, escrow_abi_checksums: [CODE_X] }],
      ["financial protocols with nothing served", { ...b, escrow_deployments: [] }],
      ["a deployment served with no financial protocol", { ...b, financial_protocols: [] }],
      ["a fractional version", { ...b, hosted_protocols: [1.5] }],
      ["a version as text", { ...b, financial_protocols: ["3"] }],
      ["a negative client protocol", { ...b, client_protocols: [-1] }],
      ["a malformed checksum", { ...b, escrow_abi_checksums: [CODE_A, "5ECC"] }],
      ["an unknown backend", { ...b, escrow_deployments: [{ key: "k", pin: { ...PIN_A, backend: "evm" } }] }],
      ["a missing field", { format: b.format, rules: b.rules }],
    ];
    for (const [why, capability] of refused) {
      expect({ why, refused: (() => { try { compatibilityKey(capability as DeploymentCapability); return false; } catch (error) { return error instanceof DeploymentCapabilityError; } })() }).toEqual({ why, refused: true });
    }
    // A release that serves nothing has exactly one canonical financial field: [].
    expect(() => compatibilityKey({ ...b, financial_protocols: [], escrow_deployments: [] })).not.toThrow();
  });

  it("names a deployment by (backend, chain, contract): escrowInstanceKey is that key plus the chain game id", () => {
    const binding = { backend: "juno-cosmwasm", network: { chain_id: "uni-7", network_class: "testnet" }, deployment: { kind: "juno-cosmwasm", contract_address: CONTRACT_A }, chain_game_id: "42" } as unknown as EscrowBindingV2;
    expect(escrowInstanceKey(binding)).toBe(`${deploymentKey(PIN_A)}|2:42`);
    // The facts are not in the name.
    expect(deploymentKey(pinOf(CONTRACT_A, { denom: "ujuno", code_checksum: CODE_X, network_class: "local", codec: "18GNO/v1" }))).toBe(deploymentKey(PIN_A));
  });
});

/* ================================================================================================= */
/* 3. THE GAMEPLAY CONTINUATION IDENTITY                                                               */
/* ================================================================================================= */

describe("GCI v1: the gameplay continuation identity, from the deal", () => {
  const deal = (fields: Record<string, unknown>) => ({ players: ["p-1", "p-2"], variants: { rules: 1 }, build: "dev", ...fields });

  it("a pre-LIVE-4 deal (no hosted_protocol) is hosted protocol 1; a stamped one is what it says", () => {
    expect(ABSENT_HOSTED_PROTOCOL).toBe(1);
    expect(gameIdentityOfDeal(deal({ rules_engine_version: 11 }))).toEqual({ kind: "dealt", gci: { format: GAME_CONTINUATION_FORMAT, rules_engine_version: 11, hosted_protocol: 1 } });
    expect(gameIdentityOfDeal(deal({ rules_engine_version: 11, hosted_protocol: 2 }))).toEqual({ kind: "dealt", gci: { format: GAME_CONTINUATION_FORMAT, rules_engine_version: 11, hosted_protocol: 2 } });
    expect(gameIdentityOfDeal(deal({ rules_engine_version: 11, hosted_protocol: undefined }))).toEqual(gameIdentityOfDeal(deal({ rules_engine_version: 11 })));
  });

  it("a hosted_protocol that is present but not a version is malformed -- never defaulted, never legacy", () => {
    for (const bad of [0, -1, 1.5, "1", null, Number.NaN, 2 ** 53, [1], {}]) {
      expect(gameIdentityOfDeal(deal({ rules_engine_version: 11, hosted_protocol: bad })).kind).toBe("malformed");
    }
    expect(gameIdentityOfDeal(deal({ hosted_protocol: 1 })).kind).toBe("malformed"); // a stamped deal always carries its pin
    expect(gameIdentityOfDeal(deal({ rules_engine_version: "11", hosted_protocol: 1 })).kind).toBe("malformed");
  });

  it("an unpinned deal stays legacy (today's rule); a pin no server could stamp is malformed; no deal is undealt", () => {
    expect(gameIdentityOfDeal(deal({}))).toEqual({ kind: "legacy" });
    expect(gameIdentityOfDeal(deal({ rules_engine_version: "11" }))).toEqual({ kind: "legacy" });
    expect(gameIdentityOfDeal(deal({ rules_engine_version: 11.5 }))).toEqual({ kind: "legacy" });
    for (const impossible of [0, -3, 2 ** 60]) expect(gameIdentityOfDeal(deal({ rules_engine_version: impossible })).kind).toBe("malformed");
    expect(gameIdentityOfDeal(null)).toEqual({ kind: "undealt" });
    expect(gameIdentityOfDeal(undefined)).toEqual({ kind: "undealt" });
    expect(gameIdentityOfDeal(7).kind).toBe("malformed");
    expect(gameIdentityOfDeal([1]).kind).toBe("malformed");
  });

  it("never reads the build: deals that differ only in `build` have one identity", () => {
    for (const fields of [{ rules_engine_version: 11 }, { rules_engine_version: 11, hosted_protocol: 1 }, {}]) {
      const facts = ["dev", "build-a", "031593e", ""].map((build) => gameIdentityOfDeal(deal({ ...fields, build })));
      for (const other of facts) expect(other).toEqual(facts[0]);
    }
    expect(gameIdentityOfDeal({ rules_engine_version: 11 })).toEqual(gameIdentityOfDeal(deal({ rules_engine_version: 11 })));
  });

  it("reads the EFFECTIVE deal, exactly the one rulesEngineVersionOf reads", () => {
    let at = 0;
    const entry = (message: unknown): ReplayEntry => ({ index: at, id: `e${at++}`, actor: "server", payload: JSON.stringify(message) });
    const logs: ReplayEntry[][] = [];
    at = 0;
    logs.push([entry({ SetupGame: deal({ rules_engine_version: 11 }) })]);
    at = 0;
    logs.push([entry({ SetupGame: deal({}) })]);
    at = 0;
    logs.push([entry({ SetupGame: deal({ rules_engine_version: 10 }) }), entry({ RevertTo: { index: 0 } })]);
    at = 0;
    logs.push([entry({ SetupGame: deal({ rules_engine_version: 10 }) }), entry({ RevertTo: { index: 0 } }), entry({ SetupGame: deal({ rules_engine_version: 11, hosted_protocol: 1 }) })]);
    at = 0;
    logs.push([{ index: 0, id: "x", actor: "server", payload: "not json" }, entry({ SetupGame: deal({ rules_engine_version: 12 }) })]);
    logs.push([]);
    for (const log of logs) {
      const version = rulesEngineVersionOf(log);
      const identity = gameIdentityOfEntries(log);
      if (version === undefined) expect(identity).toEqual({ kind: "undealt" });
      else if (version === null) expect(identity).toEqual({ kind: "legacy" });
      else expect(identity).toEqual({ kind: "dealt", gci: gameContinuationIdentity(version, 1) });
    }
    expect(gameIdentityOfEntries(logs[3])).toEqual({ kind: "dealt", gci: gameContinuationIdentity(11, 1) });
  });

  it("the money identity moved unchanged: exactly five keys, positive versions, a known codec", () => {
    expect(isMoneyContinuationIdentity(mci())).toBe(true);
    expect(isMoneyContinuationIdentity({ ...mci(), build: "dev" })).toBe(false);
    expect(isMoneyContinuationIdentity({ ...mci(), financial_protocol: 0 })).toBe(false);
    expect(isMoneyContinuationIdentity({ ...mci(), settlement_codec: "18JUNO/v2" })).toBe(false);
    expect(isMoneyContinuationIdentity({ ...mci(), format: "18COSMOS/MONEY-CONTINUATION/v2" })).toBe(false);
    expect(gameplayIdentityOfMoney(mci({ rules_engine_version: 12, hosted_protocol: 2 }))).toEqual(gameContinuationIdentity(12, 2));
  });
});

/* ================================================================================================= */
/* 4. THE CONTINUATION VERDICT                                                                        */
/* ================================================================================================= */

describe("continuationVerdict: continues, not-continued (derived), conflict (durable)", () => {
  it("continues a supported no-money game, an undealt table, and a money game whose escrow is served with its facts", () => {
    expect(verdictOf(game(dealt()))).toEqual({ kind: "continues" });
    expect(verdictOf(game({ kind: "undealt" }))).toEqual({ kind: "continues" });
    expect(verdictOf(game(dealt(), moneyRecord()))).toEqual({ kind: "continues" });
    expect(verdictOf(game({ kind: "undealt" }, moneyRecord()))).toEqual({ kind: "continues" }); // a funding table
    // Served but not verified this run (the RPC is down): gameplay continues; signing waits.
    expect(verdictOf(game(dealt(), moneyRecord()), POOL, [])).toEqual({ kind: "continues" });
  });

  it("gameplay: an unsupported rules pin or hosted protocol is not continued here -- and continues where both are read", () => {
    expect(classOf(verdictOf(game(dealt(12))))).toBe("not-continued/rules-not-supported");
    expect(classOf(verdictOf(game(dealt(11, 2))))).toBe("not-continued/hosted-protocol");
    expect(verdictOf(game(dealt(11, 2)), withPool({ hosted_protocols: [1, 2] }))).toEqual({ kind: "continues" });
    expect(verdictOf(game(dealt(11)), withPool({ rules: { current: 12, supported: [11, 12], certified: [10, 11] } }))).toEqual({ kind: "continues" });
    expect(classOf(verdictOf(game(dealt(11)), withPool({ rules: { current: 12, supported: [12], certified: [10, 11, 12] } })))).toBe("not-continued/rules-not-supported");
  });

  it("an unpinned deal is refused unless a development server says so by name -- and never for money", () => {
    expect(classOf(verdictOf(game({ kind: "legacy" })))).toBe("not-continued/legacy-unpinned");
    expect(verdictOf(game({ kind: "legacy" }), POOL, [], "development-corpus")).toEqual({ kind: "continues" });
    // Even then only where hosted protocol 1 -- what an unpinned deal is -- is read.
    expect(classOf(verdictOf(game({ kind: "legacy" }), withPool({ hosted_protocols: [2] }), [], "development-corpus"))).toBe("not-continued/hosted-protocol");
    expect(classOf(verdictOf(game({ kind: "legacy" }, moneyRecord()), POOL, [], "development-corpus"))).toBe("not-continued/legacy-unpinned");
    expect(classOf(verdictOf(game({ kind: "malformed", detail: "x" })))).toBe("not-continued/malformed");
    // The default policy is the server's.
    expect(classOf(continuationVerdict(game({ kind: "legacy" }), POOL))).toBe("not-continued/legacy-unpinned");
  });

  it("format facts come first: newer is another build's writing, never corruption; older-unread likewise", () => {
    for (const artifact of GAME_ARTIFACTS) {
      const newer = { ...MONEY_FORMATS, [artifact]: "newer" } as ArtifactFormats;
      const older = { ...MONEY_FORMATS, [artifact]: "older-unread" } as ArtifactFormats;
      const corrupt = { ...MONEY_FORMATS, [artifact]: "corrupt" } as ArtifactFormats;
      expect(classOf(verdictOf(game(dealt(), moneyRecord(), newer)))).toBe("not-continued/newer-format");
      expect(classOf(verdictOf(game(dealt(), moneyRecord(), older)))).toBe("not-continued/older-format");
      expect(classOf(verdictOf(game(dealt(), moneyRecord(), corrupt)))).toBe("not-continued/malformed");
    }
    // Precedence: another build's artifact outranks a damaged one, so a pool that cannot read everything writes nothing.
    expect(classOf(verdictOf(game(dealt(), moneyRecord(), { record: "corrupt", log: "current", fin: "newer" })))).toBe("not-continued/newer-format");
    expect(classOf(verdictOf(game(dealt(), moneyRecord(), { record: "corrupt", log: "older-unread" })))).toBe("not-continued/older-format");
    // Formats outrank identity: a newer record on a game whose pin this pool also lacks is still newer-format.
    expect(classOf(verdictOf(game(dealt(12), null, { record: "newer", log: "current" })))).toBe("not-continued/newer-format");
    // A class the verdict does not know is damage -- still derived, still no write.
    expect(classOf(verdictOf(game(dealt(), null, { record: "sideways" as never, log: "current" })))).toBe("not-continued/malformed");
  });

  it("formatFactOf: current, newer, older-unread and corrupt against what a store reads", () => {
    expect(formatFactOf(1, [1, 2])).toBe("current");
    expect(formatFactOf(2, [1, 2])).toBe("current");
    expect(formatFactOf(3, [1, 2])).toBe("newer");
    expect(formatFactOf(1, [2, 3])).toBe("older-unread");
    expect(formatFactOf(2, [1, 3])).toBe("older-unread");
    for (const bad of [0, -1, 1.5, "2", undefined, null, Number.NaN]) expect(formatFactOf(bad, [1, 2])).toBe("corrupt");
    expect(() => formatFactOf(1, [])).toThrow(TypeError);
  });

  it("money: the identity by set membership, in ESCROW-3A's order and with ESCROW-3A's reasons", () => {
    const at = (identity: unknown, capability: DeploymentCapability = POOL) => classOf(verdictOf(game({ kind: "undealt" }, moneyRecord(identity)), capability));
    expect(at({ ...mci(), extra: 1 })).toBe("not-continued/malformed");
    expect(at(mci({ rules_engine_version: 12 }))).toBe("not-continued/rules-not-supported");
    expect(at(mci({ rules_engine_version: 12 }), withPool({ rules: { current: 12, supported: [11, 12], certified: [10, 11] } }))).toBe("not-continued/rules-not-certified");
    expect(at(mci({ hosted_protocol: 2 }))).toBe("not-continued/hosted-protocol");
    expect(at(mci({ financial_protocol: 2 }))).toBe("not-continued/financial-protocol");
    expect(at(mci({ financial_protocol: 4 }))).toBe("not-continued/financial-protocol");
    expect(at(mci({ settlement_codec: "18GNO/v1" }))).toBe("not-continued/settlement-codec");
    // Order: an identity wrong on several axes answers the first, as ESCROW-3A did.
    expect(at(mci({ rules_engine_version: 12, financial_protocol: 2, settlement_codec: "18GNO/v1" }))).toBe("not-continued/rules-not-supported");
    expect(at(mci({ hosted_protocol: 2, financial_protocol: 2 }))).toBe("not-continued/hosted-protocol");
    // A pool with no escrow backend speaks no financial protocol: every money game is someone else's.
    expect(at(mci(), NO_BACKEND)).toBe("not-continued/financial-protocol");
  });

  it("money: a missing record is a conflict; the held placeholder and a record with no pin are malformed", () => {
    expect(classOf(verdictOf(game(dealt(), { kind: "missing" })))).toBe("conflict/financial-record-missing");
    expect(classOf(verdictOf(game(dealt(), { kind: "placeholder" })))).toBe("not-continued/malformed");
    expect(classOf(verdictOf(game(dealt(), moneyRecord(mci(), null))))).toBe("not-continued/malformed");
    expect(classOf(verdictOf(game(dealt(), moneyRecord(mci(), { ...PIN_A, code_checksum: "nothex" }))))).toBe("not-continued/malformed");
  });

  it("agreement: a money identity that contradicts its own deal or its own deployment is an identity conflict", () => {
    const bothCodecs = withPool({ settlement_codecs: ["18GNO/v1", "18JUNO/v1"] });
    const twoRules = withPool({ rules: { current: 11, supported: [10, 11], certified: [10, 11] } });
    expect(classOf(verdictOf(game(dealt(10), moneyRecord(mci())), twoRules))).toBe("conflict/identity-conflict");
    expect(classOf(verdictOf(game(dealt(11, 2), moneyRecord(mci())), withPool({ hosted_protocols: [1, 2] })))).toBe("conflict/identity-conflict");
    expect(classOf(verdictOf(game(dealt(), moneyRecord(mci({ settlement_codec: "18GNO/v1" }))), bothCodecs))).toBe("conflict/identity-conflict");
    // Only a pool that reads both facts judges them: a pool that cannot play the money identity's rules routes instead.
    expect(classOf(verdictOf(game(dealt(11), moneyRecord(mci({ rules_engine_version: 12 })))))).toBe("not-continued/rules-not-supported");
  });

  it("the deployment: unavailable when not served (T-10); a conflict only when the CHAIN contradicts the binding", () => {
    const aAndB = withPool({ escrow_deployments: [servedDeployment(PIN_A), servedDeployment(PIN_B)] });
    const onlyB = withPool({ escrow_deployments: [servedDeployment(PIN_B)] });
    const onB = game(dealt(), moneyRecord(mci(), PIN_B));
    expect(verdictOf(game(dealt(), moneyRecord()), POOL)).toEqual({ kind: "continues" }); // {A}
    expect(classOf(verdictOf(game(dealt(), moneyRecord()), onlyB))).toBe("not-continued/deployment-unavailable"); // {B}
    expect(verdictOf(game(dealt(), moneyRecord()), aAndB)).toEqual({ kind: "continues" }); // {A, B}
    expect(verdictOf(onB, aAndB)).toEqual({ kind: "continues" });
    // The chain agreeing with the binding and the configuration changes nothing.
    expect(verdictOf(game(dealt(), moneyRecord()), POOL, CHAIN_READ_A)).toEqual({ kind: "continues" });

    // A chain-attested fact (checksum, denom) bound differently from what this pool is configured with:
    for (const facts of [{ denom: "ujuno" }, { code_checksum: CODE_X }]) {
      const bound = game(dealt(), moneyRecord(mci(), pinOf(CONTRACT_A, facts)));
      // the chain not read (RPC down, T-22): a possible typo -- derived, never a hold;
      expect(classOf(verdictOf(bound, POOL, []))).toBe("not-continued/deployment-unverified");
      // the chain read, and it says what the configuration says: the contract is not what the game was bound to;
      expect(classOf(verdictOf(bound, POOL, CHAIN_READ_A))).toBe("conflict/deployment-conflict");
      // the chain read, and it says what the BINDING says: the configuration is the typo -- derived;
      expect(classOf(verdictOf(bound, POOL, [[deploymentKey(PIN_A), { code_checksum: CODE_A, denom: "ujunox", ...facts }]]))).toBe("not-continued/deployment-unverified");
      // another contract's chain answer says nothing about this one.
      expect(classOf(verdictOf(bound, POOL, [[deploymentKey(PIN_B), { code_checksum: CODE_A, denom: "ujunox" }]]))).toBe("not-continued/deployment-unverified");
    }
    // The contract changed under the game (an in-place migration, OD-L4-4) while the configuration still names the old
    // code: the binding and the configuration agree, the chain does not -- a conflict, never gameplay served where the
    // escrow cannot be.
    const migrated = [[deploymentKey(PIN_A), { code_checksum: CODE_X, denom: "ujunox" }]] as const;
    expect(classOf(verdictOf(game(dealt(), moneyRecord()), POOL, migrated))).toBe("conflict/deployment-conflict");
    // A DECLARED fact no chain read attests (the network class, the codec) is never a conflict, chain read or not.
    const relabelled = game(dealt(), moneyRecord(mci(), pinOf(CONTRACT_A, { network_class: "local" })));
    expect(classOf(verdictOf(relabelled, POOL, []))).toBe("not-continued/deployment-unverified");
    expect(classOf(verdictOf(relabelled, POOL, CHAIN_READ_A))).toBe("not-continued/deployment-unverified");
    // The default runtime read nothing, so without the chain no fact difference is ever a durable hold.
    expect(classOf(continuationVerdict(game(dealt(), moneyRecord(mci(), pinOf(CONTRACT_A, { denom: "ujuno" }))), POOL))).toBe("not-continued/deployment-unverified");
  });

  it("a chain answer that is not well formed is treated as not read: garbage never concludes a conflict", () => {
    const key = deploymentKey(PIN_A);
    const garbage: unknown[] = [
      null,
      {},
      { code_checksum: CODE_X },
      { denom: "ujunox" },
      { code_checksum: CODE_X.toUpperCase(), denom: "ujunox" },
      { code_checksum: `0x${CODE_X}`, denom: "ujunox" },
      { code_checksum: CODE_X, denom: "" },
      { code_checksum: CODE_X, denom: "u juno" },
      { code_checksum: 7, denom: "ujunox" },
      "5ecc",
    ];
    for (const entry of garbage) {
      const chain = [[key, entry as ChainAttestedFacts]] as const;
      // With the binding equal to the configuration, a garbage answer changes nothing ...
      expect({ entry, verdict: verdictOf(game(dealt(), moneyRecord()), POOL, chain) }).toEqual({ entry, verdict: { kind: "continues" } });
      // ... and with a difference, it stays derived -- never the durable conflict a real chain answer would make it.
      expect({ entry, why: classOf(verdictOf(game(dealt(), moneyRecord(mci(), pinOf(CONTRACT_A, { denom: "ujuno" }))), POOL, chain)) }).toEqual({ entry, why: "not-continued/deployment-unverified" });
    }
  });

  it("only conflicts carry a hold code: not-continued is derived and writes nothing", () => {
    expect(CONFLICT_HOLD_CODES).toEqual({
      "deployment-conflict": "binding-mismatch",
      "identity-conflict": "continuation-incompatible",
      "financial-record-missing": "financial-record-missing",
    });
    const derived: ContinuationVerdict[] = [
      verdictOf(game(dealt(12))),
      verdictOf(game(dealt(11, 2))),
      verdictOf(game({ kind: "legacy" })),
      verdictOf(game(dealt(), null, { record: "newer", log: "current" })),
      verdictOf(game(dealt(), moneyRecord(mci({ financial_protocol: 2 })))),
      verdictOf(game(dealt(), moneyRecord(mci(), PIN_B))),
      verdictOf(game(dealt(), moneyRecord(mci(), pinOf(CONTRACT_A, { denom: "ujuno" })))),
    ];
    for (const verdict of derived) {
      expect(verdict.kind).toBe("not-continued");
      if (verdict.kind === "not-continued") expect(Object.keys(CONFLICT_HOLD_CODES)).not.toContain(verdict.why);
    }
  });

  it("the build has no vote: facts from deals that differ only in build give one verdict, on every pool", () => {
    const pools = [POOL, NO_BACKEND, withPool({ hosted_protocols: [1, 2] }), withPool({ rules: { current: 12, supported: [12], certified: [11, 12] } })];
    for (const fields of [{ rules_engine_version: 11 }, { rules_engine_version: 11, hosted_protocol: 2 }, {}]) {
      for (const pool of pools) {
        const verdicts = ["dev", "build-a", "build-b"].map((build) => verdictOf(game(gameIdentityOfDeal({ players: [], variants: {}, build, ...fields })), pool));
        for (const other of verdicts) expect(other).toEqual(verdicts[0]);
      }
    }
    // Nor in the verdict's source: no build is read there.
    for (const file of ["gameEngine/compat/continuationVerdict.ts", "gameEngine/compat/continuationIdentity.ts"]) {
      const code = readStripped(file);
      expect(code.length).toBeGreaterThan(1000);
      expect(code).not.toMatch(/build/i);
    }
  });

  it("the dealing identity: a no-money deal takes the pool's current rules and highest hosted protocol; money its own", () => {
    const newer = withPool({ rules: { current: 12, supported: [11, 12], certified: [10, 11] }, hosted_protocols: [1, 2] });
    expect(dealingIdentity(POOL, null)).toEqual(gameContinuationIdentity(11, 1));
    expect(dealingIdentity(newer, null)).toEqual(gameContinuationIdentity(12, 2));
    expect(dealingIdentity(newer, mci())).toEqual(gameContinuationIdentity(11, 1)); // never the pool's current
    // And a money game dealt that way agrees with its own identity on that pool.
    expect(verdictOf(game({ kind: "dealt", gci: dealingIdentity(newer, mci()) }, moneyRecord()), newer)).toEqual({ kind: "continues" });
  });
});

/* ================================================================================================= */
/* 5. T-24 (THE PURE HALF): SERVING AND THE NO-MONEY DRAIN                                             */
/* ================================================================================================= */

describe("T-24 (pure): serveDecision around the flip and the 7-day no-money deadline", () => {
  const FLIP = Date.UTC(2026, 9, 1, 12, 0, 0);
  const DEADLINE = FLIP + NO_MONEY_DRAIN_MS;
  const PRIMARY: PoolServingState = { role: "primary", flipped_at: null };
  const DRAINING: PoolServingState = { role: "draining", flipped_at: FLIP };
  const PRIMARY_LACKS: ContinuationVerdict = { kind: "not-continued", why: "rules-not-supported", detail: "the primary plays 12" };
  const served = (change: Partial<ServedGameFacts> = {}): ServedGameFacts => ({
    verdict: { kind: "continues" },
    money: false,
    terminal: false,
    money_closed: false,
    primary_verdict: PRIMARY_LACKS,
    ...change,
  });

  it("is seven days, as an integer number of milliseconds", () => {
    expect(NO_MONEY_DRAIN_MS).toBe(604800000);
    expect(Number.isSafeInteger(NO_MONEY_DRAIN_MS)).toBe(true);
    expect(noMoneyDrainDeadline(DRAINING)).toBe(DEADLINE);
  });

  it("pre-flip: the primary serves what it continues, money or not, with no deadline", () => {
    for (const money of [false, true]) {
      expect(serveDecision(served({ money, primary_verdict: null }), PRIMARY, DEADLINE + 100 * NO_MONEY_DRAIN_MS)).toEqual({ kind: "serve", drain_deadline: null, blocks_retirement: false });
    }
  });

  it("a no-money game only the old pool continues: served before the deadline, expired at it exactly and after", () => {
    expect(serveDecision(served(), DRAINING, FLIP)).toEqual({ kind: "serve", drain_deadline: DEADLINE, blocks_retirement: true });
    expect(serveDecision(served(), DRAINING, FLIP - 1)).toEqual({ kind: "serve", drain_deadline: DEADLINE, blocks_retirement: true }); // a clock behind the flip
    expect(serveDecision(served(), DRAINING, DEADLINE - 1)).toEqual({ kind: "serve", drain_deadline: DEADLINE, blocks_retirement: true });
    expect(serveDecision(served(), DRAINING, DEADLINE)).toEqual({ kind: "decline", why: "drain-expired", verdict: null, detail: expect.stringContaining("7 days after the flip"), blocks_retirement: false });
    const after = serveDecision(served(), DRAINING, DEADLINE + 1);
    expect(after.kind === "decline" && after.why).toBe("drain-expired");
  });

  it("a terminal no-money game ends its own drain: still shown while the pool lives, holding nothing, at any time", () => {
    for (const now of [FLIP, DEADLINE - 1, DEADLINE, DEADLINE + NO_MONEY_DRAIN_MS]) {
      expect(serveDecision(served({ terminal: true }), DRAINING, now)).toEqual({ kind: "serve", drain_deadline: null, blocks_retirement: false });
    }
  });

  it("a game another live pool (the primary) continues is released, money or not, before or after the deadline", () => {
    for (const money of [false, true]) {
      for (const now of [FLIP, DEADLINE + 1]) {
        expect(serveDecision(served({ money, primary_verdict: { kind: "continues" } }), DRAINING, now)).toEqual({ kind: "release", detail: expect.any(String), blocks_retirement: false });
      }
    }
    // Even one the old pool can no longer read itself (derived): the primary reads it, so it moves (preflight §6).
    const cannotRead: ContinuationVerdict = { kind: "not-continued", why: "older-format", detail: "an older fin" };
    expect(serveDecision(served({ money: true, verdict: cannotRead, primary_verdict: { kind: "continues" } }), DRAINING, FLIP).kind).toBe("release");
    // But never one the old pool holds in conflict: the operator resolves that first, and an open money game keeps the pool.
    const held: ContinuationVerdict = { kind: "conflict", why: "deployment-conflict", detail: "the chain reports another checksum" };
    expect(serveDecision(served({ money: true, verdict: held, primary_verdict: { kind: "continues" } }), DRAINING, FLIP)).toEqual({ kind: "decline", why: "conflict", verdict: held, detail: held.detail, blocks_retirement: true });
    // A primary that does not continue it -- or no primary verdict at all -- never takes it away.
    expect(serveDecision(served({ primary_verdict: PRIMARY_LACKS }), DRAINING, FLIP).kind).toBe("serve");
    expect(serveDecision(served({ primary_verdict: { kind: "conflict", why: "deployment-conflict", detail: "x" } }), DRAINING, FLIP).kind).toBe("serve");
    expect(serveDecision(served({ primary_verdict: null }), DRAINING, FLIP).kind).toBe("serve");
  });

  it("money is never timed out: served until its lifecycle closes, whatever the clock says", () => {
    for (const now of [FLIP, DEADLINE - 1, DEADLINE, DEADLINE + 365 * NO_MONEY_DRAIN_MS]) {
      expect(serveDecision(served({ money: true }), DRAINING, now)).toEqual({ kind: "serve", drain_deadline: null, blocks_retirement: true });
      expect(serveDecision(served({ money: true, terminal: true }), DRAINING, now)).toEqual({ kind: "serve", drain_deadline: null, blocks_retirement: true });
      expect(serveDecision(served({ money: true, terminal: true, money_closed: true }), DRAINING, now)).toEqual({ kind: "serve", drain_deadline: null, blocks_retirement: false });
    }
    // Even with no flip time or no valid clock, money is served; the no-money game fails closed.
    for (const pool of [{ role: "draining", flipped_at: null } as PoolServingState, { role: "draining", flipped_at: -5 } as PoolServingState]) {
      expect(serveDecision(served({ money: true }), pool, FLIP).kind).toBe("serve");
      const noMoney = serveDecision(served(), pool, FLIP);
      expect(noMoney.kind === "decline" && noMoney.why).toBe("drain-expired");
    }
    expect(serveDecision(served({ money: true }), DRAINING, Number.NaN).kind).toBe("serve");
    for (const clock of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const badClock = serveDecision(served(), DRAINING, clock);
      expect(badClock.kind === "decline" && badClock.why).toBe("drain-expired");
    }
    // A clock with a fraction is still a clock.
    expect(serveDecision(served(), DRAINING, FLIP + 0.5)).toEqual({ kind: "serve", drain_deadline: DEADLINE, blocks_retirement: true });
  });

  it("a verdict that does not continue is never served, by any pool; a retired pool serves nothing", () => {
    const notHere: ContinuationVerdict = { kind: "not-continued", why: "hosted-protocol", detail: "hosted 2" };
    const held: ContinuationVerdict = { kind: "conflict", why: "identity-conflict", detail: "rules 10 vs 11" };
    for (const pool of [PRIMARY, DRAINING]) {
      expect(serveDecision(served({ verdict: notHere }), pool, FLIP)).toEqual({ kind: "decline", why: "not-continued", verdict: notHere, detail: "hosted 2", blocks_retirement: false });
      expect(serveDecision(served({ verdict: held }), pool, FLIP)).toEqual({ kind: "decline", why: "conflict", verdict: held, detail: "rules 10 vs 11", blocks_retirement: false });
    }
    const retired = serveDecision(served({ money: true }), { role: "retired", flipped_at: FLIP }, FLIP);
    expect(retired).toEqual({ kind: "decline", why: "pool-retired", verdict: null, detail: expect.any(String), blocks_retirement: false });
  });

  it("an open money game the old pool keeps but cannot serve right now still blocks its retirement -- nothing strands it", () => {
    const damaged: ContinuationVerdict = { kind: "not-continued", why: "malformed", detail: "the financial record does not parse" };
    const held: ContinuationVerdict = { kind: "conflict", why: "identity-conflict", detail: "rules 10 vs 11" };
    const declined = (verdict: ContinuationVerdict, blocks: boolean) => ({
      kind: "decline",
      why: verdict.kind === "conflict" ? "conflict" : "not-continued",
      verdict,
      detail: verdict.kind === "continues" ? "" : verdict.detail,
      blocks_retirement: blocks,
    });
    for (const verdict of [damaged, held]) {
      for (const now of [FLIP, DEADLINE + 1]) {
        expect(serveDecision(served({ money: true, verdict }), DRAINING, now)).toEqual(declined(verdict, true));
        expect(serveDecision(served({ money: true, verdict, money_closed: true }), DRAINING, now)).toEqual(declined(verdict, false));
      }
      // A primary never retires, so nothing blocks it there.
      expect(serveDecision(served({ money: true, verdict, primary_verdict: null }), PRIMARY, FLIP)).toEqual(declined(verdict, false));
    }
    // A no-money game the old pool cannot serve holds nothing.
    expect(serveDecision(served({ verdict: damaged }), DRAINING, FLIP)).toEqual(declined(damaged, false));
  });
});

/* ================================================================================================= */
/* 6. THE CLIENT VERDICT                                                                              */
/* ================================================================================================= */

describe("clientVerdict: the client protocol, the client's rules and the game's pin, kept apart", () => {
  const LIVE4 = withPool({ client_protocols: [0, 1] }); // the target once L4-3 implements protocol 1
  const RETIRED0 = withPool({ client_protocols: [1] });
  const announce = (cp: string | null, cr: string | null = null, cb: string | null = null) => parseClientAnnouncement({ cp, cr, cb });
  const kindOf = (verdict: ClientVerdict): string => (verdict.kind === "reload" || verdict.kind === "route" ? `${verdict.kind}/${verdict.code}` : verdict.kind);

  it("parses the announcement: absent cp is protocol 0; cr is required and strict from protocol 1 on", () => {
    expect(announce(null)).toEqual({ kind: "legacy", protocol: 0, build: null });
    expect(parseClientAnnouncement({})).toEqual({ kind: "legacy", protocol: 0, build: null });
    expect(announce(null, "11", "dev")).toEqual({ kind: "legacy", protocol: 0, build: "dev" });
    expect(announce("0")).toEqual({ kind: "legacy", protocol: 0, build: null });
    expect(announce("1", "11", "b1")).toEqual({ kind: "announced", protocol: 1, rules: [11], build: "b1" });
    expect(announce("1", "12,10,11")).toEqual({ kind: "announced", protocol: 1, rules: [10, 11, 12], build: null });
    expect(announce("1").kind).toBe("malformed");
    for (const cr of ["", "11,", ",11", "a", "011", "11,11", "1 1", "11;12", Array.from({ length: MAX_ANNOUNCED_RULES + 1 }, (_, at) => String(at + 1)).join(",")]) {
      expect({ cr, kind: announce("1", cr).kind }).toEqual({ cr, kind: "malformed" });
    }
    for (const cp of ["01", "-1", "x", "1.0", "", " 1", "1e0"]) {
      expect(announce(cp, "11")).toEqual({ kind: "malformed", protocol: null, problem: "cp is not a protocol number", build: null });
    }
  });

  it("protocol 0 keeps the legacy path for any game, and never gets reload, route or 4426 -- even once retired", () => {
    for (const pin of [null, 10, 11, 12]) {
      expect(clientVerdict(announce(null), LIVE4, pin)).toEqual({ kind: "legacy" });
      expect(clientVerdict(announce(null), POOL, pin)).toEqual({ kind: "legacy" });
      expect(clientVerdict(announce(null), RETIRED0, pin).kind).toBe("legacy-refused");
    }
  });

  it("an announced client: ok on its game, reload when its protocol or its rules are behind this release", () => {
    expect(clientVerdict(announce("1", "11"), LIVE4, 11)).toEqual({ kind: "ok" });
    expect(clientVerdict(announce("1", "11"), LIVE4, null)).toEqual({ kind: "ok" }); // no deal yet
    expect(clientVerdict(announce("1", "10,11"), LIVE4, 11)).toEqual({ kind: "ok" });
    const protocol = clientVerdict(announce("2", "11"), LIVE4, 11);
    expect(protocol).toEqual({ kind: "reload", code: "client-protocol", detail: expect.stringContaining("client protocol 2"), accepted: [0, 1] });
    expect(kindOf(clientVerdict(announce("1", "10"), LIVE4, 11))).toBe("reload/client-rules");
    expect(kindOf(clientVerdict(announce("1", "12"), LIVE4, 11))).toBe("reload/client-rules"); // this release's bundle carries 11
  });

  it("route when neither the tab nor this release's bundle carries the game's rules (LIVE-6 supplies the target)", () => {
    expect(kindOf(clientVerdict(announce("1", "11"), LIVE4, 12))).toBe("route/client-rules");
    expect(kindOf(clientVerdict(announce("1", "12"), withPool({ rules: { current: 12, supported: [12], certified: [10, 11, 12] }, client_protocols: [0, 1] }), 11))).toBe("route/client-rules");
  });

  it("a broken announcement from a LIVE-4 bundle is a reload; an unaccepted protocol says so first", () => {
    expect(kindOf(clientVerdict(announce("1"), LIVE4, 11))).toBe("reload/client-announcement");
    expect(kindOf(clientVerdict(announce("1", "11,11"), LIVE4, null))).toBe("reload/client-announcement");
    expect(kindOf(clientVerdict(announce("x", "11"), LIVE4, 11))).toBe("reload/client-announcement");
    expect(kindOf(clientVerdict(announce("9"), LIVE4, 11))).toBe("reload/client-protocol");
  });

  it("keeps the three axes apart: each one alone moves only its own answer", () => {
    // Protocol alone.
    expect(kindOf(clientVerdict(announce("1", "11"), LIVE4, 11))).toBe("ok");
    expect(kindOf(clientVerdict(announce("3", "11"), LIVE4, 11))).toBe("reload/client-protocol");
    // The client's rules alone.
    expect(kindOf(clientVerdict(announce("1", "10"), LIVE4, 11))).toBe("reload/client-rules");
    // The game's pin alone.
    expect(kindOf(clientVerdict(announce("1", "11"), LIVE4, 12))).toBe("route/client-rules");
    // The pin never rescues a bad protocol, and the protocol is judged before any game.
    expect(kindOf(clientVerdict(announce("3", "11"), LIVE4, null))).toBe("reload/client-protocol");
  });

  it("never reads the build (cb), and refuses a game pin that is not a version", () => {
    for (const cb of [null, "dev", "build-a", "x".repeat(500)]) {
      expect(clientVerdict(announce("1", "11", cb), LIVE4, 11)).toEqual({ kind: "ok" });
      expect(kindOf(clientVerdict(announce("1", "10", cb), LIVE4, 11))).toBe("reload/client-rules");
      expect(clientVerdict(announce(null, null, cb), LIVE4, 11)).toEqual({ kind: "legacy" });
    }
    const code = readStripped("gameEngine/compat/clientCompatibility.ts");
    const verdictBody = code.match(/export function clientVerdict[\s\S]*$/);
    expect(verdictBody).not.toBeNull();
    expect((verdictBody as RegExpMatchArray)[0].length).toBeGreaterThan(500);
    expect((verdictBody as RegExpMatchArray)[0]).not.toMatch(/\.build\b|\bcb\b/);
    for (const bad of [0, -1, 11.5, Number.NaN]) expect(() => clientVerdict(announce("1", "11"), LIVE4, bad)).toThrow(TypeError);
  });

  it("L4-3: this build talks to a protocol-1 announcement, and still keeps the legacy wire's path", () => {
    const thisBuild = withPool({ client_protocols: ACCEPTED_CLIENT_PROTOCOLS });
    expect(clientVerdict(announce(null), thisBuild, 11)).toEqual({ kind: "legacy" });
    expect(clientVerdict(announce(String(CLIENT_PROTOCOL_VERSION), "11"), thisBuild, 11)).toEqual({ kind: "ok" });
    // The pre-L4-3 pool (legacy only) would have told the same announcement to reload.
    expect(kindOf(clientVerdict(announce(String(CLIENT_PROTOCOL_VERSION), "11"), withPool({ client_protocols: [0] }), 11))).toBe("reload/client-protocol");
  });
});
