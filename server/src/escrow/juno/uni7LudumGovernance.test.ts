// server/src/escrow/juno/uni7LudumGovernance.test.ts
//
// PHASE 3 ESCROW 2.1 (owner decisions 2026-10-09): the uni-7 Ludum DAO governance values for the 2.1 deployment --
// contracts/escrow/scripts/escrow21-uni7-governance.json -- are pinned and judged by the SAME code the server and the
// browser use: the address is a valid `juno` bech32 contract address (32 bytes), treasury = resolver = the Ludum DAO
// core, subsidy 250 bps, resolver timeout 30 days; a Juno document that trusts that resolver parses, and the trust
// check accepts a game under it whose resolver timeout meets the minimum resolver-timeout policy (the repository's
// configured minimums), and refuses it when the resolver is not trusted or the timeout is below policy. Testnet only:
// no mainnet Ludum DAO address is decided. Nothing here touches a chain.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { checkEscrowTrust, type EscrowTrustPolicy } from "../../../../frontend/src/gameEngine/escrow/escrowRoster";
import type { EscrowBindingV2, EscrowGameView } from "../../../../frontend/src/gameEngine/escrow/escrowModel";
import { bech32Decode } from "./cosmosTx";
import { JUNO_BACKEND_CONFIG_FORMAT_V3, parseJunoBackendConfig } from "./junoConfig";
import { publicKeyOf } from "./secp256k1";
import { ADMISSION_PUBKEY, CANONICAL_CHECKSUM, CONTRACT, RELAYER_ADDRESS, SETTLEMENT_SECRET } from "../escrow3bSupport";

const REPO = path.resolve(__dirname, "../../../../../.."); // dist/server/src/escrow/juno -> the repository
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const GOV = JSON.parse(read("contracts/escrow/scripts/escrow21-uni7-governance.json")) as {
  format: string;
  chain_id: string;
  network_class: string;
  ludum_dao: { core_address: string; core_code_id: number; creation_tx: string; creation_height: number; daodao_indexer: string };
  escrow21: { treasury: string; resolver: string; params: { subsidy_bps: number; resolver_timeout_secs: number } };
  server_trust: { resolvers_include: string[] };
  appeals: Record<string, string>;
  mainnet: unknown;
};
const LUDUM = "juno1fccq3dcjjn35fgt8u8jfz5kvcajfk604lhl85w25k6pr32q9r7psk6wrpu";
const THIRTY_DAYS = 30 * 24 * 60 * 60;
/** The repository's configured minimum resolver-timeout policies (the staging Juno documents). */
const POLICY_MINIMUMS = ["infra/aws/fixtures/juno-backend-staging.json", "infra/aws/fixtures/juno-backend-staging-remedy.json"].map(
  (file) => BigInt((JSON.parse(read(file)) as { trust: { min_resolver_timeout_secs: string } }).trust.min_resolver_timeout_secs),
);
const KEY = (n: number) => `arn:aws:kms:us-east-1:123456789012:key/${String(n).repeat(8)}-1111-4111-8111-111111111111`;

const policy = (resolvers: string[], minResolverTimeout: bigint): EscrowTrustPolicy => ({
  operators: [RELAYER_ADDRESS],
  resolvers,
  min_challenge_window_secs: BigInt(60),
  min_liveness_window_secs: BigInt(3600),
  min_resolver_timeout_secs: minResolverTimeout,
});
const game = (resolver: string, resolverTimeout: number) =>
  ({
    trust: {
      denom: "ujunox",
      operator: RELAYER_ADDRESS,
      resolver_config: resolver,
      resolver_game: resolver,
      challenge_window_secs: "900",
      liveness_window_secs: "3600",
      resolver_timeout_secs: String(resolverTimeout),
    },
  }) as unknown as EscrowGameView;
const binding = { asset: { denom: "ujunox" } } as unknown as EscrowBindingV2;

describe("uni-7 Ludum DAO governance for the Escrow 2.1 deployment (owner 2026-10-09)", () => {
  test("the record: uni-7 testnet only; the Ludum DAO core is treasury AND resolver; 250 bps; 30-day resolver timeout; no mainnet address", () => {
    assert.equal(GOV.format, "18COSMOS/ESCROW21-GOVERNANCE/v1");
    assert.equal(GOV.chain_id, "uni-7");
    assert.equal(GOV.network_class, "testnet");
    assert.equal(GOV.ludum_dao.core_address, LUDUM);
    assert.equal(GOV.escrow21.treasury, LUDUM);
    assert.equal(GOV.escrow21.resolver, LUDUM);
    assert.equal(GOV.escrow21.params.subsidy_bps, 250);
    assert.equal(GOV.escrow21.params.resolver_timeout_secs, 2592000);
    assert.equal(GOV.escrow21.params.resolver_timeout_secs, THIRTY_DAYS);
    assert.ok(GOV.escrow21.params.resolver_timeout_secs <= 10 * 365 * 24 * 60 * 60, "within the contract's MAX_DURATION_SECS");
    assert.deepEqual(GOV.server_trust.resolvers_include, [LUDUM]);
    assert.equal(GOV.ludum_dao.core_code_id, 28);
    assert.equal(GOV.ludum_dao.creation_height, 18686976);
    assert.equal(GOV.ludum_dao.creation_tx, "F197D5466BCD4FEF6003C1DE489B6D746402863953964C31E21D77AC99FC064F");
    assert.match(GOV.ludum_dao.daodao_indexer, /No indexer for chain/);
    assert.equal(GOV.mainnet, null, "no mainnet Ludum DAO address is decided");
  });

  test("the Ludum DAO core address is a valid juno bech32 CONTRACT address (32 bytes)", () => {
    const decoded = bech32Decode(LUDUM, "juno");
    assert.equal(decoded.bytes.length, 32, "a contract address (a 20-byte account would be a wallet)");
    assert.throws(() => bech32Decode(`${LUDUM.slice(0, -1)}q`, "juno"), /checksum/);
  });

  test("the appeal workflow is recorded: Challenge -> DISPUTED, never an automatic proposal; a member submits; the DAO core executes Resolve; the relayer is no member", () => {
    assert.match(GOV.appeals.challenge, /DISPUTED/);
    assert.match(GOV.appeals.challenge, /NEVER create a DAO proposal/);
    assert.match(GOV.appeals.proposal, /Create Appeal Proposal/);
    assert.match(GOV.appeals.proposal, /Resolve \{ chain_game_id, outcome \}/);
    assert.match(GOV.appeals.submission, /member submits and signs/);
    assert.match(GOV.appeals.submission, /Ludum DAO core executes the escrow `Resolve`/);
    assert.match(GOV.appeals.relayer, /NOT a Ludum DAO member/);
    assert.match(GOV.appeals.status, /NOT implemented yet/);
  });

  test("a production Juno document that trusts the Ludum DAO as resolver parses (the server would verify the contract's resolver against it)", () => {
    const raw = {
      format: JUNO_BACKEND_CONFIG_FORMAT_V3,
      chain_id: "uni-7",
      network_class: "testnet",
      rest_endpoints: ["https://rest.example"],
      contract_address: CONTRACT,
      code_checksum: CANONICAL_CHECKSUM,
      wasm_admin: null,
      denom: "ujunox",
      asset_symbol: "JUNOX",
      relayer: { address: RELAYER_ADDRESS, signer: { kind: "kms", key_ref: KEY(1) } },
      settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "kms", key_ref: KEY(2) } },
      admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "kms", key_ref: KEY(3) } },
      trust: { operators: [RELAYER_ADDRESS], resolvers: GOV.server_trust.resolvers_include, min_challenge_window_secs: "60", min_liveness_window_secs: "3600", min_resolver_timeout_secs: String(POLICY_MINIMUMS[0]) },
      journal: { kind: "dynamodb", table_arn: "arn:aws:dynamodb:us-east-1:210987654321:table/gs-staging-ledger" },
    };
    const config = parseJunoBackendConfig(raw, { serverMode: "production", dataDir: "/data" });
    assert.ok(config.trust.resolvers.includes(GOV.escrow21.resolver), "the configured resolver is trusted");
  });

  test("the 30-day resolver timeout satisfies every configured minimum resolver-timeout policy; an untrusted resolver or a timeout below policy is refused", () => {
    assert.ok(POLICY_MINIMUMS.length > 0);
    const timeout = GOV.escrow21.params.resolver_timeout_secs;
    for (const minimum of POLICY_MINIMUMS) {
      assert.ok(BigInt(timeout) >= minimum, `${timeout} >= ${minimum}`);
      assert.equal(checkEscrowTrust(game(GOV.escrow21.resolver, timeout), binding, policy(GOV.server_trust.resolvers_include, minimum)), null);
    }
    assert.equal(checkEscrowTrust(game(RELAYER_ADDRESS, timeout), binding, policy([LUDUM], POLICY_MINIMUMS[0])), "the deployment's resolver is not an accepted resolver");
    assert.equal(checkEscrowTrust(game(LUDUM, timeout), binding, policy([RELAYER_ADDRESS], POLICY_MINIMUMS[0])), "the deployment's resolver is not an accepted resolver");
    assert.equal(checkEscrowTrust(game(LUDUM, timeout), binding, policy([LUDUM], BigInt(timeout + 1))), "the resolver timeout is below policy");
  });
});
