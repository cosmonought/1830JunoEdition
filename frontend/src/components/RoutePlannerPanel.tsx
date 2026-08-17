// frontend/src/components/RoutePlannerPanel.tsx
//
// The Run Routes step, as one panel read top to bottom.
//
// ===================================================================
//  DESIGN NOTE 0: THE STEP WAS SPREAD ACROSS THREE PLACES
// ===================================================================
//
// Running a train took four controls, and the Operating Round bar put them
// in three different regions of itself:
//
//   "Auto Route" and "Manual Route"   -- the bar's RIGHT RAIL, the docked
//                                        utilities column
//   "Run Selected Route"              -- the bar's CENTRE column, among the
//                                        sub-phase's contextual buttons
//   the waypoint list, the stop
//   counter, the value, "Clear Route" -- a dashed panel BELOW both, and
//                                        only when manual mode was on
//
// Nothing about that grouping matched the order the player works in. The
// two buttons that START a route sat furthest right; the button that
// FINISHES one sat centre, above the route it would submit; and the readout
// telling you whether finishing was even possible sat below both, in a box
// that appeared and disappeared. A player following the obvious top-to-
// bottom reading order encountered the actions in the sequence 3, 1, 2.
//
// The panel now IS the sequence:
//
//   TOP     re-draft, if you want to start over   (one action button)
//   MIDDLE  see what you have built               (a three-row table)
//   BOTTOM  run it, for a stated amount           (one primary button)
//
// ===================================================================
//  DESIGN NOTE 1: A MODE, NOT TWO BUTTONS THAT DO DIFFERENT KINDS OF THING
// ===================================================================
//
// (SUPERSEDED by design note #493, which removed the mode entirely. Kept
// because its diagnosis was right and only its conclusion was half a step
// short -- the two controls were indeed different CATEGORIES of thing, and
// the fix was to keep the action and drop the mode rather than to merge
// them into one switch.)
//
// "Auto Route" was an ACTION (draft a path now) and "Manual Route" was a
// MODE (send my map clicks here), rendered as two identical buttons side by
// side. They looked like alternatives and behaved like different categories,
// which is why the pair needed two long tooltips to be usable at all.
//
// Both became positions of one segmented control: how this route gets built.
// Choosing Auto-Route ran the tracer and filled the table; choosing Manual
// Route handed the map back to the player -- except the map had never been
// taken away, which is what design note #493 found. Selecting a mode also
// ENGAGED the planner, and that engagement is now unconditional for the
// whole sub-phase.
//
// EDITING AN AUTO-DRAFTED ROUTE FLIPPED THE TOGGLE TO MANUAL. The moment a
// player clicked a hex, the path on screen was no longer the one the tracer
// produced, and a control still reading "Auto-Route" would have been
// claiming otherwise. That correction is what gave the toggle away: a
// control that has to be silently rewritten by the thing it supposedly
// governs is not governing it. The drafted path is still kept as the
// starting point, and there is no longer a label to keep honest.
//
// ===================================================================
//  DESIGN NOTE 2: THE RUN BUTTON CARRIES THE NUMBER, AND ITS OWN GATE
// ===================================================================
//
// "Run Selected Route" named the action and withheld the one figure the
// decision turns on. It now reads "Run Selected Route(s) for $180", which
// also makes the button the confirmation: the amount on the button is the
// amount the route pays, so a player who mis-clicked a hex sees the wrong
// number before committing rather than after.
//
// It is DISABLED, not hidden, below $1. Hiding it would remove the only
// on-screen evidence that finishing is the next step, and a player whose
// route is not yet legal would be looking for a control that no longer
// exists. Disabled-with-a-reason keeps the shape of the step intact and
// says what is missing -- the reason is in the tooltip, and in the status
// line above.
//
// ===================================================================
//  DESIGN NOTE 3: WHY THE RED TEXT IS GONE
// ===================================================================
//
// The panel used to stack up to four red strings: a stop-limit warning, an
// endpoint warning, a click-rejection message, and -- after every use of
// Auto Route -- "Auto Route drafted 5 hexes worth $180. Edit it by clicking
// hexes, or clear it and build your own."
//
// That last one was the worst offender and was not a warning at all. It
// reported a SUCCESS in the colour reserved for failure, restated two
// figures already on screen (the hex chain, the value), and then explained
// the panel's own controls in prose. It fired on the happy path, so the
// steady state of a working Auto Route was a red paragraph.
//
// It is deleted outright. The legality problems it sat among are real and
// are kept, but demoted: one neutral status line under the route, plus the
// disabled run button and its tooltip. Nothing in this panel is red unless
// the player has done something the contract will refuse.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
// Design note #494: the same per-train ink the map's route overlay uses.
import { routeTrainColor } from "../styles/routeLivery";

/* `RouteBuildMode` is GONE -- design note #493. It was `"auto" | "manual"`,
   and the note above it argued at length about which value the step should
   open on. That argument is what gave the removal away: both values produced
   the same behaviour, because `routeSelectMode` engages the builder for the
   whole sub-phase either way. The type is deleted rather than left unused,
   since a mode type with no modes is how the toggle grows back. */

/* ==================================================================
 *  DESIGN NOTE 5: A CORPORATION RUNS EVERY TRAIN IT OWNS
 * ==================================================================
 *
 * REPORTED: the router runs a single train even when the corporation owns
 * three.
 *
 * The panel modelled one route, and the props said so: `selectedTrain` was
 * a string, `hexLabels` a single chain, `value` a single number. Which is a
 * fair model of what a 1830 corporation does exactly never -- it runs ALL
 * of its trains in one Operating Round turn, each on its own route, and the
 * dividend is the sum.
 *
 * THE TRAIN LIST WAS ALSO DEDUPLICATED, which is the deeper half of the
 * bug. `runnableTrains` collapsed three 3-trains into one chip on the
 * reasoning that "two 3-trains are one CHOICE" -- true when the question is
 * "which train am I validating this single route against", and false once
 * the question is "which of my trains am I drafting for now". Three
 * 3-trains are three trains. They need three routes and three chips.
 *
 * So the panel takes DRAFTS, one per owned train, identified by their index
 * into `owned_trains` rather than by model -- the only thing that
 * distinguishes one 3-train from another.
 */

/** One train's drafted route. */
export interface TrainRouteDraft {
  /** Index into the corporation's `owned_trains`. THE identity: model alone
   *  cannot tell three 3-trains apart. */
  trainIndex: number;
  /** e.g. `"3"`. For the chip label and the capacity message. */
  model: string;
  /** Reach in revenue centres; `999` is the Diesel's unlimited. */
  maxDistance: number | undefined;
  /** Every hex on the path, in order -- what "Full Path" expands to. */
  hexLabels: readonly string[];
  /** Only the hexes that PAY, with what each pays -- design note #274
   *  (`sandboxSession.ts`). This is the readout; `hexLabels` is the detail
   *  behind it. */
  stops: ReadonlyArray<{ hex: string; value: number }>;
  /** This route's revenue, or `null` when there is nothing to price. */
  value: number | null;
  revenueCentres: number;
  exceedsMaxDistance: boolean;
  endsOffTerminus: boolean;
  /** Design note #474: why this route cannot run for want of a station
   *  token, or `null` when it can. 1830 requires a route to PASS THROUGH a
   *  city the corporation has a token in -- at any point along the run. */
  tokenBlockReason: string | null;
}

export interface RoutePlannerPanelProps {
  /** Design note #5: one entry per train the corporation owns, in tier
   *  order, INCLUDING duplicates. Empty for a corporation that owns none. */
  drafts: readonly TrainRouteDraft[];
  /** Which train the map's clicks currently belong to -- design note #5.
   *  `null` when the corporation owns nothing to draft for. */
  activeTrainIndex: number | null;
  onSelectTrain: (trainIndex: number) => void;
  /* ==================================================================
   *  DESIGN NOTE 9: THE ROW'S END OF THE SHARED CURSOR
   * ==================================================================
   *
   * `hexCanvasPrimitives.ts` design note #373 explains the cursor itself.
   *
   * DISTINCT FROM `activeTrainIndex`, and the two are easy to conflate.
   * Active means "map clicks are drafting for this train" -- a MODE, chosen
   * by clicking the chip, persisting until changed. Highlighted means "this
   * is the one being looked at right now" -- transient, driven by hover,
   * and it can point at a train that is not the active one, which is
   * exactly what makes it useful for comparing two drafted routes.
   *
   * Merging them would mean hovering a row silently redirected the map's
   * clicks, which is the kind of mode change nobody expects from a hover. */
  highlightedTrainIndex?: number | null;
  onHighlightTrain?: (trainIndex: number | null) => void;
  /** Clears one train's route, or every train's when given `null`. */
  onClearRoute: (trainIndex: number | null) => void;
  onRunRoute: () => void;
  ownsAnyTrain: boolean;
  /** Whether the shell will let any action through at all. */
  controlsEnabled: boolean;
  /** Why running is impossible regardless of the route -- currently only
   *  "this corporation owns no trains". */
  noTrainReason: string;
  /* ==================================================================
   *  DESIGN NOTE 4: A REFUSED CLICK STILL HAS TO SAY SO
   * ==================================================================
   *
   * Design note #3 deletes the red paragraph Auto Route emitted on SUCCESS.
   * It does not delete the messages the builder emits when it REFUSES a
   * click -- "F10 isn't adjacent to E11", "B20 cannot START a route" --
   * which are the opposite case: the player did something, nothing
   * happened, and this string is the only thing that can explain why.
   *
   * Dropping these was briefly the state of this refactor and it was worse
   * than the clutter it removed. A builder that silently ignores half your
   * clicks reads as broken, and the player's next move is to click harder.
   *
   * It renders in the same status slot as `blockedReason` and takes
   * precedence over it, because a refusal is about the click just made
   * while the blocked reason is a standing condition. Amber, not red: the
   * route is intact and nothing has failed except one click. */
  clickFeedback: string | null;
}

/* ==================================================================
 *  DESIGN NOTE 493: THERE WAS NEVER A MANUAL MODE TO ENTER
 * ==================================================================
 *
 * REPORTED: the separate "Manual Route" button is redundant if players can
 * interact with the map natively. Remove it; clicking hexes and train chips
 * should override the auto-route suggestion with no mode toggle.
 *
 * The report is right, and the toggle was already describing a state that
 * did not exist. `routeSelectMode` -- the flag that actually routes map
 * clicks into the route builder -- is forced ON for the WHOLE Routes
 * sub-phase (App.tsx design note #266: "entering the step ENGAGES the
 * builder"), regardless of which position the toggle showed. So a player in
 * "Auto-Route" could already click hexes and edit the draft, and design note
 * #266's own `handleRouteHexClick` flipped the label to "Manual" on the
 * first click to stop the control lying about it.
 *
 * That is a toggle whose two positions did the same thing, kept in step with
 * reality by an assignment buried in a click handler. What it cost was
 * legibility: a player who wanted to edit reasonably assumed they had to
 * switch modes first, on a screen where they never did.
 *
 * WHAT REPLACES IT IS ONE BUTTON, AND THE DISTINCTION IS THE POINT.
 * `AutoRouteButton` is an ACTION -- "draft this again" -- not a mode. It has
 * no pressed state to contradict, nothing to leave switched on, and no
 * second position implying the first one disabled the map. Re-drafting is a
 * real capability worth keeping (it is how a player abandons an edit and
 * returns to the tracer's answer), so it survives the toggle rather than
 * going with it.
 *
 * `RouteBuildMode` IS DELETED, not left unused. A mode type with no modes is
 * how the toggle grows back.
 */
const AUTO_ROUTE_TITLE =
  "Draft routes for every train from this corporation's station tokens through its " +
  "connected network. A suggestion, not a ruling — connectivity, token access and train " +
  "limits are still the contract's to judge. Click any hex or train chip afterwards to " +
  "edit by hand; run this again to start over from the tracer's answer.";

/* ==================================================================
 *  DESIGN NOTE 7: THE TOGGLE MOVED UP TO THE TOOLBAR
 * ==================================================================
 *
 * Design note #0 pulled three scattered controls into one panel and put the
 * mode toggle at its top. That fixed the reading ORDER, which was the
 * complaint, and left one thing slightly off: the toggle is the only
 * control in this panel that does not describe a route. It picks the tool.
 * Sitting inside the panel's own border, above a table of drafted routes,
 * it read as a property OF those routes rather than as the thing that
 * produces them -- and it was the only sub-phase whose primary controls
 * lived somewhere other than the action toolbar every other step uses.
 *
 * So it lifts into the toolbar, on the same line as "Skip Run Routes",
 * which is exactly the pair of choices a player has on arriving at this
 * step: pick how to build, or decline to build at all.
 *
 * THE READING ORDER IS UNCHANGED, which is why this is a refinement of
 * design note #0 rather than a reversal of it. Top to bottom is still
 * choose-the-tool, see-what-you-built, run-it -- the first of those has
 * simply moved from inside the panel to the line directly above it, and
 * the two things design note #0 actually objected to (a run button ABOVE
 * the routes it submits, a mode toggle exiled to the far-right utilities
 * rail) both stay fixed.
 *
 * IT LIVES HERE, NOT IN `App.tsx`. The markup, the palette and the two
 * tooltips are this component's, and a copy in the toolbar would be a
 * second thing to keep in step with the first -- the exact drift design
 * note #0 was cleaning up. `App.tsx` mounts it; it does not rebuild it.
 */
export interface AutoRouteButtonProps {
  onAutoRoute: () => void;
  /** A corporation with no trains cannot draft at all -- the button goes
   *  dead and says why, rather than opening a builder with nothing to run. */
  ownsAnyTrain: boolean;
  controlsEnabled: boolean;
  noTrainReason: string;
}

/** Design note #493: re-run the tracer. An action, not a mode -- there is
 *  no `aria-pressed` and no active styling, because nothing stays selected
 *  and the map is editable either way. */
export function AutoRouteButton({
  onAutoRoute,
  ownsAnyTrain,
  controlsEnabled,
  noTrainReason,
}: AutoRouteButtonProps) {
  return (
    <button
      type="button"
      onClick={onAutoRoute}
      disabled={!controlsEnabled || !ownsAnyTrain}
      style={{
        ...styles.modeButton,
        ...(ownsAnyTrain ? {} : styles.modeButtonDisabled),
      }}
      title={ownsAnyTrain ? AUTO_ROUTE_TITLE : noTrainReason}
    >
      &#8635; Auto-Route
    </button>
  );
}

export function RoutePlannerPanel({
  drafts,
  activeTrainIndex,
  highlightedTrainIndex = null,
  onHighlightTrain,
  onSelectTrain,
  onClearRoute,
  onRunRoute,
  ownsAnyTrain,
  controlsEnabled,
  noTrainReason,
  clickFeedback,
}: RoutePlannerPanelProps) {
  /* Design note #6: WHICH FULL PATHS ARE OPEN.
     Local state, keyed by train index. It is pure disclosure -- nothing
     outside this panel cares which accordions a player has flipped, and
     lifting it would make every parent that renders this own a preference
     about someone else's detail rows. */
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(new Set());
  const toggleExpanded = (trainIndex: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(trainIndex)) next.delete(trainIndex);
      else next.add(trainIndex);
      return next;
    });

  /** A draft the contract could actually be asked to run. */
  const isRunnable = (draft: TrainRouteDraft) =>
    draft.value !== null &&
    draft.value > 0 &&
    !draft.exceedsMaxDistance &&
    !draft.endsOffTerminus;

  /* Design note #5: THE BUTTON SUMS EVERY VALID ROUTE. A corporation's
     dividend is what all its trains earned together, so a per-train figure
     on the run button would be the wrong number however it was chosen.
     Invalid drafts contribute nothing rather than blocking the rest -- a
     player who has drawn two good routes and one broken one can still run
     the two, which is also what the contract would let them do. */
  const runnableDrafts = drafts.filter(isRunnable);
  const totalRevenue = runnableDrafts.reduce((sum, draft) => sum + (draft.value ?? 0), 0);
  const drafted = drafts.filter((draft) => draft.hexLabels.length > 0);

  const active = drafts.find((draft) => draft.trainIndex === activeTrainIndex) ?? null;

  const blockedReason = !ownsAnyTrain
    ? noTrainReason
    : drafted.length === 0
      ? "Draw a route first — pick Auto-Route above, or click hexes on the Rail Map."
      : runnableDrafts.length === 0
        ? firstProblem(drafted)
        : null;

  /* A partial set is worth saying out loud rather than silently dropping:
     the total on the button would otherwise be quietly missing a train the
     player believes they drew. */
  const partialNote =
    runnableDrafts.length > 0 && runnableDrafts.length < drafted.length
      ? `${drafted.length - runnableDrafts.length} of ${drafted.length} drafted routes cannot run yet and are not in this total.`
      : null;

  return (
    <div style={styles.panel}>
      {/* Design note #7: the mode toggle is the TOOLBAR's now, one line
          above this panel. What remains here is the route itself. */}
      {/* ---- One row per train. ---- */}
      {drafts.length === 0 ? (
        <div style={styles.table}>
          <div style={styles.tableRow}>
            <span style={styles.empty}>No trains — buy one before running a route.</span>
          </div>
        </div>
      ) : (
        <div style={styles.table} role="table" aria-label="Drafted routes">
          <div style={styles.headerRow} role="row">
            {/* ==================================================================
                 DESIGN NOTE 499: "RUNNINGROUTE" WAS NOT A TYPO
                ==================================================================

                REPORTED: the panel listing the trains and their routes is
                titled "Runningroute", with no space.

                There is no such string, and that is the whole finding. These
                are two adjacent COLUMN HEADERS -- "Running" over the train
                chip, "Route" over the path -- and the first one overflowed
                into the second, so the two words met on screen with nothing
                between them and read as one broken title.

                THE CAUSE IS A WIDTH, not a string. `headerRow`'s grid is
                `52px 1fr 92px`, and 52px is sized for what the COLUMN holds:
                a train chip reading "3" or "5". The word above it rendered
                at `FONT_SIZE.small` bold uppercase with 0.05em tracking --
                near 68px for "RUNNING" -- so it ran past its own column and
                the 10px gap and straight into its neighbour. Editing the
                text to "Running Route" would have made the overflow worse
                and fixed nothing, because there was never a single label to
                put a space into.

                SO THE HEADER NAMES WHAT THE COLUMN HOLDS, and fits it.
                "Train" is both shorter and more accurate: the cell under it
                is a train chip, not a state of running. "Running" was
                describing the step rather than the column, which is what led
                to a header too wide for the thing it labels.

                `minWidth: 0` and `overflow: hidden` on `tableLabel` close the
                CLASS of bug rather than this instance: a grid item's default
                `min-width: auto` refuses to shrink below its content, which
                is why a too-long header silently escapes its track instead
                of being clipped. Any future header that outgrows its column
                now truncates inside it. */}
            <span style={styles.tableLabel} role="columnheader">
              Train
            </span>
            <span style={styles.tableLabel} role="columnheader">
              Route
            </span>
            <span style={{ ...styles.tableLabel, textAlign: "right" }} role="columnheader">
              Revenue
            </span>
          </div>

          {drafts.map((draft) => {
            const isActive = draft.trainIndex === activeTrainIndex;
            // Design note #9: transient, and independent of `isActive`.
            const isHighlighted = draft.trainIndex === highlightedTrainIndex;
            const isOpen = expanded.has(draft.trainIndex);
            const reach = draft.maxDistance;
            return (
              <React.Fragment key={draft.trainIndex}>
                <div
                  style={{
                    ...styles.tableRow,
                    ...(isActive ? styles.tableRowActive : {}),
                    ...(isHighlighted ? styles.tableRowHighlighted : {}),
                  }}
                  role="row"
                  onMouseEnter={() => onHighlightTrain?.(draft.trainIndex)}
                  onMouseLeave={() => onHighlightTrain?.(null)}
                >
                  {/* Design note #5: the chip is a train, not a model. Two
                      3-trains get two chips, and clicking one says "the map
                      is drafting for THIS one now". */}
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => onSelectTrain(draft.trainIndex)}
                    disabled={!controlsEnabled}
                    style={{
                      ...styles.trainChip,
                      ...(isActive ? styles.trainChipActive : {}),
                      /* Design note #494: the chip wears its own route's ink.
                         Distinct colours on the map only help if something
                         says WHICH train each one is, and this row is where
                         the player is already looking -- design note #373's
                         three-surface join, given the colour half it was
                         always described as having.

                         An underline rather than a fill: the chip's active
                         state is a fill (`trainChipActive`), and two colour
                         systems on one control would make "selected" and
                         "this train's ink" compete. Reading the same
                         `routeTrainColor` the overlay does, so the two
                         cannot disagree. */
                      borderBottom: `3px solid ${routeTrainColor(draft.trainIndex)}`,
                    }}
                    title={
                      reach === undefined
                        ? `Draft the route for this ${draft.model}-train.`
                        : `Draft the route for this ${draft.model}-train — up to ${
                            reach === 999 ? "unlimited" : reach
                          } revenue centres. Map clicks apply to the selected train.`
                    }
                  >
                    {draft.model}
                  </button>

                  <div style={styles.tableValue} role="cell">
                    {/* ---- Design note #6: THE PAYING STOPS, AND ONLY THOSE. ---- */}
                    {draft.stops.length === 0 ? (
                      <span style={styles.empty}>
                        {draft.hexLabels.length === 0 ? "No valid route" : "No paying stops yet"}
                      </span>
                    ) : (
                      <div style={styles.path}>
                        {draft.stops.map((stop, index) => (
                          <React.Fragment key={`${stop.hex}-${index}`}>
                            {index > 0 && <span style={styles.arrow}>&rarr;</span>}
                            <span style={styles.pathHex}>
                              {stop.hex} <span style={styles.stopValue}>(${stop.value})</span>
                            </span>
                          </React.Fragment>
                        ))}
                      </div>
                    )}

                    {draft.hexLabels.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(draft.trainIndex)}
                        aria-expanded={isOpen}
                        style={styles.fullPathToggle}
                        title="Expand to see full route of all track hexes"
                      >
                        <span style={styles.caret}>{isOpen ? "\u25be" : "\u25b8"}</span> Full Path
                      </button>
                    )}
                  </div>

                  <div style={styles.revenueCell} role="cell">
                    <span
                      style={{
                        ...styles.revenue,
                        ...(isRunnable(draft) ? {} : styles.revenueMuted),
                      }}
                    >
                      {draft.value === null || draft.value === 0 ? "--" : `$${draft.value}`}
                    </span>
                    <span
                      style={{
                        ...styles.stopCount,
                        ...(draft.exceedsMaxDistance ? styles.stopCountExceeded : {}),
                      }}
                    >
                      {draft.revenueCentres}
                      {reach !== undefined && reach !== 999 ? `/${reach}` : ""} stops
                    </span>
                  </div>
                </div>

                {isOpen && (
                  <div style={styles.fullPathRow} role="row">
                    <span style={styles.fullPathLabel}>Full path</span>
                    <div style={styles.path} role="cell">
                      {draft.hexLabels.map((label, index) => (
                        <React.Fragment key={`${label}-${index}`}>
                          {index > 0 && <span style={styles.arrow}>&rarr;</span>}
                          {/* Plain track is dimmed rather than hidden --
                              hiding it is what the collapsed row already
                              does, and the point of expanding is to see
                              which hexes were crossed for nothing. */}
                          <span
                            style={{
                              ...styles.pathHexPlain,
                              ...(draft.stops.some((stop) => stop.hex === label)
                                ? styles.pathHexPaying
                                : {}),
                            }}
                          >
                            {label}
                          </span>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}

          <div style={styles.clearRow}>
            <button
              type="button"
              style={styles.clearButton}
              onClick={() => onClearRoute(activeTrainIndex)}
              disabled={!controlsEnabled || !active || active.hexLabels.length === 0}
              title="This allows you to manually enter a route for this train."
            >
              Clear Route
            </button>
            <button
              type="button"
              style={styles.clearButton}
              onClick={() => onClearRoute(null)}
              disabled={!controlsEnabled || drafted.length === 0}
              title="Clear every drafted route and start the whole turn over."
            >
              Clear All
            </button>
          </div>
        </div>
      )}

      {/* ---- BOTTOM: run them all, for a stated total. ---- */}
      <div style={styles.runRow}>
        {clickFeedback !== null ? (
          <span style={{ ...styles.status, ...styles.statusRefused }}>{clickFeedback}</span>
        ) : (
          (blockedReason ?? partialNote) !== null && (
            <span style={styles.status}>{blockedReason ?? partialNote}</span>
          )
        )}
        <button
          type="button"
          style={{
            ...styles.runButton,
            ...(runnableDrafts.length > 0 && controlsEnabled ? {} : styles.runButtonDisabled),
          }}
          onClick={onRunRoute}
          disabled={runnableDrafts.length === 0 || !controlsEnabled}
          title={
            runnableDrafts.length > 0
              ? `Declares ${runnableDrafts.length === 1 ? "this route" : `all ${runnableDrafts.length} routes`}. Revenue is withheld into the treasury; pay it out in the Dividends step that follows.`
              : (blockedReason ?? "Draw a route worth more than $0 to run it.")
          }
        >
          Run Selected Route(s) for ${totalRevenue}
        </button>
      </div>
    </div>
  );
}

/** The first thing wrong with a set of drafts none of which can run.
 *
 *  One sentence rather than one per train: three broken routes usually have
 *  the same problem, and three copies of it is the clutter design note #3
 *  removed in the first place. */
function firstProblem(drafted: readonly TrainRouteDraft[]): string {
  const overLong = drafted.find((draft) => draft.exceedsMaxDistance);
  if (overLong) {
    return `Too many stops for the ${overLong.model}-train. Plain track between stops is free — only revenue centres count.`;
  }
  if (drafted.some((draft) => draft.endsOffTerminus)) {
    return "A route ends somewhere it cannot. Extend it to a city or a red off-board hex — towns only add revenue in passing.";
  }
  /* Design note #474: reported AFTER the geometric problems above and
     before the generic "worth nothing", because a route that misses the
     corporation's tokens is usually a well-formed route in the wrong place
     -- the player has drawn something valid-looking and needs to be told
     which rule it misses rather than that it is worthless. */
  const tokenless = drafted.find((draft) => draft.tokenBlockReason !== null);
  if (tokenless?.tokenBlockReason) return tokenless.tokenBlockReason;
  return "No drafted route is worth anything yet — each needs at least two paying stops.";
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "12px 14px",
    borderRadius: "8px",
    backgroundColor: "#161922",
    border: "1px solid #2b3242",
  },
  /* `modeRow` is GONE with design note #7 -- the centring it applied was
     for a heading inside this panel, and the toggle is a toolbar control
     now. The toolbar owns its own alignment.

     `modeGroup` and `modeButtonActive` are GONE with design note #493.
     The first framed two segments as one control and the second painted the
     selected one; with a single action button there is no group to frame and
     no selection to paint. `modeButton` survives as that button's own look,
     which is what it always described. */
  modeButton: {
    padding: "7px 20px",
    borderRadius: "8px",
    border: "1px solid #4a5163",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  modeButtonDisabled: { opacity: 0.4, cursor: "not-allowed", color: "#8a90a0" },
  table: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "6px",
    border: "1px solid #2b3242",
    overflow: "hidden",
  },
  /* Three columns now (design note #5): the train, its route, its revenue.
     The revenue column is fixed-width so several trains' figures line up
     vertically -- which is the comparison a player makes when deciding
     which route to redraw. */
  tableRow: {
    display: "grid",
    gridTemplateColumns: "52px 1fr 92px",
    alignItems: "start",
    gap: "10px",
    padding: "8px 10px",
    borderBottom: "1px solid #232936",
  },
  tableRowActive: {
    backgroundColor: "#1a2130",
    boxShadow: "inset 2px 0 0 #38bdf8",
  },
  /* Design note #9: distinct from active, and it has to LOOK distinct --
     the active row already owns a left rule and a fill, so the highlight
     takes the one channel left, an outline. Spread after `tableRowActive`
     so a row that is both keeps its rule and gains the ring. */
  tableRowHighlighted: {
    outline: "1px solid rgba(160, 200, 255, 0.75)",
    outlineOffset: "-1px",
    backgroundColor: "#1b2434",
  },
  headerRow: {
    display: "grid",
    gridTemplateColumns: "52px 1fr 92px",
    alignItems: "center",
    gap: "10px",
    padding: "6px 10px",
    borderBottom: "1px solid #2b3242",
    backgroundColor: "#141821",
  },
  revenueCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "2px",
  },
  revenue: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    color: "#7ee0a1",
    fontVariantNumeric: "tabular-nums",
  },
  revenueMuted: { color: "#6f7480" },
  stopValue: { color: "#7ee0a1", fontWeight: 700 },
  /* The accordion control. Deliberately a quiet link rather than a button
     with a border: it sits inside a table cell that already has a chip and
     a chain of pills, and a third bordered control there would compete with
     the route it is describing. */
  fullPathToggle: {
    alignSelf: "flex-start",
    padding: "2px 6px",
    border: "none",
    background: "none",
    color: "#7f93b5",
    fontSize: FONT_SIZE.small,
    fontFamily: "inherit",
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  caret: { textDecoration: "none", display: "inline-block", width: "10px" },
  fullPathRow: {
    display: "grid",
    gridTemplateColumns: "88px 1fr",
    alignItems: "start",
    gap: "10px",
    padding: "6px 10px 10px 62px",
    borderBottom: "1px solid #232936",
    backgroundColor: "#12161f",
  },
  fullPathLabel: {
    fontSize: FONT_SIZE.small,
    color: "#6f7480",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  pathHexPlain: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    color: "#7a808c",
    padding: "2px 7px",
    borderRadius: "999px",
    border: "1px solid #2b3242",
  },
  pathHexPaying: { color: "#f4ecd8", borderColor: "#3a3f4b", backgroundColor: "#242833" },
  clearRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "8px 10px",
  },
  /* Design note #499: a grid item defaults to `min-width: auto`, which
     refuses to shrink below its own content -- so a header wider than its
     track does not clip, it OVERFLOWS into the next column. That is how
     "Running" and "Route" came to be read as one word. These two properties
     make a too-wide header truncate inside its own column instead. */
  tableLabel: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#9aa0ac",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tableValue: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px",
    minWidth: 0,
  },
  trainChips: { display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "6px" },
  trainChip: {
    minWidth: "30px",
    padding: "4px 10px",
    borderRadius: "6px",
    border: "1px solid #4a5163",
    backgroundColor: "#242833",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    cursor: "pointer",
  },
  trainChipActive: {
    borderColor: "#38bdf8",
    backgroundColor: "#1d3a55",
    color: "#eaf2ff",
  },
  path: { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: "6px" },
  pathHex: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    color: "#f4ecd8",
    padding: "3px 9px",
    borderRadius: "999px",
    backgroundColor: "#242833",
    border: "1px solid #3a3f4b",
  },
  arrow: { fontSize: FONT_SIZE.control, color: "#6f7480" },
  empty: { fontSize: FONT_SIZE.control, color: "#6f7480", fontStyle: "italic" },
  stopCount: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.body,
    color: "#9aa0ac",
  },
  stopCountExceeded: { color: "#ff8a75" },
  clearButton: {
    fontSize: FONT_SIZE.body,
    padding: "5px 12px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  runRow: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  status: {
    fontSize: FONT_SIZE.body,
    color: "#9aa0ac",
    lineHeight: 1.4,
  },
  statusRefused: { color: "#e0b062" },
  runButton: {
    width: "100%",
    padding: "11px 18px",
    borderRadius: "8px",
    border: "1px solid #2f7d55",
    backgroundColor: "#1d5c40",
    color: "#eafff2",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
  },
  runButtonDisabled: {
    borderColor: "#343b48",
    backgroundColor: "#20242e",
    color: "#6f7480",
    cursor: "not-allowed",
  },
};
