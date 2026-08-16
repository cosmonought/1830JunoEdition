// frontend/src/components/PrivatePowerPanel.tsx
//
// The private companies' special abilities, as controls.
//
// ===================================================================
//  DESIGN NOTE 0: THE ABILITIES HAD NO SURFACE AT ALL
// ===================================================================
//
// REPORTED: there is no UI to activate a private company's special
// ability -- the Camden & Amboy tile lay, the Delaware & Hudson station,
// the Baltimore & Ohio president's certificate.
//
// True, and the privates were otherwise fully modelled: they are auctioned,
// owned, they pay revenue each Operating Round, and they close at Phase 5.
// Everything except the one thing that makes them interesting to own.
//
// ===================================================================
//  DESIGN NOTE 1: WHAT THESE BUTTONS HONESTLY ARE
// ===================================================================
//
// `ExecuteMsg` has no variant for using a private's power. There is no
// `UsePrivateAbility`, and `GAMEPLAY_MESSAGE_KEYS` -- which is the session
// key's on-chain allow-list, not merely a client convenience -- could not
// carry one if there were.
//
// So a button here CANNOT dispatch to the contract, and pretending
// otherwise would be the worst available outcome: a control that broadcasts
// a message certain to be rejected, or worse, one that logs a success the
// chain never saw. This codebase has removed exactly that shape twice
// (`App.tsx` design notes #162 and #193).
//
// These are therefore SANDBOX-ONLY controls, and they say so. In sandbox
// they run a local reducer action, so the flow is clickable and the gating
// is testable; outside sandbox the panel does not render at all rather than
// showing a row of dead buttons whose tooltip explains a backend gap the
// player cannot close.
//
// WHAT IS AND IS NOT MODELLED. The reducer action marks the ability USED
// and logs it. It does not lay the tile, place the station or move the
// certificate -- each of those is real map or share logic, and inventing a
// half-version is how a mock starts disagreeing with the contract. The
// button exists so the surface, the ownership gate and the phase gate can
// be exercised now, and so wiring real behaviour later is filling in a
// handler rather than designing a UI.
//
// ===================================================================
//  DESIGN NOTE 2: TWO GATES, AND THEY ARE DIFFERENT QUESTIONS
// ===================================================================
//
//   OWNERSHIP -- does this player hold the private. A fact about the board.
//   PHASE     -- is this the round the ability may be used in. A rule.
//
// Both are shown rather than one hiding the other: a player who owns the
// D&H wants to know it is theirs during a Stock Round even though they
// cannot fire it until they operate. So an out-of-phase ability renders
// disabled WITH the reason, and one they do not own is absent entirely --
// listing every private in the game with five "not yours" rows would be the
// roster problem `TrainPurchasePanel` design note #232 already fixed once.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import type { OperatingSubPhase } from "./OperatingSubPhaseStepper";
import type { PrivateCompanyState, RoundType } from "../utils/gameState";

/* ==================================================================
 *  DESIGN NOTE 349: A ROUND IS NOT PRECISE ENOUGH
 * ==================================================================
 *
 * REPORTED: the Champlain & St. Lawrence track-lay power shows up during
 * the Stock Round; it should appear only in the Operating Round's Lay
 * Track subphase.
 *
 * Two different things were wrong and the first hid the second.
 *
 * IT WAS NOT ACTUALLY SHOWING IN A STOCK ROUND -- `inPhase` compares
 * `roundType === ability.phase` and C&SL is tagged `OperatingRound`, so in
 * a Stock Round it rendered DISABLED with "Only usable during an Operating
 * Round". Disabled, but present: a row with the company's name and a
 * greyed button, in a panel titled Private Powers, on a screen where the
 * power cannot be used at all. Design note #2 argued for showing an
 * out-of-phase ability rather than hiding it, and that reasoning holds for
 * a power the player will use LATER THIS ROUND -- it does not hold across
 * a round boundary, where the answer is simply "not now, and not for a
 * while".
 *
 * AND THE GATE WAS TOO COARSE. Even inside an Operating Round, a free tile
 * lay is only legal during Lay Track: offering it during Run Routes is
 * offering an action the contract refuses. `AbilityPhase` had no way to
 * say so, so the panel could not have been right even in principle.
 *
 * The type now carries an optional SUBPHASE. Absent means "any subphase of
 * that round", which is the honest default for the powers that genuinely
 * are round-wide (the share exchanges).
 */
export type AbilityPhase = "OperatingRound" | "StockRound";

export interface PrivateAbility {
  privateId: number;
  /** Short verb for the button. */
  action: string;
  /** One line: what it does, in 1830 terms. */
  description: string;
  phase: AbilityPhase;
  /** Design note #349: narrows to one Operating Round step. Omitted means
   *  the whole round. */
  subPhase?: OperatingSubPhase;
  /** Design note #349: hidden entirely outside its round rather than shown
   *  disabled. Set for powers whose round is far away when it is not the
   *  current one; left off where the wait is short enough that a disabled
   *  row is useful context rather than noise. */
  hideOutOfRound?: boolean;
}

/* ==================================================================
 *  DESIGN NOTE 350: CAMDEN & AMBOY WAS MISSING, NOT ABSENT BY DESIGN
 * ==================================================================
 *
 * REPORTED: the private that exchanges for a PRR certificate (Camden &
 * Amboy) should be visible and actionable during the Stock Round.
 *
 * The comment that stood here said C&A "is granted on purchase rather than
 * triggered", so it deserved no button. That is not this ruleset: the
 * auction dashboard's own catalog has described C&A as "May be exchanged
 * for a 10% share of the PRR. The exchange closes this private
 * permanently." since it was written, and an EXCHANGE is a decision the
 * owner makes on their turn -- exactly the shape of the Mohawk & Hudson's
 * NYC exchange sitting directly above it, which did get a button.
 *
 * So five of the six privates now have controls, and the one that does not
 * is Schuylkill Valley, which genuinely has no ability at all. */
export const PRIVATE_ABILITIES: readonly PrivateAbility[] = [
  {
    privateId: 2,
    action: "Lay free tile",
    description:
      "Champlain & St. Lawrence — the owning corporation may lay a tile on B20 (Burlington) at no cost, without using its normal tile lay.",
    phase: "OperatingRound",
    /* Design note #349: a tile lay is legal in ONE step of the round, and
       the panel is hidden outside the round entirely -- a Stock Round has
       no track step to be waiting for. */
    subPhase: "Track",
    hideOutOfRound: true,
  },
  {
    privateId: 3,
    action: "Place free station",
    description:
      "Delaware & Hudson — the owning corporation may lay a tile AND place a station on F16 (Scranton) at no cost.",
    phase: "OperatingRound",
    subPhase: "Track",
    hideOutOfRound: true,
  },
  {
    privateId: 4,
    action: "Exchange for NYC share",
    description:
      "Mohawk & Hudson — the owner may exchange this private for a 10% share of the New York Central.",
    phase: "StockRound",
  },
  {
    privateId: 5,
    action: "Exchange for PRR share",
    description:
      "Camden & Amboy — the owner may exchange this private for a 10% share of the Pennsylvania. The exchange closes this private permanently.",
    phase: "StockRound",
  },
  {
    privateId: 6,
    action: "Take B&O presidency",
    description:
      "Baltimore & Ohio — the owner holds the B&O's 20% President's Certificate and sets its par price.",
    phase: "StockRound",
  },
];

export interface PrivatePowerPanelProps {
  /** Every private in the game, from `GameStateResponse`. */
  privateCompanies: readonly PrivateCompanyState[];
  /** The seat acting right now -- abilities belong to a PLAYER, not to the
   *  corporation operating. */
  viewerAddress: string | null;
  roundType: RoundType | null;
  /** Design note #349: the Operating Round step, for the abilities that are
   *  legal in only one of them. `null` outside an Operating Round. */
  orSubPhase: OperatingSubPhase | null;
  /** Design note #1: rendered only in sandbox, because only sandbox has
   *  anywhere for the action to go. */
  sandbox: boolean;
  /** Abilities already fired this game, by `private_id`. */
  usedAbilities: ReadonlySet<number>;
  onUseAbility: (ability: PrivateAbility) => void;
  controlsEnabled: boolean;
}

export function PrivatePowerPanel({
  privateCompanies,
  viewerAddress,
  roundType,
  orSubPhase,
  sandbox,
  usedAbilities,
  onUseAbility,
  controlsEnabled,
}: PrivatePowerPanelProps) {
  if (!sandbox) return null;

  const owned = PRIVATE_ABILITIES.map((ability) => {
    const priv = privateCompanies.find((entry) => entry.private_id === ability.privateId);
    return { ability, priv };
  }).filter(
    ({ ability, priv }) =>
      priv !== undefined &&
      !priv.closed &&
      viewerAddress !== null &&
      priv.owner === viewerAddress &&
      // Design note #349: an ability whose round is somewhere else entirely
      // is not context, it is clutter. Only the ones that opt in.
      !(ability.hideOutOfRound && roundType !== ability.phase),
  );

  // Design note #2: nothing owned means nothing to say. A permanent empty
  // panel is a permanent reminder of a thing the player does not have.
  if (owned.length === 0) return null;

  return (
    <div style={styles.panel}>
      <div style={styles.headerRow}>
        <span style={styles.heading}>Private Powers</span>
        <span style={styles.sandboxTag} title="These abilities have no contract message yet — see this file's design note #1. The buttons run the local sandbox reducer so the flow can be tested.">
          sandbox only
        </span>
      </div>

      {owned.map(({ ability, priv }) => {
        const used = usedAbilities.has(ability.privateId);
        const inPhase = roundType === ability.phase;
        /* Design note #349: the subphase gate, which only applies inside
           the right round. `undefined` means the whole round, so an
           ability without one is in-step by definition. */
        const inSubPhase =
          ability.subPhase === undefined || orSubPhase === ability.subPhase;
        const reason = used
          ? "Already used this game."
          : !inPhase
            ? `Only usable during ${ability.phase === "OperatingRound" ? "an Operating Round" : "a Stock Round"}.`
            : !inSubPhase
              ? `Only usable during the ${ability.subPhase} step of an Operating Round.`
              : null;
        return (
          <div key={ability.privateId} style={styles.row}>
            <div style={styles.rowText}>
              <span style={styles.privateName}>{priv?.name ?? `Private #${ability.privateId}`}</span>
              <span style={styles.description}>{ability.description}</span>
            </div>
            <button
              type="button"
              style={{
                ...styles.useButton,
                ...(reason !== null || !controlsEnabled ? styles.useButtonDisabled : {}),
              }}
              disabled={reason !== null || !controlsEnabled}
              onClick={() => onUseAbility(ability)}
              title={reason ?? ability.description}
            >
              {used ? "Used" : ability.action}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px 10px",
    borderRadius: "8px",
    backgroundColor: "#161922",
    border: "1px solid #2b3242",
  },
  headerRow: { display: "flex", alignItems: "center", gap: "8px" },
  heading: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#e6e8ef",
  },
  /* Design note #1: the label is not decoration. A control that cannot
     reach the chain has to say so where it is used, not only in a comment
     nobody playing will read. */
  sandboxTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#e0b062",
    cursor: "help",
  },
  row: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "10px",
    padding: "5px 0",
    borderTop: "1px solid #232936",
  },
  rowText: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0, flex: 1 },
  privateName: { fontSize: FONT_SIZE.body, fontWeight: 700, color: "#e6e8ef" },
  description: { fontSize: FONT_SIZE.small, color: "#8a919e", lineHeight: 1.35 },
  useButton: {
    flexShrink: 0,
    padding: "5px 12px",
    borderRadius: "7px",
    border: "1px solid #2f7d55",
    backgroundColor: "#1d5c40",
    color: "#eafff2",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  useButtonDisabled: {
    borderColor: "#343b48",
    backgroundColor: "#20242e",
    color: "#6f7480",
    cursor: "not-allowed",
  },
};

export default PrivatePowerPanel;
