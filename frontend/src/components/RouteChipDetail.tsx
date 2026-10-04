// frontend/src/components/RouteChipDetail.tsx
//
// One train's route, in the sticky bar, under the chip that opened it.
//
// ==================================================================
//  DESIGN NOTE 802: THE PANEL BECOMES A LINE
// ==================================================================
//
// REQUESTED, twice: "the Run Routes fixed subpanel can be completely done away with in exchange for the
// ability to click the train chips and have the sticky Action bar expand slightly to list its route. Players
// can click through each one to see what it's doing without needing the huge subpanel."
//
// AND REPORTED ALONGSIDE IT: "the train chips with their respective revenue values are still not displaying
// on other players' Action bars, even though the routes themselves are highlighted on the map."
//
// THOSE TWO ARE ONE PROBLEM. `RoutePlannerPanel` held every route for every train at once, which is why it
// was large -- and why #787's attempt to show it to watchers was the wrong fix rather than a broken one: it
// widened the audience for a surface that should not have existed at that size. A watcher needs ONE figure at
// a time, on demand, in the bar they are already looking at. So does the acting player.
//
// WHAT THIS IS NOT: a second control for running routes. Auto Route and Run Routes stay in the bar's button
// row where they already were (#623), because they are TURN actions and belong beside Skip and End Turn.
// Clear is here, because it is a TRAIN action -- it belongs with the train it clears, and putting it in the
// row would make a player choose between three buttons where two are about the turn and one is about a route
// they may not currently be looking at.
//
// EVERY VIEWER, EVERY TIME. The chips render for the whole table (they come off `activeCorporation.trains`,
// which is shared state) and the drafts arrive through presence for a watcher and locally for the actor. The
// only thing that changes with `canClear` is whether the Clear button is there.

import React from "react";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { TrainGlyph } from "./TrainGlyph";
import { trainTier } from "../gameEngine/gamePhase";
import { routeTrainColor } from "../styles/routeLivery";
import type { TrainRouteDraft } from "./RoutePlannerPanel";

export interface RouteChipDetailProps {
  /** The draft for the selected chip, or `null` when no chip is open. */
  draft: TrainRouteDraft | null;
  /** Whether this viewer may clear the route -- the acting president alone. */
  canClear: boolean;
  onClearRoute: (trainIndex: number) => void;
  /** ==================================================================
   *   DESIGN NOTE 1024: REMOVE ONE STOP, NOT THE WHOLE ROUTE
   *  ==================================================================
   *
   * REQUESTED: "the only option to modify the route is a global 'Clear' button that completely wipes the
   * entire array ... Add a 'Remove' button (such as a small 'X' icon) to each individual hex/stop."
   *
   * KEYED BY HEX LABEL RATHER THAN BY INDEX. This list renders `draft.stops` -- the PAYING revenue centres --
   * while the array being spliced is `routeDrafts[trainIndex]`, the full walk including the plain track
   * between them. The two are different lengths, so an index here means nothing there; the label is the one
   * value both surfaces agree on. An index would have been a proxy that stops standing for its subject, which
   * is this codebase's fifth recurring bug shape.
   *
   * OPTIONAL, so a caller that offers no removal renders the list exactly as it did before #1024. */
  onRemoveStop?: (trainIndex: number, hexLabel: string) => void;
  /** How many drafted hexes removing a given stop would take with it -- see `routeTruncate.ts` on why a route
   *  truncates rather than splicing from the middle. Supplied by the caller because it owns the full walk;
   *  this component only ever sees the paying stops. */
  stopsRemovedBy?: (trainIndex: number, hexLabel: string) => number;
  /** ==================================================================
   *   PHASE 3 W3-E (K-06 / U-17, OD-11): STOP OR BYPASS, ON THE WAYPOINT ITSELF
   *  ==================================================================
   *
   * A route crossing a hex with a track around its revenue centre (Altoona's bow, H12) may stop there or go
   * round it. The draft names those waypoints (`draft.bypassChoices`); this renders one small Stop / Bypass
   * pair per waypoint, in the strip that already lists the route's stops, so the choice sits beside the route
   * it changes -- not a secret gesture on the map. A forced bypass (the city is closed to this corporation) is
   * stated, not offered.
   *
   * GATED ON `canClear`, the edit permission the X and Clear already carry: a watcher may read, not choose.
   * OPTIONAL, so a caller that offers no choice renders exactly as before. */
  onSetBypass?: (trainIndex: number, pointIndex: number, bypass: boolean) => void;
  /** Closes the detail without touching the route. */
  onClose: () => void;
  /** The panel's own click feedback, so a refused draft explains itself here rather than nowhere. */
  feedback?: string | null;
}

/** Design note #1024: one sentence, so the tooltip and the accessible name cannot drift apart -- and so the
 *  interior case names its cost rather than leaving the player to discover it. */
export function removeStopTitle(hex: string, hexesRemoved: number): string {
  return hexesRemoved <= 1
    ? `Remove ${hex} from this route. The route then ends at the stop before it.`
    : `Remove ${hex} and the ${hexesRemoved - 1} hex${hexesRemoved === 2 ? "" : "es"} drawn after it — a route is a single path, so the tail goes with it. You can carry on drawing from the new end.`;
}

/** Phase 3 W3-E: one sentence per button, so the tooltip and the accessible name cannot drift apart. */
export function bypassChoiceTitle(hex: string, bypass: boolean): string {
  return bypass
    ? `Bypass ${hex}: take the track around its revenue centre. It pays nothing and does not use one of this train's stops.`
    : `Stop at ${hex}: it counts as one of this train's stops and pays its revenue.`;
}

/** Phase 3 W3-E: what a forced bypass is, stated rather than offered. */
export function forcedBypassNote(hex: string): string {
  return `${hex}: bypassed — the city is closed to this corporation, so the train takes the track around it.`;
}

/** Phase 3 W3-E: the over-reach line, naming the stop a Bypass would save when there is one to choose. */
export function tooManyStopsNote(model: string, choices: TrainRouteDraft["bypassChoices"]): string {
  const savable = (choices ?? []).find((choice) => choice.kind === "choice" && !choice.bypassed);
  return savable
    ? `Too many stops for a ${model}. Bypass ${savable.hexLabel} to save a stop, or shorten the route.`
    : `Too many stops for a ${model}.`;
}

/** The open chip's route, or nothing. */
export function RouteChipDetail({
  draft,
  canClear,
  onClearRoute,
  onRemoveStop,
  stopsRemovedBy,
  onSetBypass,
  onClose,
  feedback,
}: RouteChipDetailProps): React.ReactElement | null {
  if (!draft) return null;

  const stops = draft.stops ?? [];
  const bypassChoices = draft.bypassChoices ?? [];
  const model = draft.model ?? "Train";
  /* Design note #869: the route's own ink, from the one function that decides it (#494). The chip above, the
     line on the map and this head are now three drawings of one colour rather than three opinions. */
  const routeInk = routeTrainColor(draft.trainIndex);

  return (
    <div style={styles.strip} role="group" aria-label={`${model}-Train route`}>
      {/* ==================================================================
           DESIGN NOTE 869: A BARE "2" IS NOT THE THING THE PLAYER CLICKED
          ==================================================================

          ASKED: "when I click the train chip on Run Routes to see what hexes it's going through, the printed
          string text is: '2 F6 $30 -> F2 $40' and I'm wondering if rather than or in addition to '2' we put
          the full train chip (the one showing the revenue center marks) and color it the color matching the
          route color?"

          IN ADDITION, NOT INSTEAD. The glyph's carriages ARE the reach -- `TrainGlyph` draws one per revenue
          centre, three dots for the Diesel's "and onward" (#617) -- so it answers "how far can this go"
          without a number. But reading it requires COUNTING, and the model is the train's name: a player
          says "the 3-train", not "the three-carriage one". Two channels for two questions, which is #732's
          rule rather than an exception to it.

          THE HEAD IS THE CHIP THAT OPENED IT. `condensedTrainChip` above carries the route ink on a bottom
          rule; this wears the same rule in the same colour, so a disclosure opened from a chip is visibly
          about that chip. A different shape here would have been a second object claiming to be the same
          one -- which is what "2" already was.

          WHY TINTING IS SAFE HERE and was not on the fleet chips (#702 measured a 2-train at 1.00:1 against
          NNH's livery): those six route inks are chosen LIGHT on purpose, because the map draws them inside
          the rail's ink (`routeLivery.ts` #494b). On this panel's dark ground that constraint works for us
          rather than against us, and the chip keeps its own opaque body underneath. */}
      <span style={{ ...styles.model, borderBottomColor: routeInk }}>
        <TrainGlyph tier={trainTier(model) ?? model} color={routeInk} height={11} />
        <span style={{ color: routeInk }}>{model}-Train</span>
      </span>

      {stops.length === 0 ? (
        /* Design note #802: AN EMPTY ROUTE IS A STATE, NOT A BLANK. A chip with no drafted route is the
           commonest thing a player clicks on their own turn -- it is how they find out there is nothing
           there yet -- and an empty strip would read as a component that failed. */
        <span style={styles.empty}>No route drafted for this train yet.</span>
      ) : (
        <>
          <span style={styles.path}>
            {stops.map((stop, index) => (
              <React.Fragment key={`${stop.hex}-${index}`}>
                {index > 0 && (
                  <span style={styles.arrow} aria-hidden="true">
                    &rarr;
                  </span>
                )}
                <span style={styles.stop}>
                  {stop.hex}
                  {/* The per-stop value is what makes this a REVENUE readout rather than a list of hexes --
                      and it is the figure the report says watchers could not see. */}
                  <span style={styles.stopValue}>${stop.value}</span>
                  {/* ==================================================================
                       DESIGN NOTE 1024: THE 'X' SAYS WHAT IT WILL TAKE
                      ==================================================================
                      An 'X' reads as "remove this one", and that is true only of the LAST stop -- a route is a
                      contiguous path, so removing an interior hex takes the tail with it (`routeTruncate.ts`).
                      Rather than hide that or refuse the control on interior stops, the count goes in the
                      tooltip and the accessible name: #783's rule that a control whose effect a player cannot
                      predict is worse than one they cannot press.
                      GATED ON `canClear`, the same permission the Clear button carries -- a watcher may read
                      the route and may not edit it. */}
                  {canClear && onRemoveStop && (
                    <button
                      type="button"
                      style={styles.removeStop}
                      onClick={() => onRemoveStop(draft.trainIndex, stop.hex)}
                      title={removeStopTitle(stop.hex, stopsRemovedBy?.(draft.trainIndex, stop.hex) ?? 1)}
                      aria-label={removeStopTitle(
                        stop.hex,
                        stopsRemovedBy?.(draft.trainIndex, stop.hex) ?? 1,
                      )}
                    >
                      &times;
                    </button>
                  )}
                </span>
              </React.Fragment>
            ))}
          </span>
          <span style={styles.total}>
            {/* `value` is the route's own total, computed where the route was priced. Not re-summed from the
                stops here: #775's rule, and an off-board terminus can be worth more than its printed face. */}
            ${draft.value ?? 0}
          </span>
        </>
      )}

      {/* Phase 3 W3-E (K-06): one Stop / Bypass pair per waypoint that has a track around its centre. On its
          own line, because a bypassed hex pays nothing and so is not in the stop list above it. */}
      {bypassChoices.length > 0 && (
        <span style={styles.bypassRow}>
          {bypassChoices.map((choice) =>
            choice.kind === "forced" ? (
              <span key={`bypass-${choice.index}`} style={styles.bypassForced}>
                {forcedBypassNote(choice.hexLabel)}
              </span>
            ) : (
              <span
                key={`bypass-${choice.index}`}
                style={styles.bypassGroup}
                role="group"
                aria-label={`${choice.hexLabel}: stop or bypass`}
              >
                <span style={styles.bypassHex}>{choice.hexLabel}</span>
                {canClear && onSetBypass ? (
                  ([false, true] as const).map((bypass) => (
                    <button
                      key={bypass ? "bypass" : "stop"}
                      type="button"
                      aria-pressed={choice.bypassed === bypass}
                      style={{
                        ...styles.bypassOption,
                        ...(choice.bypassed === bypass ? styles.bypassOptionOn : {}),
                      }}
                      onClick={() => onSetBypass(draft.trainIndex, choice.index, bypass)}
                      title={bypassChoiceTitle(choice.hexLabel, bypass)}
                      aria-label={bypassChoiceTitle(choice.hexLabel, bypass)}
                    >
                      {bypass ? "Bypass" : "Stop"}
                    </button>
                  ))
                ) : (
                  <span style={styles.bypassReadOnly}>{choice.bypassed ? "bypassed" : "stops"}</span>
                )}
              </span>
            ),
          )}
        </span>
      )}

      {draft.exceedsMaxDistance && (
        <span style={styles.problem}>{tooManyStopsNote(model, draft.bypassChoices)}</span>
      )}
      {draft.endsOffTerminus && (
        <span style={styles.problem}>A route must finish at a city, a town or a red off-board hex.</span>
      )}
      {feedback && <span style={styles.problem}>{feedback}</span>}

      {canClear && stops.length > 0 && (
        <button
          type="button"
          style={styles.clear}
          onClick={() => onClearRoute(draft.trainIndex)}
          title={`Clears the drafted route for this ${model}. Nothing is dispatched.`}
        >
          Clear
        </button>
      )}
      <button type="button" style={styles.close} onClick={onClose} title="Close this route.">
        &times;
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /* "Expand slightly" is the request, so this is a ROW rather than a card: one line that wraps, no heading,
     no border box. A panel with a title would be the thing being replaced, smaller. */
  strip: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "4px 10px",
    padding: "5px 12px 6px",
    fontSize: FONT_SIZE.small,
    color: "#f2f0eb",
  },
  /* Design note #869: the chip shell, matching `condensedTrainChip` in `appStyles.ts` -- same padding, same
     radius, same two-weight border, so the head and the chip that opened it read as one object. Declared
     here rather than imported because this file owns its own styles and a cross-file import for four
     properties would couple the two surfaces harder than it would keep them in step; the harness asserts
     they agree instead. LONGHAND BORDERS THROUGHOUT (#840): `borderBottomColor` is overridden per route, so
     declaring the rest as a `border` shorthand is the exact React diffing trap that pass documented. */
  model: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    padding: "2px 8px",
    borderRadius: RADIUS.control,
    borderWidth: "1px",
    borderStyle: "solid",
    /* Design note #1092: retoned WITH `condensedTrainChip`, not after it. The comment above says these two
       shells are kept in step by the harness rather than by an import, and that is exactly what caught this
       -- the re-theme's first pass moved `appStyles.ts` alone and `routeChipHead` failed on the pair going
       out of agreement, which is the harness doing the job it was written for. */
    borderColor: "#3a3a3a",
    borderBottomWidth: "2px",
    backgroundColor: "#1c1c1c",
    fontWeight: 800,
    letterSpacing: "0.02em",
    whiteSpace: "nowrap",
  },
  path: { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: "3px 6px", minWidth: 0 },
  stop: { display: "inline-flex", alignItems: "baseline", gap: "3px", whiteSpace: "nowrap" },
  stopValue: { fontSize: FONT_SIZE.micro, color: "#a8a6a0", fontVariantNumeric: "tabular-nums" },
  arrow: { color: "#6e6c68" },
  total: {
    fontWeight: 800,
    color: "#7fd18c",
    fontVariantNumeric: "tabular-nums",
    marginLeft: "auto",
    whiteSpace: "nowrap",
  },
  empty: { color: "#a8a6a0" },
  problem: { color: "#e0a76a", flexBasis: "100%" },
  /* ==================================================================
      DESIGN NOTE 1024: A GLYPH BESIDE A FIGURE, NOT A BUTTON UNDER IT
     ==================================================================
     This strip is one wrapping ROW (#802), so a removal control has to sit INSIDE the stop it belongs to or
     the association is lost the moment the line wraps. Hence a bare glyph with no border and no background:
     the stop is the object, and the X is a handle on it rather than a second control competing with it.
     DIMMER THAN THE HEX AND THE FIGURE, which are the things being read. It brightens on nothing -- inline
     styles cannot express `:hover` (#46) -- so it is legible at rest instead, which is the honest trade on a
     surface that cannot have a hover state.
     THE CLOSE BUTTON KEEPS ITS OWN STYLE. Both draw a multiplication sign and they do different things: one
     shuts the readout, one edits the route. Sharing a style would make them look like one control appearing
     twice. */
  removeStop: {
    marginLeft: "4px",
    padding: "0 2px",
    border: "none",
    background: "none",
    color: "#8a8a86",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.micro,
    lineHeight: 1,
    cursor: "pointer",
  },
  /* Phase 3 W3-E: the Stop / Bypass pair. A small two-segment control rather than a checkbox, so both
     outcomes are named and the current one is the lit one (`aria-pressed`). Longhand borders (#840). */
  bypassRow: { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: "4px 12px", flexBasis: "100%" },
  bypassGroup: { display: "inline-flex", alignItems: "center", gap: "4px", whiteSpace: "nowrap" },
  bypassHex: { fontWeight: 700, marginRight: "2px" },
  bypassOption: {
    padding: "1px 8px",
    borderRadius: RADIUS.control,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#4a4a4a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    cursor: "pointer",
  },
  bypassOptionOn: { borderColor: "#7fd18c", backgroundColor: "#24342a", color: "#f2f0eb" },
  bypassReadOnly: { fontSize: FONT_SIZE.micro, color: "#a8a6a0" },
  bypassForced: { fontSize: FONT_SIZE.micro, color: "#a8a6a0" },
  clear: {
    padding: "2px 9px",
    borderRadius: RADIUS.control,
    border: "1px solid #4a4a4a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    cursor: "pointer",
  },
  close: {
    padding: "0 6px",
    border: "none",
    backgroundColor: "transparent",
    color: "#a8a6a0",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.strong,
    lineHeight: 1,
    cursor: "pointer",
  },
};

export default RouteChipDetail;
