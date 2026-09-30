// server/src/aws/ownership/relayerRole.ts
//
// ==================================================================
//  LIVE-5 L5-6: THE RELAYER ROLE -- TAKEN ONLY AS THE PRIMARY POOL'S CURRENT TASK, LEDGER FIRST, THEN THE MIRROR
// ==================================================================
//
// Preflight §4 row 28 / §5.5 / §12.2, and the L5-3 / L5-5 handoffs. The relayer is ONE task: the current task of the
// primary pool. It holds TWO fences, in two accounts, and must hold both:
//
//   the LEDGER's relayer fence `FENCE#relayer#<account>` = (epoch r, minting token) -- authoritative: minted by
//     compare-and-swap (L5-5 `takeOverRelayer`) in a table never restored with the app, so r never goes backwards; every
//     attempt this task journals carries it (and the adopted generation) INSIDE the ledger write;
//   the GAME table's mirror `ROLE#relayer#<account>` = (r, task, pool, claim) -- written only with the routing and pool
//     conditions inside its own transaction (`aws/game/relayerRole.ts`); every chain-intent write the relayer makes
//     carries `ROLE_RL` (the mirror's epoch AND claim) INSIDE the game-table write (`dynamoIntentStore` `relayerRole`).
//
// THE TAKEOVER (`takeRelayerRole`), in this order -- and the reason for each step:
//
//   0. the routing, as a HINT: a task the routing does not name primary mints NOTHING (a mint fences whoever holds the
//      ledger fence; only the primary's task may do that);
//   1. the pool writer's side-effect gate (`beforeSideEffect`): this task was shown current within the freshness window
//      -- a paused or stale task mints nothing (the mint is a write in another account: no game-table fence reaches it);
//   2. the LEDGER mint: r = epoch + 1, under the generation check (a restore adopted since -> fenced: the ledger's
//      `onFenced` hook, `ledgerFencedHook`, makes the pool writer lost). From this write on, every earlier holder's
//      attempt writes are refused by the ledger; this task's ledger instance holds (r, token);
//   3. the MIRROR, with `[SYSTEM/ROUTING primary_pool = :P; POOL#P writer_epoch = :E]` inside its own transaction and
//      `epoch < r` on the mirror: a routing flip or a newer task of the pool since the hint refuses it (DynamoDB decides,
//      not this task's reads); a lost answer is settled by the mirror's claim. A refusal is EXPLAINED from the table --
//      the mirror (our claim -> taken), this task's pool (lost), the routing (`not-primary`), a newer mirror (refused) --
//      and anything it cannot explain is thrown, never guessed;
//   4. the role is put under the pool writer's self-check (`holdRole("relayer", probe)`): the probe reads the ledger's
//      generation and fence (by epoch AND minting token) and the mirror (by epoch AND claim); anything moved -> the task
//      is LOST (L5-7: exit 3); a read that fails, or an item this build cannot read -> unknown (side effects wait);
//   5. one confirming read of that probe: taken only if both fences are still this task's at the end.
//
// L5-7 THEN (preflight §12.2 steps 3-5): the relayer's load -- the chain's account sequence and the forgotten-attempt
// guard over the ledger's journalled attempts; the open intents, whose live attempt is observed before anything is
// signed -- and only then passes, with this role as the relayer's `authority` and `intentStoreRole()` on the relayer's
// own view of the intents.
//
// A MINT WITHOUT A MIRROR (step 3 refused or unknown): this task is NOT the relayer -- nothing is returned that could
// act as one; the ledger instance holds a fence nobody will use (L5-7 gives the relayer `NO_RELAYER_ROLE`, so it never
// runs a pass; and were it to journal, the intent write that must precede any broadcast carries ROLE_RL, which a mirror
// this task did not write refuses). The previous holder is fenced in the ledger from the mint on and exits at its next
// attempt or self-check; the next takeover (this task's again, or another's) mints a newer epoch.
//
// THE SIDE-EFFECT GATE (`RelayerRole.beforeSideEffect`): the pool writer's gate -- a good self-check (which reads both
// fences) started within 5 s, else one now -- before each KMS Sign, broadcast and rebroadcast. It NARROWS the stale
// window; the fences inside the ledger and intent writes CLOSE it for everything durable: an admission that said `ok`
// is followed, before any broadcast of a new attempt, by the ledger write (relayer fence + generation) and the intent
// write (ROLE_RL), each evaluated by DynamoDB after the admission.

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import type { RelayerAuthority, RelayerSideEffect } from "../../escrow/juno/relayer";
import type { DynamoSigningLedger } from "../ledger/dynamoSigningLedger";
import { mirrorRelayerRole, readRelayerRole, relayerAccountProblem, relayerRoleFence, type RelayerRoleRecord } from "../game/relayerRole";
import { readRouting, roleTakeoverChecks } from "../game/routing";
import type { ResendTiming } from "../game/transact";
import { PoolWriterNotCurrentError, type HeldProbe, type PoolWriter } from "./poolWriter";

export const RELAYER_ROLE = "relayer";

/** What the takeover needs of the signing ledger (the DynamoDB ledger; narrower for tests). */
export type RelayerLedger = Pick<DynamoSigningLedger, "relayer" | "relayerEpoch" | "takeOverRelayer" | "relayerFenceHeld">;

/** The role was not taken, and this task is not the relayer: another task mirrored the same or a newer epoch, or a
 *  refusal the table could not explain. */
export class RelayerRoleRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerRoleRefusedError";
  }
}

/** The mirror's outcome is not known (it may still land -- it can never pass a newer mirror): this task is NOT the
 *  relayer. Take the role again later (a new mint, a newer epoch). */
export class RelayerRoleUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerRoleUnknownError";
  }
}

/** The relayer role as the pool writer's self-check sees it: held while the ledger's generation and fence are still this
 *  ledger instance's AND the mirror still names exactly this takeover. Throws (unknown) when a read fails or an item
 *  cannot be read. */
export function relayerRoleProbe(ledger: RelayerLedger, writer: Pick<PoolWriter, "client" | "table">, held: RelayerRoleRecord): HeldProbe {
  return {
    async check() {
      const fence = await ledger.relayerFenceHeld();
      if (!fence.held) return { held: false, detail: `the ledger's relayer fence is no longer this task's: ${fence.detail}` };
      const role = await readRelayerRole(writer.client, writer.table, held.account);
      if (role === null) return { held: false, detail: `the relayer role mirror of ${held.account} is gone` };
      if (role.epoch !== held.epoch || role.claim !== held.claim) {
        return { held: false, detail: `the relayer role mirror is at epoch ${role.epoch} (${role.task} of ${role.pool}), not this task's ${held.epoch}` };
      }
      return { held: true };
    },
  };
}

/**
 * The ledger's `onFenced` (L5-5: called once per fence value when a NEWER writer holds a fence this ledger instance still
 * believed it held -- never for damage, never for a fence this instance moved past itself) as the pool writer's loss.
 * L5-7: `openDynamoSigningLedger(client, { ..., onFenced: ledgerFencedHook(writer) })`.
 */
export function ledgerFencedHook(writer: Pick<PoolWriter, "markLost">): (which: "generation" | "relayer", detail: string) => void {
  return (which, detail) => {
    writer.markLost(which === "generation" ? `the signing ledger refused a write: the adopted generation moved (${detail})` : `the signing ledger refused a write: a newer relayer holds the relayer fence (${detail})`);
  };
}

/** No relayer role: the relayer runs no pass and makes no side effect (a non-primary task; a takeover that failed). */
export const NO_RELAYER_ROLE: RelayerAuthority = Object.freeze({
  current: () => false,
  async beforeSideEffect(what: RelayerSideEffect): Promise<void> {
    throw new PoolWriterNotCurrentError(`this task does not hold the relayer role: no ${what}`, false);
  },
});

/** Pool writers that hold the relayer role (a task takes it once: a second takeover by the same task would replace the
 *  mirror under its own probe and prove itself lost). */
const holders = new WeakSet<PoolWriter>();

/** The relayer role this task holds (from `takeRelayerRole`). It is the relayer's `authority`, and its
 *  `intentStoreRole()` is the relayer's view of the chain intents. */
export class RelayerRole implements RelayerAuthority {
  constructor(
    private readonly writer: PoolWriter,
    /** The mirror as this takeover wrote it. */
    readonly record: RelayerRoleRecord,
    /** The role's own probe (both fences), and whether one read of it has come back held since the role was put under
     *  the self-check. Until then (the takeover's confirming read could not tell), the pool writer's last good check may
     *  predate the role and vouch for nothing about it: every side effect first reads the probe itself. */
    private readonly probe: HeldProbe,
    private confirmed: boolean,
  ) {}

  get account(): string {
    return this.record.account;
  }

  get epoch(): number {
    return this.record.epoch;
  }

  /** ROLE_RL: carried INSIDE every intent write the relayer makes (preflight §4 rows 16-17). */
  intentFence(): TransactWriteItem {
    return relayerRoleFence(this.writer.table, this.record.account, { epoch: this.record.epoch, claim: this.record.claim });
  }

  /** The relayer's intent view saw ROLE_RL refused. That is not taken as proof by itself (a damaged mirror fails it too):
   *  the self-check reads both fences now and decides -- lost, or unknown (side effects wait). */
  onIntentFenced(): void {
    this.writer.checkSoon();
  }

  /** For `createDynamoIntentStore({ ..., relayerRole })`: the relayer's view of the intents. */
  intentStoreRole(): { readonly fence: () => TransactWriteItem; readonly onFenced: (detail: string) => void } {
    return { fence: () => this.intentFence(), onFenced: () => this.onIntentFenced() };
  }

  current(): boolean {
    return this.writer.lost === null;
  }

  async beforeSideEffect(): Promise<void> {
    await this.writer.beforeSideEffect();
    if (this.confirmed) return;
    const answer = await this.probe.check(); // throws: unknown -- the side effect waits
    if (!answer.held) {
      this.writer.markLost(`the relayer role is no longer this task's: ${answer.detail}`);
      throw new PoolWriterNotCurrentError(`the relayer role is no longer this task's: ${answer.detail}`, true);
    }
    this.confirmed = true;
  }
}

export type RelayerRoleTakeover =
  | { readonly kind: "taken"; readonly role: RelayerRole }
  /** The routing does not name this pool primary (at the hint, or at the mirror's own write): this task is not the
   *  relayer. After a refused mirror the ledger fence may have been minted (see the header). */
  | { readonly kind: "not-primary"; readonly primary: string | null };

/**
 * Take the relayer role for `writer`'s task -- only as the primary pool's current task (see the header): the ledger mint,
 * then the mirror, then the self-check watches both. `ledger` is the signing ledger this task opened for its relayer
 * account (the same instance the relayer journals through). Throws when the role was not taken for a reason other than
 * the routing (`RelayerRoleRefusedError`, `RelayerRoleUnknownError`, the ledger's `SigningJournalError`, the pool
 * writer's `PoolWriterNotCurrentError`); never answers `taken` unless both fences are this task's.
 */
export async function takeRelayerRole(
  writer: PoolWriter,
  options: { readonly ledger: RelayerLedger; readonly now: () => number; readonly timing?: Partial<ResendTiming> },
): Promise<RelayerRoleTakeover> {
  const ledger = options.ledger;
  const account = ledger.relayer;
  const problem = relayerAccountProblem(account);
  if (account === null || problem !== null) throw new Error(`takeRelayerRole: the ledger was not opened for a relayer account (${problem ?? "none"})`);
  writer.assertCurrent();
  if (holders.has(writer)) throw new RelayerRoleRefusedError("this task already holds the relayer role: it is taken once per task (a restarted task takes it anew)");
  /* 0. The routing, as a hint: a task that is not the primary's mints nothing. */
  const hint = await readRouting(writer.client, writer.table);
  if (hint === null || hint.primary_pool !== writer.pool) return { kind: "not-primary", primary: hint?.primary_pool ?? null };
  /* 1. Shown current, freshly: a stale or paused task mints nothing. */
  await writer.beforeSideEffect();
  /* 2. The ledger half. Its errors are the takeover's: fenced (the generation moved: the hook marks the writer lost),
        definite (another task minted first), uncertain (this task holds no new epoch; a retry mints a newer one). */
  const minted = await ledger.takeOverRelayer();
  if (ledger.relayerEpoch() !== minted.epoch) throw new RelayerRoleRefusedError(`the ledger minted epoch ${minted.epoch} but this instance holds ${String(ledger.relayerEpoch())}`);
  /* 3. The mirror, with the routing and this task's pool epoch inside its own transaction. */
  const outcome = await mirrorRelayerRole(writer.client, writer.table, {
    account,
    epoch: minted.epoch,
    task: writer.task,
    pool: writer.pool,
    poolEpoch: writer.epoch,
    now: options.now(),
    checks: roleTakeoverChecks(writer.table, writer.fence),
    ...(options.timing !== undefined ? { timing: options.timing } : {}),
  });
  let record: RelayerRoleRecord;
  if (outcome.kind === "mirrored") {
    record = outcome.role;
  } else {
    /* Explained from the table, never from the error alone: the mirror first (our claim -> it landed: taken, and watched),
       then this task's pool (lost), then the routing (not primary), then a newer mirror (another task is the relayer). */
    const stored = await readRelayerRole(writer.client, writer.table, account);
    if (stored !== null && stored.claim === outcome.claim) {
      record = stored;
    } else {
      const self = await writer.check();
      if (self.kind === "lost") throw new PoolWriterNotCurrentError(`the relayer role was not taken: this task is no longer its pool's (${self.reason})`, true);
      const routing = await readRouting(writer.client, writer.table);
      if (routing === null || routing.primary_pool !== writer.pool) return { kind: "not-primary", primary: routing?.primary_pool ?? null };
      if (stored !== null && stored.epoch >= minted.epoch) {
        throw new RelayerRoleRefusedError(`another task mirrored relayer epoch ${stored.epoch} (${stored.task} of ${stored.pool}) at or past this task's ${minted.epoch}: this task is not the relayer`);
      }
      if (outcome.kind === "unknown") throw new RelayerRoleUnknownError(`the relayer role mirror's outcome is unknown (${outcome.detail}); this task is not the relayer -- take the role again`);
      throw new RelayerRoleRefusedError(`the relayer role mirror was refused and the table does not explain it (${outcome.which}: ${outcome.detail})`);
    }
  }
  /* 4. Watched by the self-check from now on: both fences, every 2 s and before every side effect. */
  const probe = relayerRoleProbe(ledger, writer, record);
  writer.holdRole(RELAYER_ROLE, probe);
  holders.add(writer);
  /* 5. Confirmed once, deterministically (not through a self-check that may have started before the role was held). */
  let confirmed;
  try {
    confirmed = await probe.check();
  } catch {
    /* Unknown (a read failed, or an item cannot be read): the role is held and watched, but UNCONFIRMED -- its first
       side effect reads the probe itself (the pool writer's last good check may predate the role). */
    return { kind: "taken", role: new RelayerRole(writer, record, probe, false) };
  }
  if (!confirmed.held) {
    writer.markLost(`the relayer role moved while it was being taken: ${confirmed.detail}`);
    throw new PoolWriterNotCurrentError(`the relayer role was not kept: ${confirmed.detail}`, true);
  }
  return { kind: "taken", role: new RelayerRole(writer, record, probe, true) };
}
