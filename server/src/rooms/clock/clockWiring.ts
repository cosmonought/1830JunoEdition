// server/src/rooms/clock/clockWiring.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: ONE WIRING FOR BOTH STORAGE MODES (`start.ts` file mode, `aws/runtime/awsRuntime.ts`)
// ==================================================================
//
// The table clock and the money side reach each other late: the Juno backend is opened BEFORE the game server (its
// relayer asks the clock lane's `remedyGate`, its bind asks the table's recorded deadline), and the game server's clock
// asks the backend's REMEDY pipeline. This module holds both late bindings so neither mode can wire them differently:
//
//   - before the server is built, the gate answers WAIT (nothing is relayed) and the deadline is unknown (an async game
//     is not bound) -- fail closed;
//   - without a backend, or a backend with no REMEDY key, every sealed money remedy is refused (`remedyPipeline.ts`);
//   - the clock's continuity AUTHORITY is the caller's: file mode the data-directory lock's instance id (every process
//     start is a new authority: a Live table is SYSTEM-PAUSED across any restart), AWS the generation / pool / pool
//     epoch / task (a takeover is a new authority).

import type { EscrowService } from "../../escrow/escrowService";
import type { JunoBackend } from "../../escrow/juno/junoBackend";
import type { ChainIntentRecord } from "../../escrow/chainIntents";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { createRemedyPipeline, type RemedyPort } from "../../escrow/remedyPipeline";
import type { OpsRecorder } from "../../persistence/opsRecorder";
import type { RoomHostClockConfig } from "../roomHost";
import type { ClockController } from "./clockController";
import type { ClockConductHook } from "./clockEvidence";
import type { ClockStore } from "./clockStore";

export interface ClockWiringInput {
  readonly store: ClockStore;
  readonly authority: string;
  /** The money records (a closed escrow ends gameplay). */
  readonly financial: { load(gameId: string): Promise<FinancialGameRecord | null> };
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops: OpsRecorder;
  /** The player-reporting lane's hook (optional; nothing secret ever reaches it). */
  readonly conduct?: ClockConductHook;
}

export interface ClockWiring {
  /** For `openJunoBackend`: the clock lane's word before a remedy is relayed, and the table's recorded deadline. */
  readonly backendDeps: {
    readonly remedyGate: (gameId: string, intent: ChainIntentRecord) => Promise<{ readonly kind: "ok" } | { readonly kind: "wait"; readonly why: string }>;
    readonly tableDeadline: (gameId: string) => Promise<{ readonly deadline: "live" | "async-pace" | "no-deadline"; readonly paceSecs: number | null } | null>;
  };
  /** For `createGameServer({ clock })`. */
  readonly server: RoomHostClockConfig;
  /** The backend opened: its remedy pipeline (a backend with no REMEDY key refuses every remedy). */
  backendOpened(backend: Pick<JunoBackend, "service" | "remedySigner">): void;
  /** The server is built: the gate and the deadline answer from its clock; escrow changes re-check money tables. */
  serverBuilt(server: { readonly clock: ClockController | null }, escrow: Pick<EscrowService, "onChange"> | null): void;
  /** The remedy port in force (`null`: no backend). */
  remedy(): RemedyPort | null;
}

export function createClockWiring(input: ClockWiringInput): ClockWiring {
  let port: RemedyPort | null = null;
  let clock: ClockController | null = null;
  return {
    backendDeps: {
      remedyGate: (gameId, intent) => (clock === null ? Promise.resolve({ kind: "wait" as const, why: "the table clock is not running yet" }) : clock.remedyGate(gameId, intent)),
      tableDeadline: (gameId) => (clock === null ? Promise.resolve(null) : clock.deadlineOf(gameId)),
    },
    server: {
      store: input.store,
      authority: input.authority,
      remedy: () => port,
      moneyTerminal: async (gameId) => {
        const record = await input.financial.load(gameId);
        return record?.chain_outcome?.route ?? null;
      },
      moneyStartedAtSecs: (gameId) => (port === null ? Promise.resolve(null) : port.startedAtSecs(gameId)),
      ...(input.conduct !== undefined ? { conduct: input.conduct } : {}),
    },
    backendOpened(backend) {
      port = createRemedyPipeline({
        service: backend.service,
        signer: backend.remedySigner,
        now: input.now,
        warn: input.warn,
        audit: (event, fields) => input.ops.audit(event, fields),
      });
      if (backend.remedySigner === null) input.warn("  clock: no dedicated REMEDY key is configured -- timed money remedies are REFUSED (fail closed); free tables are timed as usual");
    },
    serverBuilt(server, escrow) {
      clock = server.clock;
      if (clock !== null && escrow !== null) {
        const bound = clock;
        escrow.onChange((gameId) => bound.moneyChanged(gameId));
      }
    },
    remedy: () => port,
  };
}
