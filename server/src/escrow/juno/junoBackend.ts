// server/src/escrow/juno/junoBackend.ts
//
// ==================================================================
//  ESCROW-3B: ASSEMBLING THE JUNO BACKEND -- NOTHING SIGNS OR BROADCASTS UNTIL THE CHAIN AGREES WITH EVERY PIN
// ==================================================================
//
// `start.ts` builds this only when `ESCROW_JUNO_CONFIG` names a configuration file. The pieces are the configuration's
// (`junoConfig.ts`): the REST client, the three keys -- relayer, settlement and (ESCROW-JOIN) join admission, each its own
// key (KMS in production; a development key file only where allowed), the
// signing journal (outside the data directory in production), the durable chain intents, the escrow service and the
// relayer. It starts UNVERIFIED: the relayer does not pass and the service signs nothing until `verifyJunoDeployment`
// says the chain is exactly the configured one AND the service has loaded every money game's durable state (review #2:
// a load that fails leaves it unverified and is retried with the verification, never "active but blind"). A mismatch
// keeps it off for the life of the process; an unreachable chain is retried every minute. Before any chain read, the
// frozen financial rosters are preloaded from the durable store (review #8), so the room host never moves a frozen
// seat because the chain was unreachable at boot. Money games stay disabled to players whatever this reports.

import { JUNO_CODEC_V1 } from "../../../../frontend/src/gameEngine/escrow/junoCodecV1";
import type { ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { OpsRecorder } from "../../persistence/opsRecorder";
import type { ChainIntentStore } from "../chainIntents";
import { createEscrowService, type EscrowService } from "../escrowService";
import type { FinancialGameStore } from "../financialGameStore";
import type { PrefixReplay } from "../settlementEvidence";
import type { InspectableSigningJournal } from "../signingJournal";
import type { WalletTicketLedger } from "../walletTickets";
import type { WalletControlProofs } from "../escrowPorts";
import { junoJoinAdmissionSigner } from "./joinAdmission";
import type { MoneyServing } from "../moneyServing";
import type { GameIdentityFacts } from "../../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { FormatFact } from "../../../../frontend/src/gameEngine/compat/continuationVerdict";
import { checkSignerIdentities, pinOf, settlementKeyConfigOf, verifyJunoDeployment, type DeploymentVerdict, type JunoBackendConfig, type SignerRef } from "./junoConfig";
import { createJunoRest, type HttpTransport, type JunoRest } from "./junoRest";
import { createJunoRelayer, type Relayer, type RelayerAuthority } from "./relayer";
import { junoSettlementSigner, openDevelopmentSignerFile, openKmsDigestSigner, SignerError, type DigestSigner, type KmsClient } from "./signer";

export type JunoBackendState = "unverified" | "active" | "refused";

export interface JunoBackend {
  readonly service: EscrowService;
  readonly relayer: Relayer;
  readonly rest: JunoRest;
  state(): JunoBackendState;
  lastVerdict(): DeploymentVerdict | null;
  /** Verify the deployment (retrying while the chain is unreachable); on success, resume every money game's work. */
  start(): Promise<JunoBackendState>;
  stop(): void;
}

export interface JunoBackendDeps {
  readonly config: JunoBackendConfig;
  readonly serverMode: "development" | "production";
  readonly financial: FinancialGameStore;
  readonly intents: ChainIntentStore;
  readonly journal: InspectableSigningJournal;
  readonly tickets: WalletTicketLedger;
  readonly readLog: (gameId: string) => Promise<readonly ServerLogEntry[]>;
  /** LIVE-4 (L4-4): the deal's identity, read-only (`dealIdentity.ts`); default: from `readLog`. */
  readonly readDeal?: (gameId: string) => Promise<GameIdentityFacts>;
  /** LIVE-4 (integration): the log's format class, read-only (the escrow service's `readLogFormat`). */
  readonly readLogFormat?: (gameId: string) => Promise<FormatFact>;
  readonly replay: PrefixReplay;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly log: (line: string) => void;
  readonly ops?: OpsRecorder;
  /** LIVE-5 binds AWS KMS here. Absent: a KMS-configured key refuses to open. */
  readonly kms?: KmsClient;
  readonly http?: HttpTransport;
  /** Tests: the REST client itself (an offline chain). */
  readonly rest?: JunoRest;
  readonly verifyEveryMs?: number;
  /** ESCROW-4: the proofs of wallet control the join admission requires (absent: no admission is ever issued). */
  readonly walletProofs?: WalletControlProofs;
  /** LIVE-4 (L4-4): the pool's serving, when the caller shares one (default: the service's own over the configured pin). */
  readonly serving?: MoneyServing;
  /** LIVE-5 L5-6: the relayer ROLE (AWS: `aws/ownership/relayerRole.ts` -- the `RelayerRole` this task took, or
   *  `NO_RELAYER_ROLE`). The relayer runs no pass while it is not current, and asks it before every KMS Sign, broadcast
   *  and rebroadcast. Absent (the file stores' single process): always the relayer, as before. */
  readonly relayerAuthority?: RelayerAuthority;
  /** LIVE-5 L5-6: the RELAYER's view of the chain intents (AWS: the DynamoDB intent store built with
   *  `relayerRole: role.intentStoreRole()`, whose writes carry the role fence instead of the game's). Absent: `intents`. */
  readonly relayerIntents?: ChainIntentStore;
}

async function openSigner(ref: SignerRef, deps: JunoBackendDeps): Promise<DigestSigner> {
  if (ref.kind === "kms") {
    if (deps.kms === undefined) throw new SignerError("config", `no KMS client is wired in this build (LIVE-5); the key ${ref.key_ref} cannot be opened`);
    return openKmsDigestSigner(deps.kms, ref.key_ref);
  }
  return openDevelopmentSignerFile(ref.key_file, { serverMode: deps.serverMode, networkClass: deps.config.networkClass, chainId: deps.config.chainId, acknowledged: deps.config.devSignerAcknowledged });
}

export async function openJunoBackend(deps: JunoBackendDeps): Promise<JunoBackend> {
  const config = deps.config;
  /* L5-6: the role and the role-fenced view go together -- a role without its view writes other pools' intents through
     the game fence (refused), a view without the role has no side-effect gates. */
  if ((deps.relayerAuthority === undefined) !== (deps.relayerIntents === undefined)) throw new Error("openJunoBackend: the relayer role and the relayer's view of the intents are given together, or neither is");
  const rest = deps.rest ?? createJunoRest({ endpoints: config.endpoints, expectedChainId: config.chainId, allowInsecureLocalHttp: config.allowInsecureLocalHttp, timeoutMs: config.timeoutMs, maxResponseBytes: 256 * 1024, maxCodeBytes: 4 * 1024 * 1024 }, deps.http);
  const relayerSigner = await openSigner(config.relayer.signer, deps);
  const settlementDigestSigner = await openSigner(config.settlementKey.signer, deps);
  const admissionDigestSigner = await openSigner(config.admissionKey.signer, deps);
  const keyConfig = settlementKeyConfigOf(config, settlementDigestSigner.label);
  checkSignerIdentities(config, relayerSigner.publicKey, settlementDigestSigner.publicKey, keyConfig, admissionDigestSigner.publicKey);

  let state: JunoBackendState = "unverified";
  /** Verified, and the service's load is running (its jobs may run; the relayer waits for `active`). */
  let loading = false;
  let verdict: DeploymentVerdict | null = null;
  let timer: NodeJS.Timeout | null = null;
  let relayer: Relayer | null = null;
  const service = createEscrowService({
    backend: {
      pin: pinOf(config),
      symbol: config.symbol,
      policy: [{ backend: "juno-cosmwasm", chain_id: config.chainId, network_class: config.networkClass, deployments: [{ kind: "juno-cosmwasm", contract_address: config.contract, code_checksums: config.codeChecksums, admin: config.wasmAdmin }] }],
      trust: config.trust,
      rest,
      settlementKeys: [keyConfig],
      settlementSigner: junoSettlementSigner(keyConfig, JUNO_CODEC_V1, settlementDigestSigner, deps.journal),
    },
    financial: deps.financial,
    intents: deps.intents,
    journal: deps.journal,
    relayer: () => (state === "active" || loading ? relayer : null),
    tickets: deps.tickets,
    readLog: deps.readLog,
    ...(deps.readDeal !== undefined ? { readDeal: deps.readDeal } : {}),
    ...(deps.readLogFormat !== undefined ? { readLogFormat: deps.readLogFormat } : {}),
    replay: deps.replay,
    now: deps.now,
    warn: deps.warn,
    ops: deps.ops,
    ready: () => state === "active" || loading,
    admission: { signer: junoJoinAdmissionSigner(config.admissionKey.publicKeyHex, JUNO_CODEC_V1, admissionDigestSigner), ttlSecs: config.admissionKey.ttlSecs },
    walletProofs: deps.walletProofs,
    ...(deps.serving !== undefined ? { serving: deps.serving } : {}),
  });
  relayer = createJunoRelayer({
    rest,
    store: deps.relayerIntents ?? deps.intents,
    journal: deps.journal,
    account: { address: config.relayer.address, signer: relayerSigner },
    chainId: config.chainId,
    contract: config.contract,
    gas: config.gas,
    timeoutBlocks: config.timeoutBlocks,
    now: deps.now,
    warn: deps.warn,
    ops: deps.ops,
    onResolved: (intent) => service.onIntentResolved(intent),
    active: () => state === "active",
    admit: (intent) => service.admit(intent),
    /* LIVE-4 (L4-4): the canonical verdict for every open intent, before the relayer writes anything for it. */
    classify: (intent) => service.classifyIntent(intent),
    ...(deps.relayerAuthority !== undefined ? { authority: deps.relayerAuthority } : {}),
  });
  /* Review #8: the frozen rosters, from the durable store, before the server takes a single op (no chain needed). */
  const preloaded = await service.preload();
  if (preloaded > 0) deps.log(`  escrow: ${preloaded} money games preloaded (frozen financial rosters protected before any chain read)`);

  async function verifyOnce(): Promise<JunoBackendState> {
    verdict = await verifyJunoDeployment(config, rest);
    /* LIVE-4 (L4-4): whenever the chain answered, the deployment's chain-attested facts at VERIFICATION GRADE -- the only
       source of the continuation verdict's `runtime.chainFacts` (a mismatch included: they make the classification of
       every money game deterministic, and a configuration typo stays derived, never a conflict). */
    if (verdict.kind !== "unavailable") {
      const read = await service.refreshChainFacts();
      if (read.kind === "unavailable") deps.warn(`  escrow: the deployment's facts could not be read at verification grade (${read.detail}); no deployment conflict is concluded until they are`);
    }
    if (verdict.kind === "verified") {
      if (state !== "active" && !loading) {
        loading = true;
        let loaded: Awaited<ReturnType<typeof service.load>>;
        try {
          loaded = await service.load();
        } catch (error) {
          /* Not active: the next verification retries the load (nothing is signed or submitted meanwhile). */
          deps.warn(`  escrow: the money games could not be loaded -- ${error instanceof Error ? error.message : String(error)}; financial mode waits and retries`);
          return state;
        } finally {
          loading = false;
        }
        state = "active";
        deps.ops?.audit("escrow.backend-verified", { chain_id: config.chainId, contract: config.contract, height: verdict.height, relayer: config.relayer.address, signer_key_id: config.settlementKey.signerKeyId, settlement_key: settlementDigestSigner.kind, relayer_key: relayerSigner.kind, admission_key: admissionDigestSigner.kind });
        deps.log(`  escrow: Juno backend VERIFIED on ${config.chainId} at height ${verdict.height} (contract ${config.contract}; relayer ${config.relayer.address}; ${relayerSigner.kind} keys) -- money games remain disabled to players`);
        if (loaded.games > 0) deps.log(`  escrow: ${loaded.games} money games -- ${loaded.resumed} settlements resumed, ${loaded.held} held, ${loaded.skipped} not continued here`);
        relayer?.wake();
      }
    } else if (verdict.kind === "mismatch") {
      state = "refused";
      deps.ops?.audit("escrow.backend-refused", { chain_id: config.chainId, contract: config.contract, problems: verdict.problems.slice(0, 8) });
      deps.warn(`  escrow: the Juno backend is REFUSED for this process -- ${verdict.problems.join("; ")}`);
    } else if (state === "unverified") {
      deps.warn(`  escrow: the Juno chain is not reachable yet (${verdict.detail}); financial mode waits and retries`);
    }
    return state;
  }

  return {
    service,
    relayer,
    rest,
    state: () => state,
    lastVerdict: () => verdict,
    async start() {
      let result: JunoBackendState;
      try {
        result = await verifyOnce();
      } catch (error) {
        deps.warn(`  escrow: verification failed -- ${error instanceof Error ? error.message : String(error)}; retrying`);
        result = state;
      }
      if (result !== "refused") {
        timer = setInterval(() => {
          if (state === "refused") return;
          void verifyOnce().catch((error) => deps.warn(`  escrow: verification failed -- ${error instanceof Error ? error.message : String(error)}`));
        }, deps.verifyEveryMs ?? 60_000);
        timer.unref?.();
      }
      return result;
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      relayer?.stop();
    },
  };
}
