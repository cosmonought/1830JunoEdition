// server/src/tools/logDoctor.ts
//
// LIVE-3B: the offline operator tool for a room log the server holds as damaged (LIVE-3 §8.5).
//
// ==================================================================
//  OFFLINE, READ-ONLY ON THE ORIGINAL, AND NEVER THE LAST WORD
// ==================================================================
//
// The server's loader truncates only a torn FINAL batch -- damage confined to the one batch that can have been in
// flight at a crash. Anything else it HOLDS (`corrupt`), untouched, because the bytes after the damage may be
// acknowledged history. This tool is how an operator looks at such a file and, where the shape is understood,
// recovers it:
//
//   inspect (default)    print the valid prefix, the damage offset and the classification (clean / torn-tail /
//                        corrupt), with the prefix's `logHash`.
//   --repair             write a REPAIRED COPY beside the original (`<file>.repaired`, or `--out <path>`); the
//                        original is opened read-only and never changed. A torn tail is cut back to the last
//                        complete batch.
//   --split-poisoned     with --repair: also recover LIVE-3 F-8's shape -- a line that fails to parse because an
//                        earlier crash left a torn fragment and the next entry was appended BEHIND it. When a
//                        suffix of such a line parses as the next contiguous entry, the torn prefix is dropped and
//                        the entry kept. Anything else stays for a human.
//
// Every repair is VERIFIED before it is written: the copy scans clean, its valid prefix is byte-identical to the
// original's, and it replays under the development-corpus policy (the `replayCli` check). The documented workflow
// (claude/live3b-hardened-local-store-2026-09-25.md) is:
//   1. stop the server (this tool refuses while a live server holds the data directory's lock);
//   2. node dist/server/src/tools/logDoctor.js data/JUNO-XXX.log.jsonl              (inspect)
//   3. node dist/server/src/tools/logDoctor.js data/JUNO-XXX.log.jsonl --repair [--split-poisoned]
//   4. node dist/server/src/replayCli.js data/JUNO-XXX.log.jsonl.repaired           (replay verification)
//   5. record the printed logHash; move the original aside (keep it); rename the copy to JUNO-XXX.log.jsonl;
//   6. LIVE-3C: a held game stays held across restarts until `tools/gamesDoctor.ts release` verifies it (the scan, the
//      replay and the reconciliation table) and lifts its durable hold, audited;
//   7. start the server -- the game loads through the full validated load.
// It is never an online mutation path.

import { promises as fs } from "fs";
import * as path from "path";

import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import {
  DEFAULT_SANDBOX_SCENARIO,
  DEVELOPMENT_CORPUS_POLICY,
  entriesFromExport,
  logHash,
  replayLog,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  waterfallForRoster,
  withEmptyRoster,
  type ExportedEntry,
} from "../../../frontend/src/gameEngine";
import { parseEntryLine, recoverSuffix, scanLog, type LogScan } from "../persistence/logFormat";
import { describeOwner, lockStatus } from "../persistence/processLock";

export interface Diagnosis {
  readonly file: string;
  readonly size: number;
  readonly classification: LogScan["classification"];
  readonly validEntries: number;
  readonly lastIndex: number;
  readonly validBytes: number;
  readonly damageAt: number | null;
  readonly evidenceAt: number | null;
  readonly detail: string;
  readonly stampedLines: number;
  readonly legacyLines: number;
  readonly prefixLogHash: string | null;
}

const hashOf = (entries: readonly ServerLogEntry[]): string | null => {
  try {
    return logHash(entries);
  } catch {
    return null;
  }
};

export function diagnose(file: string, bytes: Uint8Array): Diagnosis {
  const scan = scanLog(bytes);
  return {
    file,
    size: scan.size,
    classification: scan.classification,
    validEntries: scan.entries.length,
    lastIndex: scan.entries.length - 1,
    validBytes: scan.end,
    damageAt: scan.damageAt,
    evidenceAt: scan.evidenceAt,
    detail: scan.detail,
    stampedLines: scan.stampedLines,
    legacyLines: scan.legacyLines,
    prefixLogHash: hashOf(scan.entries),
  };
}

export type Repair =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly entries: ServerLogEntry[];
      readonly splits: ReadonlyArray<{ readonly at: number; readonly droppedBytes: number; readonly index: number }>;
      readonly droppedTailBytes: number;
    }
  | { readonly ok: false; readonly reason: string };

/** F-8: rebuild the file line by line, dropping a torn prefix wherever a suffix of the line parses as the next
 *  contiguous entry. Any other unparseable line ends the attempt. */
function splitPoisoned(bytes: Buffer): { bytes: Buffer; splits: Array<{ at: number; droppedBytes: number; index: number }> } | string {
  const kept: Buffer[] = [];
  const splits: Array<{ at: number; droppedBytes: number; index: number }> = [];
  let expected = 0;
  for (let at = 0; at < bytes.length; ) {
    const newline = bytes.indexOf(0x0a, at);
    if (newline === -1) break; // an unterminated final fragment: a torn tail, dropped
    const text = bytes.toString("utf8", at, newline);
    const whole = parseEntryLine(text);
    if (whole !== null) {
      if (whole.entry.index !== expected) return `the line at byte ${at} has index ${whole.entry.index}, expected ${expected}`;
      kept.push(bytes.subarray(at, newline + 1));
      expected += 1;
    } else {
      const glued = recoverSuffix(text);
      if (glued === null || glued.parsed.entry.index !== expected) {
        return `the line at byte ${at} does not parse, and no suffix of it is the next entry (index ${expected})`;
      }
      const dropped = Buffer.byteLength(text.slice(0, glued.offset), "utf8");
      kept.push(bytes.subarray(at + dropped, newline + 1));
      splits.push({ at, droppedBytes: dropped, index: expected });
      expected += 1;
    }
    at = newline + 1;
  }
  return { bytes: Buffer.concat(kept), splits };
}

/** The repaired contents, verified, or why there are none. Pure: nothing is read or written here. */
export function repairBytes(original: Buffer, options: { split?: boolean } = {}): Repair {
  const scan = scanLog(original);
  if (scan.classification === "clean") return { ok: false, reason: "the log is clean; there is nothing to repair" };
  let candidate: Buffer;
  let splits: Array<{ at: number; droppedBytes: number; index: number }> = [];
  if (scan.classification === "torn-tail") {
    candidate = Buffer.from(original.subarray(0, scan.end));
  } else {
    if (!options.split) {
      return {
        ok: false,
        reason: `the log is corrupt (${scan.detail}); only --split-poisoned can recover the F-8 shape, anything else needs a human`,
      };
    }
    const rebuilt = splitPoisoned(original);
    if (typeof rebuilt === "string") return { ok: false, reason: `--split-poisoned cannot repair it: ${rebuilt}` };
    if (rebuilt.splits.length === 0) return { ok: false, reason: "--split-poisoned found no torn fragment to split" };
    const again = scanLog(rebuilt.bytes);
    if (again.classification === "corrupt") return { ok: false, reason: `the split copy is still corrupt: ${again.detail}` };
    candidate = Buffer.from(rebuilt.bytes.subarray(0, again.end));
    splits = rebuilt.splits;
  }
  const check = scanLog(candidate);
  if (check.classification !== "clean") return { ok: false, reason: `the repaired copy does not scan clean: ${check.detail}` };
  if (!candidate.subarray(0, scan.end).equals(original.subarray(0, scan.end))) {
    return { ok: false, reason: "the repaired copy's prefix is not byte-identical to the original's valid prefix" };
  }
  return { ok: true, bytes: candidate, entries: check.entries, splits, droppedTailBytes: original.length - scan.end };
}

/** The `replayCli` check, in process: the copy replays under the development-corpus policy. */
export function verifyReplay(entries: readonly ServerLogEntry[]): { ok: true; applied: number; unparseable: readonly number[]; logHash: string | null } | { ok: false; reason: string } {
  try {
    const result = replayLog(
      entriesFromExport(entries as unknown as ExportedEntry[]),
      sandboxReplayProviders(),
      {
        state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
        waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
      },
      undefined,
      DEVELOPMENT_CORPUS_POLICY,
    );
    return { ok: true, applied: result.applied, unparseable: result.unparseable, logHash: hashOf(entries) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function report(d: Diagnosis): string {
  return [
    `log         ${d.file}`,
    `size        ${d.size} bytes (${d.stampedLines} stamped + ${d.legacyLines} legacy lines in the valid prefix)`,
    `verdict     ${d.classification.toUpperCase()}`,
    `valid       ${d.validEntries} entries (index 0..${d.lastIndex}), bytes 0..${d.validBytes}`,
    ...(d.damageAt === null ? [] : [`damage at   byte ${d.damageAt}${d.evidenceAt === null ? "" : ` (evidence at byte ${d.evidenceAt})`}`]),
    `detail      ${d.detail}`,
    `logHash     ${d.prefixLogHash ?? "(refused)"} (of the valid prefix)`,
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.filter((arg) => !arg.startsWith("--"));
  const flag = (name: string) => argv.includes(name);
  const outAt = argv.indexOf("--out");
  const file = args[0];
  if (!file || (outAt !== -1 && !argv[outAt + 1])) {
    console.error("usage: logDoctor <room.log.jsonl> [--repair [--split-poisoned] [--out <copy>]] [--json]");
    return 2;
  }
  const target = path.resolve(file);
  const lock = await lockStatus(path.dirname(target));
  if (lock.held) {
    console.error(
      `Refusing: a game server holds ${path.dirname(target)} (${describeOwner(lock.owner)}, heartbeat ` +
        `${Math.round((lock.ageMs ?? 0) / 1000)} s ago). logDoctor is an offline tool -- stop the server first.`,
    );
    return 2;
  }
  const original = await fs.readFile(target); // read-only: the original is never opened for writing
  const diagnosis = diagnose(target, original);
  if (flag("--json")) console.log(JSON.stringify(diagnosis, null, 2));
  else console.log(report(diagnosis));
  if (!flag("--repair")) return diagnosis.classification === "clean" ? 0 : 1;

  const repair = repairBytes(original, { split: flag("--split-poisoned") });
  if (!repair.ok) {
    console.error(`\nNo copy written: ${repair.reason}`);
    return diagnosis.classification === "clean" ? 0 : 1;
  }
  const replay = verifyReplay(repair.entries);
  if (!replay.ok) {
    console.error(`\nNo copy written: the repaired history does not replay -- ${replay.reason}`);
    return 1;
  }
  const out = path.resolve(outAt !== -1 ? argv[outAt + 1] : `${target}.repaired`);
  const handle = await fs.open(out, "wx"); // never over an existing file
  try {
    await handle.writeFile(repair.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!(await fs.readFile(out)).equals(repair.bytes)) {
    console.error(`\nThe copy at ${out} does not read back as written; do not install it.`);
    return 1;
  }
  console.log(
    [
      "",
      `REPAIRED COPY  ${out}`,
      `  ${repair.entries.length} entries; ${repair.droppedTailBytes} bytes of torn tail dropped` +
        (repair.splits.length === 0
          ? ""
          : `; ${repair.splits.length} poisoned line(s) split (${repair.splits.map((s) => `index ${s.index} at byte ${s.at}, ${s.droppedBytes} torn bytes dropped`).join("; ")})`),
      `  replays: ${replay.applied} applied, ${replay.unparseable.length} unparseable; logHash ${replay.logHash ?? "(refused)"}`,
      `  the original (${target}) is unchanged.`,
      "",
      "Next (server still stopped):",
      `  1. node dist/server/src/replayCli.js "${out}"     -- the replay verification`,
      "  2. record the logHash above in the audit trail",
      `  3. move the original aside (keep it), then rename the copy to ${path.basename(target)}`,
      "  4. LIVE-3C: the game is durably held -- `npm run gamesDoctor -- release <game_id> --note \"<why>\"` verifies",
      "     it through the full load (scan, replay, reconciliation) and only then lifts the hold",
      "  5. start the server: the game loads through the full validated load",
    ].join("\n"),
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error("logDoctor failed:", error);
      process.exit(2);
    },
  );
}
