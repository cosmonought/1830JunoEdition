// frontend/src/components/HostSetupCard.tsx
//
/* ==================================================================
    PLAY HOST A GAME (approved design, "play-host-waiting-handoff" §3): A BOARD IN TWO STEPS, TABLE THEN TERMS
   ==================================================================
   "Host a game" is a departure board of its own: the header with the step marker ("1 · Table  2 · Terms"), a LIVE copy
   of the lobby's Departures row built from the host's choices ("How your table will appear on Departures" -- every flap
   flips as the choices change), the step, and a footer that says either what is being made or why it can't be yet.
     STEP 1, TABLE: the three editions as cards; the pace as two cards that each carry their own clock (Live's 20m per
       action; Async's 12h-7d chips and None) with "How the clock works" folded underneath, and the No-deadline
       acknowledgement right there (moved here from step 2; still sent as `noDeadlineAck`); Public or Private.
     STEP 2, TERMS: Players (Any first and the default, then exact counts), the ante per seat with the deployment's own
       fee, the Bank, and the Variants as a grid of tagged toggles.
   Choosing the TABLE resets step 2 to that table's recommended defaults (Play's rule); the pace is on step 1 now, so it
   is kept. "Create table" sends Play's existing `create` op -- nothing about it changed.
   ANY-COUNT ON A MONEY TABLE (§11) is GATED, NOT RESOLVED: Any stays first, selected and worded as designed; on a money
   table Create table says why it is blocked (`ANY_COUNT_BLOCKED_SENTENCE`) until Juno's corrected escrow is certified
   (`ANY_COUNT_MONEY_TABLES`). Nothing turns Any into an exact count, and no money create is sent without one.
   KEPT FROM THE CARD IT REPLACES: the native modal (#1652: one named dialog, `closedby` while busy), Escape and the
   scrim as the same close (#1629/#1641), focus into the selected table card on open and the step's own focus moves
   (#1630), the roving radio groups (#1448, Home/End W1-O), the click-fallback focusable card, and the scrolling body
   with the header and footer pinned (W1-O AUD-16.02). Mounted at the lobby's root (#1360). */

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import {
  GAME_LENGTH_NOTE,
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
/* W1-O (AUD-16.02 / AUD-16.05): the card's height is asked in real viewport units under the layer's zoom. */
import { zoomAwareMediaCss, zoomAwareVh } from "../utils/uiScale";
import { useUiScale } from "../utils/useUiScale";
/* ESCROW-4: the stake, when the server opens real-money tables on this build's escrow. */
import { stakeChoice, useMoneyTableOffer } from "./money/HostStakeSection";
/* Phase 3 final clocks: the Async action deadline and the No-deadline disclosure. */
import { CLOCK_ASYNC_PACES_SECS, NO_DEADLINE_DISCLOSURE } from "../utils/clockProtocol";
/* PHASE 3 FINAL (§13): every player game is anted. */
import { ANTE_UNAVAILABLE_SENTENCE, ANY_COUNT_BLOCKED_SENTENCE, ANY_COUNT_MONEY_TABLES, FREE_TABLES_OFFERED } from "../utils/tablePolicy";
import { formatAmount } from "../utils/moneyProtocol";
import { EDITION_NAME, PACE_LABEL } from "../utils/lobbyBoard";
import { LENGTH_WORD, anteFeeSentence, paceModeCell, paceText, type PaceChoice } from "../utils/roomDesign";
import { profileNickname } from "../utils/profileApi";
import { ROOM_DESIGN_CSS } from "./room/roomDesignCss";
import { ClockRules, EDITION_TOKEN, EditionNumerals, Lockup } from "./room/RoomParts";
import SplitFlap from "./SplitFlap";

/** The type boxes' sentences, as asked. `GAME_TYPE_COPY`'s blurbs are the waiting room's and the Lobby's older
 *  form's; these are the host's first screen, which reads them side by side. */
export const HOST_TYPE_BLURB: Readonly<Record<GameType, string>> = {
  standard: "The classic game.",
  plus: "A larger map, suitable for higher player counts or less blocking at lower player counts.",
  levelPlayingField: "A rebalanced map with additional tiles, private companies, and railroads.",
};

/** Design note #1447: the normalised title art for each game, one 1080x810 canvas each -- the same lockup the design
 *  draws (handoff §1: "Play's own game-18xx*.jpg carry the same lockup and may be used for the host cards"). */
export const GAME_TYPE_ART: Readonly<Record<GameType, string>> = {
  standard: "game-18xx.jpg",
  plus: "game-18xx-plus.jpg",
  levelPlayingField: "game-18xx-lpf.jpg",
};

export const VISIBILITY_COPY: Readonly<Record<RoomVisibility, { label: string; blurb: string }>> = {
  public: { label: "Public", blurb: "Listed on the Lobby. Anyone can join, and anyone can watch." },
  private: { label: "Private", blurb: "Unlisted. Players join by room code only, and nobody can watch." },
};

/** The four rule variants in the order the Variants grid reads them, each with its tag. The blurbs are the shared copy
 *  (#961a), so a rule reads the same here as in the waiting room. */
export const HOUSE_RULE_ROWS: ReadonlyArray<{
  key: "gentleRust" | "dynamicStockMarket" | "delayedAuction" | "unpredictableRevenue";
  title: string;
  tag: VariantTag;
}> = [
  { key: "gentleRust", title: "Gentle Rust", tag: "easier" },
  { key: "dynamicStockMarket", title: "Dynamic Market", tag: "riskier" },
  { key: "delayedAuction", title: "Delayed Auction", tag: "harder" },
  // UR-6 (UR-F14; OD-UR-12 = 12-A, D-45): the canonical name.
  { key: "unpredictableRevenue", title: "Unpredictable Revenue", tag: "chaotic" },
];

/** The design's short label for the tile tray toggle ("18XX+ Tiles", handoff §10). */
export const PLUS_TILES_TITLE = "18XX+ Tiles";

/** The line under a table with no ante (development builds only: production games are always anted). */
export const ANTE_SUBSIDY_NOTE =
  "No ante at this table: nothing is deposited. At a real-money table every seat's ante goes into an escrow on Juno, which keeps a fee, set by the escrow, from each deposit; the fee is not refunded.";

/** The footer of step 2 when nothing blocks the create (handoff §3.2). */
export const CREATE_MOVES_NO_MONEY = "Creating the table moves no money. You open it on Juno with your own ante from the waiting room.";

export interface HostSetupCardProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (variants: GameVariants, setup: RoomSetup) => void;
}

type Step = "type" | "rules";
type PaceKey = string; // a pace in seconds ("86400"), or "none"

/* #1653: `tabbableWithin` lives in `NativeModal`; re-exported so nothing that imported it from here has to move. */
export { tabbableWithin } from "./NativeModal";

const LENGTHS: readonly GameLength[] = ["short", "standard", "long"];
const PACE_KEYS: readonly PaceKey[] = [...CLOCK_ASYNC_PACES_SECS.map(String), "none"];

export function HostSetupCard({ busy, error, onClose, onCreate }: HostSetupCardProps) {
  const [step, setStep] = useState<Step>("type");
  const [type, setType] = useState<GameType>("standard");
  const [mode, setMode] = useState<GameMode>("live");
  const [visibility, setVisibility] = useState<RoomVisibility>(DEFAULT_ROOM_SETUP.visibility);
  const [variants, setVariants] = useState<GameVariants>(() => recommendedVariantsFor("standard", "live"));
  /* Any (null) is the approved default (handoff §3.2), on every table. */
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  /* ESCROW-4: a real-money table's stake -- offered only when the server and this build agree on the escrow. */
  const moneyOffer = useMoneyTableOffer();
  const [stakeOn, setStakeOn] = useState(false);
  const [stakeText, setStakeText] = useState("");
  /* PHASE 3 FINAL (§13): every player game is anted -- the stake is REQUIRED; only the development-identity build keeps
     the no-ante choice, for fixtures (`utils/tablePolicy.ts`); the server refuses a no-ante table outside development. */
  const anteRequired = !FREE_TABLES_OFFERED;
  const stakeActive = anteRequired || stakeOn;
  const anteUnavailable = anteRequired && moneyOffer === null;
  /* The amount alone (the count is asked separately below, so Any is never folded into an amount problem). */
  const stake = stakeChoice(moneyOffer, stakeActive, stakeText, MIN_PLAYERS);
  const moneyTable = stakeActive && moneyOffer !== null;
  /* Phase 3 final clocks: an Async table's action deadline -- a pace (12 h .. 7 d) or No deadline. 24 h by default. */
  const [deadline, setDeadline] = useState<"async-pace" | "no-deadline">("async-pace");
  const [paceSecs, setPaceSecs] = useState<number>(86_400);
  const [noDeadlineAck, setNoDeadlineAck] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  /* #1447: a card whose artwork cannot be fetched or decoded falls back to the lockup drawn in type. */
  const [artFailed, setArtFailed] = useState<Partial<Record<GameType, boolean>>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const seatMax = maxPlayersFor(variants);
  const pace: PaceChoice = { mode, deadline: mode === "live" ? "live" : deadline, paceSecs: mode === "async" && deadline === "async-pace" ? paceSecs : null };
  const paceKey: PaceKey = deadline === "no-deadline" ? "none" : String(paceSecs);
  const ackNeeded = mode === "async" && deadline === "no-deadline" && moneyTable && !noDeadlineAck;

  /* Changing the table resets step 2 to that table's recommended defaults; an exact count the new board can't seat
     goes back to Any. The pace (step 1) is kept. */
  const chooseType = (next: GameType) => {
    if (next === type) return;
    setType(next);
    const fresh = recommendedVariantsFor(next, mode);
    setVariants(fresh);
    setPlayerCount((current) => (current !== null && current > maxPlayersFor(fresh) ? null : current));
  };
  const choosePace = (key: PaceKey) => {
    setMode("async");
    setNoDeadlineAck(false);
    if (key === "none") setDeadline("no-deadline");
    else {
      setDeadline("async-pace");
      setPaceSecs(Number(key));
    }
  };

  const gameRadio = useRadioGroup(GAME_TYPE_ORDER, type, chooseType);
  const modeRadio = useRadioGroup<GameMode>(["live", "async"], mode, setMode);
  const paceRadio = useRadioGroup<PaceKey>(PACE_KEYS, paceKey, choosePace, mode === "async");
  const visibilityRadio = useRadioGroup<RoomVisibility>(["public", "private"], visibility, setVisibility);
  const countKeys = ["any", ...Array.from({ length: seatMax - MIN_PLAYERS + 1 }, (_, i) => String(MIN_PLAYERS + i))];
  const countRadio = useRadioGroup<string>(countKeys, playerCount === null ? "any" : String(playerCount), (key) => setPlayerCount(key === "any" ? null : Number(key)));
  const bankRadio = useRadioGroup<GameLength>(LENGTHS, variants.length, (length) => setVariants((current) => ({ ...current, length })));
  const ids = useId();
  /* W1-O (AUD-16.02): the modal layer draws under `zoom: uiScale`, so its height is asked in real viewport units. */
  const uiScale = useUiScale();

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  /* #1630: the first meaningful decision on the step -- the selected table card (the group's one Tab stop). */
  const focusSelectedGameRadio = () => {
    gameRadio.ref.current?.querySelector<HTMLElement>(`[data-radio-key="${type}"]`)?.focus();
  };

  /* #1630: the step change is a navigation, so focus goes with it -- forward to the heading (which names the step, by
     its description), back to the selected table card. A layout effect, so no frame has focus outside the dialog. */
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

  /* #1630: initial focus, declared AFTER the modal's own opener capture (effects run in declaration order). */
  useEffect(() => {
    focusSelectedGameRadio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tileTag = plusTilesTagFor(type);
  const recommendedLength = recommendedLengthFor(type);
  const symbol = moneyOffer?.deployment.symbol ?? "JUNOX";
  const exponent = moneyOffer?.deployment.exponent ?? 6;
  const anteShown = moneyTable && stake.base !== null && stake.problem === null ? formatAmount(stake.base, exponent, symbol) : null;

  /* Why Create table can't be pressed yet (the footer says it), or null. */
  const amountBlock = !stakeActive || moneyOffer === null ? null : stake.base === null ? "Enter an ante above zero." : stake.problem;
  const anyBlocked = moneyTable && playerCount === null && !ANY_COUNT_MONEY_TABLES;
  const createBlock = anteUnavailable ? ANTE_UNAVAILABLE_SENTENCE : (amountBlock ?? (anyBlocked ? ANY_COUNT_BLOCKED_SENTENCE : null));

  const create = () => {
    if (createBlock !== null || ackNeeded || busy) return;
    onCreate(
      { ...variants, mode },
      {
        visibility,
        playerCount,
        anteUjuno: moneyTable && stake.base !== null ? stake.base : DEFAULT_ROOM_SETUP.anteUjuno,
        ...(mode === "async" ? { deadline, paceSecs: deadline === "async-pace" ? paceSecs : null, ...(deadline === "no-deadline" && moneyTable ? { noDeadlineAck } : {}) } : {}),
      },
    );
  };

  const variantNames = [...(variants.plusTiles && type !== "levelPlayingField" ? [PLUS_TILES_TITLE] : []), ...HOUSE_RULE_ROWS.filter((row) => variants[row.key]).map((row) => row.title)];
  const cap = playerCount ?? seatMax;
  const utc = new Date(now).toISOString().slice(11, 16);

  return (
    <NativeModal
      /* #1630 and #1652: constant -- the dialog is "Host a game" throughout; the step is the heading's description. */
      name="Host a game"
      dismissible={!busy}
      onDismiss={onClose}
      onScrimClick={busy ? undefined : onClose}
      restoreOpener
      scrimStyle={styles.backdrop}
      className="host-scrim"
    >
      <style>{zoomAwareMediaCss(ROOM_DESIGN_CSS + HOST_SETUP_CSS, uiScale)}</style>
      <div
        ref={dialogRef}
        className="rh host-card"
        /* #1630: focusable as a CLICK FALLBACK only (a click on dead space would otherwise strand focus on <body>). */
        tabIndex={-1}
        style={{ ...styles.card, maxHeight: `calc(${zoomAwareVh(100, uiScale)} - 48px)` }}
        onClick={(event) => event.stopPropagation()}
        data-testid="host-card"
      >
        <div className="rh-head">
          <h2 ref={headingRef} className="host-heading" tabIndex={-1} aria-describedby={`${ids}-steps`}>
            Host a game
          </h2>
          <span className="rh-head-r">
            <span className="rh-steps" id={`${ids}-steps`} data-testid="host-steps">
              <span>{step === "type" ? <b aria-current="step">1 · Table</b> : "1 · Table"}</span>
              <span>{step === "rules" ? <b aria-current="step">2 · Terms</b> : "2 · Terms"}</span>
            </span>
            <button type="button" className="rh-close" onClick={onClose} aria-label="Close" disabled={busy}>
              ×
            </button>
          </span>
        </div>

        {/* W1-O (AUD-16.02): the step scrolls; the header above and the footer below do not. */}
        <div className="rh-scroll host-body" style={styles.body} data-testid="host-body">
          <div className="rh-preview" data-testid="host-preview">
            <span className="rm-lab">How your table will appear on Departures</span>
            <div className="rh-prow" style={{ ["--rm-ed" as string]: EDITION_TOKEN[type] } as React.CSSProperties}>
              <span className="rh-when">
                <span className="rh-time">{utc}</span>
                <SplitFlap text="----" width={4} className="rm-flap-xs" label="The table code is assigned when you create it" title="The table code is assigned when you create it" />
              </span>
              <span className="rh-tbl">
                <span className="rh-ed">
                  <span className="rh-nm">{type === "standard" ? "18XX" : <EditionNumerals type="plus" />}{type === "levelPlayingField" ? " LPF" : ""}</span>
                  <span className="rh-bank">({LENGTH_WORD[variants.length]})</span>
                </span>
                <span className="rh-meta">
                  <span>
                    <em>Host</em>
                    {profileNickname() || "You"}
                  </span>
                  <span>
                    <em>Mode</em>
                    {paceModeCell(pace)}
                  </span>
                </span>
                {variantNames.length > 0 ? (
                  <span className="rh-meta">
                    <span>
                      <em>Variants</em>
                      {variantNames.join(", ")}
                    </span>
                  </span>
                ) : null}
              </span>
              <span className="rh-seats">
                <span>
                  <SplitFlap text={`1/${cap}`} width={3} className="rm-flap-sm" label={`1 of ${cap} seats`} testId="host-preview-seats" />
                </span>
                <span className="rm-pips" aria-hidden="true">
                  {Array.from({ length: cap }, (_, i) => (
                    <i key={i} className={i < 1 ? "rm-on" : undefined} />
                  ))}
                </span>
                <span className="rm-lab">{playerCount === null ? "Any count" : "Exactly"}</span>
              </span>
              <span className="rh-ante" data-testid="host-preview-ante">
                <em>Ante</em>
                {anteShown ?? "—"}
              </span>
              <span className="rh-st">
                <SplitFlap text="Boarding" width={10} className="lb-st-boarding" label="Boarding" />
              </span>
            </div>
          </div>

          {step === "type" ? (
            <div className="rh-body">
              <div className="rh-field">
                <span className="rh-fl" id={`${ids}-type`}>
                  Table
                </span>
                <div ref={gameRadio.ref} className="rh-cards" role="radiogroup" aria-labelledby={`${ids}-type`} onKeyDown={gameRadio.onKeyDown}>
                  {GAME_TYPE_ORDER.map((candidate) => {
                    const selected = candidate === type;
                    const art = artFailed[candidate] !== true;
                    return (
                      <button
                        key={candidate}
                        type="button"
                        {...gameRadio.optionProps(candidate)}
                        className="rh-tcard host-type-card"
                        style={{ ["--rm-ed" as string]: EDITION_TOKEN[candidate] } as React.CSSProperties}
                        data-testid={`host-type-${candidate}`}
                      >
                        <span className="rh-well" aria-hidden="true" style={art ? styles.typeWell : undefined} data-well="1">
                          {art ? (
                            <img
                              src={`${process.env.PUBLIC_URL ?? ""}/images/${GAME_TYPE_ART[candidate]}`}
                              alt=""
                              draggable={false}
                              onError={() => setArtFailed((current) => ({ ...current, [candidate]: true }))}
                              style={{ ...styles.typeArt }}
                              data-testid={`host-type-art-${candidate}`}
                            />
                          ) : (
                            <Lockup type={candidate} />
                          )}
                        </span>
                        <span className="rh-tl">
                          <span aria-hidden="true">
                            {candidate === "standard" ? "18XX" : <EditionNumerals type="plus" />}
                            {candidate === "levelPlayingField" ? " LPF" : ""}
                          </span>
                          <span className="rm-sr" id={gameRadio.labelId(candidate)}>
                            {GAME_TYPE_COPY[candidate].label}
                          </span>
                          <i aria-hidden="true">{selected ? "✓" : ""}</i>
                        </span>
                        <p id={gameRadio.descriptionId(candidate)}>{HOST_TYPE_BLURB[candidate]}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rh-field">
                <span className="rh-fl" id={`${ids}-mode`}>
                  Pace
                </span>
                <div ref={modeRadio.ref} className="rh-paces" role="radiogroup" aria-labelledby={`${ids}-mode`} onKeyDown={modeRadio.onKeyDown}>
                  <div className="rh-pcard" data-on={mode === "live"}>
                    <button type="button" className="rh-opt host-segment" {...modeRadio.optionProps("live")} data-testid="host-pace-live">
                      <b id={modeRadio.labelId("live")}>{GAME_MODE_COPY.live.label}</b>
                      <span id={modeRadio.descriptionId("live")}>{GAME_MODE_COPY.live.blurb}</span>
                    </button>
                    <div className="rh-nums" data-testid="host-deadline-live">
                      <span className="rh-fixed">
                        20m<small>per action</small>
                      </span>
                    </div>
                  </div>
                  <div className="rh-pcard" data-on={mode === "async"}>
                    <button type="button" className="rh-opt host-segment" {...modeRadio.optionProps("async")} data-testid="host-pace-async">
                      <b id={modeRadio.labelId("async")}>{GAME_MODE_COPY.async.label}</b>
                      <span id={modeRadio.descriptionId("async")}>{GAME_MODE_COPY.async.blurb}</span>
                    </button>
                    <div
                      ref={paceRadio.ref}
                      className="rh-nums"
                      role="radiogroup"
                      aria-label="Async deadline per action"
                      onKeyDown={(event) => {
                        paceRadio.onKeyDown(event);
                        /* The chips' arrows are theirs: the Pace group around them must not move too. */
                        if (event.defaultPrevented) event.stopPropagation();
                      }}
                      data-testid="host-deadline"
                    >
                      {PACE_KEYS.map((key) => (
                        <button key={key} type="button" {...paceRadio.optionProps(key)} data-testid={`host-deadline-${key}`}>
                          <span id={paceRadio.labelId(key)}>{key === "none" ? "None" : PACE_LABEL[Number(key)]}</span>
                          <small id={paceRadio.descriptionId(key)}>{key === "none" ? "no deadline" : "per action"}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <ClockRules pace={pace} feeBps={moneyOffer?.feeBps ?? null} open={clockOpen} onToggle={setClockOpen} testId="host-clock" />
                {mode === "async" && deadline === "no-deadline" && moneyTable ? (
                  <label className="rh-ack" data-testid="host-no-deadline-disclosure">
                    <input type="checkbox" checked={noDeadlineAck} onChange={(event) => setNoDeadlineAck(event.target.checked)} data-testid="host-no-deadline-ack" />
                    <span>{NO_DEADLINE_DISCLOSURE}</span>
                  </label>
                ) : null}
              </div>

              <div className="rh-field">
                <span className="rh-fl" id={`${ids}-vis`}>
                  Visibility
                </span>
                <div ref={visibilityRadio.ref} className="rh-paces" role="radiogroup" aria-labelledby={`${ids}-vis`} onKeyDown={visibilityRadio.onKeyDown}>
                  {(["public", "private"] as const).map((key) => (
                    <button key={key} type="button" className="rh-opt host-segment" {...visibilityRadio.optionProps(key)} data-testid={`host-visibility-${key}`}>
                      <b id={visibilityRadio.labelId(key)}>{VISIBILITY_COPY[key].label}</b>
                      <span id={visibilityRadio.descriptionId(key)}>{VISIBILITY_COPY[key].blurb}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="rh-body">
              <div className="rh-field">
                <span className="rh-fl" id={`${ids}-n`}>
                  Players
                </span>
                <div ref={countRadio.ref} className="rh-nums" role="radiogroup" aria-labelledby={`${ids}-n`} aria-describedby={`${ids}-n-note`} onKeyDown={countRadio.onKeyDown} data-testid="host-player-count">
                  {countKeys.map((key) => {
                    const on = key === (playerCount === null ? "any" : String(playerCount));
                    return (
                      <button key={key} type="button" className={key === "any" ? "rh-any" : undefined} {...countRadio.optionProps(key)} data-testid={`host-players-${key}`}>
                        <span id={countRadio.labelId(key)}>{key === "any" ? "Any" : key}</span>
                        <small id={countRadio.descriptionId(key)}>{key === "any" ? `up to ${seatMax}` : on ? "exactly" : " "}</small>
                      </button>
                    );
                  })}
                </div>
                <p className="rh-fnote" id={`${ids}-n-note`}>
                  {playerCount === null
                    ? `Up to ${seatMax} players. You can start once at least two seats are taken and everyone seated has anted; open seats close when you start.`
                    : `Nobody may join past ${playerCount}, and the game starts only when all ${playerCount} seats have anted.`}
                </p>
              </div>

              <div className="rh-two">
                <div className="rh-field" data-testid={moneyOffer !== null ? "host-stake" : undefined}>
                  {moneyOffer !== null ? (
                    <>
                      <label className="rh-fl" htmlFor={`${ids}-ante`}>
                        Ante per seat
                      </label>
                      {!anteRequired ? (
                        <label className="rh-fnote" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input type="checkbox" checked={stakeOn} onChange={(event) => setStakeOn(event.target.checked)} data-testid="host-stake-on" />
                          Play this table for an ante (development build: a no-ante table is allowed here)
                        </label>
                      ) : null}
                      {stakeActive ? (
                        <form
                          className="rh-amount"
                          onSubmit={(event) => {
                            event.preventDefault();
                            create();
                          }}
                        >
                          <input
                            id={`${ids}-ante`}
                            inputMode="decimal"
                            autoComplete="off"
                            value={stakeText}
                            placeholder="10"
                            onChange={(event) => setStakeText(event.target.value)}
                            aria-describedby={`${ids}-ante-note`}
                            data-testid="host-stake-amount"
                          />
                          <span>{symbol}</span>
                        </form>
                      ) : null}
                      <p className="rh-fnote" id={`${ids}-ante-note`} data-testid={stake.problem !== null || stake.base === null ? "host-stake-problem" : "host-stake-summary"}>
                        {!stakeActive
                          ? ANTE_SUBSIDY_NOTE
                          : stake.base === null
                            ? `Enter the ante in ${symbol}, like 10 or 2.5 (above zero).`
                            : stake.problem !== null
                              ? stake.problem
                              : `${anteFeeSentence(stake.base, moneyOffer.feeBps, exponent, symbol)} You can change the ante in the waiting room until the first deposit.`}
                      </p>
                    </>
                  ) : anteUnavailable ? (
                    <>
                      <span className="rh-fl">Ante per seat</span>
                      <p className="rh-fnote" role="status" data-testid="host-ante-unavailable">
                        {ANTE_UNAVAILABLE_SENTENCE}
                      </p>
                    </>
                  ) : (
                    <>
                      <span className="rh-fl">Ante per seat</span>
                      <p className="rh-fnote">{ANTE_SUBSIDY_NOTE}</p>
                    </>
                  )}
                </div>
                <div className="rh-field">
                  <span className="rh-fl" id={`${ids}-bank`}>
                    Bank
                  </span>
                  <div ref={bankRadio.ref} className="rh-nums" role="radiogroup" aria-labelledby={`${ids}-bank`} aria-describedby={`${ids}-bank-note`} onKeyDown={bankRadio.onKeyDown} data-testid="host-bank-size">
                    {LENGTHS.map((length) => (
                      <button key={length} type="button" {...bankRadio.optionProps(length)} data-testid={`host-bank-${length}`}>
                        <span id={bankRadio.labelId(length)}>{bankSizeLabel(length)}</span>
                        <small id={bankRadio.descriptionId(length)}>
                          {LENGTH_WORD[length]}
                          {length === recommendedLength ? " · recommended" : ""}
                        </small>
                      </button>
                    ))}
                  </div>
                  <p className="rh-fnote" id={`${ids}-bank-note`}>
                    {GAME_LENGTH_NOTE[variants.length]}
                  </p>
                </div>
              </div>

              <div className="rh-field">
                <span className="rh-fl">Variants</span>
                <div className="rh-two" style={{ gap: "10px" }}>
                  {tileTag ? (
                    <ToggleRow
                      title={PLUS_TILES_TITLE}
                      tag={tileTag.tag}
                      blurb={`${VARIANT_COPY.plusTiles.blurb} ${tileTag.note}`}
                      checked={variants.plusTiles}
                      onChange={(checked) => setVariants((current) => ({ ...current, plusTiles: checked }))}
                      testId="host-plus-tiles"
                    />
                  ) : (
                    <p className="rh-fnote" style={{ gridColumn: "1 / -1" }}>
                      The Level Playing Field brings its own tile tray.
                    </p>
                  )}
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
                </div>
              </div>
            </div>
          )}
        </div>

        {/* W1-O review: the refusal sits beside the button that produced it, outside the scrolling body. */}
        {error && (
          <p className="rm-err" style={{ padding: "0 22px" }} role="alert" data-testid="host-error">
            {error}
          </p>
        )}

        {step === "type" ? (
          <div className="rh-foot" style={styles.footer} data-testid="host-footer">
            <span className="rm-why" data-testid="host-summary">
              {ackNeeded ? "Tick the no-deadline acknowledgement to continue." : `${EDITION_NAME[type]} · ${paceText(pace)} · ${VISIBILITY_COPY[visibility].label}`}
            </span>
            <span className="rm-actions">
              <button type="button" className="rm-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="rm-btn rm-primary" onClick={() => setStep("rules")} disabled={ackNeeded} data-testid="host-continue">
                Continue
              </button>
            </span>
          </div>
        ) : (
          <div className="rh-foot" style={styles.footer} data-testid="host-footer">
            <span className={`rm-why${anyBlocked && createBlock === ANY_COUNT_BLOCKED_SENTENCE ? " rh-gate" : ""}`} role={createBlock !== null ? "status" : undefined} data-testid="host-create-why">
              {ackNeeded ? "Tick the no-deadline acknowledgement on step 1 to create this table." : (createBlock ?? CREATE_MOVES_NO_MONEY)}
            </span>
            <span className="rm-actions">
              <button type="button" className="rm-btn" onClick={() => setStep("type")} disabled={busy}>
                Back
              </button>
              <button type="button" className="rm-btn rm-primary" onClick={create} disabled={busy || createBlock !== null || ackNeeded} data-testid="host-create-room">
                {busy ? "Opening…" : "Create table"}
              </button>
            </span>
          </div>
        )}
      </div>
    </NativeModal>
  );
}

export default HostSetupCard;

/* ==================================================================
    DESIGN NOTE 1448: A RADIO GROUP IS ONE CONTROL, NOT N BUTTONS
   ==================================================================
   Focus and selection move together, which is the platform's own radio behaviour: the selected option is the group's
   one Tab stop, the arrows (and Home/End, W1-O) change the answer and take focus with them, Tab leaves. Pointer
   selection focuses the option it selected (WebKit doesn't focus a clicked button). No stored focus state.
   PLAY HOST A GAME: `active` -- the Async chips remember a pace while Live is chosen. Then no chip is CHECKED (the table
   is Live), and the remembered one stays the group's Tab stop so the keyboard can still reach the group. */
const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

const EDGE_KEYS: ReadonlySet<string> = new Set(["Home", "End"]);

function useRadioGroup<T extends string>(keys: ReadonlyArray<T>, value: T, onChange: (next: T) => void, active = true) {
  const ref = useRef<HTMLDivElement | null>(null);
  /* W1-O (AUD-17.01): each option is NAMED by its label and DESCRIBED by its sentence. */
  const idBase = useId();
  const labelId = (key: T) => `${idBase}-${key}-label`;
  const descriptionId = (key: T) => `${idBase}-${key}-description`;

  const select = (key: T) => {
    onChange(key);
    ref.current?.querySelector<HTMLElement>('[data-radio-key="' + key + '"]')?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (EDGE_KEYS.has(event.key)) {
      if (keys.length === 0) return;
      event.preventDefault();
      select(event.key === "Home" ? keys[0] : keys[keys.length - 1]);
      return;
    }
    const step = ARROW_STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = keys.indexOf(value);
    if (at === -1) return;
    select(keys[(at + step + keys.length) % keys.length]);
  };

  const optionProps = (key: T) => ({
    role: "radio" as const,
    "aria-checked": active && key === value,
    tabIndex: key === value ? 0 : -1,
    "data-radio-key": key,
    "aria-labelledby": labelId(key),
    "aria-describedby": descriptionId(key),
    onClick: () => select(key),
  });

  return { ref, onKeyDown, optionProps, labelId, descriptionId };
}

function ToggleRow({ title, tag, blurb, checked, onChange, testId }: { title: string; tag: VariantTag | null; blurb: string; checked: boolean; onChange: (checked: boolean) => void; testId: string }) {
  /* W1-O (AUD-17.01): named by the title (and its tag), described by the sentence -- not one run-on name. */
  const id = useId();
  return (
    <label className="rh-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid={testId} aria-labelledby={`${id}-title`} aria-describedby={`${id}-blurb`} />
      <b id={`${id}-title`}>
        {title}
        {tag && <span className={`rh-vt rh-${tag}`}>{tag}</span>}
      </b>
      <span className="rh-bl" id={`${id}-blurb`}>
        {blurb}
      </span>
    </label>
  );
}

/* One stylesheet, for what an inline style object cannot say. NO BACKTICK MAY APPEAR BETWEEN THESE BACKTICKS. */
const HOST_SETUP_CSS = `
/* Design note #1630: neither the card nor the heading is a control; both are focused programmatically, so the ring is
   left to :focus-visible (the engine's judgement about the keyboard). */
.host-card:focus, .host-heading:focus { outline: none; }
.host-card:focus-visible, .host-heading:focus-visible { outline: 2px solid #f8e5a3; outline-offset: -2px; }
.host-type-card img { opacity: .9; }
.host-type-card[aria-checked="true"] img, .host-type-card:hover img { opacity: 1; }
`;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* #1651: the scrim is a <dialog> in the top layer, above the whole document by definition. */
    pointerEvents: "auto", // #1360
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
    overflowY: "auto",
  },
  card: {
    /* W1-O: the cap is set at render, zoom-aware (`zoomAwareVh`); this is the at-100% value it replaces. */
    maxHeight: "calc(100vh - 48px)",
    /* W1-O (AUD-16.02): the BODY scrolls, not the card -- the header and the footer stay in view. */
    overflow: "hidden",
  },
  /* W1-O (AUD-16.02): the scrolling part of a step (the preview row and the step), between the pinned header and footer. */
  body: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
  footer: { flex: "none" },
  /* #1447: the media viewport -- identical in every card, black because the artwork's own ground is black. */
  typeWell: {
    display: "block",
    width: "100%",
    aspectRatio: "4 / 3",
    backgroundColor: "#000000",
  },
  typeArt: { display: "block", width: "100%", height: "100%", objectFit: "contain" },
};
