// frontend/src/components/RoutePlannerPanel.tsx
//
// The Run Routes step, as one panel read top to bottom.
//
// Design note #0: THE STEP WAS SPREAD ACROSS THREE PLACES -- the two buttons that START a route in the bar's
// far-right utilities rail, the button that FINISHES one in its centre column above the route it would
// submit, and the readout saying whether finishing was possible in a box below both. A player following the
// obvious top-to-bottom reading order encountered the actions in the sequence 3, 1, 2.
// The panel now IS the sequence: re-draft, see what you built, run it for a stated amount.
//
// Design note #2: the run button carries the NUMBER and its own gate -- the amount on the button is the
// amount the route pays, so a mis-clicked hex shows the wrong number before committing rather than after.
// Disabled, not hidden, below $1: hiding it would remove the only evidence that finishing is the next step.
//
// Design note #3: nothing here is red unless the player has done something the contract will refuse. The
// worst offender was not a warning at all -- it reported a SUCCESS in the colour reserved for failure, on
// the happy path, so the steady state of a working Auto Route was a red paragraph.
//
// Design notes #1/#4-#9/#474/#493/#499/#623: see `docs/ai_architecture/routing_pathfinding.md`.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
// Design note #494: the same per-train ink the map's route overlay uses.
import { routeTrainColor } from "../styles/routeLivery";

/* `RouteBuildMode` is GONE -- design note #493. It was `"auto" | "manual"`, and the note above it argued at
   length about which value the step should open on. That argument is what gave the removal away: both values
   produced the same behaviour, because `routeSelectMode` engages the builder for the whole sub-phase either
   way. Deleted rather than left unused, since a mode type with no modes is how the toggle grows back. */

/* Design note #5: A CORPORATION RUNS EVERY TRAIN IT OWNS. The panel modelled one route and the props said
   so -- a fair model of what a 1830 corporation does exactly never: it runs ALL of its trains in one turn,
   each on its own route, and the dividend is the sum.
   THE TRAIN LIST WAS ALSO DEDUPLICATED, which is the deeper half. Three 3-trains collapsed into one chip on
   the reasoning that "two 3-trains are one CHOICE" -- true when the question is which train to validate a
   single route against, false once it is which of my trains am I drafting for now. Three 3-trains are three
   trains. They need three routes and three chips.
   So the panel takes DRAFTS, one per owned train, identified by their index into `owned_trains` -- the only
   thing that distinguishes one 3-train from another. */

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
  /* Design note #9: THE ROW'S END OF THE SHARED CURSOR (`hexCanvasPrimitives.ts #373` explains the cursor).
     DISTINCT FROM the active train, and the two are easy to conflate: ACTIVE means "map clicks are drafting for
     this train" -- a mode, chosen by clicking, persisting until changed. HIGHLIGHTED means "this is the one
     being looked at right now" -- transient, driven by hover, and it can point at a train that is not the
     active one, which is exactly what makes it useful for comparing two drafted routes.
     Merging them would mean hovering a row silently redirected the map's clicks. */
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
  /* Design note #4: A REFUSED CLICK STILL HAS TO SAY SO. #3 deletes the red paragraph Auto Route emitted on
     SUCCESS; it does not delete the messages the builder emits when it REFUSES a click, which are the opposite
     case -- the player did something, nothing happened, and this string is the only thing that can explain why.
     Dropping these was briefly the state of this refactor and it was worse than the clutter it removed: a
     builder that silently ignores half your clicks reads as broken, and the player's next move is to click
     harder.
     It takes precedence over the standing blocked reason, because a refusal is about the click just made.
     Amber, not red: the route is intact and nothing has failed except one click. */
  clickFeedback: string | null;
}

/* Design note #493: THERE WAS NEVER A MANUAL MODE TO ENTER. `routeSelectMode` -- the flag that actually
   routes map clicks into the builder -- is forced ON for the WHOLE Routes sub-phase (`App.tsx #266`),
   regardless of which position the toggle showed. So a player in "Auto-Route" could already edit the draft,
   and #266's click handler flipped the label to "Manual" on the first click to stop the control lying.
   That is a toggle whose two positions did the same thing, kept in step with reality by an assignment buried
   in a click handler -- and what it cost was legibility: a player who wanted to edit reasonably assumed they
   had to switch modes first, on a screen where they never did.
   WHAT REPLACES IT IS ONE BUTTON, AND THE DISTINCTION IS THE POINT. Auto-Route is an ACTION -- "draft this
   again" -- with no pressed state to contradict and no second position implying the first disabled the map.
   Re-drafting is how a player abandons an edit and returns to the tracer's answer, so it survives the toggle. */
const AUTO_ROUTE_TITLE =
  "Draft routes for every train from this corporation's station tokens through its " +
  "connected network. A suggestion, not a ruling — connectivity, token access and train " +
  "limits are still the contract's to judge. Click any hex or train chip afterwards to " +
  "edit by hand; run this again to start over from the tracer's answer.";

/* Design note #7: THE TOGGLE MOVED UP TO THE TOOLBAR. #0 fixed the reading ORDER and left one thing off:
   the toggle is the only control in this panel that does not describe a route -- it picks the tool. Sitting
   inside the panel's border above a table of drafted routes, it read as a property OF those routes.
   THE READING ORDER IS UNCHANGED, which is why this refines #0 rather than reversing it: top to bottom is
   still choose-the-tool, see-what-you-built, run-it.
   IT LIVES HERE, NOT IN `App.tsx`: the markup, the palette and the tooltips are this component's, and a copy
   in the toolbar would be a second thing to keep in step -- the exact drift #0 was cleaning up. */
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
        /* Design note #623: the greying tracks `disabled`, both halves of it.
           This read `ownsAnyTrain` alone, so off-turn the button refused the
           click and looked live -- the same split `appStyles.ts` design note
           #619 records for the action bar's own buttons. */
        ...styles.modeButton,
        ...(controlsEnabled && ownsAnyTrain ? {} : styles.modeButtonDisabled),
      }}
      title={ownsAnyTrain ? AUTO_ROUTE_TITLE : noTrainReason}
    >
      &#8635; Auto-Route
    </button>
  );
}

/** A draft the contract could actually be asked to run. */
function isRunnableDraft(draft: TrainRouteDraft): boolean {
  return (
    draft.value !== null &&
    draft.value > 0 &&
    !draft.exceedsMaxDistance &&
    !draft.endsOffTerminus
  );
}

/* Design note #623: ONE ANSWER TO "WHAT WOULD RUN, AND FOR HOW MUCH". Exported because the Run button now
   exists twice -- at the bottom of this panel and on the action bar -- and the two must not be able to
   disagree about whether there is anything to run or what it pays.
   That is a real risk and not a theoretical one: #5 settles a genuinely non-obvious rule -- invalid drafts
   contribute nothing rather than blocking the rest -- and the failure mode of a second implementation is a
   bar button that offers a total the panel refuses to run. */
export function runnableRouteSummary(drafts: readonly TrainRouteDraft[]): {
  runnable: number;
  drafted: number;
  totalRevenue: number;
} {
  const runnable = drafts.filter(isRunnableDraft);
  return {
    runnable: runnable.length,
    drafted: drafts.filter((draft) => draft.hexLabels.length > 0).length,
    totalRevenue: runnable.reduce((sum, draft) => sum + (draft.value ?? 0), 0),
  };
}

/* Design note #623: THE STEP'S PRIMARY ACTION, ON THE STEP'S TOOLBAR. #266 moved Run out of the toolbar
   deliberately and its reasoning was sound -- the button belongs under the path it runs, and a copy in the
   bar would be the vaguer of the two since only the panel's copy knows the figure.
   WHAT THAT ARGUMENT MISSED IS THE STICKY BAR. The bar follows the player down the page; the panel does not.
   So on the one step whose primary action lives in the panel, scrolling to look at the map leaves a toolbar
   showing only Auto-Route and Skip -- two ways to not finish the step. Every other sub-phase keeps its
   finishing action on that bar.
   THE "VAGUER OF THE TWO" OBJECTION IS ANSWERED RATHER THAN IGNORED: both read `runnableRouteSummary`.
   Neither is the authority; the drafts are, and both render the same derivation of them.
   AUTO-ROUTE STAYS. It is not automatic -- entering the step engages the builder and drafts nothing -- so
   removing it would leave clicking hexes as the only way to draft. What it should be is SUBORDINATE to Run. */
export interface RunRoutesButtonProps {
  onRunRoute: () => void;
  drafts: readonly TrainRouteDraft[];
  controlsEnabled: boolean;
  ownsAnyTrain: boolean;
  noTrainReason: string;
}

export function RunRoutesButton({
  onRunRoute,
  drafts,
  controlsEnabled,
  ownsAnyTrain,
  noTrainReason,
}: RunRoutesButtonProps) {
  const { runnable, totalRevenue } = runnableRouteSummary(drafts);
  const live = runnable > 0 && controlsEnabled;
  return (
    <button
      type="button"
      onClick={onRunRoute}
      disabled={!live}
      style={{ ...styles.runButton, ...(live ? {} : styles.runButtonDisabled) }}
      title={
        !ownsAnyTrain
          ? noTrainReason
          : runnable > 0
            ? `Declares ${runnable === 1 ? "this route" : `all ${runnable} routes`} for $${totalRevenue}. Revenue is withheld into the treasury; pay it out in the Dividends step that follows.`
            : "Draw a route worth more than $0 to run it — use Auto-Route, or click hexes on the Rail Map."
      }
    >
      {/* Design note #623: the figure is on the button when there is one, so
          the bar's copy is never the vaguer control. `Run Trains` alone while
          nothing is runnable, because "$0" reads as a route that pays
          nothing rather than as no route at all.
          ==================================================================
           DESIGN NOTE 942: "PROJECTED", BECAUSE ONE DIE IS STILL TO COME
          ==================================================================
          RULED: "update the submission button in the Action Bar to read: `Run Trains for Projected Revenue:
          $X`, where $X is the standard 100% printed total of all valid routes currently plotted."
          AND THE WORD IS DOING REAL WORK NOW THAT #941 ROLLS ONCE PER TURN. The old copy promised a figure
          the corporation would receive; under Unpredictable Revenue it is a figure the die has not yet seen.
          `totalRevenue` is unchanged -- `runnableRouteSummary` has always summed the drafts' printed values,
          which is exactly the "standard 100% printed total" asked for.
          IT SAYS "PROJECTED" IN A STANDARD GAME TOO, where the figure is exact. Two labels differing by
          variant would put a rules fork in a button, and a player who never enables the variant loses
          nothing by reading a promise as an estimate. */}
      {runnable > 0 ? `Run Trains for Projected Revenue: $${totalRevenue}` : "Run Trains"}
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
  /* Design note #6: WHICH FULL PATHS ARE OPEN. Local state, keyed by train index -- pure disclosure, and
     lifting it would make every parent that renders this own a preference about someone else's detail rows. */
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(new Set());
  const toggleExpanded = (trainIndex: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(trainIndex)) next.delete(trainIndex);
      else next.add(trainIndex);
      return next;
    });

  /* Design note #5: THE BUTTON SUMS EVERY VALID ROUTE. A corporation's dividend is what all its trains earned
     together, so a per-train figure would be the wrong number however it was chosen. Invalid drafts contribute
     nothing rather than blocking the rest -- a player with two good routes and one broken one can still run the
     two, which is also what the contract would let them do.
     Design note #623: lifted into `runnableRouteSummary`, which the bar's copy also reads. The rule above is
     exactly the kind a second implementation would get subtly wrong. */
  const {
    runnable: runnableCount,
    drafted: draftedCount,
    totalRevenue,
  } = runnableRouteSummary(drafts);
  const drafted = drafts.filter((draft) => draft.hexLabels.length > 0);

  const active = drafts.find((draft) => draft.trainIndex === activeTrainIndex) ?? null;

  const blockedReason = !ownsAnyTrain
    ? noTrainReason
    : drafted.length === 0
      ? "Draw a route first — pick Auto-Route above, or click hexes on the Rail Map."
      : runnableCount === 0
        ? firstProblem(drafted)
        : null;

  /* A partial set is worth saying out loud rather than silently dropping:
     the total on the button would otherwise be quietly missing a train the
     player believes they drew. */
  const partialNote =
    runnableCount > 0 && runnableCount < draftedCount
      ? `${draftedCount - runnableCount} of ${draftedCount} drafted routes cannot run yet and are not in this total.`
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
            {/* Design note #499: "RUNNINGROUTE" WAS NOT A TYPO. There is no such string, and that is the whole finding --
               these are two adjacent COLUMN HEADERS, and the first overflowed into the second so the two words met on
               screen with nothing between them.
               THE CAUSE IS A WIDTH, not a string. The grid track is 52px, sized for what the COLUMN holds -- a train chip
               reading "3" or "5" -- while the word above it rendered near 68px. Editing the text to "Running Route" would
               have made the overflow worse and fixed nothing, because there was never a single label to put a space into.
               SO THE HEADER NAMES WHAT THE COLUMN HOLDS, and fits it. "Train" is both shorter and more accurate: the cell
               under it is a train chip, not a state of running.
               `minWidth: 0` and `overflow: hidden` close the CLASS of bug rather than this instance -- any future header
               that outgrows its column now truncates inside it. */}
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
                      /* Design note #494: the chip wears its own route's ink. Distinct colours on the map only help if something
                         says WHICH train each one is, and this row is where the player is already looking.
                         An underline rather than a fill: the chip's active state is a fill, and two colour systems on one control
                         would make "selected" and "this train's ink" compete. Reading the same source the overlay does. */
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
                        // Design note #623: the module-level predicate the
                        // summary uses, so a row cannot look runnable while
                        // the total leaves it out.
                        ...(isRunnableDraft(draft) ? {} : styles.revenueMuted),
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
            ...(runnableCount > 0 && controlsEnabled ? {} : styles.runButtonDisabled),
          }}
          onClick={onRunRoute}
          disabled={runnableCount === 0 || !controlsEnabled}
          title={
            runnableCount > 0
              ? `Declares ${runnableCount === 1 ? "this route" : `all ${runnableCount} routes`}. Revenue is withheld into the treasury; pay it out in the Dividends step that follows.`
              : (blockedReason ?? "Draw a route worth more than $0 to run it.")
          }
        >
          {/* Design note #942: THE SAME SENTENCE AS THE BAR'S BUTTON, and #623's rule is why. Both controls
              call `onRunRoute`, which runs every runnable draft -- so "Selected Route(s)" was describing a
              selection this button does not have, and the two copies of one action read as two actions. */}
          {`Run Trains for Projected Revenue: $${totalRevenue}`}
        </button>
      </div>
    </div>
  );
}

/** The first thing wrong with a set of drafts none of which can run. One sentence rather than one per train:
 *  three broken routes usually have the same problem, and three copies of it is the clutter #3 removed. */
function firstProblem(drafted: readonly TrainRouteDraft[]): string {
  const overLong = drafted.find((draft) => draft.exceedsMaxDistance);
  if (overLong) {
    return `Too many stops for the ${overLong.model}-train. Plain track between stops is free — only revenue centres count.`;
  }
  if (drafted.some((draft) => draft.endsOffTerminus)) {
    return "A route ends somewhere it cannot. Extend it to a city or a red off-board hex — towns only add revenue in passing.";
  }
  /* Design note #474: reported AFTER the geometric problems and before the generic "worth nothing", because a
     route that misses the corporation's tokens is usually a well-formed route in the wrong place -- the player
     has drawn something valid-looking and needs to be told which rule it misses rather than that it is
     worthless. */
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
    backgroundColor: "#0f0f0f",
    border: "1px solid #2a2a2a",
  },
  /* `modeRow` is GONE with design note #7 -- the centring it applied was for a heading inside this panel, and
     the toggle is a toolbar control now.
     `modeGroup` and `modeButtonActive` are GONE with #493: the first framed two segments as one control and the
     second painted the selected one, and with a single action button there is no group to frame and no
     selection to paint. `modeButton` survives as that button's own look, which is what it always described. */
  modeButton: {
    padding: "7px 20px",
    borderRadius: "8px",
    border: "1px solid #4a4a4a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  modeButtonDisabled: { opacity: 0.4, cursor: "not-allowed", color: "#8a8a86" },
  table: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "6px",
    border: "1px solid #2a2a2a",
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
    borderBottom: "1px solid #1c1c1c",
  },
  tableRowActive: {
    backgroundColor: "#1c1c1c",
    boxShadow: "inset 2px 0 0 #38bdf8",
  },
  /* Design note #9: distinct from active, and it has to LOOK distinct --
     the active row already owns a left rule and a fill, so the highlight
     takes the one channel left, an outline. Spread after `tableRowActive`
     so a row that is both keeps its rule and gains the ring. */
  tableRowHighlighted: {
    outline: "1px solid rgba(160, 200, 255, 0.75)",
    outlineOffset: "-1px",
    backgroundColor: "#1c1c1c",
  },
  headerRow: {
    display: "grid",
    gridTemplateColumns: "52px 1fr 92px",
    alignItems: "center",
    gap: "10px",
    padding: "6px 10px",
    borderBottom: "1px solid #2a2a2a",
    backgroundColor: "#161616",
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
  revenueMuted: { color: "#6e6c68" },
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
    borderBottom: "1px solid #1c1c1c",
    backgroundColor: "#161616",
  },
  fullPathLabel: {
    fontSize: FONT_SIZE.small,
    color: "#6e6c68",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  pathHexPlain: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    color: "#8a8a86",
    padding: "2px 7px",
    borderRadius: "999px",
    border: "1px solid #2a2a2a",
  },
  pathHexPaying: { color: "#f4ecd8", borderColor: "#3a3a3a", backgroundColor: "#1c1c1c" },
  clearRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "8px 10px",
  },
  /* Design note #499: a grid item defaults to `min-width: auto`, which refuses to shrink below its own content
     -- so a header wider than its track does not clip, it OVERFLOWS into the next column. That is how
     "Running" and "Route" came to be read as one word. These two properties make a too-wide header truncate
     inside its own column instead. */
  tableLabel: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#a8a6a0",
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
    border: "1px solid #4a4a4a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
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
    backgroundColor: "#1c1c1c",
    border: "1px solid #3a3a3a",
  },
  arrow: { fontSize: FONT_SIZE.control, color: "#6e6c68" },
  empty: { fontSize: FONT_SIZE.control, color: "#6e6c68", fontStyle: "italic" },
  stopCount: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.body,
    color: "#a8a6a0",
  },
  stopCountExceeded: { color: "#ff8a75" },
  clearButton: {
    fontSize: FONT_SIZE.body,
    padding: "5px 12px",
    borderRadius: "8px",
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    cursor: "pointer",
  },
  runRow: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  status: {
    fontSize: FONT_SIZE.body,
    color: "#a8a6a0",
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
    borderColor: "#3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#6e6c68",
    cursor: "not-allowed",
  },
};
