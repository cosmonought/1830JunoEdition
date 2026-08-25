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
import { FONT_SIZE } from "../styles/typography";
import type { TrainRouteDraft } from "./RoutePlannerPanel";

export interface RouteChipDetailProps {
  /** The draft for the selected chip, or `null` when no chip is open. */
  draft: TrainRouteDraft | null;
  /** Whether this viewer may clear the route -- the acting president alone. */
  canClear: boolean;
  onClearRoute: (trainIndex: number) => void;
  /** Closes the detail without touching the route. */
  onClose: () => void;
  /** The panel's own click feedback, so a refused draft explains itself here rather than nowhere. */
  feedback?: string | null;
}

/** The open chip's route, or nothing. */
export function RouteChipDetail({
  draft,
  canClear,
  onClearRoute,
  onClose,
  feedback,
}: RouteChipDetailProps): React.ReactElement | null {
  if (!draft) return null;

  const stops = draft.stops ?? [];
  const model = draft.model ?? "Train";

  return (
    <div style={styles.strip} role="group" aria-label={`${model} route`}>
      <span style={styles.model}>{model}</span>

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

      {draft.exceedsMaxDistance && (
        <span style={styles.problem}>Too many stops for a {model}.</span>
      )}
      {draft.endsOffTerminus && (
        <span style={styles.problem}>A route must finish at a city or a red off-board hex.</span>
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
    color: "#d7dce6",
  },
  model: { fontWeight: 800, letterSpacing: "0.02em" },
  path: { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: "3px 6px", minWidth: 0 },
  stop: { display: "inline-flex", alignItems: "baseline", gap: "3px", whiteSpace: "nowrap" },
  stopValue: { fontSize: FONT_SIZE.micro, color: "#8f98a8", fontVariantNumeric: "tabular-nums" },
  arrow: { color: "#6c7484" },
  total: {
    fontWeight: 800,
    color: "#7fd18c",
    fontVariantNumeric: "tabular-nums",
    marginLeft: "auto",
    whiteSpace: "nowrap",
  },
  empty: { color: "#8f98a8" },
  problem: { color: "#e0a76a", flexBasis: "100%" },
  clear: {
    padding: "2px 9px",
    borderRadius: "5px",
    border: "1px solid #4a5162",
    backgroundColor: "transparent",
    color: "#c8cedb",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    cursor: "pointer",
  },
  close: {
    padding: "0 6px",
    border: "none",
    backgroundColor: "transparent",
    color: "#8f98a8",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.strong,
    lineHeight: 1,
    cursor: "pointer",
  },
};

export default RouteChipDetail;
