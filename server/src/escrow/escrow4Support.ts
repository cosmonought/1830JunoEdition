// server/src/escrow/escrow4Support.ts
//
// ESCROW-4 test support (never imported by production code): a PRODUCTION-identity game server (cookies, profiles,
// "Confirm it's you") with the whole money stack -- the real ledger bound to the real identity service and room
// records, the real escrow service and relayer over the offline Juno (`juno/fakeJunoChain.ts`), and the real money
// layer (`moneyTables.ts`) with its HTTP routes -- plus wallets that sign ADR-036 exactly as Keplr does and consent keys
// that sign as the browser does.

import { createHash } from "crypto";

import { adr036SignDocJson, parseWalletLinkChallenge } from "../../../frontend/src/gameEngine/escrow/walletLinkChallengeV1";
import { JUNO_CODEC_V1 } from "../../../frontend/src/gameEngine/escrow/junoCodecV1";
import { variantsDigestV1 } from "../../../frontend/src/gameEngine/escrow/variantsDigest";
import { resolveVariants } from "../../../frontend/src/gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { annulDigestV1, consentDigestV1 } from "../../../frontend/src/gameEngine/settlementPayload";
import { createMemoryIdentityStore } from "../identity/store";
import { IdentityService } from "../identity/sessions";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import { seatOf } from "../rooms/gameRecord";
import { NoMoneyRosterSource } from "../rooms/roomService";
import { accountBrowser, apiRequest, Client, IN_SEAT_ORDER, profiledBrowser, PROD_ORIGIN, startServer, type ApiAnswer, type Frame, type ProfiledBrowser } from "../rooms/testSupport";
import { createMemoryChainIntentStore } from "./chainIntents";
import { createEscrowService, type EscrowService, type JunoBackendRuntime } from "./escrowService";
import { createMemoryFinancialGameStore } from "./financialGameStore";
import { createMoneyTables, type MoneyTables } from "./moneyTables";
import { createSettlementCoordinator } from "./settlementCoordinator";
import type { DeploymentCapability } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import type { LogStore } from "../fileLogStore";
import { createMemorySigningJournal } from "./signingJournal";
import { createMemoryWalletTicketStore, createWalletTicketLedger } from "./walletTickets";
import { addressOfPublicKey } from "./juno/cosmosTx";
import { FakeJunoChain } from "./juno/fakeJunoChain";
import { DEFAULT_GAS_POLICY } from "./juno/gasPolicy";
import { junoJoinAdmissionSigner } from "./juno/joinAdmission";
import { createJunoRelayer, type Relayer } from "./juno/relayer";
import { publicKeyOf, signDigest } from "./juno/secp256k1";
import { developmentDigestSigner, junoSettlementSigner } from "./juno/signer";
import { ADMISSION_PUBKEY, ADMISSION_SECRET, ADMISSION_TTL_SECS, CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, PIN, RELAYER_ADDRESS, RELAYER_SECRET, SETTLEMENT_SECRET, settlementKeyConfig, T0 } from "./escrow3bSupport";

const sha = (label: string) => createHash("sha256").update(label).digest();
const GUARD = { serverMode: "development" as const, networkClass: "testnet" as const, chainId: CHAIN_ID, acknowledged: true };

/** A Keplr account: its key, its address, and an ADR-036 signer exactly as `signArbitrary` signs. */
export interface TestWallet {
  readonly secret: Buffer;
  readonly pubkey: Buffer;
  readonly address: string;
  /** `signArbitrary(chain, address, text)`: {pub_key.value, signature} (base64). */
  signArbitrary(text: string, signer?: string): { readonly pubKey: string; readonly signature: string };
}

export function testWallet(label: string): TestWallet {
  const secret = sha(`18COSMOS/TEST/wallet/${label}`);
  const pubkey = publicKeyOf(secret);
  const address = addressOfPublicKey(pubkey, "juno");
  return {
    secret,
    pubkey,
    address,
    signArbitrary(text, signer = address) {
      const digest = createHash("sha256").update(Buffer.from(adr036SignDocJson(signer, text), "utf8")).digest();
      return { pubKey: pubkey.toString("base64"), signature: signDigest(secret, digest).toString("base64") };
    },
  };
}

/** A browser-held consent key: its public key, and CONSENT / ANNUL signatures as the browser makes them. */
export interface TestConsentKey {
  readonly secret: Buffer;
  readonly pubkey: string;
  consent(domain: string, seq: string, settleDigest: string): string;
  annul(domain: string, trustedSeq: string): string;
}

export function testConsentKey(label: string): TestConsentKey {
  const secret = sha(`18COSMOS/TEST/consent/${label}`);
  return {
    secret,
    pubkey: publicKeyOf(secret).toString("hex"),
    consent: (domain, seq, settleDigest) => signDigest(secret, Buffer.from(consentDigestV1(domain, BigInt(seq), settleDigest), "hex")).toString("hex"),
    annul: (domain, trustedSeq) => signDigest(secret, Buffer.from(annulDigestV1(domain, BigInt(trustedSeq)), "hex")).toString("hex"),
  };
}

export interface MoneyServer {
  readonly port: number;
  readonly server: Awaited<ReturnType<typeof startServer>>["server"];
  readonly chain: FakeJunoChain;
  readonly identity: IdentityService;
  readonly service: EscrowService;
  readonly relayer: Relayer;
  readonly money: MoneyTables;
  readonly ledger: ReturnType<typeof createWalletTicketLedger>;
  /** JX-3B: the ledger's store and identity's durable store (the evidence tooling reads them as a data directory would). */
  readonly ticketStore: ReturnType<typeof createMemoryWalletTicketStore>;
  readonly identityStore: ReturnType<typeof createMemoryIdentityStore>;
  readonly financial: ReturnType<typeof createMemoryFinancialGameStore>;
  readonly intents: ReturnType<typeof createMemoryChainIntentStore>;
  /** JX-4B: the signing journal (the evidence tooling projects its attempts as the ledger's ATTI# / TXID# items). */
  readonly journal: ReturnType<typeof createMemorySigningJournal>;
  readonly ops: ReturnType<typeof createMemoryOpsRecorder>;
  readonly clock: { now: number };
  readonly warnings: string[];
  /** Advance the clocks (server ms and chain seconds together). */
  advance(ms: number): void;
  /** Relayer passes, blocks and money refreshes until `done()`. */
  drive(done: () => boolean | Promise<boolean>, max?: number): Promise<void>;
  /** One observation of every money table, awaited. */
  observe(): Promise<void>;
  close(): Promise<void>;
}

export interface MoneyServerOptions {
  readonly enabled?: boolean;
  readonly pin?: typeof PIN;
  readonly minAnte?: string;
  readonly fundingPeriodSecs?: number;
  /** LIVE-4 amendment §4: an injected creation identity and deployment (an uncertified rules bump). */
  readonly continuation?: Parameters<typeof createEscrowService>[0]["continuation"];
  /** LIVE-4 (L4-2): this pool's deployment capability. Absent: this build's, serving the fixture pin. */
  readonly capability?: DeploymentCapability;
  /** LIVE-4 (L4-7): the game server's log store (a controlled store, so a test can hold an append). Absent: in memory. */
  readonly store?: LogStore;
  /** JX-4B: the contract's resolver (a bech32 address when a test parses a production configuration naming it). */
  readonly resolver?: string;
  /** PHASE 3 FINAL (§13): the room host's free-table switch -- `false` is every production entry point's (no-ante tables
   *  are refused); absent: the internal default (free tables allowed, for the historical fixtures). */
  readonly freeTables?: boolean;
}

export async function moneyServer(options: MoneyServerOptions = {}): Promise<MoneyServer> {
  const clock = { now: T0 };
  const warnings: string[] = [];
  const identityStore = createMemoryIdentityStore();
  /* P3-ACCT: a cheap password KDF for the test world (production's is `DEFAULT_PASSWORD_KDF`). */
  const identity = IdentityService.fromSnapshot(identityStore, { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
  const chain = new FakeJunoChain({
    chainId: CHAIN_ID,
    contract: CONTRACT,
    operator: RELAYER_ADDRESS,
    resolver: options.resolver ?? "juno1resolver",
    treasury: "juno1treasury",
    denom: "ujunox",
    admin: null,
    codeId: "4242",
    codeChecksum: CANONICAL_CHECKSUM,
    signerKeys: [publicKeyOf(SETTLEMENT_SECRET).toString("hex")],
    admissionPubkey: ADMISSION_PUBKEY,
    challengeWindowSecs: 60,
    startTime: Math.floor(T0 / 1000),
    subsidyBps: 100,
    minAnte: options.minAnte ?? "1000",
    fundingPeriodSecs: options.fundingPeriodSecs ?? 3600,
  });
  chain.fund(RELAYER_ADDRESS, BigInt(10_000_000));
  const financial = createMemoryFinancialGameStore();
  const intents = createMemoryChainIntentStore();
  const journal = createMemorySigningJournal(() => clock.now);
  const tickets = createMemoryWalletTicketStore();
  const ops = createMemoryOpsRecorder();
  const refs: { server: MoneyServer["server"] | null; money: MoneyTables | null } = { server: null, money: null };
  const ledger = createWalletTicketLedger({
    store: tickets,
    standing: (context) => identity.securityStanding(context),
    holdsSeat: (gameId, principalId, playerId) => {
      const record = refs.server?.rooms.moneyPort.recordOf(gameId) ?? null;
      return record !== null && seatOf(record, principalId)?.player_id === playerId;
    },
    now: () => clock.now,
  });
  const backend: JunoBackendRuntime = {
    pin: options.pin ?? PIN,
    symbol: "JUNOX",
    policy: [{ backend: "juno-cosmwasm", chain_id: CHAIN_ID, network_class: "testnet", deployments: [{ kind: "juno-cosmwasm", contract_address: CONTRACT, code_checksums: [CANONICAL_CHECKSUM], admin: null }] }],
    trust: { operators: [RELAYER_ADDRESS], resolvers: [options.resolver ?? "juno1resolver"], min_challenge_window_secs: BigInt(1), min_liveness_window_secs: BigInt(1), min_resolver_timeout_secs: BigInt(1) },
    rest: chain,
    settlementKeys: [settlementKeyConfig()],
    settlementSigner: junoSettlementSigner(settlementKeyConfig(), JUNO_CODEC_V1, developmentDigestSigner(SETTLEMENT_SECRET, "settlement", GUARD), journal),
  };
  let relayer: Relayer | null = null;
  const service = createEscrowService({
    backend,
    financial,
    intents,
    journal,
    relayer: () => relayer,
    tickets: ledger,
    readLog: async () => [],
    replay: () => ({ ok: false, reason: "not used" }),
    now: () => clock.now,
    warn: (line) => warnings.push(line),
    ops,
    admission: { signer: junoJoinAdmissionSigner(ADMISSION_PUBKEY, JUNO_CODEC_V1, developmentDigestSigner(ADMISSION_SECRET, "admission", GUARD)), ttlSecs: ADMISSION_TTL_SECS },
    walletProofs: ledger,
    ...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
  });
  relayer = createJunoRelayer({
    rest: chain,
    store: intents,
    journal,
    account: { address: RELAYER_ADDRESS, signer: developmentDigestSigner(RELAYER_SECRET, "relayer", GUARD) },
    chainId: CHAIN_ID,
    contract: CONTRACT,
    gas: { ...DEFAULT_GAS_POLICY, feeDenom: "ujunox" },
    timeoutBlocks: 5,
    now: () => clock.now,
    warn: (line) => warnings.push(line),
    ops,
    onResolved: (intent) => service.onIntentResolved(intent),
    admit: (intent) => service.admit(intent),
    classify: (intent) => service.classifyIntent(intent),
    pollMs: 1_000,
    rebroadcastMs: 1_000,
    schedule: () => ({ cancel: () => undefined }),
  });
  /* As `junoBackend` does at verification (L4-4): the deployment's chain-attested facts, at verification grade (money
     creation requires them). */
  await service.refreshChainFacts();
  const noMoney = new NoMoneyRosterSource();
  identity.setHooks({
    onSecurityEvent: (event) => {
      void ledger
        .gamesOfPrincipal(event.principalId)
        .then(async (games) => {
          /* As `start.ts` (L4-4): only a game this server continues is written. */
          for (const gameId of games) if ((await service.servingDecision(gameId, { where: "security event" })).verdict.kind === "continues") await ledger.revokeForSecurityEvent(gameId);
        })
        .catch(() => undefined)
        .finally(() => refs.money?.onSecurityEvent(event.principalId));
    },
  });
  /* LIVE-4 (L4-2): the money facts' index over the same financial store the escrow service writes (the production
     server's is its settlement coordinator; here one serves as the index only -- it is not the settlement lifecycle).
     LIVE-4 (integration, D): it stays an INDEX. It is given no serving, so its step -1 runs on `noMoneyServing` -- a pool
     that serves no escrow deployment, owns no game and continues none -- and it is never the server's `settlement`, so
     nothing announces a seal to it: through L4-4's coordinator it still writes no financial state. */
  const moneyFacts = createSettlementCoordinator({ store: financial, replay: () => ({ ok: false, reason: "not used" }), now: () => clock.now, warn: (line) => warnings.push(line), schedule: () => ({ cancel: () => undefined }) });
  await moneyFacts.load();
  const started = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service: identity },
    shuffle: IN_SEAT_ORDER,
    /* LIVE-4 (L4-2): this pool serves the fixture escrow (the pin its money tables are bound to). LIVE-4 (integration):
       as `start.ts` does, the ONE capability is the money serving's own, and the sessions read the same runtime chain
       facts the escrow service records (a test may still inject another capability for the session side). */
    capability: options.capability ?? service.serving.capability,
    runtime: service.serving.runtime(),
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.freeTables !== undefined ? { freeTables: options.freeTables } : {}),
    moneyFacts,
    rosterSource: { plan: (record, ctx) => (record.money === null ? noMoney.plan(record, ctx) : service.rosterSource.plan(record, ctx)) },
    money: () => refs.money,
    escrow: { onGameplayCommitted: (input) => service.onGameplayCommitted(input), isRosterFrozen: (gameId) => service.isRosterFrozen(gameId) },
  });
  refs.server = started.server;
  /* As `start.ts` (LIVE-4 integration): when the chain facts every verdict reads change, every resident game's
     verdict is asked again at once -- a verified contradiction stops its session here too. */
  service.serving.onChainFacts(() => {
    void started.server.lifecycle.reviewContinuation().catch(() => undefined);
  });
  const money = createMoneyTables(
    { enabled: options.enabled ?? true, service, pin: options.pin ?? PIN, symbol: "JUNOX", rest: chain, tickets: ledger, financial, appName: "Project 18XX", now: () => clock.now, warn: (line) => warnings.push(line), ops, manualObserver: true },
    started.server.rooms.moneyPort,
  );
  refs.money = money;
  await started.server.lifecycle.ready;

  const world: MoneyServer = {
    port: started.port,
    server: started.server,
    chain,
    identity,
    service,
    relayer,
    money,
    ledger,
    ticketStore: tickets,
    identityStore,
    financial,
    intents,
    journal,
    ops,
    clock,
    warnings,
    advance(ms) {
      clock.now += ms;
      chain.time = Math.floor(clock.now / 1000);
    },
    async observe() {
      for (const record of started.server.rooms.moneyPort.moneyRecords()) await money.refresh(record.game_id);
      await service.idle();
      await money.idle();
    },
    async drive(done, max = 30) {
      for (let round = 0; round < max; round += 1) {
        await service.idle();
        await money.idle();
        if (await done()) return;
        await (relayer as Relayer).pass();
        await service.idle();
        await world.observe();
        if (await done()) return;
        chain.produceBlock(0);
        chain.height += 0;
        world.advance(6_000);
      }
      throw new Error(`the money world did not settle (relayer ${JSON.stringify((relayer as Relayer).status())}; warnings ${warnings.slice(-5).join(" | ")})`);
    },
    async close() {
      money.stop();
      (relayer as Relayer).stop();
      await started.server.close();
    },
  };
  return world;
}

/* ------------------------------------------------------------------ */
/* Players: a profiled browser, its socket, and its money requests      */
/* ------------------------------------------------------------------ */

export interface Player {
  readonly browser: ProfiledBrowser;
  readonly client: Client;
  readonly name: string;
  api(route: string, body?: object): Promise<ApiAnswer>;
  confirm(): Promise<void>;
}

/** P3-ACCT: the cheap scrypt parameters test worlds use (the stored hash carries them; production makes N=2^15, p=3). */
export const TEST_PASSWORD_KDF = Object.freeze({ logN: 10, r: 1, p: 1 });

/** P3-ACCT: a USERNAME/PASSWORD account player -- "Confirm it's you" is its password. */
export async function accountPlayer(world: MoneyServer, name: string, password = "correct horse battery"): Promise<Player> {
  const account = await accountBrowser(world.port, name, password);
  const client = await Client.openWithCookie(world.port, account.cookie, name);
  return {
    browser: { cookie: account.cookie, name: account.name, username: account.username, password: account.password, wallet: account.wallet },
    client,
    name,
    api: (route, body = {}) => apiRequest(world.port, `/gs/api/money/${route}`, { cookie: account.cookie, body }),
    async confirm() {
      const answer = await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: account.cookie, body: { password } });
      if (answer.status !== 200) throw new Error(`reauth: ${answer.status} ${answer.text}`);
    },
  };
}

/** A player: an account (username, password, Authorization Wallet) on its own browser. "Confirm it's you" is its
 *  password (PHASE 3 FINAL: no recovery key exists). */
export async function player(world: MoneyServer, name: string): Promise<Player> {
  const browser = await profiledBrowser(world.port, name);
  const client = await Client.openWithCookie(world.port, browser.cookie, name);
  return {
    browser,
    client,
    name,
    api: (route, body = {}) => apiRequest(world.port, `/gs/api/money/${route}`, { cookie: browser.cookie, body }),
    async confirm() {
      const answer = await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: browser.cookie, body: { password: browser.password } });
      if (answer.status !== 200) throw new Error(`reauth: ${answer.status} ${answer.text}`);
    },
  };
}

/** The newest `room` view this client received for `gameId` (after asking for one). */
export async function viewOf(client: Client, gameId: string): Promise<Record<string, unknown>> {
  const before = client.frames.length;
  client.roomHello(gameId);
  await client.next((frame: Frame) => frame.kind === "room" && frame.gameId === gameId && client.frames.indexOf(frame) >= before, "a room view");
  const views = client.frames.filter((frame) => frame.kind === "room" && frame.gameId === gameId);
  return views[views.length - 1].view as Record<string, unknown>;
}

export const STAKE = "1000000";

/** The host opens a real-money table for `seats` players. */
export async function openMoneyTable(host: Player, seats = 2, over: Record<string, unknown> = {}): Promise<{ gameId: string; code: string; playerId: string }> {
  const created = await host.client.op({ type: "create", visibility: "public", exactPlayers: seats, variants: {}, nickname: host.name, stake: STAKE, ...over });
  if (created.ok !== true) throw new Error(`create refused: ${JSON.stringify(created)}`);
  return created.data as { gameId: string; code: string; playerId: string };
}

/** The whole wallet link: Confirm it's you, the challenge, the wallet's ADR-036 signature, the link. */
export async function linkWallet(who: Player, gameId: string, wallet: TestWallet, consentKey: TestConsentKey, over: { replace?: boolean; confirm?: boolean } = {}): Promise<ApiAnswer> {
  if (over.confirm !== false) await who.confirm();
  const challenge = await who.api("wallet-challenge", { gameId, wallet: wallet.address });
  if (challenge.status !== 200) return challenge;
  const text = challenge.body?.text as string;
  if (parseWalletLinkChallenge(text) === null) throw new Error("the challenge text does not parse");
  const signed = wallet.signArbitrary(text);
  return who.api("wallet-link", { gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: consentKey.pubkey, ...(over.replace !== undefined ? { replace: over.replace } : {}) });
}

/** The host's CreateGame on chain, exactly as the browser builds it from the view (then the deposit hint). */
export async function hostCreates(world: MoneyServer, host: Player, gameId: string, wallet: TestWallet, consentKey: TestConsentKey, ticket: string, over: { hint?: boolean; players?: number } = {}): Promise<string> {
  const created = world.chain.createGame(
    wallet.address,
    { max_players: over.players ?? 2, mode: "live", rules_engine_version: RULES_ENGINE_VERSION, variants_digest: variantsDigestV1(resolveVariants({} as never)), consent_pubkey: consentKey.pubkey, join_ticket: ticket },
    STAKE,
  );
  if (!created.ok) throw new Error(`CreateGame: ${created.error}`);
  if (over.hint !== false) {
    const hinted = await host.api("deposit-sent", { gameId, kind: "create", txHash: "AB".repeat(32), chainGameId: created.chainGameId });
    if (hinted.status !== 202) throw new Error(`hint: ${hinted.status} ${hinted.text}`);
  }
  return created.chainGameId;
}

/** A joiner's deposit: ask for the admission, then Join on chain with it. */
export async function joinerFunds(world: MoneyServer, who: Player, gameId: string, wallet: TestWallet, consentKey: TestConsentKey, ticket: string): Promise<{ chainGameId: string; admission: Record<string, string> }> {
  const asked = await who.api("join-admission", { gameId });
  if (asked.status !== 200) throw new Error(`admission: ${asked.status} ${asked.text}`);
  const admission = asked.body?.admission as Record<string, string>;
  const joined = world.chain.join(admission.chain_game_id, { wallet: wallet.address, consent_pubkey: consentKey.pubkey, join_ticket: ticket }, { expires_at: admission.expires_at, signature: admission.signature });
  if (!joined.ok) throw new Error(`Join: ${joined.error}`);
  return { chainGameId: admission.chain_game_id, admission };
}

export { CHAIN_ID, CONTRACT, PROD_ORIGIN };
