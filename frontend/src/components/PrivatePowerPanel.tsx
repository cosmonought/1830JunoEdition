// frontend/src/components/PrivatePowerPanel.tsx
//
// The private companies' special abilities, as controls.
//
// Design note #0: the abilities had no surface at all. The privates were otherwise fully modelled -- auctioned,
// owned, paying revenue, closing at Phase 5 -- everything except the one thing that makes them interesting.
//
// Design note #1: WHAT THESE BUTTONS HONESTLY ARE. `ExecuteMsg` has no variant for using a private's power,
// and `GAMEPLAY_MESSAGE_KEYS` -- the session key's on-chain allow-list, not merely a client convenience --
// could not carry one if there were. So a button here CANNOT dispatch, and pretending otherwise would be the
// worst available outcome: a control that broadcasts a message certain to be rejected, or one that logs a
// success the chain never saw. These are SANDBOX-ONLY controls, and outside sandbox the panel does not render.
// The reducer action marks the ability USED and logs it; it does not lay the tile, place the station or move
// the certificate, because inventing a half-version is how a mock starts disagreeing with the contract.
//
// Design note #2: two gates, and they are different questions -- OWNERSHIP is a fact about the board, PHASE is
// a rule. An out-of-phase ability renders disabled WITH the reason; one the viewer does not own is absent.
//
// Design notes #349/#350/#441/#442/#470/#573b/#576: see `docs/ai_architecture/contract_economy.md`.

import React from "react";
// Design note #725: the D&H rule, stated once.
import { CSL_POWER_DESCRIPTION, DH_POWER_DESCRIPTION } from "../utils/dhPower";

import { FONT_SIZE } from "../styles/typography";
import type { OperatingSubPhase } from "./OperatingSubPhaseStepper";
import type { PrivateCompanyState, RoundType } from "../utils/gameState";

/* Design note #349: A ROUND IS NOT PRECISE ENOUGH. Two things were wrong and the first hid the second.
   IT WAS NOT ACTUALLY SHOWING IN A STOCK ROUND -- C&SL is tagged `OperatingRound`, so it rendered DISABLED
   with "Only usable during an Operating Round". Disabled, but present: a row with the company's name and a
   greyed button, in a panel titled Private Powers, on a screen where the power cannot be used at all. #2's
   argument for showing an out-of-phase ability holds for a power the player will use LATER THIS ROUND -- it
   does not hold across a round boundary, where the answer is "not now, and not for a while".
   AND THE GATE WAS TOO COARSE: even inside an Operating Round, a free tile lay is only legal during Lay Track,
   and `AbilityPhase` had no way to say so -- so the panel could not have been right even in principle.
   The type now carries an optional SUBPHASE. Absent means "any subphase of that round", the honest default for
   the powers that genuinely are round-wide. */
export type AbilityPhase = "OperatingRound" | "StockRound";

/* Design note #441: WHO OWNS A POWER IS NOT WHO OWNS THE PRIVATE. The panel filtered on `priv.owner ===
   viewerAddress` -- a PLAYER-level test -- and applied it to every ability alike. That is right for half of
   them and wrong for the other half, and 1830 draws the line in the text of the powers themselves:
     "A player owning the MH may exchange it for a 10% share of NYC"
     "A railroad owning the DH may lay a track tile and a station token"
   The exchanges belong to a PERSON and fire on their stock turn; the track powers belong to a CORPORATION and
   fire on its operating turn. A private sitting in a player's pocket confers no track power on anything --
   `owner_protocol_id` is null until a corporation buys it, and until then there is no railroad owning the DH
   for the rule to name.
   So the scope is a property of each ability rather than an assumption the panel makes once for all of them. */
export type AbilityScope = "player" | "corporation";

/** One button on an ability's row. */
export interface PrivateAbilityAction {
  /** Unique across every ability -- what the spent-marker is keyed by. Design note #442: keyed per ACTION, not
   *  per private. The D&H grants a tile lay AND a token placement, and 1830 lets a corporation take both in the
   *  same turn; keying by `private_id` would have made either one consume the other. */
  key: string;
  /** Design note #782: THE STEP THIS ACTION BELONGS TO.
   *
   *  REPORTED: "During Run Routes, the 'Private Powers' subpanel is still visible. There's no reason for it
   *  to be visible." It was gated on the ROUND, and #349's `subPhase` on the ability was never consulted --
   *  so both corporate powers rendered at every step of an Operating Round, including two they can do
   *  nothing in.
   *  ON THE ACTION RATHER THAN THE ABILITY, because the D&H spans two steps: its tile is a Track action and
   *  its free station is a Tokens action. An ability-level field cannot say that, which is probably why the
   *  one #349 added went unused. */
  subPhase?: OperatingSubPhase;
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
  /* Design note #807: `subPhase` IS GONE FROM THE ABILITY, and this is what it did on its way out.
   *
   * REPORTED: "I was able to correctly use the Lay Track action and was bumped into the Place Station action,
   * but the Special Power for Place Station is grayed out."
   *
   * THIS PANEL HAD TWO STEP GATES READING TWO DIFFERENT FIELDS. #782 moved the step onto the ACTION and
   * taught the FILTER to read it -- correctly, and its own note says why: "`subPhase` sat on the ABILITY, and
   * the D&H is one ability spanning two steps ... An ability-level field cannot express that." It then left
   * the ability field in place, where `reason` was still reading it to decide whether to GREY the button.
   * So on the Tokens step the D&H's `dh-token` action passed the filter (its own step matched) and was
   * disabled by the reason (its ABILITY still said "Track"). On screen: the right button, in the right step,
   * greyed out with a tooltip naming a step the player had already left.
   *
   * ONE FIELD, ONE READER. The step is a property of the action, and the filter is the only thing that asks
   * it -- an action out of its step is not rendered at all, so there is no second question to answer. */
  /** Design note #349: hidden entirely outside its round rather than shown
   *  disabled. Set for powers whose round is far away when it is not the
   *  current one; left off where the wait is short enough that a disabled
   *  row is useful context rather than noise. */
  hideOutOfRound?: boolean;
}

/* Design note #350: CAMDEN & AMBOY WAS MISSING, NOT ABSENT BY DESIGN. The comment that stood here said C&A
   "is granted on purchase rather than triggered", so it deserved no button -- but the auction's own catalog
   had described it as an exchange since it was written, and an EXCHANGE is a decision the owner makes on
   their turn, exactly the shape of the Mohawk's NYC exchange sitting above it.
   (Superseded by #576: the share arrives on PURCHASE and the private stays open, so the row keeps its
   description and loses the control.) */
export const PRIVATE_ABILITIES: readonly PrivateAbility[] = [
  {
    privateId: 2,
    actions: [{ key: "csl-tile", label: "Lay Track (B20)", subPhase: "Track" }],
    /* Design note #726: the connection waiver named. The old sentence was right about the EXTRA lay -- unlike
       the D&H's, which #725 had to correct -- and silent about the half that makes the power worth owning. */
    description: CSL_POWER_DESCRIPTION,
    phase: "OperatingRound",
    // Design note #441: "A railroad owning the CL may lay a tile on the
    // CL's hex" -- the corporation, not the player holding the certificate.
    scope: "corporation",
    /* Design note #349: a tile lay is legal in ONE step of the round, and the panel is hidden outside the
       round entirely -- a Stock Round has no track step to be waiting for. The step now rides on the action
       above (#782), which is the only place that can be right for a power spanning two steps (#807). */
    hideOutOfRound: true,
  },
  {
    /* Design note #725: THE D&H IS ONE POWER IN TWO STEPS. The paragraph below is kept because its costing is
       right and its conclusion is wrong: the tile and the token are NOT independent. Reported: "the Place
       Station for free action ... should only be allowed if the track lay also happened". Two buttons remain
       the right control -- they are separately spendable -- but the second is gated on the first, and the
       reasoning for that is in `dhPower.ts` #725.
       Design note #442: THE D&H IS TWO POWERS, AND F16 IS NOT FREE. The caption read "may lay a tile AND place a
       station on F16 at no cost", which is wrong twice over and wrong in the direction that costs a player money:
       `privateCatalog.ts` carries the rulebook's own rule -- the mountain costs $120 as usual, and only the TOKEN
       is free. A caption promising a free tile on a $120 mountain hex is an invitation to a purchase the player
       cannot afford to have misjudged.
       "AND" was the second error: the rulebook grants the tile and the token independently -- a corporation may
       take either, both, or neither -- and one button could not express that, which is also why the one button had
       nothing coherent to do.
       So: one caption stating both costs honestly, and two buttons. */
    privateId: 3,
    actions: [
      { key: "dh-tile", label: "Lay Track (F16)", subPhase: "Track" },
      /* Design note #781/#782: the free station is a TOKENS-step action. Naming the step here is the second
         half of #781, which taught `stationPlacementBlockReason` that this placement exists -- together they
         mean the step stays open AND the button is on screen when it does. */
      { key: "dh-token", label: "Place Station Token for $0 (F16)", subPhase: "Tokens" },
    ],
    /* Design note #725: THE CAPTION WAS WRONG TWICE MORE. #442 corrected an earlier version and introduced two
       fresh errors of its own -- "AND/OR", which made the token reachable without the lay, and "in addition to
       its normal lay", which it is not. The wording now lives in `dhPower.ts` so the panel, the rules reference
       and the auction card cannot drift into three accounts of one rule again. */
    description: DH_POWER_DESCRIPTION,
    phase: "OperatingRound",
    scope: "corporation",
    /* Design note #807: THE LINE THAT GREYED THE FREE STATION. `subPhase: "Track"` was true of the D&H's
       FIRST action and false of its second, and there is no single value that would have been right -- which
       is the whole reason #782 moved the field onto the actions. Removing it here is the other half of that
       move; the two actions above carry "Track" and "Tokens" and nothing else needs to know. */
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
  /* Design note #576: THE C&A ROW HAS NO BUTTON, BECAUSE IT HAS NO ACTION. #350 read it as an exchange the owner
     triggers. That is not the rule -- the share arrives on PURCHASE, free, and the company STAYS OPEN and goes
     on paying $25 an Operating Round. The auction now grants it where the win resolves (`App.tsx #576`).
     So the row keeps its DESCRIPTION -- a player looking here should still learn what the company did for them --
     and loses the control, because there is nothing left for the owner to trigger. An empty action list renders
     the text without a button, which is the honest shape for a power that has already happened.
     NOT DELETED ENTIRELY, deliberately: a C&A owner who finds no row at all would reasonably conclude the company
     has no power, which is the confusion #350 was originally written to fix. */
  {
    privateId: 5,
    actions: [],
    description:
      "Camden & Amboy — its purchaser received a 10% share of the Pennsylvania Railroad (PRR) free, at the moment they won it. Nothing further to trigger: the company stays open and keeps paying its revenue.",
    phase: "StockRound",
    scope: "player",
  },
  /* Design note #441: THE B&O ROW IS GONE. Its phase was `"StockRound"`, so hiding it there hides it everywhere
     -- the requirement is a deletion written as a restriction. And it should be deleted, because the button had
     already been overtaken: #399 moved the grant to the moment the private is WON, since a presided-over company
     with no price is a state #387 refuses to render. By the time any Stock Round exists the presidency is long
     since granted, so this button offered to do a thing that had already happened.
     The B&O is still visible to its owner everywhere privates are listed. What is removed is a control, not
     information. */
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
  /** Design note #441: the corporation currently operating. A corporation-scoped power belongs to whoever OWNS
   *  the private and is usable on that corporation's turn, so this is what `owner_protocol_id` is compared
   *  against. `null` outside an Operating Round, which hides every corporate power by construction. */
  actingProtocolId: number | null;
  /** Design note #441: the acting corporation's president. A corporate
   *  power is executed by the person holding the controls, so the row
   *  appears for them and nobody else at the table. */
  actingPresident: string | null;
  /** Design note #442: actions already fired this game, by action KEY -- not by `private_id`.
   *  Design note #725: the D&H's two are NOT independent, which #442 asserted and the report corrected. Keyed
   *  per action still, because they are separately spendable; what changed is that the second is gated on the
   *  first, via `blockedActions` below. */
  usedAbilities: ReadonlySet<string>;
  /** Design note #725: why a specific action cannot be taken right now, by action key. Distinct from `reason`,
   *  which speaks for a whole private -- the D&H needs to grey ONE of its two buttons and say why, while the
   *  other stays live. */
  blockedActions?: Readonly<Record<string, string | null>>;
  onUseAbility: (ability: PrivateAbility, action: PrivateAbilityAction) => void;
  controlsEnabled: boolean;
  /* Design note #573b: WHY IT REFUSED, IN WORDS. A DISABLED BUTTON WOULD NOT DO -- the exchange's legality
     depends on the player's holding in a corporation this panel does not otherwise read, and the interesting
     refusals ("you hold 60% of the PRR", "no NYC certificate is available") are facts about somewhere else on
     the board. A greyed control with a tooltip is right when the reason is local; this one has to be a sentence
     the player can act on.
     SHOWN AFTER THE ATTEMPT rather than pre-emptively, because the attempt costs nothing: the power stays intact
     on a refusal, so clicking to find out is a legitimate way to ask. */
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
  blockedActions,
  onUseAbility,
  controlsEnabled,
  abilityError = null,
}: PrivatePowerPanelProps) {
  if (!sandbox) return null;

  /* Design note #441: TWO OWNERSHIP TESTS, ONE PER SCOPE. PLAYER scope is what the panel always did, and for the
     two exchanges it was right. CORPORATION scope needs both halves: without the first, a president whose
     corporation does not own the D&H sees its power (the reported bug); without the second, every player at the
     table sees a button only one of them may press.
     `owner_protocol_id` answers "which railroad owns this", and `gameState.ts` records that it is mutually
     exclusive with `owner` -- so a private in a player's pocket has a null protocol id and matches no
     corporation, which is exactly the rule. */
  const ownsForScope = (ability: PrivateAbility, priv: PrivateCompanyState): boolean => {
    if (ability.scope === "player") {
      return viewerAddress !== null && priv.owner === viewerAddress;
    }
    /* Design note #470: EXACT identity, both halves. `owner_protocol_id` must equal the corporation currently
       operating -- not merely be non-null, and not the president's other corporation -- and the viewer must be the
       person holding that corporation's controls. */
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
      /* Design note #470: THE OUT-OF-ROUND POWERS LEAKED INTO THE OR. #441's corporate half held; the leak was the
         two PLAYER-scoped exchanges, whose phase is `"StockRound"` and which did not opt into hiding -- so during an
         Operating Round they rendered DISABLED: a Private Powers heading and two dead rows, on a panel whose entire
         subject is the acting corporation, describing privates that corporation does not own and cannot use.
         #349 introduced the opt-in reasoning that a disabled row is "useful context rather than noise" when the wait
         is short. True of a power the viewer will use SOON on this same panel; not true here, where the wait is not
         short, it is a different subject.
         SO THE ROUND MUST MATCH, ALWAYS. The opt-in becomes redundant rather than wrong, and is left on the two
         entries that set it as a statement of intent. A power is shown in its own round or not at all. */
      roundType === entry.ability.phase,
  )
    /* Design note #782: WHAT IS LEFT TO DO HERE, RIGHT NOW.
     *
     * Two reports, one filter. "During Run Routes, the Private Powers subpanel is still visible -- there's no
     * reason for it to be visible", and "once CSL and DH's powers are used, they do not need to be displayed".
     *
     * A SPENT ACTION IS NOT CONTEXT. #349 argued that a disabled row is "useful context rather than noise"
     * when the wait is short, and #470 already found the limit of that: a row whose wait is not short is a
     * different subject. A row whose wait is FOREVER -- the power is gone -- is not a subject at all.
     * FILTERED ON THE ACTIONS, then the ability, so the D&H keeps its token row after its tile row goes and
     * disappears only when both are spent. An ability with nothing left to offer is dropped whole rather than
     * rendered as a heading over an empty list. */
    .map((entry) => ({
      ...entry,
      ability: {
        ...entry.ability,
        actions: entry.ability.actions.filter(
          (action) =>
            !usedAbilities.has(action.key) &&
            (action.subPhase === undefined || action.subPhase === orSubPhase),
        ),
      },
    }))
    .filter((entry) => entry.ability.actions.length > 0);

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

      {/* Design note #807: `reason` IS GONE, AND BOTH OF ITS ARMS WERE DEAD OR WRONG.
         It read:
           `!inPhase  ? "Only usable during an Operating Round." : !inSubPhase ? "Only usable during the
            {ability.subPhase} step..." : null`
         THE ROUND ARM WAS UNREACHABLE. `owned` above filters on `roundType === entry.ability.phase`, so by
         the time a row renders, `inPhase` is true by construction -- #470 made it so and this sentence was
         never revisited. An arm that cannot fire still passes every test written for it (#788).
         THE STEP ARM WAS THE REPORTED BUG. It asked the ABILITY's step while the filter asked the ACTION's,
         and the D&H is the one power where those differ.
         SO THERE IS NO THIRD GATE. An action reaches this map only if its own step is the current one, which
         means the only remaining questions are the per-action block (`dhPower.ts`'s ordering) and whether it
         has been spent. Both are below, and both are about the POWER rather than about the clock. */}
      {owned.map(({ ability, priv }) => {
        return (
          <div key={ability.privateId} style={styles.row}>
            <div style={styles.rowText}>
              <span style={styles.nameLine}>
                <span style={styles.privateName}>
                  {priv?.name ?? `Private #${ability.privateId}`}
                </span>
                {/* Design note #443: THE REVENUE, WHERE THE DECISION IS. Both exchanges are a trade -- give up a certificate
                   that pays every Operating Round, receive a 10% share that pays dividends and can be sold -- and a player
                   weighing that needs the figure they are giving up. This panel, the one surface carrying the exchange BUTTON,
                   was the one place on the tab that did not show it.
                   It rides on the name rather than in the description because it is a NUMBER a player scans for, and a figure
                   buried mid-sentence in a rules paragraph is not scannable. */}
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
                /* Design note #725: the per-action reason wins over the generic "already used", because it is
                   the more specific true statement -- "lay the F16 tile first" tells a player what to do and
                   "already used" would be a lie about a power they still hold.
                   Design note #807: and it is now FIRST rather than second. `reason` used to sit in front of
                   it and shadowed it whenever it fired -- so the one sentence that could tell a D&H president
                   what to do next was unreachable in the step where they needed it. */
                const blocked =
                  blockedActions?.[action.key] ??
                  (used ? "Already used this game." : null);
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
