// frontend/src/components/HostSetupCard.tsx
//
/* ==================================================================
    DESIGN NOTE 1415: THE TERMS ARE CHOSEN BEFORE THE ROOM EXISTS
   ==================================================================
   ASKED: "Host Game" opens a first screen -- the game type as three boxes, the pace, public or private -- and
   "Continue" opens the house rules: the ante, the player count, the tile set, the bank, and the four rule
   variants, each tagged with what it does to the game. "Create Room" then opens the waiting room with those
   choices shown as terms, not controls.
   TWO STEPS RATHER THAN ONE LONG FORM, because the first step changes what the second offers: the type decides
   which tile-set tag is shown (easier on the printed map, recommended on 18XX+, nothing under the Level Playing
   Field, which brings the tray), which bank is recommended, and how many seats the board has. Choosing the type
   RESETS the second step to that type's recommended defaults -- "recommended options default on" -- so a host
   who goes back and changes the type is not left holding the previous type's choices.
   THE ANTE IS A PLACEHOLDER. Real JUNO moves through the wallet, which is not wired to this screen yet; the
   control is shown disabled at 0 so the flow reads whole, and the line under it says where the fee goes.
   MOUNTED AT THE LOBBY'S ROOT like the rejoin cards (#1360): the scene is `pointer-events: none`, and a card
   inside it is a card nobody can click. */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import {
  GAME_LENGTH_BLURB,
  GAME_MODE_COPY,
  GAME_TYPE_COPY,
  GAME_TYPE_ORDER,
  VARIANT_COPY,
  type GameLength,
  type GameMode,
  type GameType,
  type GameVariants,
  type VariantTag,
  bankSizeLabel,
  plusTilesTagFor,
  recommendedLengthFor,
  recommendedVariantsFor,
} from "../gameEngine/gameVariants";
import { MIN_PLAYERS, maxPlayersFor } from "../gameEngine/gameSetup";
import { DEFAULT_ROOM_SETUP, type RoomSetup, type RoomVisibility } from "../utils/sandboxRoomSummary";
import { NativeModal } from "./NativeModal";

/** The type boxes' sentences, as asked. `GAME_TYPE_COPY`'s blurbs are the waiting room's and the Lobby's older
 *  form's; these are the host's first screen, which reads them side by side. */
export const HOST_TYPE_BLURB: Readonly<Record<GameType, string>> = {
  standard: "The classic game.",
  plus: "A larger map, suitable for higher player counts or less blocking at lower player counts.",
  levelPlayingField: "A rebalanced map with additional tiles, private companies, and railroads.",
};

/** Design note #1447: the normalised title art for each game, one 1080x810 canvas each. Exported so the
 *  presentation layer has one table to assert against and the filenames are not spelled in three places. */
export const GAME_TYPE_ART: Readonly<Record<GameType, string>> = {
  standard: "game-18xx.jpg",
  plus: "game-18xx-plus.jpg",
  levelPlayingField: "game-18xx-lpf.jpg",
};

export const VISIBILITY_COPY: Readonly<Record<RoomVisibility, { label: string; blurb: string }>> = {
  public: { label: "Public", blurb: "Listed on the Lobby. Anyone can join, and anyone can watch." },
  private: { label: "Private", blurb: "Unlisted. Players join by room code only, and nobody can watch." },
};

/** The four rule variants in the order the house-rules step reads them, each with its tag. The titles are the
 *  short forms asked for on this screen; the blurbs are the shared copy (#961a), so the rule reads the same
 *  here as in the waiting room. */
export const HOUSE_RULE_ROWS: ReadonlyArray<{
  key: "gentleRust" | "dynamicStockMarket" | "delayedAuction" | "unpredictableRevenue";
  title: string;
  tag: VariantTag;
}> = [
  { key: "gentleRust", title: "Gentle Rust", tag: "easier" },
  { key: "dynamicStockMarket", title: "Dynamic Market", tag: "riskier" },
  { key: "delayedAuction", title: "Delayed Auction", tag: "harder" },
  { key: "unpredictableRevenue", title: "Unpredictable Routes", tag: "chaotic" },
];

/** The dev-subsidy line under the ante -- the project's gas-subsidisation rule, said where the money is set. */
export const ANTE_SUBSIDY_NOTE =
  "Antes are off for the playtest. When they are on, a small share of every ante funds the developer treasury that pays players' transaction fees.";

export interface HostSetupCardProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (variants: GameVariants, setup: RoomSetup) => void;
}

type Step = "type" | "rules";

/** ==================================================================
 *   DESIGN NOTE 1630: `aria-modal="true"` IS A PROMISE ABOUT THE KEYBOARD
 *  ==================================================================
 *
 * #1629 gave this dialog Escape and sent focus home on close. It left three things that the `aria-modal`
 * attribute had been claiming since the card was written, and measured false in Chromium at 430 and 1440:
 *   (1) focus stayed on the "Host game" button BEHIND the dialog when it opened;
 *   (2) Tab walked straight out of the card into the lobby underneath it;
 *   (3) pressing Continue unmounted the focused Continue button and dropped focus onto `<body>`.
 *
 * ONE MORE MEASUREMENT DECIDED THE SHAPE OF THE FIX, and it is the reason the card itself is focusable:
 * clicking dead space inside the card -- the header bar, a section label -- moves `document.activeElement` to
 * `<body>` in Chromium. That is why Escape STAYS on `window` (#1629) rather than moving to this element, and
 * why the card carries `tabIndex={-1}`: a click that would otherwise strand focus outside the dialog now
 * lands on the dialog. The card is a fallback for a click, never an initial target. */

/* #1653: `tabbableWithin` MOVED TO `NativeModal`, unchanged. It was written here (#1630) and was the only
   measured implementation in the codebase, which is exactly why the shared boundary took this one rather than
   writing a second -- Host Game's Tab order had to come out of that move byte-for-byte identical. It is
   re-exported so nothing that imported it from here has to move with it. */
export { tabbableWithin } from "./NativeModal";

export function HostSetupCard({ busy, error, onClose, onCreate }: HostSetupCardProps) {
  const [step, setStep] = useState<Step>("type");
  const [type, setType] = useState<GameType>("standard");
  const [mode, setMode] = useState<GameMode>("live");
  const [visibility, setVisibility] = useState<RoomVisibility>(DEFAULT_ROOM_SETUP.visibility);
  const [variants, setVariants] = useState<GameVariants>(() => recommendedVariantsFor("standard", "live"));
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  /* #1447: a card whose artwork cannot be fetched or decoded falls back to the text-only box this step
     used before -- an empty black well would read as a broken card. */
  const [artFailed, setArtFailed] = useState<Partial<Record<GameType, boolean>>>({});

  const gameRadio = useRadioGroup(GAME_TYPE_ORDER, type, setType);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLSpanElement | null>(null);

  /* #1630: the FIRST MEANINGFUL DECISION on the step, and deliberately not the close button, the heading or
     the card. The selected Game radio is already the group's single Tab stop (#1448's roving implementation),
     so focusing it creates nothing new -- it puts the keyboard exactly where the roving group says it belongs,
     and a Tab from there leaves the group the way it always did. Read through `data-radio-key`, which is the
     contract `useRadioGroup` already publishes; the hook itself is untouched. */
  const focusSelectedGameRadio = () => {
    const node = gameRadio.ref.current?.querySelector<HTMLElement>(`[data-radio-key="${type}"]`);
    node?.focus();
  };

  /* #1630: THE STEP CHANGE IS A NAVIGATION, so focus goes with it -- measured before the fix, Continue
     unmounted the button holding focus and left `document.activeElement` on `<body>`.
     A LAYOUT EFFECT rather than an effect, so focus lands before the browser paints the new step and there is
     no frame in which the dialog is on screen with focus outside it.
     FORWARD GOES TO THE HEADING, which is the wizard convention and the thing that announces the new context:
     "House rules", heading level 2, read out because focus arrived there. That is the announcement, so there
     is no live region -- one would say the same thing twice.
     BACK GOES TO THE SELECTED GAME RADIO, not the heading: step one's context was already announced when the
     dialog opened, and the player returning to it is returning to a decision, not to a new screen. */
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    if (step === "rules") headingRef.current?.focus();
    else focusSelectedGameRadio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* #1630, MOVED BY #1653: THE BOUNDARY `aria-modal` CLAIMED, AND EVERY NATIVE MODAL NOW CLAIMS.
     This dialog's Tab trap used to live here, on the card. It is `NativeModal`'s now -- rooted at the
     `<dialog>` rather than at the card, treating "not one of the stops" as outside exactly as this did, and
     therefore producing the same six stops in the same order in both directions. Two traps on one dialog
     would compete, so this one is gone rather than left beside it; `hostNativeDialog.test.tsx` and
     `hostDialogEscape.test.tsx` still assert the order, unchanged, and are what proves the move was exact. */

  /* ==================================================================
      DESIGN NOTE 1629: THE TWO THINGS EVERY OTHER MODAL IN THIS APP ALREADY DID
     ==================================================================
     REPORTED: Escape does not dismiss this dialog. Measured before the fix, in Chromium at 430 and 1440: the
     dialog stayed open on Escape from BOTH steps, and closing it through the visible controls left focus on
     `<body>` -- `document.activeElement` was BODY after the x and after Cancel, because the button the player
     pressed was unmounted with the card.

     NEITHER IS A NEW IDEA HERE. `MarketPeekModal` already carries both halves and `BuyLicenseModal` carries
     the first, in the same shape: a `keydown` listener mounted only while the dialog is up, and #1141's
     opener capture restored on unmount. This dialog is simply the one that never got them.

     AMENDED BY #1641. The two sentences that stood here said there was no shared modal primitive to reach for
     and that extracting one would mean re-verifying ten consumers, so the inconsistency was reported rather
     than fixed. The audit did that reporting (`claude/modal-audit-2026-09-18.md`), and its batch 0 extracted
     exactly this lifecycle into `useDialogDismissal` -- with this dialog as its ONLY consumer, so that the
     boundary gets a suite of its own before any of the other twenty surfaces is moved onto it. Everything the
     rest of this note describes is still exactly what happens; it happens one call away, and the fifty cases
     below this file are unchanged.

     THE ESCAPE PATH IS THE SAME CLOSE PATH, and that is the whole design: it calls `onClose`, the identical
     prop the x, the Cancel button and the backdrop click call. `onClose` is `setHostSetup(false)` in `Lobby`,
     which UNMOUNTS this component -- so every scrap of temporary state here (`step`, `type`, `mode`,
     `visibility`, `variants`, `playerCount`, `artFailed`) is reset by the unmount itself rather than by any
     reset code. There is no second partial path to keep in step, because there is no second path.

     GATED ON `busy`, for the same reason the x is `disabled={busy}` and the backdrop click is
     `busy ? undefined : onClose`: while the room is being opened the authoritative close is not available,
     and Escape must not be a way around a rule the visible controls enforce.

     `defaultPrevented` IS THE FIRST-REFUSAL CHECK. If a nested transient surface is ever added inside this
     card -- a confirmation, a menu, a picker -- it handles Escape and calls `preventDefault`, and this
     listener stands down rather than closing a second layer on one keypress. (An inner surface that calls
     `stopPropagation` instead also wins, because `window` is on the propagation path.) Today there is NO such
     surface in this dialog: step one is three game cards, Pace and Visibility; step two is the ante, the
     player count and the house rules. The mechanism is here because the cost of adding it later, after the
     first nested surface, is a bug nobody attributes to this file.

     WHAT IS DELIBERATELY NOT CHANGED: where focus goes when the dialog OPENS. It stays on the "Host game"
     button, which is what it did before -- and because the opener is also where focus is restored to, the
     common pointer-open/Escape-close round trip moves focus nowhere at all and therefore cannot manufacture a
     ring `:focus-visible` did not ask for. Moving focus INTO the card on open is what `aria-modal="true"`
     properly wants, and it is a bigger change than this one; it is reported, not taken. */
  /* ==================================================================
      DESIGN NOTE 1652: THE DIALOG IS THE ELEMENT, AND THE POLICY IS AN ATTRIBUTE
     ==================================================================
     TWO THINGS #1650 GOT WRONG, both measured rather than argued:

       (1) IT PUT TWO DIALOGS IN THE ACCESSIBILITY TREE. `Accessibility.getFullAXTree` on the real Lobby
           returned `role=dialog name=""` for the native element and `role=dialog name="Host a game"` for the
           card inside it. Chromium ignores `role="presentation"` on a `<dialog>` -- the element's implicit
           role is `dialog` and only `alertdialog` may replace it -- so the wrapper was a second, unnamed
           dialog. The name now lives on the native element (`NativeModal`'s `name`), and the card below is an
           ordinary `<div>`: one named dialog, same pixels.

       (2) IT FOUGHT THE PLATFORM INSTEAD OF STATING A POLICY. Escape was refused with `preventDefault` and,
           when Chromium overruled the refusal, the dialog was put back with `showModal()`. `closedby` says
           the same thing as a state: `none` while `busy`, `closerequest` otherwise. Measured, `closedby="none"`
           survives six rapid Escapes and a backdrop click with no `cancel` and no `close` at all -- so the
           busy gate is now the engine's, and there is no close-and-reopen to see.

     WHAT DID NOT CHANGE. `dismissible={!busy}` is the same rule the visible controls enforce (the x is
     `disabled={busy}`, the scrim click is `busy ? undefined : onClose`). `onDismiss` is `onClose` -- the SAME
     authoritative close the x, Cancel and the scrim call, which unmounts this component, which is what resets
     the step and every selection. `restoreOpener` keeps #1641's guarded return to the "Host game" button.
     `defaultPrevented` first refusal survives untouched, and is now the engine's: a nested surface that
     handles Escape suppresses the close request without knowing this dialog exists. */

  /* #1630: INITIAL FOCUS STAYS HERE -- where focus belongs on open is a judgement about this surface, not a
     lifecycle (see the hook's own note). It is declared AFTER the hook call, and that order is load-bearing:
     the hook captures `document.activeElement` in its own mount effect, effects run in declaration order, and
     so the opener recorded is the control the player actually pressed rather than the radio this line is
     about to focus. The two used to share one effect body, which made the ordering obvious; now it is the
     order of two calls, so a case asserts it directly. */
  useEffect(() => {
    focusSelectedGameRadio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seatMax = maxPlayersFor(variants);
  const tileTag = plusTilesTagFor(type);
  const recommendedLength = recommendedLengthFor(type);

  const continueToRules = () => {
    /* The recommended defaults for the type chosen -- see the note at the top. An exact count the new board
       cannot seat goes back to "any". */
    const next = recommendedVariantsFor(type, mode);
    setVariants(next);
    setPlayerCount((current) => (current !== null && current > maxPlayersFor(next) ? null : current));
    setStep("rules");
  };

  const create = () => {
    onCreate({ ...variants, mode }, { visibility, playerCount, anteUjuno: DEFAULT_ROOM_SETUP.anteUjuno });
  };

  return (
    <NativeModal
      /* #1630 and #1652: CONSTANT, and it was not. The name was following the step, so on step two the dialog
         announced itself as "House rules" -- a different dialog, by name, from the one the player opened. The
         dialog is "Host a game" throughout; the STEP is announced by the heading below, which is where focus
         goes when the step changes. It is declared HERE because the native element is the dialog now. */
      name="Host a game"
      dismissible={!busy}
      onDismiss={onClose}
      onScrimClick={busy ? undefined : onClose}
      restoreOpener
      scrimStyle={styles.backdrop}
      className="host-scrim"
    >
      <style>{HOST_SETUP_CSS}</style>
      <div
        ref={dialogRef}
        className="host-card"
        /* #1630: focusable as a CLICK FALLBACK only. Measured: a click on dead space inside this card sends
           `document.activeElement` to `<body>` in Chromium, which would put focus outside the dialog while
           the dialog is still up. With this, such a click lands here instead. It is `-1`, so it is not a Tab
           stop and `tabbableWithin` excludes it. */
        tabIndex={-1}
        style={{ ...styles.card, ...(step === "type" ? styles.cardGallery : null) }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={styles.header}>
          {/* #1630: a heading in the accessibility tree as well as on screen, and the focus target for the
              forward step change. `tabIndex={-1}` makes it focusable without making it a Tab stop. */}
          <span
            ref={headingRef}
            className="host-heading"
            role="heading"
            aria-level={2}
            tabIndex={-1}
            style={styles.heading}
          >
            {step === "type" ? "Host a game" : "House rules"}
          </span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close" disabled={busy}>
            ×
          </button>
        </div>

        {step === "type" ? (
          <>
            {/* ==================================================================
                 DESIGN NOTE 1447: THREE EDITIONS, NOT THREE SETTINGS
                ==================================================================
                ASKED: use the three title images to redesign this step, so the choice reads as three editions
                of one game rather than three generic option boxes.
                THESE MAY BE BOUNDED OBJECTS -- the rest of the app has been moving AWAY from cards (#1443), but
                a card earns its border here: these are mutually exclusive choices, and the border is what says
                only one of them will be true. The gold artwork carries the character; the card stays dark and
                adds no ornament of its own.
                THE ARTWORK IS NOT THE TITLE. Every card states its game in text, which is the accessible name
                and the authority; each image is `alt=""` so the name is announced once, not twice.
                NORMALISED IN THE FILE, NOT IN THE STYLESHEET. `game-18xx*.jpg` are derivatives built on one
                1080x810 canvas with the `8` of 18XX measured to the same height and placed on the same
                baseline in all three (docs/ai_architecture/title_art_normalisation.md), so `contain` in an identical well is
                the whole of the presentation logic -- no per-logo scale or offset to keep in step with the art.
                The originals are untouched.
                THE WELL IS BLACK because the artwork's own ground is black; a well of any other colour would
                show the file's edge as a rectangle. */}
            <Section title="Game">
              <div
                ref={gameRadio.ref}
                style={styles.typeGrid}
                role="radiogroup"
                aria-label="Game"
                onKeyDown={gameRadio.onKeyDown}
              >
                {GAME_TYPE_ORDER.map((candidate) => {
                  const selected = candidate === type;
                  const art = artFailed[candidate] !== true;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      {...gameRadio.optionProps(candidate)}
                      className="host-type-card"
                      style={{ ...styles.typeBox, ...(selected ? styles.typeBoxSelected : {}) }}
                      data-testid={`host-type-${candidate}`}
                    >
                      {art && (
                        <span style={styles.typeWell} data-well="1">
                          <img
                            src={`${process.env.PUBLIC_URL ?? ""}/images/${GAME_TYPE_ART[candidate]}`}
                            alt=""
                            draggable={false}
                            onError={() => setArtFailed((current) => ({ ...current, [candidate]: true }))}
                            style={{ ...styles.typeArt, ...(selected ? null : styles.typeArtIdle) }}
                            data-testid={`host-type-art-${candidate}`}
                          />
                        </span>
                      )}
                      <span style={styles.typeText}>
                        <span style={styles.typeLabelRow}>
                          <span style={styles.typeLabel}>{GAME_TYPE_COPY[candidate].label}</span>
                          <span
                            aria-hidden="true"
                            style={{ ...styles.typeMark, ...(selected ? styles.typeMarkOn : null) }}
                          >
                            {selected ? "✓" : ""}
                          </span>
                        </span>
                        <span style={styles.typeBlurb}>{HOST_TYPE_BLURB[candidate]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Pace">
              <Segmented<GameMode>
                value={mode}
                options={(["live", "async"] as const).map((key) => ({
                  key,
                  label: GAME_MODE_COPY[key].label,
                  blurb: GAME_MODE_COPY[key].blurb,
                }))}
                onChange={setMode}
                name="pace"
              />
            </Section>

            <Section title="Visibility">
              <Segmented<RoomVisibility>
                value={visibility}
                options={(["public", "private"] as const).map((key) => ({
                  key,
                  label: VISIBILITY_COPY[key].label,
                  blurb: VISIBILITY_COPY[key].blurb,
                }))}
                onChange={setVisibility}
                name="visibility"
              />
            </Section>

            <div style={styles.footer}>
              <button type="button" style={styles.secondaryButton} onClick={onClose}>
                Cancel
              </button>
              <button type="button" style={styles.primaryButton} onClick={continueToRules} data-testid="host-continue">
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={styles.terms}>
              {GAME_TYPE_COPY[type].label} · {GAME_MODE_COPY[mode].label} · {VISIBILITY_COPY[visibility].label}
            </p>

            <Section title="Set Ante">
              <div style={styles.row}>
                <input style={{ ...styles.input, ...styles.inputDisabled }} value="0 JUNO" disabled aria-label="Ante" readOnly />
              </div>
              <p style={styles.note}>{ANTE_SUBSIDY_NOTE}</p>
            </Section>

            <Section title="Player Count">
              <select
                style={styles.select}
                aria-label="Player count"
                value={playerCount === null ? "any" : String(playerCount)}
                onChange={(event) => setPlayerCount(event.target.value === "any" ? null : Number(event.target.value))}
                data-testid="host-player-count"
              >
                <option value="any">Any — starts with {MIN_PLAYERS} or more, up to {seatMax}</option>
                {Array.from({ length: seatMax - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
                  <option key={n} value={n}>
                    Exactly {n}
                  </option>
                ))}
              </select>
              <p style={styles.note}>
                {playerCount === null
                  ? "The host may start once two seats are ready; the table closes when the board's seats are full."
                  : `Nobody may join past ${playerCount}, and the game starts only when exactly ${playerCount} seats are ready.`}
              </p>
            </Section>

            <Section title="Tile Set">
              {tileTag ? (
                <ToggleRow
                  title={VARIANT_COPY.plusTiles.label}
                  tag={tileTag.tag}
                  blurb={`${VARIANT_COPY.plusTiles.blurb} ${tileTag.note}`}
                  checked={variants.plusTiles}
                  onChange={(checked) => setVariants((current) => ({ ...current, plusTiles: checked }))}
                  testId="host-plus-tiles"
                />
              ) : (
                <p style={styles.note}>The Level Playing Field brings the Project 18XX+ tile set.</p>
              )}
            </Section>

            <Section title="Bank Size">
              <select
                style={styles.select}
                aria-label="Bank size"
                value={variants.length}
                onChange={(event) => setVariants((current) => ({ ...current, length: event.target.value as GameLength }))}
                data-testid="host-bank-size"
              >
                {/* Design note #1440: the digits come from the table, in one formatting, so the option and
                    the sentence under it cannot name different amounts. */}
                {(["short", "standard", "long"] as const).map((length) => (
                  <option key={length} value={length}>
                    {bankSizeLabel(length)}
                    {length === recommendedLength ? " (recommended)" : ""}
                  </option>
                ))}
              </select>
              <p style={styles.note}>{GAME_LENGTH_BLURB[variants.length]}</p>
            </Section>

            {HOUSE_RULE_ROWS.map((row) => (
              <ToggleRow
                key={row.key}
                title={row.title}
                tag={row.tag}
                blurb={VARIANT_COPY[row.key].blurb}
                checked={variants[row.key]}
                onChange={(checked) => setVariants((current) => ({ ...current, [row.key]: checked }))}
                testId={`host-rule-${row.key}`}
              />
            ))}

            {error && <p style={styles.warning}>{error}</p>}

            <div style={styles.footer}>
              <button type="button" style={styles.secondaryButton} onClick={() => setStep("type")} disabled={busy}>
                Back
              </button>
              <button
                type="button"
                style={{ ...styles.primaryButton, ...(busy ? styles.disabled : {}) }}
                onClick={create}
                disabled={busy}
                data-testid="host-create-room"
              >
                {busy ? "Opening…" : "Create Room"}
              </button>
            </div>
          </>
        )}
      </div>
    </NativeModal>
  );
}

export default HostSetupCard;

/* ==================================================================
    DESIGN NOTE 1448: A RADIO GROUP IS ONE CONTROL, NOT N BUTTONS
   ==================================================================
   REPORTED, from a screenshot: "one radio selected while another radio in the same group carries an equally
   prominent outline makes the interface look as though two choices are active" -- and, from an earlier
   playtest, pointer use leaving the previously clicked option outlined.
   BOTH WERE REAL AND THEY ARE DIFFERENT BUGS. The second is #1448a below (a stale `border-color`). This note
   is the first: the three groups were N independent buttons that happened to carry `role="radio"`.
   MEASURED BEFORE THE FIX, in all three groups: every option had `tabIndex=0`, so Tab visited each one
   separately (seven stops across the step); the arrow keys did nothing at all; and Tab from the selected
   option landed on its unselected sibling, which is how a keyboard user arrived at the screenshot -- ring on
   one option, green on another, the group's single answer shown in two places.
   SO FOCUS AND SELECTION MOVE TOGETHER, which is the platform's own radio behaviour and the only arrangement
   in which "focused" and "selected" cannot disagree. The selected option is the group's Tab stop; the rest are
   `tabIndex=-1`; the arrows change the answer and take the focus with them; Tab leaves.
   THE RING STAYS. It now falls on the selected option -- "this is the answer AND you are standing on it" --
   which is a state, not a contradiction.
   NO STORED FOCUS. This holds a ref to the group element and nothing else: no focused index, no blur timer,
   no document-level mouse listener. Remounting the dialog therefore cannot carry stale focus state, because
   there is no focus state to carry -- the selected value alone decides the Tab stop, and it is already props.
   POINTER SELECTION FOCUSES THE OPTION IT SELECTED, in the click handler rather than by relying on the
   browser to focus a button that was clicked on one of its children. Chromium and Firefox do that themselves;
   WebKit does not focus a button on click at all, which would leave a keyboard ring on the option the user
   just moved AWAY from. One line at the source beats a heuristic. A click is a pointer interaction either way,
   so `:focus-visible` stays false and no ring appears. */
const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

function useRadioGroup<T extends string>(keys: ReadonlyArray<T>, value: T, onChange: (next: T) => void) {
  const ref = useRef<HTMLDivElement | null>(null);

  /* Focus follows the value. The node is focused before React re-renders, while its `tabIndex` is still -1 --
     which `focus()` does not care about; only Tab does. */
  const select = (key: T) => {
    onChange(key);
    ref.current?.querySelector<HTMLElement>('[data-radio-key="' + key + '"]')?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[event.key];
    if (step === undefined) return;
    event.preventDefault(); // or ArrowUp/ArrowDown scrolls the dialog out from under the group
    const at = keys.indexOf(value);
    if (at === -1) return;
    select(keys[(at + step + keys.length) % keys.length]);
  };

  /* Everything a single option needs to BE a radio, in one place, so the three groups cannot drift. */
  const optionProps = (key: T) => ({
    role: "radio" as const,
    "aria-checked": key === value,
    tabIndex: key === value ? 0 : -1,
    "data-radio-key": key,
    onClick: () => select(key),
  });

  return { ref, onKeyDown, optionProps };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <span style={styles.sectionTitle}>{title}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  name,
}: {
  value: T;
  options: ReadonlyArray<{ key: T; label: string; blurb: string }>;
  onChange: (value: T) => void;
  name: string;
}) {
  /* #1448: the same group behaviour as the Game cards, from the same hook -- two consumers, one definition of
     what a radio group does. */
  const radio = useRadioGroup(options.map((option) => option.key), value, onChange);
  return (
    <div
      ref={radio.ref}
      style={styles.segmented}
      role="radiogroup"
      aria-label={name}
      onKeyDown={radio.onKeyDown}
    >
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            {...radio.optionProps(option.key)}
            className="host-segment"
            style={{ ...styles.segment, ...(selected ? styles.segmentSelected : {}) }}
            data-testid={`host-${name}-${option.key}`}
          >
            <span style={styles.segmentLabel}>{option.label}</span>
            <span style={styles.segmentBlurb}>{option.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

const TAG_TEXT: Readonly<Record<VariantTag, string>> = {
  recommended: "recommended",
  easier: "easier",
  riskier: "riskier",
  harder: "harder",
  chaotic: "chaotic",
};

function ToggleRow({
  title,
  tag,
  blurb,
  checked,
  onChange,
  testId,
}: {
  title: string;
  tag: VariantTag | null;
  blurb: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <label style={styles.toggleRow}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid={testId} style={styles.checkbox} />
      <span style={styles.toggleText}>
        <span style={styles.toggleTitle}>
          {title}
          {tag && <span style={{ ...styles.tag, ...(tag === "recommended" ? styles.tagRecommended : {}) }}>({TAG_TEXT[tag]})</span>}
        </span>
        <span style={styles.toggleBlurb}>{blurb}</span>
      </span>
    </label>
  );
}

/* One stylesheet, for the two things an inline style object cannot say. NO BACKTICK MAY APPEAR BETWEEN THESE
   BACKTICKS -- it ends the literal and the build fails on the next line. */
const HOST_SETUP_CSS = `
.host-type-card:focus-visible,
.host-segment:focus-visible { outline: 2px solid #8a8a86; outline-offset: 2px; }
/* Design note #1630: neither of these is a control, and both are focused programmatically -- the card as a
   fallback for a click on dead space, the heading when the step changes. So the resting :focus outline is
   dropped and the ring is left entirely to :focus-visible, which is the engine's own judgement about whether
   the player is on the keyboard. Source order matters: :focus-visible is second, so it wins. */
.host-card:focus, .host-heading:focus { outline: none; }
.host-card:focus-visible, .host-heading:focus-visible { outline: 2px solid #8a8a86; outline-offset: -2px; }
.host-type-card:hover img { opacity: 1; }
`;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* #1651: the `zIndex: 4200` that stood here is gone. This scrim is a `<dialog>` in the top layer, which is
       above the whole document by definition, so the number decided nothing and would have read as a
       stacking contract that no longer exists. */
    pointerEvents: "auto", // #1360
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
    overflowY: "auto",
  },
  card: {
    width: "min(600px, 100%)",
    maxHeight: "calc(100vh - 48px)",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    padding: "18px 20px",
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  /* #1447: the gallery step is wider than the form step. Three logo wells need the width -- at the form
     step's 600px each well is 175px across and the Level Playing Field subtitle falls to an 8px cap.
     The house-rules step is untouched at 600. */
  cardGallery: { width: "min(820px, 100%)" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800 },
  closeButton: { background: "none", border: "none", color: "#8a8a86", cursor: "pointer", fontSize: FONT_SIZE.heading, lineHeight: 1 },
  terms: { margin: 0, fontSize: FONT_SIZE.small, color: "#8a8a86", letterSpacing: "0.02em" },
  section: { display: "flex", flexDirection: "column", gap: "6px" },
  sectionTitle: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8a8a86" },
  typeGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "12px" },
  typeBox: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    padding: 0,
    overflow: "hidden",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    textAlign: "left",
    cursor: "pointer",
  },
  /* ==================================================================
      DESIGN NOTE 1448a: THE BORDER A DESELECTED OPTION KEPT
     ==================================================================
     REPORTED from playtest: pointer use left "the formerly clicked item outlined after selecting another".
     REPRODUCED, and it is not a focus bug at all. The selected variants set the `borderColor` LONGHAND over a
     base object that sets the `border` SHORTHAND. React diffs inline styles key by key: on deselect it clears
     `borderColor`, and it does NOT rewrite `border`, because `border` is the same string in both renders. The
     element is left holding `border-width: 1px; border-style: solid;` with no colour at all -- measured inline
     style after deselecting, verbatim:
         border-width: 1px; border-style: solid; border-image: initial;
     and Chromium then computes `border-top-color: rgb(0, 0, 0)`. Sampled on screen: the deselected card's
     left border is (0,0,0) where a never-selected peer's is (58,58,58). A black edge on a #1c1c1c card over a
     #0f0f0f dialog reads as a dark outline that nothing else has -- the "formerly clicked item outlined", and
     it survives until the dialog unmounts.
     THE FIX IS TO CHANGE THE SAME PROPERTY BACK. Every selected variant here now sets the `border` shorthand,
     so React sees one string replaced by another and rewrites the whole declaration. A longhand override of a
     shorthand is only safe when nothing ever removes it.
     THIS PATTERN IS NOT UNIQUE TO THIS FILE -- about twenty components pair a `border` base with a
     `borderColor` variant. Only this one was in scope; the rest are a sweep of their own. */
  typeBoxSelected: { border: "1px solid #6fae86", backgroundColor: "#173327", boxShadow: "inset 0 0 0 1px #6fae86" },
  /* The media viewport: identical in every card, black because the artwork's ground is black, and capped in
     height so a full-width card on a phone does not spend 285px on one logo. */
  typeWell: {
    display: "block",
    width: "100%",
    aspectRatio: "4 / 3",
    maxHeight: "200px",
    backgroundColor: "#000000",
    borderBottom: "1px solid #2a2a2a",
  },
  typeArt: { display: "block", width: "100%", height: "100%", objectFit: "contain" },
  /* Unselected art is stepped down, not dimmed out: at 0.86 the gold is still plainly gold. The selected state
     is carried by the border, the surface and the mark, which is where an unmistakable state belongs. */
  typeArtIdle: { opacity: 0.86 },
  typeText: { display: "flex", flexDirection: "column", gap: "4px", padding: "9px 12px 11px" },
  typeLabelRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
  typeLabel: { fontSize: FONT_SIZE.body, fontWeight: 800, lineHeight: 1.25 },
  typeMark: {
    flex: "none",
    width: "16px",
    height: "16px",
    borderRadius: RADIUS.circle,
    border: "1px solid #5a5a56",
    color: "#0f1f16",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    lineHeight: "14px",
    textAlign: "center",
  },
  typeMarkOn: { border: "1px solid #6fae86", backgroundColor: "#6fae86" }, // #1448a
  typeBlurb: { fontSize: FONT_SIZE.micro, color: "#c8c6c0", lineHeight: 1.4 },
  segmented: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px" },
  segment: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    textAlign: "left",
    cursor: "pointer",
  },
  segmentSelected: { border: "1px solid #6fae86", backgroundColor: "#173327", boxShadow: "inset 0 0 0 1px #6fae86" }, // #1448a
  segmentLabel: { fontSize: FONT_SIZE.small, fontWeight: 800 },
  segmentBlurb: { fontSize: FONT_SIZE.micro, color: "#c8c6c0", lineHeight: 1.4 },
  row: { display: "flex", gap: "8px", alignItems: "center" },
  input: {
    flex: 1,
    padding: "7px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.body,
    fontVariantNumeric: "tabular-nums",
  },
  inputDisabled: { color: "#6e6c68", cursor: "not-allowed" },
  select: {
    padding: "7px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.small,
  },
  note: { fontSize: FONT_SIZE.micro, color: "#8a8a86", lineHeight: 1.4, margin: 0 },
  toggleRow: { display: "flex", gap: "10px", alignItems: "flex-start", cursor: "pointer" },
  checkbox: { marginTop: "3px" },
  toggleText: { display: "flex", flexDirection: "column", gap: "2px" },
  toggleTitle: { fontSize: FONT_SIZE.small, fontWeight: 800, display: "flex", gap: "6px", alignItems: "baseline" },
  tag: { fontSize: FONT_SIZE.micro, fontWeight: 600, color: "#8a8a86" },
  tagRecommended: { color: "#9ed8b4" },
  toggleBlurb: { fontSize: FONT_SIZE.micro, color: "#c8c6c0", lineHeight: 1.4 },
  warning: { fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.4, margin: 0 },
  footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px", marginTop: "4px" },
  secondaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
  },
  primaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  disabled: { border: "1px solid #3a3a3a", backgroundColor: "#1c1c1c", color: "#6e6c68", cursor: "not-allowed" }, // #1448a
};
