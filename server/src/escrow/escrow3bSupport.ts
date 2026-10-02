// server/src/escrow/escrow3bSupport.ts
//
// ESCROW-3B test support (never imported by production code): one money game's whole backend over the offline Juno
// (`juno/fakeJunoChain.ts`) -- the real stores (memory or files), the real ledger, the real service and relayer, the
// development signers -- and a stored game played by the real reducer, so checkpoints are real committed boards.

import { createHash } from "crypto";

import { ALICE, BOB, BUILD, BUY, PASS, SETUP, probeSession } from "../rooms/testSupport";
import { JUNO_CODEC_V1 } from "../../../frontend/src/gameEngine/escrow/junoCodecV1";
import { joinTicketV1 } from "../../../frontend/src/gameEngine/escrow/escrowRoster";
import { variantsDigestV1 } from "../../../frontend/src/gameEngine/escrow/variantsDigest";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { GameVariants } from "../../../frontend/src/gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import type { RoomSession, ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import { createMemoryChainIntentStore, type ChainIntentStore } from "./chainIntents";
import { createEscrowService, type EscrowService, type JunoBackendRuntime } from "./escrowService";
import type { WalletControlProof, WalletControlProofs } from "./escrowPorts";
import { junoJoinAdmissionSigner, type JoinAdmissionSigner } from "./juno/joinAdmission";
import { joinAdmissionDigestV1 } from "../../../frontend/src/gameEngine/escrow/junoJoinAdmissionV1";
import { createMemoryFinancialGameStore, type FinancialGameStore } from "./financialGameStore";
import { createMemorySigningJournal, type InspectableSigningJournal } from "./signingJournal";
import { serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
import { createMemoryWalletTicketStore, createWalletTicketLedger, type WalletTicketStore } from "./walletTickets";
import { addressOfPublicKey } from "./juno/cosmosTx";
import { FakeJunoChain } from "./juno/fakeJunoChain";
import { DEFAULT_GAS_POLICY } from "./juno/gasPolicy";
import { createJunoRelayer, type Relayer, type RelayerAuthority } from "./juno/relayer";
import { publicKeyOf, signDigest } from "./juno/secp256k1";
import { developmentDigestSigner, junoSettlementSigner, type DigestSigner } from "./juno/signer";
import type { SettlementKeyConfig } from "./escrowPorts";
import type { FinancialDeploymentPin } from "./moneyLifecycle";

export const GAME_A = "g_0000000000000000000000000w";
export const GAME_B = "g_000000000000000000000000cw";
export const CHAIN_ID = "uni-7";
/** The canonical escrow 2.0.0 wasm (ESCROW-JOIN), pinned here independently of `junoConfig.ts`. */
export const CANONICAL_CHECKSUM = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8";
/** The historical escrow 1.0.0 artifact (ESCROW-B2): its Join seated any payer; configuration refuses it by name. */
export const HISTORICAL_1_0_0_CHECKSUM = "b263277aa5d1d63c33e8e238f27ad2b9ee4749c9a66abe82ef3146d51d119296";
export const T0 = 1_760_000_000_000;

const sha = (label: string) => createHash("sha256").update(label).digest();
const GUARD = { serverMode: "development" as const, networkClass: "testnet" as const, chainId: CHAIN_ID, acknowledged: true };

export const SETTLEMENT_SECRET = sha("18JUNO/TEST/signer/1");
/** The join-admission key: the frozen vectors' `18JUNO/TEST/admission/1` (so the fixtures and the vectors agree). */
export const ADMISSION_SECRET = sha("18JUNO/TEST/admission/1");
export const ADMISSION_PUBKEY = publicKeyOf(ADMISSION_SECRET).toString("hex");
export const ADMISSION_TTL_SECS = 600;
export const RELAYER_SECRET = sha("18COSMOS/TEST/relayer");
export const RELAYER_ADDRESS = addressOfPublicKey(publicKeyOf(RELAYER_SECRET), "juno");
export const CONTRACT = addressOfPublicKey(publicKeyOf(sha("contract")), "juno");
export const WALLETS = [addressOfPublicKey(publicKeyOf(sha("wallet-0")), "juno"), addressOfPublicKey(publicKeyOf(sha("wallet-1")), "juno"), addressOfPublicKey(publicKeyOf(sha("wallet-2")), "juno")];
export const CONSENT_KEYS = [publicKeyOf(sha("consent-0")).toString("hex"), publicKeyOf(sha("consent-1")).toString("hex"), publicKeyOf(sha("consent-2")).toString("hex")];
export const VARIANTS = { ...(SETUP.SetupGame.variants as object) } as GameVariants;

export const PIN: FinancialDeploymentPin = Object.freeze({
  backend: "juno-cosmwasm",
  codec: "18JUNO/v1",
  chain_id: CHAIN_ID,
  network_class: "testnet",
  contract_address: CONTRACT,
  code_checksum: CANONICAL_CHECKSUM,
  denom: "ujunox",
});

export interface World {
  readonly chain: FakeJunoChain;
  readonly financial: FinancialGameStore;
  readonly intents: ChainIntentStore;
  readonly journal: InspectableSigningJournal;
  readonly tickets: WalletTicketStore;
  readonly ledger: ReturnType<typeof createWalletTicketLedger>;
  readonly ops: ReturnType<typeof createMemoryOpsRecorder>;
  readonly logs: Map<string, ServerLogEntry[]>;
  /** LIVE-4 (L4-4): the escrow deployment the (next) process is configured for; a test reconfigures it before a
   *  `restart` (another contract, a mistyped denom). The fake chain itself is unchanged. */
  pin: FinancialDeploymentPin;
  service: EscrowService;
  relayer: Relayer;
  clock: { now: number };
  warnings: string[];
  replay: PrefixReplay;
  /** ESCROW-JOIN: the wallet-control proofs per (game, player, principal) -- what ESCROW-4 will record (tests set them). */
  readonly proofs: Map<string, WalletControlProof>;
  /** ESCROW-JOIN: identity's verdict on every ticket's security context (tests end it). */
  standing: "standing" | "ended";
  /** LIVE-4 (L4-4): games whose durable log cannot be read at all right now (an I/O fault, not damage): tests set them. */
  readonly logFaults: Set<string>;
  /** LIVE-6 L6-2: the next (re)build's post-restore safe mode (a test sets it before a `restart`). */
  restoreSafeMode: boolean;
  /** Rebuild the service and the relayer over the same durable stores (a process restart); the load's summary. */
  restart(): Promise<{ readonly games: number; readonly held: number; readonly resumed: number; readonly skipped: number }>;
  /** Relayer passes, blocks and service jobs until `done()` or `max` rounds. */
  drive(done: () => boolean | Promise<boolean>, max?: number, blocks?: boolean): Promise<number>;
}

export interface WorldOptions {
  readonly financial?: FinancialGameStore;
  readonly intents?: ChainIntentStore;
  readonly journal?: InspectableSigningJournal;
  readonly tickets?: WalletTicketStore;
  readonly replay?: PrefixReplay;
  readonly signerKeys?: readonly string[];
  readonly timeoutBlocks?: number;
  readonly challengeWindowSecs?: number;
  /** ESCROW-JOIN: build the service without an admission signer (production before LIVE-5 wires KMS). */
  readonly noAdmissionSigner?: boolean;
  /** ESCROW-JOIN: wrap the admission signer (tests observe what it is asked to sign, and when). */
  readonly wrapAdmissionSigner?: (signer: JoinAdmissionSigner) => JoinAdmissionSigner;
  /** LIVE-4 (L4-4): the escrow deployment this process is configured for (default `PIN`). */
  readonly pin?: FinancialDeploymentPin;
  /** LIVE-4 (L4-4): an injected creation identity and deployment (ESCROW-3A's seam; an uncertified or unserved bump). */
  readonly continuation?: Parameters<typeof createEscrowService>[0]["continuation"];
  /** LIVE-5 L5-5: wrap the settlement / relayer key (tests make a KMS answer go missing after the signature was made). */
  readonly wrapSettlementKey?: (signer: DigestSigner) => DigestSigner;
  readonly wrapRelayerKey?: (signer: DigestSigner) => DigestSigner;
  /** LIVE-5 L5-6: per process (every `build`, so a `restart` is a new task): the relayer's own journal, its view of the
   *  intents and its role -- a takeover test gives the old and the new task different ones. */
  readonly relayerSeam?: () => { readonly journal?: InspectableSigningJournal; readonly store?: ChainIntentStore; readonly authority?: RelayerAuthority };
  /** LIVE-6 L6-7: the relayer's page threshold, queue refresh interval and failure budget (defaults: the relayer's).
   *  JX-2B: and its rebroadcast spacing (default here 1 s; production's is 30 s). */
  readonly relayerTuning?: { readonly pageAfterMs?: number; readonly queueRefreshMs?: number; readonly failureBudget?: number; readonly rebroadcastMs?: number };
  /** LIVE-6 L6-7: the money games the service's load and chain sweep visit (AWS: the open-money-game index). */
  readonly openGames?: () => Promise<string[]>;
}

export const proofKey = (gameId: string, playerId: string, principalId: string) => `${gameId}|${playerId}|${principalId}`;

/** A wallet-control proof as ESCROW-4's verifier would record it (tests only). */
export function proofFor(gameId: string, playerId: string, principalId: string, wallet: string, verifiedAt: number = T0): WalletControlProof {
  return { kind: "adr036", game_id: gameId, player_id: playerId, principal_id: principalId, wallet, challenge_digest: "5a".repeat(32), verified_at: verifiedAt };
}

export function settlementKeyConfig(): SettlementKeyConfig {
  return { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT, signer_key_id: 1, scheme: "secp256k1-ecdsa-prehashed/rs64-low-s", kms_key_ref: "development:settlement", public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), role: "active" };
}

export function makeWorld(options: WorldOptions = {}): World {
  const chain = new FakeJunoChain({
    chainId: CHAIN_ID,
    contract: CONTRACT,
    operator: RELAYER_ADDRESS,
    resolver: "juno1resolver",
    treasury: "juno1treasury",
    denom: "ujunox",
    admin: null,
    codeId: "4242",
    codeChecksum: CANONICAL_CHECKSUM,
    signerKeys: options.signerKeys ?? [publicKeyOf(SETTLEMENT_SECRET).toString("hex")],
    admissionPubkey: ADMISSION_PUBKEY,
    challengeWindowSecs: options.challengeWindowSecs ?? 60,
  });
  chain.fund(RELAYER_ADDRESS, BigInt(10_000_000));
  const clock = { now: T0 };
  const financial = options.financial ?? createMemoryFinancialGameStore();
  const intents = options.intents ?? createMemoryChainIntentStore();
  const journal = options.journal ?? createMemorySigningJournal(() => clock.now);
  const tickets = options.tickets ?? createMemoryWalletTicketStore();
  const standingOf = () => (world.standing === "ended" ? ({ kind: "ended", why: "family" } as const) : ({ kind: "standing" } as const));
  const ledger = createWalletTicketLedger({ store: tickets, standing: () => standingOf(), holdsSeat: () => true, now: () => clock.now, random: (size) => Buffer.alloc(size, 7) });
  const ops = createMemoryOpsRecorder();
  const logs = new Map<string, ServerLogEntry[]>();
  const warnings: string[] = [];
  const replay = options.replay ?? serverPrefixReplay(BUILD);
  const proofs = new Map<string, WalletControlProof>();
  const walletProofs: WalletControlProofs = { proofOf: async (input) => proofs.get(proofKey(input.gameId, input.playerId, input.principalId)) ?? null };

  const world = {
    chain,
    financial,
    intents,
    journal,
    tickets,
    ledger,
    ops,
    logs,
    clock,
    warnings,
    replay,
    proofs,
    standing: "standing",
    pin: options.pin ?? PIN,
    logFaults: new Set<string>(),
    restoreSafeMode: false,
  } as unknown as World;

  function build(): void {
    const settlementSigner: DigestSigner = (options.wrapSettlementKey ?? ((signer) => signer))(developmentDigestSigner(SETTLEMENT_SECRET, "settlement", GUARD));
    const relayerSigner: DigestSigner = (options.wrapRelayerKey ?? ((signer) => signer))(developmentDigestSigner(RELAYER_SECRET, "relayer", GUARD));
    const pin = world.pin;
    const backend: JunoBackendRuntime = {
      pin,
      symbol: "JUNOX",
      policy: [{ backend: "juno-cosmwasm", chain_id: pin.chain_id, network_class: pin.network_class, deployments: [{ kind: "juno-cosmwasm", contract_address: pin.contract_address, code_checksums: [pin.code_checksum], admin: null }] }],
      trust: { operators: [RELAYER_ADDRESS], resolvers: ["juno1resolver"], min_challenge_window_secs: BigInt(1), min_liveness_window_secs: BigInt(1), min_resolver_timeout_secs: BigInt(1) },
      rest: chain,
      settlementKeys: [settlementKeyConfig()],
      settlementSigner: junoSettlementSigner(settlementKeyConfig(), JUNO_CODEC_V1, settlementSigner, journal),
    };
    let relayer: Relayer | null = null;
    const service = createEscrowService({
      backend,
      financial,
      intents,
      journal,
      relayer: () => relayer,
      tickets: ledger,
      readLog: async (gameId) => {
        if (world.logFaults.has(gameId)) throw new Error(`EMFILE: the log of ${gameId} cannot be read right now`);
        return logs.get(gameId) ?? [];
      },
      replay: world.replay,
      now: () => clock.now,
      warn: (line) => warnings.push(line),
      ops,
      admission: options.noAdmissionSigner
        ? undefined
        : { signer: (options.wrapAdmissionSigner ?? ((signer) => signer))(junoJoinAdmissionSigner(ADMISSION_PUBKEY, JUNO_CODEC_V1, developmentDigestSigner(ADMISSION_SECRET, "admission", GUARD))), ttlSecs: ADMISSION_TTL_SECS },
      walletProofs,
      ...(world.restoreSafeMode ? { restoreSafeMode: true } : {}),
      ...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
      ...(options.openGames !== undefined ? { openGames: options.openGames } : {}),
    });
    const seam = options.relayerSeam?.() ?? {};
    relayer = createJunoRelayer({
      rest: chain,
      store: seam.store ?? intents,
      journal: seam.journal ?? journal,
      ...(seam.authority !== undefined ? { authority: seam.authority } : {}),
      account: { address: RELAYER_ADDRESS, signer: relayerSigner },
      chainId: pin.chain_id,
      contract: pin.contract_address,
      gas: { ...DEFAULT_GAS_POLICY, feeDenom: "ujunox" },
      timeoutBlocks: options.timeoutBlocks ?? 5,
      now: () => clock.now,
      warn: (line) => warnings.push(line),
      ops,
      onResolved: (intent) => service.onIntentResolved(intent),
      admit: (intent) => service.admit(intent),
      classify: (intent) => service.classifyIntent(intent),
      pollMs: 1_000,
      rebroadcastMs: 1_000,
      schedule: () => ({ cancel: () => undefined }), // tests drive passes by hand
      ...(options.relayerTuning ?? {}),
    });
    world.service = service;
    world.relayer = relayer;
  }
  build();

  world.restart = async () => {
    world.relayer.stop();
    build();
    await world.service.preload();
    /* As `junoBackend` does at verification (L4-4): the deployment's chain facts, at verification grade, then the load. */
    await world.service.refreshChainFacts();
    return world.service.load();
  };

  world.drive = async (done, max = 40, blocks = true) => {
    for (let round = 0; round < max; round += 1) {
      await world.service.idle();
      if (await done()) return round;
      await world.relayer.pass();
      await world.service.idle();
      if (await done()) return round;
      if (blocks) chain.produceBlock();
      clock.now += 6_000;
    }
    throw new Error(`the world did not settle within ${max} rounds (relayer: ${JSON.stringify(world.relayer.status())}; warnings: ${warnings.slice(-5).join(" | ")})`);
  };
  return world;
}

/** Issues the seats' tickets through the real ledger, then has their wallets fund the chain game with exactly them. */
export async function fundedGame(world: World, gameId: string, players: readonly string[] = [ALICE, BOB]): Promise<string> {
  const tickets: string[] = [];
  for (let i = 0; i < players.length; i += 1) {
    const issued = await world.ledger.issue({
      binding: { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT },
      gameId,
      playerId: players[i],
      wallet: WALLETS[i],
      context: { principalId: `pr_${i}`, familyId: `sf_${i}`, recoverySelector: `rk_${i}` },
      reauthorized: true,
    });
    if (!issued.ok) throw new Error(`ticket for ${players[i]}: ${issued.refusal}`);
    tickets.push(issued.ticket);
  }
  return world.chain.seedFundedGame({
    seats: players.map((_, i) => ({ wallet: WALLETS[i], consent_pubkey: CONSENT_KEYS[i], join_ticket: tickets[i] })),
    anteGross: "1010000",
    anteNet: "1000000",
    rulesEngineVersion: RULES_ENGINE_VERSION,
    variantsDigest: variantsDigestV1(VARIANTS),
  });
}

/** create -> bind -> freeze + Start -> Start on chain. Returns the chain game id. */
export async function startedGame(world: World, gameId: string = GAME_A): Promise<string> {
  const created = await world.service.createMoneyGame(gameId);
  if (!created.ok) throw new Error(`create: ${created.detail}`);
  const chainGameId = await fundedGame(world, gameId);
  const bound = await world.service.bindChainGame(gameId, chainGameId, VARIANTS);
  if (!bound.ok) throw new Error(`bind: ${bound.detail}`);
  const started = await world.service.requestStart(gameId, [{ player_id: ALICE }, { player_id: BOB }]);
  if (!started.ok) throw new Error(`start: ${started.code} ${started.detail}`);
  await world.drive(async () => (await world.financial.load(gameId))?.chain.started !== null);
  return chainGameId;
}

const buysMade = new WeakMap<RoomSession, number>();

/** A played game: the deal and `buys` purchases (the seat on turn buys the cheapest private, alternating as
 *  `storedLog` does), committed one batch at a time through the service's seam. */
export function play(world: World, gameId: string, buys: number, session: RoomSession = probeSession(`money-${gameId}`)): RoomSession {
  if (session.entries.length === 0) {
    session.submit({ actor: ALICE, build: BUILD, msg: SETUP as never, baseIndex: -1, submissionId: `${gameId}-deal` });
    commit(world, gameId, session);
  }
  for (let n = 0; n < buys; n += 1) {
    const made = buysMade.get(session) ?? 0;
    const seat = session.state.player_addresses[made % 2];
    const result = session.submit({ actor: seat, build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: `${gameId}-buy-${made}` });
    if (result.kind !== "applied") throw new Error(`buy ${made} was ${result.kind}`);
    buysMade.set(session, made + 1);
    commit(world, gameId, session);
  }
  return session;
}

/** One move by `actor`, committed as one batch. */
export function move(world: World, gameId: string, session: RoomSession, actor: string, msg: object): void {
  const result = session.submit({ actor, build: BUILD, msg: msg as never, baseIndex: session.nextIndex - 1, submissionId: `${gameId}-${session.entries.length}-${actor}` });
  if (result.kind !== "applied") throw new Error(`${Object.keys(msg)[0]} by ${actor} was ${result.kind}: ${(result as { reason?: string }).reason ?? ""}`);
  commit(world, gameId, session);
}

/** From the deal to the first Stock Round: every private bought, the B&O parred by its owner, the round opened. */
export function toStockRound(world: World, gameId: string, session: RoomSession): void {
  while (session.state.private_companies.some((p) => p.owner === null || p.owner === undefined)) play(world, gameId, 1, session);
  const bo = session.state.private_companies.find((p) => p.private_id === 6);
  if (bo?.owner) move(world, gameId, session, bo.owner, { SetBoPar: { player: bo.owner, par_value: "100" } });
  move(world, gameId, session, ALICE, { OpenStockRound: {} });
}

/** A whole Stock Round of passes (no railroad floats, so its empty Operating Rounds pass at once): one boundary. */
export function passRound(world: World, gameId: string, session: RoomSession): void {
  move(world, gameId, session, ALICE, PASS);
  move(world, gameId, session, BOB, PASS);
}

export function commit(world: World, gameId: string, session: RoomSession): void {
  const entries = Object.freeze(session.entries.map((entry) => Object.freeze({ ...entry }))) as readonly ServerLogEntry[];
  world.logs.set(gameId, [...entries]);
  world.service.onGameplayCommitted({ gameId, entries, board: session.state as GameStateResponse });
}

export const joinTicketFor = joinTicketV1;

/** A correct server's admission for `wallet` (signed directly with the test key; `authorizeJoin` is tested on its own). */
export function admissionFor(world: World, chainGameId: string, wallet: string, joinTicket: string, expiresAt: number = world.chain.time + ADMISSION_TTL_SECS): { expires_at: string; signature: string } {
  const digest = joinAdmissionDigestV1({ chain_id: CHAIN_ID, contract_addr: CONTRACT, chain_game_id: BigInt(chainGameId), wallet, join_ticket: joinTicket, expires_at: BigInt(expiresAt) });
  return { expires_at: String(expiresAt), signature: signDigest(ADMISSION_SECRET, Buffer.from(digest, "hex")).toString("hex") };
}
