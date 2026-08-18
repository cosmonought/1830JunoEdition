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

/* ==================================================================
 *  DESIGN NOTE 441: WHO OWNS A POWER IS NOT WHO OWNS THE PRIVATE
 * ==================================================================
 *
 * REPORTED: the PRR President sees the Delaware & Hudson's power in their
 * Private Powers panel even when the PRR does not own the D&H.
 *
 * The panel filtered on `priv.owner === viewerAddress` -- a PLAYER-level
 * test -- and applied it to every ability alike. That is right for half of
 * them and wrong for the other half, and 1830 draws the line in the text of
 * the powers themselves:
 *
 *   "A player owning the MH may exchange it for a 10% share of NYC"
 *   "A railroad owning the DH may lay a track tile and a station token"
 *
 * The exchanges belong to a PERSON and fire on their stock turn. The track
 * powers belong to a CORPORATION and fire on its operating turn. A private
 * sitting in a player's pocket confers no track power on anything --
 * `owner_protocol_id` is null until a corporation buys it, and until then
 * there is no railroad owning the DH for the rule to name.
 *
 * So the scope is now a property of each ability rather than an assumption
 * the panel makes once for all of them. */
export type AbilityScope = "player" | "corporation";

/** One button on an ability's row. */
export interface PrivateAbilityAction {
  /** Unique across every ability -- what `usedAbilities` is keyed by.
   *
   *  Design note #442: keyed per ACTION, not per private. The D&H grants a
   *  tile lay AND a token placement, and 1830 lets a corporation take both
   *  in the same turn. Keying the spent-marker by `private_id` would have
   *  made either one consume the other. */
  key: string;
  /** The button's label -- a full phrase, not a verb, because two buttons
   *  on one row have to be told apart at a glance. */
  label: string;
}

export interface PrivateAbility {
  privateId: number;
  /** Design note #442: one or more buttons. Most powers have exactly one. */
  actions: readonly PrivateAbilityAction[];
  /** One line: what it does, in 1830 terms. */
  description: string;
  phase: AbilityPhase;
  /** Design note #441: whether the PRIVATE must be held by the viewer, or
   *  by the corporation currently operating. */
  scope: AbilityScope;
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
    actions: [{ key: "csl-tile", label: "Lay Track (B20)" }],
    description:
      "Champlain & St. Lawrence — the owning corporation may lay a tile on B20 (Burlington) in addition to its normal lay.",
    phase: "OperatingRound",
    // Design note #441: "A railroad owning the CL may lay a tile on the
    // CL's hex" -- the corporation, not the player holding the certificate.
    scope: "corporation",
    /* Design note #349: a tile lay is legal in ONE step of the round, and
       the panel is hidden outside the round entirely -- a Stock Round has
       no track step to be waiting for. */
    subPhase: "Track",
    hideOutOfRound: true,
  },
  {
    /* ==============================================================
     *  DESIGN NOTE 442: THE D&H IS TWO POWERS, AND F16 IS NOT FREE
     * ==============================================================
     *
     * REPORTED: the D&H caption is misleading and its single "Place
     * Station" button does nothing.
     *
     * The caption read "may lay a tile AND place a station on F16
     * (Scranton) at no cost", which is wrong twice over and wrong in the
     * direction that costs a player money. `privateCatalog.ts` carries the
     * rulebook's own words and they are explicit: "The mountain costs $120
     * as usual, but laying the token is free." Only the TOKEN is free. A
     * caption promising a free tile on a $120 mountain hex is an invitation
     * to a purchase the player cannot afford to have misjudged.
     *
     * "AND" was the second error. The rulebook grants the tile and the
     * token independently -- a corporation may take either, both, or
     * neither, and taking the tile without the token is a normal line of
     * play. One button could not express that, which is also why the one
     * button had nothing coherent to do.
     *
     * So: one caption stating both costs honestly, and two buttons.
     */
    privateId: 3,
    actions: [
      { key: "dh-tile", label: "Lay Track (F16)" },
      { key: "dh-token", label: "Place Station Token for $0 (F16)" },
    ],
    description:
      "Delaware & Hudson — The owning corporation may lay a tile on F16 (paying the $120 terrain cost) in addition to its normal lay, AND/OR place a station token there for $0.",
    phase: "OperatingRound",
    scope: "corporation",
    subPhase: "Track",
    hideOutOfRound: true,
  },
  {
    privateId: 4,
    actions: [{ key: "mh-exchange", label: "Exchange for NYC share" }],
    description:
      "Mohawk & Hudson — the owner may exchange this private for a 10% share of the New York Central (NYC). The exchange closes this private permanently.",
    phase: "StockRound",
    // "A PLAYER owning the MH may exchange it" -- design note #441.
    scope: "player",
  },
  /* ==================================================================
   *  DESIGN NOTE 576: THE C&A ROW HAS NO BUTTON, BECAUSE IT HAS NO ACTION
   * ==================================================================
   *
   * Design note #350 added this row with an "Exchange for PRR share"
   * button, on the reading that C&A "May be exchanged for a 10% share of
   * the PRR. The exchange closes this private permanently."
   *
   * That is not the rule. The share arrives on PURCHASE, free, and the
   * company STAYS OPEN and goes on paying $25 an Operating Round --
   * `privateCatalog.ts` says so, design note #360 recorded it as a
   * correction to an older paraphrase, and the auction now grants it where
   * the win resolves (`App.tsx`, design note #576).
   *
   * So the row keeps its DESCRIPTION -- a player looking here should still
   * learn what the company did for them -- and loses the control, because
   * there is nothing left for the owner to trigger. `actions: []` renders
   * the text without a button, which is the honest shape for a power that
   * has already happened.
   *
   * NOT DELETED ENTIRELY, deliberately: a C&A owner who finds no row at all
   * would reasonably conclude the company has no power, which is the
   * confusion design note #350 was originally written to fix. */
  {
    privateId: 5,
    actions: [],
    description:
      "Camden & Amboy — its purchaser received a 10% share of the Pennsylvania Railroad (PRR) free, at the moment they won it. Nothing further to trigger: the company stays open and keeps paying its revenue.",
    phase: "StockRound",
    scope: "player",
  },
  /* ==================================================================
   *  DESIGN NOTE 441: THE B&O ROW IS GONE
   * ==================================================================
   *
   * REPORTED: hide "Take B&O presidency" during the Stock Round -- it
   * serves no purpose once the B&O is parred.
   *
   * Its `phase` was `"StockRound"`, so hiding it there hides it everywhere:
   * the requirement is a deletion written as a restriction.
   *
   * And it should be deleted, because the button had already been overtaken.
   * Design note #399 moved the grant to the moment the private is WON --
   * `BoParPrompt` hands over the President's Certificate and takes the par
   * price in one blocking step, at the auction, because a presided-over
   * company with no price is a state design note #387 refuses to render.
   * By the time any Stock Round exists the presidency is long since
   * granted, so this button offered to do a thing that had already
   * happened.
   *
   * The B&O is still visible to its owner everywhere privates are listed
   * (the auction's seating table, the Ledger's Player Assets, the Stock
   * Round footer). What is removed is a control, not information. */
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
  /** Design note #441: the corporation currently operating. A
   *  corporation-scoped power belongs to whoever OWNS the private, and it
   *  is usable on that corporation's turn -- so this is what
   *  `owner_protocol_id` is compared against. `null` outside an Operating
   *  Round, which hides every corporate power by construction. */
  actingProtocolId: number | null;
  /** Design note #441: the acting corporation's president. A corporate
   *  power is executed by the person holding the controls, so the row
   *  appears for them and nobody else at the table. */
  actingPresident: string | null;
  /** Design note #442: actions already fired this game, by action KEY --
   *  not by `private_id`. The D&H's two powers are independent. */
  usedAbilities: ReadonlySet<string>;
  onUseAbility: (ability: PrivateAbility, action: PrivateAbilityAction) => void;
  controlsEnabled: boolean;
  /* ==================================================================
   *  DESIGN NOTE 573b: WHY IT REFUSED, IN WORDS
   * ==================================================================
   *
   * REPORTED: "the Exchange button should return an error that they are at
   * the limit and the power should be maintained for a subsequent round."
   *
   * A DISABLED BUTTON WOULD NOT DO. The exchange's legality depends on the
   * player's holding in a corporation this panel does not otherwise read,
   * and the interesting refusals ("you hold 60% of the PRR", "no NYC
   * certificate is available") are facts about somewhere else on the board.
   * A greyed control with a tooltip is right when the reason is local; this
   * one has to be a sentence the player can act on.
   *
   * SHOWN AFTER THE ATTEMPT rather than pre-emptively, because the attempt
   * costs nothing -- design note #573b keeps the power intact on a refusal,
   * so clicking to find out is a legitimate way to ask. */
  abilityError?: string | null;
}

export function PrivatePowerPanel({
  privateCompanies,
  viewerAddress,
  roundType,
  orSubPhase,
  sandbox,
  actingProtocolId,
  actingPresident,
  usedAbilities,
  onUseAbility,
  controlsEnabled,
  abilityError = null,
}: PrivatePowerPanelProps) {
  if (!sandbox) return null;

  /* ==================================================================
   *  DESIGN NOTE 441: TWO OWNERSHIP TESTS, ONE PER SCOPE
   * ==================================================================
   *
   * PLAYER scope: the viewer holds the certificate. Unchanged -- this is
   * what the panel always did, and for the two exchanges it was right.
   *
   * CORPORATION scope: the private is owned by the corporation currently
   * OPERATING, and the viewer is the person holding that corporation's
   * controls. Both halves are load-bearing. Without the first, a president
   * whose corporation does not own the D&H sees its power (the reported
   * bug). Without the second, every player at the table sees a button only
   * one of them may press.
   *
   * `owner_protocol_id` is the field that answers "which railroad owns
   * this", and `gameState.ts` records that it is mutually exclusive with
   * `owner` -- so a private in a player's pocket has a null protocol id and
   * matches no corporation, which is exactly the rule. */
  const ownsForScope = (ability: PrivateAbility, priv: PrivateCompanyState): boolean => {
    if (ability.scope === "player") {
      return viewerAddress !== null && priv.owner === viewerAddress;
    }
    /* Design note #470: EXACT identity, both halves. `owner_protocol_id`
       must equal the corporation currently operating -- not merely be
       non-null, and not the president's other corporation -- and the viewer
       must be the person holding that corporation's controls. A private
       owned by a player rather than a railroad has a null protocol id and
       matches nothing, which is the rule rather than a guard. */
    return (
      actingProtocolId !== null &&
      priv.owner_protocol_id !== null &&
      priv.owner_protocol_id === actingProtocolId &&
      viewerAddress !== null &&
      actingPresident !== null &&
      actingPresident === viewerAddress
    );
  };

  const owned = PRIVATE_ABILITIES.map((ability) => {
    const priv = privateCompanies.find((entry) => entry.private_id === ability.privateId);
    return { ability, priv };
  }).filter(
    (entry): entry is { ability: PrivateAbility; priv: PrivateCompanyState } =>
      entry.priv !== undefined &&
      !entry.priv.closed &&
      ownsForScope(entry.ability, entry.priv) &&
      /* ==================================================================
       *  DESIGN NOTE 470: THE OUT-OF-ROUND POWERS LEAKED INTO THE OR
       * ==================================================================
       *
       * REPORTED: the Private Powers panel leaks into the Operating Round
       * action panel even when the acting corporation does not own the
       * private.
       *
       * `ownsForScope` already refuses a CORPORATE power the acting
       * corporation does not own (design note #441), and that half held. The
       * leak was the two PLAYER-scoped exchanges -- Mohawk and Camden. Their
       * phase is `"StockRound"` and neither sets `hideOutOfRound`, so during
       * an Operating Round they rendered DISABLED: a Private Powers heading
       * and two dead rows, on a panel whose entire subject is the acting
       * corporation, describing privates that corporation does not own and
       * cannot use.
       *
       * Design note #349 introduced `hideOutOfRound` as an opt-in, reasoning
       * that a disabled row is "useful context rather than noise" when the
       * wait is short. That is true of a power the viewer will use SOON on
       * this same panel. It is not true here: the Operating Round's panel
       * belongs to a corporation, and a player's personal share exchange has
       * no relationship to it at all -- the wait is not short, it is a
       * different subject.
       *
       * SO THE ROUND MUST MATCH, ALWAYS. `hideOutOfRound` becomes redundant
       * rather than wrong, and is left on the two entries that set it as a
       * statement of intent; nothing now depends on it. A power is shown in
       * its own round or not at all. */
      roundType === entry.ability.phase,
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

      {/* Design note #573b: the last refusal, in full. Above the rows rather
          than inside one, because the reason is usually about a DIFFERENT
          company than the row that produced it. */}
      {abilityError && <p style={styles.abilityError}>{abilityError}</p>}

      {owned.map(({ ability, priv }) => {
        const inPhase = roundType === ability.phase;
        /* Design note #349: the subphase gate, which only applies inside
           the right round. `undefined` means the whole round, so an
           ability without one is in-step by definition. */
        const inSubPhase =
          ability.subPhase === undefined || orSubPhase === ability.subPhase;
        const reason = !inPhase
            ? `Only usable during ${ability.phase === "OperatingRound" ? "an Operating Round" : "a Stock Round"}.`
            : !inSubPhase
              ? `Only usable during the ${ability.subPhase} step of an Operating Round.`
              : null;
        return (
          <div key={ability.privateId} style={styles.row}>
            <div style={styles.rowText}>
              <span style={styles.nameLine}>
                <span style={styles.privateName}>
                  {priv?.name ?? `Private #${ability.privateId}`}
                </span>
                {/* ==================================================
                     DESIGN NOTE 443: THE REVENUE, WHERE THE DECISION IS
                    ==================================================

                     REPORTED: the Mohawk and Camden can be exchanged for
                     shares, but their Operating Round revenue is not
                     visible on the Stocks tab for comparison.

                     Both exchanges are a trade: give up a certificate that
                     pays every Operating Round, receive a 10% share that
                     pays dividends and can be sold. A player weighing that
                     needs the figure they are giving up, and this panel --
                     the one surface carrying the exchange BUTTON -- was the
                     one place on the tab that did not show it.

                     It rides on the name rather than in the description
                     because it is a NUMBER a player scans for, and a figure
                     buried mid-sentence in a rules paragraph is not
                     scannable. Tabular numerals for the same reason every
                     other money column in this app uses them. */}
                {priv && (
                  <span
                    style={styles.revenue}
                    title={`${priv.name} pays $${priv.revenue_per_or} to its owner every Operating Round.`}
                  >
                    ${priv.revenue_per_or}/OR
                  </span>
                )}
              </span>
              <span style={styles.description}>{ability.description}</span>
            </div>
            {/* Design note #442: one button per action. Most powers have a
                single one and render exactly as before; the D&H has two. */}
            <div style={styles.actionColumn}>
              {ability.actions.map((action) => {
                const used = usedAbilities.has(action.key);
                const blocked = reason ?? (used ? "Already used this game." : null);
                return (
                  <button
                    key={action.key}
                    type="button"
                    style={{
                      ...styles.useButton,
                      ...(blocked !== null || !controlsEnabled ? styles.useButtonDisabled : {}),
                    }}
                    disabled={blocked !== null || !controlsEnabled}
                    onClick={() => onUseAbility(ability, action)}
                    title={blocked ?? ability.description}
                  >
                    {used ? "Used" : action.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  abilityError: {
    margin: "0 0 8px",
    padding: "7px 9px",
    borderRadius: "6px",
    border: "1px solid #6b4a2f",
    backgroundColor: "#2a1d13",
    color: "#e6c08a",
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
  },
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
  /* Design note #443: the name and its revenue on one baseline, so the
     figure reads as a property of the company rather than as a second
     line of prose. */
  nameLine: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
  revenue: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#7ee0a1",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    cursor: "help",
  },
  /* Design note #442: a column, not a row. Two buttons side by side would
     force the D&H's long labels to wrap mid-phrase at this panel's width;
     stacked, each keeps its own line and the pair reads as two choices
     rather than one split control. */
  actionColumn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "4px",
    flexShrink: 0,
  },
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
