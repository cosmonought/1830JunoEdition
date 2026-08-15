// frontend/src/components/SandboxToolbar.tsx
//
// The Offline Sandbox's hotseat dev toolbar: pick which seat the client is
// pretending to be, and whether that choice should follow the turn.
//
// ===================================================================
//  DESIGN NOTE 0: WHY A SEAT SWITCHER EXISTS AT ALL
// ===================================================================
//
// Every turn-gated control in this app compares the viewer's address against
// whoever may currently act. In sandbox there is no wallet, so the viewer was
// hardcoded to the first seat -- which meant that the moment the simulated
// turn moved to Bob, the entire dashboard went dead. Not broken, just
// permanently disabled, which is the least useful state a UI can be in for
// someone trying to exercise it.
//
// A hotseat switcher is the standard answer: one machine, one screen, and a
// control that says which player is sitting in front of it. That makes the
// whole loop playable solo, which is what the sandbox is for.
//
// ===================================================================
//  DESIGN NOTE 1: WHY AUTO-FOLLOW IS ON BY DEFAULT
// ===================================================================
//
// The common case is "play the game forward and watch it work", and in that
// case manually re-selecting a seat after every single action is pure
// friction -- four clicks of overhead per round of play, every round.
// Auto-follow makes the default experience "press the buttons and the game
// advances".
//
// The uncommon case -- "show me what Carol's screen looks like right now,
// while it is Bob's turn" -- is exactly what manual selection is for, so
// picking a seat by hand DISABLES auto-follow rather than fighting it. A
// toggle that silently snapped back on the next state change would make the
// feature useless for the one job it has.
//
// ===================================================================
//  DESIGN NOTE 2: THIS IS A DEV TOOL AND MUST LOOK LIKE ONE
// ===================================================================
//
// Deliberately loud: a fixed banner across the top, in a colour used nowhere
// else in the app. The failure mode worth designing against is somebody
// taking a screenshot of the sandbox and mistaking it for the real product,
// or worse, not noticing they are in it. Blending in would be the wrong kind
// of polish.
//
// It is rendered ONLY from `App.tsx`'s `sandbox` branch, so it is
// structurally impossible to reach in a live game.

import React from "react";

import { actingSeatIndex } from "../utils/gameState";
import type { GameStateResponse } from "../utils/gameState";
import {
  SANDBOX_SCENARIOS,
  type SandboxTrainFixture,
  sandboxPlayerLabel,
  sandboxScenario,
  type SandboxScenarioId,
} from "../utils/sandboxState";
import { FONT_SIZE } from "../styles/typography";

export interface SandboxToolbarProps {
  /** The live sandbox state, so the toolbar can show which seat the game
   *  thinks should be acting. `null` before it is built. */
  gameState: GameStateResponse | null;
  /** Which seat the client is currently pretending to be. */
  seatIndex: number;
  onSelectSeat: (seatIndex: number) => void;
  autoFollow: boolean;
  onToggleAutoFollow: () => void;
  /* ===================================================================
   *  DESIGN NOTE 177: A SCENARIO, NOT A PHASE
   * ===================================================================
   *
   * This was three buttons selecting a `RoundType`, which turned out to be
   * only half of what distinguishes one testbed from another. Switching to
   * "Operating Round" told you nothing about which ERA you would land in,
   * and the answer was always Green -- so the yellow and brown tile
   * catalogs were unreachable from the toolbar that appeared to control
   * exactly that.
   *
   * A scenario names both, plus the train tier that has to agree with the
   * era (`sandboxState.ts` design note #176). Five entries, so a dropdown
   * rather than a button row -- five buttons of that width would push the
   * seat rail off a narrow toolbar, and the choice is made rarely enough
   * that a click to open it costs nothing.
   */
  scenario: SandboxScenarioId;
  onSelectScenario: (scenario: SandboxScenarioId) => void;
  /* ==================================================================
   *  DESIGN NOTE 246: THE TRAIN FIXTURE IS ITS OWN AXIS
   * ==================================================================
   *
   * The Buy-from-Corporation accordion could not be tested at all: the
   * fleet cap hands every train in a Green scenario to the first
   * corporation in the queue, so nobody else owns one and the roster --
   * correctly filtered to owners -- comes up empty.
   *
   * This toggle injects a distribution instead of a different era, which is
   * why it is a separate control rather than a sixth scenario entry. "Which
   * phase am I testing" and "who owns trains" are independent questions,
   * and folding them together would have meant five more dropdown options
   * to express one boolean.
   *
   * A SWITCH, matching Auto-Follow beside it, because it is a mode the
   * tester turns on and leaves on while working through the trade flow --
   * not a choice made once like the scenario. */
  trainFixture: SandboxTrainFixture;
  onToggleTrainFixture: () => void;
}


export function SandboxToolbar({
  gameState,
  seatIndex,
  onSelectSeat,
  autoFollow,
  onToggleAutoFollow,
  scenario,
  onSelectScenario,
  trainFixture,
  onToggleTrainFixture,
}: SandboxToolbarProps) {
  const seats = gameState?.player_addresses ?? [];

  // Whose turn the GAME thinks it is, which is not necessarily the seat the
  // client is occupying -- that is the entire point of manual selection.
  const acting = gameState ? actingSeatIndex(gameState) : null;

  // In an Operating Round the acting seat is a corporation's president
  // rather than the seat pointer, so the label has to say which question it
  // is answering or the number looks wrong.
  const followTarget =
    gameState?.current_round_type === "OperatingRound"
      ? "the acting corporation's president"
      : "whoever's turn it is";

  return (
    <div style={styles.root} role="region" aria-label="Sandbox hotseat controls">
      <div style={styles.row}>
        <span style={styles.title}>🚂 Sandbox Mode (Hotseat Testing)</span>

        <span style={styles.divider} aria-hidden="true" />

        <span style={styles.label}>Seat</span>
        <div style={styles.group} role="group" aria-label="Simulated seat">
          {seats.map((address, index) => {
            const selected = index === seatIndex;
            const isActing = acting === index;
            const name = sandboxPlayerLabel(address) ?? `Seat ${index}`;
            return (
              <button
                key={address}
                type="button"
                onClick={() => onSelectSeat(index)}
                aria-pressed={selected}
                style={{
                  ...styles.seatButton,
                  ...(selected ? styles.seatButtonActive : {}),
                }}
                title={
                  isActing
                    ? `${name} is up now. Click to view the board as ${name}.`
                    : `View the board as ${name}. This turns Auto-Follow off.`
                }
              >
                {/* A dot marks the seat the GAME wants to act, which may not
                    be the seat being viewed. Without it, manual selection
                    silently hides whose turn it actually is. */}
                {isActing && <span style={styles.actingDot} aria-hidden="true" />}
                <span style={styles.seatIndex}>{index}</span>
                {name}
              </button>
            );
          })}
          {seats.length === 0 && <span style={styles.empty}>No seats yet</span>}
        </div>

        <span style={styles.divider} aria-hidden="true" />

        <button
          type="button"
          onClick={onToggleAutoFollow}
          aria-pressed={autoFollow}
          style={{
            ...styles.toggle,
            ...(autoFollow ? styles.toggleActive : {}),
          }}
          title={
            autoFollow
              ? `On: the seat follows ${followTarget} as the game advances. Picking a seat by hand turns this off.`
              : `Off: the seat stays where you put it. Turn this on to follow ${followTarget}.`
          }
        >
          <span
            style={{
              ...styles.toggleTrack,
              ...(autoFollow ? styles.toggleTrackActive : {}),
            }}
            aria-hidden="true"
          >
            <span
              style={{
                ...styles.toggleThumb,
                ...(autoFollow ? styles.toggleThumbActive : {}),
              }}
            />
          </span>
          Auto-Follow Turn
        </button>

        <span style={styles.divider} aria-hidden="true" />

        <span style={styles.label}>Scenario</span>
        <select
          value={scenario}
          onChange={(event) => onSelectScenario(event.target.value as SandboxScenarioId)}
          style={styles.scenarioSelect}
          aria-label="Sandbox scenario"
          title={sandboxScenario(scenario).blurb}
        >
          {SANDBOX_SCENARIOS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        {/* The blurb, spelled out rather than left in the tooltip -- the
            whole point of the switcher is telling a tester what each
            scenario exercises, and a hover is a poor place for the only
            copy that does that. */}
        <span style={styles.scenarioBlurb}>{sandboxScenario(scenario).blurb}</span>

        <span style={styles.divider} aria-hidden="true" />

        {/* Design note #246: the trade-screen fixture. */}
        <button
          type="button"
          onClick={onToggleTrainFixture}
          aria-pressed={trainFixture === "spread"}
          style={{
            ...styles.toggle,
            ...(trainFixture === "spread" ? styles.toggleActive : {}),
          }}
          title={
            trainFixture === "spread"
              ? "ON: the first two floated corporations each hold a 2-train and a 3-train, so the Buy-from-Corporation accordion has real trains to offer. Turn off to return to the ordinary depot-capped distribution."
              : "OFF: trains are handed out in queue order until the depot would empty, which usually leaves only the first corporation holding any -- and the Buy-from-Corporation accordion empty. Turn on to equip two corporations for trade testing."
          }
        >
          <span
            style={{
              ...styles.toggleTrack,
              ...(trainFixture === "spread" ? styles.toggleTrackActive : {}),
            }}
            aria-hidden="true"
          >
            <span
              style={{
                ...styles.toggleThumb,
                ...(trainFixture === "spread" ? styles.toggleThumbActive : {}),
              }}
            />
          </span>
          Trade Fixture
        </button>
      </div>

      <p style={styles.footnote}>
        Local mock state -- nothing is signed and nothing reaches a chain. Turn order and
        balances move so the controls are testable; the contract remains the only authority
        on rules.
      </p>
    </div>
  );
}

export default SandboxToolbar;

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

const ACCENT = "#f5b942";

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 16px",
    // Design note #2: a colour used nowhere else, so this can never be
    // mistaken for ordinary product chrome.
    backgroundColor: "#2a2410",
    borderBottom: `2px solid ${ACCENT}`,
  },
  row: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px",
  },
  title: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: ACCENT,
    letterSpacing: "0.01em",
  },
  divider: {
    width: "1px",
    alignSelf: "stretch",
    minHeight: "20px",
    backgroundColor: "#5a4a20",
  },
  label: {
    fontSize: FONT_SIZE.small,
    color: "#c9b98a",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  group: { display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "6px" },
  empty: { fontSize: FONT_SIZE.small, color: "#8a7d5c", fontStyle: "italic" },
  seatButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 11px",
    borderRadius: "6px",
    border: "1px solid #5a4a20",
    backgroundColor: "#1b1810",
    color: "#d9cfae",
    fontSize: FONT_SIZE.control,
    cursor: "pointer",
  },
  seatButtonActive: {
    borderColor: ACCENT,
    backgroundColor: "#4a3c14",
    color: "#fff4d6",
    fontWeight: 700,
  },
  seatIndex: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.micro,
    opacity: 0.7,
  },
  actingDot: {
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    backgroundColor: "#4ade80",
  },
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 11px",
    borderRadius: "6px",
    border: "1px solid #5a4a20",
    backgroundColor: "#1b1810",
    color: "#d9cfae",
    fontSize: FONT_SIZE.control,
    cursor: "pointer",
  },
  toggleActive: { borderColor: ACCENT, color: "#fff4d6", fontWeight: 700 },
  toggleTrack: {
    display: "inline-flex",
    alignItems: "center",
    width: "30px",
    height: "16px",
    borderRadius: "999px",
    backgroundColor: "#3a3222",
    padding: "2px",
    boxSizing: "border-box",
  },
  toggleTrackActive: { backgroundColor: "#6b5518" },
  toggleThumb: {
    width: "12px",
    height: "12px",
    borderRadius: "999px",
    backgroundColor: "#8a7d5c",
    transition: "transform 0.12s ease",
  },
  toggleThumbActive: { backgroundColor: ACCENT, transform: "translateX(14px)" },
  scenarioSelect: {
    padding: "5px 10px",
    borderRadius: "6px",
    border: "1px solid #5a4a20",
    backgroundColor: "#1b1810",
    color: "#f0e4c0",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  scenarioBlurb: { fontSize: FONT_SIZE.small, color: "#9a8d6c", fontStyle: "italic" },
  phaseButton: {
    padding: "5px 11px",
    borderRadius: "6px",
    border: "1px solid #5a4a20",
    backgroundColor: "#1b1810",
    color: "#d9cfae",
    fontSize: FONT_SIZE.control,
    cursor: "pointer",
  },
  phaseButtonActive: {
    borderColor: ACCENT,
    backgroundColor: "#4a3c14",
    color: "#fff4d6",
    fontWeight: 700,
  },
  footnote: {
    margin: 0,
    fontSize: FONT_SIZE.small,
    color: "#9a8d6c",
    lineHeight: 1.4,
  },
};
