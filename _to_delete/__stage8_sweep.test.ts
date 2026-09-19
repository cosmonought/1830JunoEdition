// STAGE-8 DESIGN-PASS DIAGNOSTIC SWEEP (temporary; moved to _to_delete/ after the run).
// Read-only over the development corpus: reports facts for the Stage-8 design document.
import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

import { entriesFromExport, replayLog, type ExportedEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { buildOperatingOrder } from "../gameEngine/operatingOrder";
import { presidentFor } from "../gameEngine/presidencyTransfer";
import { homeHexesFor } from "../components/hexContractTypes";
import { heraldHexFor } from "../components/hexBoardData";
import type { GameStateResponse } from "../gameEngine/gameState";

const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const PREFIX_DIR = join(__dirname, "__fixtures__");

const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ExportedEntry);
const exported = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};
function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const add = (name: string, entries: ExportedEntry[]) => out.push({ name, entries });
  if (existsSync(FROZEN_DIR)) for (const f of readdirSync(FROZEN_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) add(`golden/${f.replace(".log.jsonl", "")}`, jsonl(join(FROZEN_DIR, f)));
  if (existsSync(SERVER_DIR)) for (const f of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) add(`server/${f.replace(".log.jsonl", "")}`, jsonl(join(SERVER_DIR, f)));
  if (existsSync(EXPORT_DIR)) for (const f of readdirSync(EXPORT_DIR).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort()) add(`export/${f.replace("sandbox-log-", "").replace(".json", "")}`, exported(join(EXPORT_DIR, f)));
  const prefix = join(PREFIX_DIR, "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) add("prefix/JUNO-FCJ-96", jsonl(prefix));
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) add("fixture/JUNO-Z6C-494", exported(z6c));
  return out;
}

interface Ev { index: number; kind: string; msg: any; before: GameStateResponse; homes: Record<number, { label: string; q: number; r: number }[]>; herald: Record<number, boolean> }

function walk(entries: ExportedEntry[]): { events: Ev[]; final: GameStateResponse } {
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []);
  const events: Ev[] = [];
  const result = replayLog(entriesFromExport(entries), sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall }, ({ entry, msg, stateBefore }) => {
    const homes: Ev["homes"] = {};
    const herald: Ev["herald"] = {};
    for (const c of stateBefore.public_companies) {
      homes[c.company_id] = homeHexesFor(c.company_id).map((h) => ({ label: h.label, q: h.q, r: h.r }));
      herald[c.company_id] = heraldHexFor(c.company_id) !== null;
    }
    events.push({ index: entry.index, kind: Object.keys(msg as object)[0] ?? "?", msg, before: stateBefore, homes, herald });
  }, DEVELOPMENT_CORPUS_POLICY);
  return { events, final: result.state };
}

const cursorCorp = (s: GameStateResponse) => (s.current_round_type === "OperatingRound" ? (s.active_operating_order ?? [])[s.active_corporation_index] ?? null : null);
const tick = (s: GameStateResponse, id: number) => s.public_companies.find((c) => c.company_id === id)?.ticker ?? `#${id}`;
const roundLabel = (s: GameStateResponse) => `${s.current_round_type} m${s.macro_round_number} sub${s.sub_round_index}${s.current_round_type === "OperatingRound" ? ` cur=${cursorCorp(s) !== null ? tick(s, cursorCorp(s)!) : "-"} step=${s.operating_sub_phase}` : ""}`;

describe("Stage-8 design sweep", () => {
  it("reports", () => {
    const report: any = { files: [] };
    for (const { name, entries } of corpus()) {
      const { events, final } = walk(entries);
      const after = (i: number) => (i + 1 < events.length ? events[i + 1].before : final);
      const file: any = { name, entries: events.length, homePlacements: [], orOpenings: [], midOrPriceMoves: [], presidencyChanges: [], exchanges: [], dhPlacements: [], soldOutRises: [] };

      // first OR turn per corporation (first entry where the corp is the cursor in an OR)
      const firstTurn = new Map<number, number>();
      events.forEach((ev, i) => {
        const c = cursorCorp(ev.before);
        if (c !== null && !firstTurn.has(c)) firstTurn.set(c, ev.index);
      });
      // float index per corporation
      const floatAt = new Map<number, number>();
      events.forEach((ev, i) => {
        for (const c of after(i).public_companies) {
          const was = ev.before.public_companies.find((x) => x.company_id === c.company_id)?.is_floated;
          if (c.is_floated && !was && !floatAt.has(c.company_id)) floatAt.set(c.company_id, ev.index);
        }
      });

      events.forEach((ev, i) => {
        const b = ev.before; const a = after(i);
        if (ev.kind === "PlaceHomeStation") {
          const m = ev.msg.PlaceHomeStation;
          const comp = b.public_companies.find((c) => c.company_id === m.company_id);
          const compA = a.public_companies.find((c) => c.company_id === m.company_id);
          const applied = (compA?.station_token_hexes.length ?? 0) > (comp?.station_token_hexes.length ?? 0);
          const homes = ev.homes[m.company_id] ?? [];
          const onHome = homes.some((h) => h.q === m.q && h.r === m.r);
          const rec: any = { index: ev.index, kind: m.kind, corp: comp?.ticker, round: roundLabel(b), floatedBefore: comp?.is_floated, applied, hexMatchesHome: onHome, homes: homes.map((h) => h.label), cityIndex: m.city_index ?? null, hexLabel: m.hex_label ?? null, seatBefore: b.active_player_index, seatAfter: a.active_player_index };
          if (m.kind === "dh") file.dhPlacements.push(rec);
          else {
            rec.floatAt = floatAt.get(m.company_id) ?? null;
            rec.firstOrTurnAt = firstTurn.get(m.company_id) ?? null;
            // entries between placement and first OR turn that touch the home hex(es)
            const touches: any[] = [];
            const ft = rec.firstOrTurnAt;
            if (ft !== null) {
              for (let j = i + 1; j < events.length && events[j].index < ft; j++) {
                const e = events[j]; const mm = e.msg;
                const labels = homes.map((h) => h.label);
                const text = JSON.stringify(mm);
                const hit = labels.some((l) => text.includes(`"${l}"`)) || homes.some((h) => (mm.LayTile && mm.LayTile.q === h.q && mm.LayTile.r === h.r) || (mm.PlaceStationToken && mm.PlaceStationToken.q === h.q && mm.PlaceStationToken.r === h.r));
                if (hit) touches.push({ index: e.index, kind: e.kind, round: roundLabel(e.before) });
              }
            }
            rec.touchesHomeBeforeFirstTurn = touches;
            rec.orEntriesBeforeFirstTurn = ft === null ? null : events.filter((e) => e.index > ev.index && e.index < ft && e.before.current_round_type === "OperatingRound").length;
            file.homePlacements.push(rec);
          }
        }
        if (b.current_round_type === "StockRound" && a.current_round_type === "OperatingRound") {
          const locked = a.active_operating_order;
          const rebuilt = buildOperatingOrder(a);
          const rises: any[] = [];
          for (const c of a.public_companies) {
            const pb = b.market_positions?.[c.company_id]; const pa = a.market_positions?.[c.company_id];
            if (pb && pa && (pb.x !== pa.x || pb.y !== pa.y)) rises.push({ corp: c.ticker, from: pb.price, to: pa.price, cell: `${pa.x},${pa.y}` });
          }
          const cells = new Map<string, string[]>();
          for (const r of rises) cells.set(r.cell, [...(cells.get(r.cell) ?? []), r.corp]);
          file.orOpenings.push({ index: ev.index, kind: ev.kind, locked: locked.map((id) => tick(a, id)), rebuiltOnRisen: rebuilt.map((id) => tick(a, id)), same: JSON.stringify(locked) === JSON.stringify(rebuilt), rises, twoRisersOneCell: [...cells.values()].filter((v) => v.length > 1) });
        }
        // mid-OR price movement of a not-yet-operated corporation
        if (b.current_round_type === "OperatingRound" && a.current_round_type === "OperatingRound" && b.sub_round_index === a.sub_round_index && b.macro_round_number === a.macro_round_number) {
          const order = b.active_operating_order; const idx = b.active_corporation_index;
          const moved: any[] = [];
          for (let k = idx + 1; k < order.length; k++) {
            const id = order[k]; const pb = b.market_positions?.[id]; const pa = a.market_positions?.[id];
            if (pb && pa && pb.price !== pa.price) moved.push({ corp: tick(a, id), from: pb.price, to: pa.price, queuePos: k });
          }
          if (moved.length) {
            const remaining = order.slice(idx + 1);
            const resorted = buildOperatingOrder(a).filter((id) => remaining.includes(id));
            file.midOrPriceMoves.push({ index: ev.index, kind: ev.kind, actor: cursorCorp(b) !== null ? tick(b, cursorCorp(b)!) : null, moved, remaining: remaining.map((id) => tick(a, id)), resorted: resorted.map((id) => tick(a, id)), orderWouldChange: JSON.stringify(remaining) !== JSON.stringify(resorted) });
          }
        }
        // presidency changes and ties
        for (const c of a.public_companies) {
          const cb = b.public_companies.find((x) => x.company_id === c.company_id);
          if (cb && cb.president !== c.president) {
            const incumbentPct = cb.player_holdings.find((h) => h.player === cb.president)?.percentage ?? 0;
            const holdingsNow = c.player_holdings.filter((h) => h.percentage >= 20 && h.percentage > incumbentPct);
            const top = Math.max(...holdingsNow.map((h) => h.percentage));
            const tied = holdingsNow.filter((h) => h.percentage === top);
            let clockwise: string | null = null;
            if (cb.president) {
              const seats = a.player_addresses; const from = seats.indexOf(cb.president);
              for (let d = 1; d <= seats.length; d++) { const p = seats[(from + d) % seats.length]; if (tied.some((h) => h.player === p)) { clockwise = p; break; } }
            }
            file.presidencyChanges.push({ index: ev.index, kind: ev.kind, corp: c.ticker, from: cb.president, to: c.president, tiedChallengers: tied.map((h) => `${h.player}@${h.percentage}`), clockwisePick: clockwise, differs: tied.length > 1 && clockwise !== null && clockwise !== c.president });
          }
        }
        if (ev.kind === "ExchangePrivate") {
          const m = ev.msg.ExchangePrivate;
          const cb = b.public_companies.find((x) => x.company_id === m.company_id); const ca = a.public_companies.find((x) => x.company_id === m.company_id);
          const held = cb?.player_holdings.find((h) => h.player === m.player)?.percentage ?? 0;
          file.exchanges.push({ index: ev.index, round: roundLabel(b), source: m.source, keep_open: m.keep_open ?? null, corp: cb?.ticker, heldBefore: held, ipoBefore: cb?.ipo_pool_percentage, poolBefore: cb?.bank_pool_percentage, ipoAfter: ca?.ipo_pool_percentage, poolAfter: ca?.bank_pool_percentage, floatedBefore: cb?.is_floated, floatedAfter: ca?.is_floated, parBefore: cb?.par_value, presidentBefore: cb?.president, presidentAfter: ca?.president, shouldPreside: ca ? presidentFor(ca) : null, applied: JSON.stringify(cb) !== JSON.stringify(ca), seatBefore: b.active_player_index, seatAfter: a.active_player_index, activeStage: b.stock_turn_stage ?? null });
        }
      });
      // no-op tail: index after which no entry changes the board
      let lastChange = -1;
      events.forEach((ev, i) => { if (JSON.stringify(ev.before) !== JSON.stringify(after(i))) lastChange = ev.index; });
      file.lastBoardChangeIndex = lastChange;
      file.lastEntryIndex = events.length ? events[events.length - 1].index : null;
      file.floatsWithoutPlacement = [...floatAt.entries()].filter(([id]) => !events.some((e) => e.kind === "PlaceHomeStation" && e.msg.PlaceHomeStation.company_id === id && e.msg.PlaceHomeStation.kind !== "dh" && (after(events.indexOf(e)).public_companies.find((c) => c.company_id === id)?.station_token_hexes.length ?? 0) > 0)).map(([id, at]) => ({ corp: tick(final, id), floatAt: at, firstTurn: firstTurn.get(id) ?? null }));
      // S8-1 mechanism proof on this file's final board: an overlay resolver naming a different price is ignored when positions exist
      if (final.market_positions && final.active_operating_order.length > 1) {
        const first = final.active_operating_order[0];
        const overlay = buildOperatingOrder(final, (id) => (id === first ? 1 : final.market_positions?.[id]?.price ?? null), (id) => final.market_positions?.[id] ?? null);
        file.overlayIgnoredProof = { locked: final.active_operating_order.map((id) => tick(final, id)), withOverlayDemotingFirst: overlay.map((id) => tick(final, id)), overlayIgnored: overlay[0] === first };
      }
      // which top-level fields change on entries applied while a floated corporation owes a home token (pre-move hold window)
      file.changesDuringHomeHold = [];
      events.forEach((ev, i) => {
        const b = ev.before; const a = after(i);
        const owed = b.public_companies.some((c) => c.is_floated && c.home_hex_label && !ev.herald[c.company_id] && c.station_token_hexes.length === 0);
        if (!owed) return;
        const keys = Object.keys({ ...b, ...a }).filter((k) => JSON.stringify((b as any)[k]) !== JSON.stringify((a as any)[k]));
        if (keys.length) file.changesDuringHomeHold.push({ index: ev.index, kind: ev.kind, round: roundLabel(b), keys });
      });
      file.finalRound = roundLabel(final);
      report.files.push(file);
    }
    writeFileSync(join(__dirname, "..", "..", "..", "_to_delete", "stage8_sweep.json"), JSON.stringify(report, null, 1));
    expect(report.files.length).toBeGreaterThan(0);
  });
});
