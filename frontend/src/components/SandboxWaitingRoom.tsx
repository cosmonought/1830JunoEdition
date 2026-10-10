// The waiting room: the table's own departure sign, your boarding pass, what to do before departure, every seat's
// pass, and the table's settings.
//
// Design note #529: this REPLACES the board rather than sitting over it -- before the deal there is no game, so the
// player count, the starting cash and the certificate limit are undecided. Design note #529a: only the host starts
// (Start is the one write that deals).
//
// ==================================================================
//  PLAY WAITING ROOM (approved design, "play-host-waiting-handoff" §4-§9): A DEPARTURE BOARD FOR ONE TABLE
// ==================================================================
//
// Top to bottom: Play's top bar; THE SIGN (§5) -- the edition's lockup, Status / Seats / Ante / Pace / Bank / Host /
// Variants, the code and the edition's sentence; YOUR BOARDING PASS (§6), the sign's full width on rag paper, in two
// halves -- who you are and your colour (left), and everything you do before departure (right: the status sentence, the
// action row with THE ONE ACTION, the Terms link, the error line); THE BOARDING BOARD (§8) -- every seat's pass in seat
// order, the tear and the stamps, "At this count"; GAME SETTINGS (with Skip the titles, Report a player and the host's
// Cancel table) and VARIANTS (§9); the Ludum footer. Visibility and the code are not changed from here (§5, §16).
//
// LIVE-2D STILL HOLDS: drawn from the server's per-recipient `RoomView`; every control is one named `room-op` the
// server authorizes against its own record, shown only to the role that may use it, greyed while a request is in flight;
// a refusal is shown as the sentence it is. The ROLE is the server's (`you.role`).
//
// THE MONEY (§6, §7): this screen owns ONE `useMoneyTable` and shares it. The pass carries the Ante -- one press runs
// what the seat still needs (`moneyActions.anteNow`: connect, the free proof, the deposit), each approved in Keplr's
// own window -- with a status line naming the approval Keplr is showing ("Check Keplr: … (2 of 3)"). The pass's right half
// also carries, inset in their own dark look, everything else the seat's money needs, unchanged (`MoneyPanelView`, layout "departure"): "Confirm it's you",
// the wallet questions, the No-deadline acknowledgement, the deposit's terms, the exit confirmations, the pending
// transaction, the escrow details. The host's ante editor sends the new `set-ante` op, which the SERVER allows only
// until the first deposit. Funding is only ever what the server read from Juno: a pass tears and "Boarded" lands when
// the server says the seat funded, never on a click.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { GAME_TYPE_COPY, STANDARD_VARIANTS, VARIANT_COPY, type VariantCopyKey, gameTypeOf } from "../gameEngine/gameVariants";

import { roomVisibility, seatsNeeded, waitingRoomBlock } from "../utils/sandboxRoom";
import type { RoomOpResult, RoomView, RoomVisibility } from "../utils/roomProtocol";
import { MIN_PLAYERS, certLimitForPlayers, startingCashForPlayers } from "../gameEngine/gameSetup";
import { VISIBILITY_COPY, PLUS_TILES_TITLE, HOUSE_RULE_ROWS } from "./HostSetupCard";
import { SEAT_COLORS, SEAT_COLOR_NAMES, resolveSeatColors } from "../utils/playerLabels";
import { MoneyPanelView, type AskedKind } from "./money/MoneyPanel";
import { KeplrMark } from "./money/KeplrMark";
import { CLOCK_ASYNC_PACES_SECS, CLOCK_OPS, type RoomClockView } from "../utils/clockProtocol";
import { paceLabel } from "../utils/gameClockView";
import { roomOp } from "../utils/roomLink";
import { ReportPlayerControl } from "./ReportPlayerControl";
import type { ReportPlayerBody } from "../utils/conductApi";
import { TermsLink } from "./InfoPages";
import { amountText } from "../money/moneyFlow";
import { moneyServices } from "../money/moneySession";
import { useMoneyTable } from "../money/useMoneyTable";
import { formatAmount, parseAmountToBase, type MoneySeatFunding } from "../utils/moneyProtocol";
import { type AudioControlsProps } from "./AudioControls";
/* Design note #1138: the shell's own bar, mounted here so the audio controls stay put between anteroom and table. */
import TopBar from "./TopBar";
import { setSkipIntroPreferred, skipIntroPreferred } from "../utils/introPreference";
import { chromeZoomFor } from "../styles/appStyles";
import { useUiScale } from "../utils/useUiScale";
/* W1-O (AUD-16.05): breakpoints asked in the zoomed root's own pixels. */
import { zoomAwareMediaCss } from "../utils/uiScale";
import { EDITION_NAME, clockText, type PublicSeatHistory } from "../utils/lobbyBoard";
import { readPublicPlayers } from "./LobbyBoards";
import {
  PASS_STATE_TEXT,
  ROOM_STATUS_CLASS,
  ROOM_STATUS_WORD,
  anteFeeSentence,
  approvalOf,
  approvalStatus,
  bankText,
  departureBlocker,
  leadSentence,
  paceText,
  plannedApprovals,
  roomStatus,
  type ApprovalStep,
  type PaceChoice,
  type PassState,
} from "../utils/roomDesign";
import { RAG_PAPER_URL, ROOM_DESIGN_CSS } from "./room/roomDesignCss";
import { BoardingPass, ClockRules, EDITION_TOKEN, Lockup, OpenSeat, PlayerPanel, RoomFooter, type PanelHistory } from "./room/RoomParts";
import SplitFlap from "./SplitFlap";

/** Design note #1271: `expandedMap` and `levelPlayingField` are the Game Type (one choice), not toggles -- named here so
 *  `variantWiring.test.ts` can still ask that every boolean flag reaches a control somewhere. */
export const GAME_TYPE_FLAGS = ["expandedMap", "levelPlayingField"] as const;

/** The table's variants in force, in the order the Variants section reads them: the tile tray, then the four rules
 *  (#961a: the shared copy, so a rule reads the same here as on the host's card). */
const VARIANT_ROWS: ReadonlyArray<{ key: VariantCopyKey; title: string; blurb: string }> = [
  { key: "plusTiles", title: PLUS_TILES_TITLE, blurb: VARIANT_COPY.plusTiles.blurb },
  ...HOUSE_RULE_ROWS.map((row) => ({ key: row.key as VariantCopyKey, title: row.title, blurb: VARIANT_COPY[row.key].blurb })),
];

/** How long the sign holds DEPARTING before the opening titles take over (handoff §9.4); reduced motion: briefly. */
export const DEPART_HOLD_MS = 2_100;
export const DEPART_HOLD_REDUCED_MS = 300;

export interface SandboxWaitingRoomProps {
  /** LIVE-2D: the table's code, or "Private game" to an outsider. */
  roomCode: string;
  room: RoomView | null;
  /** LIVE-2D: this tab's seat, from `room.you.playerId` ("" when it holds none). Presentation only. */
  localPlayerId: string;
  error: string | null;
  busy: boolean;
  /** Kept for the shell's wiring. PLAY WAITING ROOM: the design has no name field -- a seat's name is the account's
   *  profile name (`create` and `take-seat` seed it); `set-profile {nickname}` is no longer offered here. */
  onSetNickname?: (nickname: string) => void;
  /** Design note #569: `null` returns this seat to the assigned default. */
  onSetColor: (color: string | null) => void;
  /** Development builds' no-ante tables only: Ready (a production table's Ready is its ante). */
  onToggleReady: (isReady: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
  /** #1415: the host removes a joiner, before the start only. `undefined` for a guest. */
  onKick?: (playerId: string) => void;
  /** LIVE-2D: a watcher of a waiting table takes a seat (`take-seat`). Absent when the table cannot seat them. */
  onTakeSeat?: () => void;
  /** LIVE-2D: a seated player gives the seat up and keeps watching (`release-seat`). */
  onReleaseSeat?: () => void;
  /** NOT OFFERED HERE (handoff §5, §10, §16): visibility is chosen in Host a game and only shown afterwards, and the
   *  code doesn't change from the waiting room. Kept in the props for the shell's wiring; the server ops stand. */
  onSetVisibility?: (visibility: RoomVisibility) => void;
  onRotateCode?: () => void;
  /** LIVE-2D, host only: hand the host role on (`transfer-host`) -- never at a money table (its host is the escrow's
   *  creator on Juno), so only a development build's no-ante table offers it. */
  onTransferHost?: (playerId: string) => void;
  /** LIVE-2D, host only: close the table for everybody (`cancel-room`). */
  onCancelRoom?: () => void;
  /** Phase 3 (P3-N035): a seated player reports another seat's conduct (`room-op report-player`). */
  onReport?: (body: ReportPlayerBody) => Promise<RoomOpResult>;
  /** Design note #1101/#1102: the same audio controls the bar carries in the game. */
  audio?: AudioControlsProps["audio"];
  /** The host started: the sign flips to DEPARTING and holds before the opening titles (§9.4). */
  departing?: boolean;
  /** Tests: the room-op sender for the ante editor and the deadline chooser. */
  sendOp?: typeof roomOp;
}

const utcHm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
/** An amount's number alone ("2.5"), as the ante editor's field shows it (`formatAmount` never groups digits). */
const plainAmount = (base: string, exponent: number, symbol: string): string => formatAmount(base, exponent, symbol).replace(` ${symbol}`, "");

export function SandboxWaitingRoom({
  roomCode,
  room,
  localPlayerId,
  error,
  busy,
  onSetColor,
  onToggleReady,
  onStart,
  onLeave,
  onKick,
  onTakeSeat,
  onReleaseSeat,
  onTransferHost,
  onCancelRoom,
  onReport,
  audio,
  departing: departingHold = false,
  sendOp = roomOp,
}: SandboxWaitingRoomProps) {
  const uiScale = useUiScale();
  const players = room?.players ?? [];
  const me = players.find((player) => player.id === localPlayerId) ?? null;
  /* Design note #1337: one colour per seat, chosen or assigned, the same on every client. */
  const resolvedColors = resolveSeatColors(players);
  const isHost = room?.you.role === "host";
  const variants = room?.variants ?? STANDARD_VARIANTS;
  const type = gameTypeOf(variants);
  const visibility = roomVisibility(room);
  const exact = typeof room?.playerCount === "number";
  const cap = room?.playerCount ?? room?.seatCap ?? 0;
  const money = room?.money ?? null;
  const wasKicked = room !== null && room.you.kicked;
  /* A seat is still free at a waiting table (a watcher's panel says how to take it, or that it can't). */
  const seatFree = room !== null && room.status === "waiting" && room.joinable && players.length < cap;
  const hostPlayer = players.find((player) => player.id === room?.hostId) ?? null;
  const hostName = hostPlayer?.nickname || "The host";
  const nameOf = (player: { nickname: string }) => player.nickname || "A player";

  /* ---- the money: ONE hook, shared by the pass's action, its status line and the money steps under them */
  const services = moneyServices();
  const table = useMoneyTable({ gameId: room?.gameId ?? "", view: money, variants, isHost, services, onStart, clock: room?.clock ?? null });
  const flow = money !== null ? table.flow : null;
  const [asking, setAsking] = useState<AskedKind | null>(null);
  const inFlight = table.busy !== null || busy;
  const approving = table.busy === "ante" || table.busy === "verify";
  const fundingOf = (playerId: string): MoneySeatFunding => money?.seats.find((seat) => seat.playerId === playerId)?.funding ?? "none";
  const myFunding: MoneySeatFunding = money?.you?.funding ?? (me !== null ? fundingOf(me.id) : "none");
  const escrowOpen = money?.escrow.chainGameId != null;
  const anyMoney = money !== null && (escrowOpen || players.some((player) => fundingOf(player.id) !== "none" && fundingOf(player.id) !== "linked") || table.pending !== null);

  /* ---- §7: the Keplr approval count, planned at the press and followed as the Ante runs */
  const [approvals, setApprovals] = useState<{ plan: ApprovalStep[]; seen: ApprovalStep[] } | null>(null);
  useEffect(() => {
    const step = approvalOf(table.progress);
    if (step === null) return;
    setApprovals((current) => (current === null || current.seen[current.seen.length - 1] === step ? current : { ...current, seen: [...current.seen, step] }));
  }, [table.progress]);
  useEffect(() => {
    if (table.busy === null) setApprovals(null);
  }, [table.busy]);
  const pressAnte = () => {
    setApprovals({
      plan: plannedApprovals({ connected: table.wallet.kind === "connected", linked: money?.you?.link != null, proofRefused: table.proof === "refused", isHost }),
      seen: [],
    });
    void table.run("ante");
  };

  /* ---- §6: the tear -- only the moment of funding animates; a seat already funded when the page loads is torn */
  const fundedIds = players.filter((player) => fundingOf(player.id) === "funded").map((player) => player.id);
  const fundedKey = fundedIds.join(",");
  const seenFunded = useRef<Set<string> | null>(null);
  const [tearing, setTearing] = useState<ReadonlySet<string>>(() => new Set());
  const tearTimers = useRef<number[]>([]);
  useEffect(() => {
    if (money === null) return;
    const previous = seenFunded.current;
    seenFunded.current = new Set(fundedIds);
    if (previous === null) return;
    const fresh = fundedIds.filter((id) => !previous.has(id));
    if (fresh.length === 0) return;
    setTearing((current) => new Set([...Array.from(current), ...fresh]));
    tearTimers.current.push(
      window.setTimeout(() => {
        setTearing((current) => new Set(Array.from(current).filter((id) => !fresh.includes(id))));
      }, 1_100),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundedKey, money === null]);
  useEffect(() => () => tearTimers.current.forEach((timer) => window.clearTimeout(timer)), []);

  /* ---- local UI state */
  const [kicking, setKicking] = useState<string | null>(null);
  const [handingOver, setHandingOver] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [skipIntro, setSkipIntro] = useState(() => skipIntroPreferred());
  const [clockOpen, setClockOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  /* ---- the sign */
  const departing = departingHold || room?.status === "playing" || money?.start.state === "starting" || money?.start.state === "started";
  const status = roomStatus({ departing, seated: players.length, cap, exact });
  const pace: PaceChoice = {
    mode: variants.mode,
    deadline: room?.clock?.deadline ?? (variants.mode === "live" ? "live" : null),
    paceSecs: room?.clock?.paceSecs ?? null,
  };
  const ante = money !== null ? amountText(money, money.terms.anteGross) : null;
  const exponent = money?.deployment.exponent ?? 6;
  const symbol = money?.deployment.symbol ?? "JUNOX";
  const fundedSeats = money?.escrow.fundedSeats ?? 0;
  const fundOf = exact ? cap : players.length;
  const totalOf = (n: number): string => (money === null ? "" : formatAmount((BigInt(/^[0-9]{1,40}$/.test(money.terms.anteGross) ? money.terms.anteGross : "0") * BigInt(n)).toString(), exponent, symbol));
  const fundedLine =
    money === null
      ? "No ante at this table (development build)."
      : `${fundedSeats} of ${fundOf} ${exact ? "seats" : "seated"} funded${fundedSeats > 0 ? ` · ${totalOf(fundedSeats).replace(` ${symbol}`, "")} of ${totalOf(fundOf)}` : ""}`;
  const variantRows = VARIANT_ROWS.filter((row) => variants[row.key] && !(row.key === "plusTiles" && variants.levelPlayingField));
  const code = room?.code ?? null;
  const copyCode = () => {
    if (code === null) return;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    };
    try {
      void navigator.clipboard?.writeText(code).then(done, () => undefined);
    } catch {
      /* no clipboard on an insecure origin: the code is `user-select: all` and can be copied by hand */
    }
  };

  /* ---- the pass's right half: the status sentence and what it reads */
  const needed = seatsNeeded(room, MIN_PLAYERS);
  const allReady = players.length > 0 && players.every((player) => player.isReady);
  const canStartFree = isHost && (room?.you.canStart ?? false) && players.length >= needed && allReady;
  const canStart = !departing && (money !== null ? flow?.primary?.kind === "start" : canStartFree);
  const allIn = money !== null && (exact ? players.length === cap : players.length >= MIN_PLAYERS) && players.every((player) => fundingOf(player.id) === "funded");
  const blocker = money !== null ? departureBlocker(money, money.start.blocker, table.now, { exact, seated: players.length, cap }) : null;
  const special =
    flow === null
      ? null
      : flow.stage === "held" || flow.stage === "cancelled" || flow.stage === "started" || flow.stage === "starting"
        ? flow.headline
        : myFunding === "unlinked"
          ? flow.headline
          : flow.step === "sent" && flow.primary?.kind === "resend"
            ? flow.headline
            : /* linked, but the escrow won't take this seat's deposit right now (Juno unreadable, the host's ante gone, …) */
              myFunding === "linked" && flow.primary === null && (isHost || escrowOpen) && flow.detail !== null
              ? flow.detail
              : null;
  const lead =
    money === null
      ? freeTableLead({ departing, isHost, canStart: canStartFree, exact, cap, block: waitingRoomBlock(room, MIN_PLAYERS), ready: me?.isReady ?? false })
      : leadSentence({
          departing,
          isHost,
          hostName,
          ante: ante ?? "",
          exact,
          seated: players.length,
          approving,
          funding: myFunding === "unlinked" ? "unlinked" : myFunding,
          sending: table.pending !== null && (table.pending.kind === "create" || table.pending.kind === "join"),
          escrowOpen,
          allIn,
          canStart: flow?.primary?.kind === "start",
          blocker,
          special,
        });
  /* The flow's own detail, under the lead, where it says something the lead doesn't (held, a signed-only deposit, …). */
  const leadDetail = flow !== null && special === flow.headline && flow.detail !== null ? flow.detail : null;

  /* ---- §6: the host's ante editor (until the first deposit -- the server decides; this hides it once money moved) */
  const [anteDraft, setAnteDraft] = useState<string | null>(null);
  const [anteEditing, setAnteEditing] = useState(false);
  const anteInput = useRef<HTMLInputElement | null>(null);
  const [anteSending, setAnteSending] = useState(false);
  const [anteError, setAnteError] = useState<string | null>(null);
  const anteEditable = isHost && money !== null && !departing && room?.status === "waiting" && !anyMoney && !approving;
  const anteCurrent = money === null ? "" : plainAmount(money.terms.anteGross, exponent, symbol);
  const anteTyped = anteDraft ?? anteCurrent;
  const anteBase = parseAmountToBase(anteTyped, exponent);
  const anteBelowMin = anteBase !== null && money?.terms.minAnte != null && BigInt(anteBase) < BigInt(money.terms.minAnte);
  const openAnteEditor = () => {
    setAnteEditing(true);
    setAnteDraft(anteCurrent);
    setAnteError(null);
    window.setTimeout(() => anteInput.current?.select(), 0);
  };
  const closeAnteEditor = () => {
    setAnteEditing(false);
    setAnteDraft(null);
    setAnteError(null);
  };
  const submitAnte = () => {
    if (room === null || money === null) return;
    if (anteBase === null) {
      setAnteError(`Enter the ante in ${symbol}, like 10 or 2.5 (above zero).`);
      return;
    }
    if (anteBelowMin) {
      setAnteError(`The smallest ante Juno's escrow accepts is ${formatAmount(money.terms.minAnte, exponent, symbol)}.`);
      return;
    }
    setAnteSending(true);
    setAnteError(null);
    void sendOp({ type: "set-ante", stake: anteBase }, room.gameId).then((answer) => {
      setAnteSending(false);
      if (answer.ok) closeAnteEditor();
      else setAnteError(answer.reason);
    });
  };

  /* ---- §8: the player panel (the lobby's public history; the tablemate facts for seated viewers) */
  const [panel, setPanel] = useState<{ playerId: string; anchor: HTMLElement } | null>(null);
  /* The table's public answer, read once per roster: null while it is read; "private" / "error" when it can't be. */
  const [history, setHistory] = useState<{ key: string; seats: PublicSeatHistory[] | "private" | "error" | null } | null>(null);
  const roster = players.map((player) => player.id).join(",");
  const historyKey = `${room?.gameId ?? ""}|${roster}|${visibility}`;
  const closePanel = useCallback(() => setPanel(null), []);
  useEffect(() => {
    if (panel === null || room === null) return undefined;
    if (history !== null && history.key === historyKey) return undefined;
    /* The endpoint answers only for a table in the public list (`publicHistory.ts`): a private table's names are not
       tied to anyone's public record here. */
    if (visibility !== "public") {
      setHistory({ key: historyKey, seats: "private" });
      return undefined;
    }
    setHistory({ key: historyKey, seats: null });
    let live = true;
    void readPublicPlayers(room.gameId).then(
      (seats) => live && setHistory({ key: historyKey, seats: seats ?? "error" }),
      () => live && setHistory({ key: historyKey, seats: "error" }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, historyKey]);
  const panelPlayer = panel === null ? null : (players.find((player) => player.id === panel.playerId) ?? null);
  useEffect(() => {
    if (panel !== null && panelPlayer === null) setPanel(null);
  }, [panel, panelPlayer]);
  const panelHistory = (seat: number): PanelHistory => {
    const seats = history?.key === historyKey ? history.seats : null;
    if (seats === null) return { state: "loading" };
    if (seats === "private") return { state: "private" };
    if (seats === "error") return { state: "error" };
    return { state: "ok", history: seats.find((entry) => entry.seat === seat)?.history ?? null };
  };
  const openPanel = (playerId: string, anchor: HTMLElement) => setPanel((current) => (current?.playerId === playerId ? null : { playerId, anchor }));

  /* ---- what each seat's pass says */
  const passState = (playerId: string): PassState => {
    if (money === null) return players.find((player) => player.id === playerId)?.isReady ? "ready" : "not-ready";
    const funding = fundingOf(playerId);
    if (funding === "funded") return "paid";
    if (funding === "sent") return "sent";
    if (funding === "unlinked") return "unlinked";
    if (playerId === room?.hostId && !escrowOpen) return "opens";
    return "none";
  };
  const stampOf = (state: PassState): "sent" | "boarded" | null => (state === "paid" ? "boarded" : state === "sent" ? "sent" : null);

  /* ---- the action printed on your pass */
  const passAction = (): JSX.Element | null => {
    if (departing || me === null) return null;
    const startButton = (enabled: boolean, testId: string) => (
      <button type="button" className="rm-btn rm-primary rm-big" onClick={onStart} disabled={!enabled || busy || inFlight} title="Locks the seats with the escrow and starts the game on Juno." data-testid={testId}>
        Start game
      </button>
    );
    if (money === null) {
      return (
        <>
          <button type="button" className={isHost ? "rm-qbtn" : "rm-btn rm-primary rm-big"} onClick={() => onToggleReady(!me.isReady)} disabled={busy} data-testid="ready-toggle">
            {me.isReady ? "Not ready" : "Ready to play"}
          </button>
          {isHost ? startButton(canStartFree, "start-game") : null}
        </>
      );
    }
    if (flow === null) return null;
    if (approving) {
      return (
        <button type="button" className="rm-btn rm-primary rm-big" disabled data-testid="money-action-ante">
          Approve in Keplr…
        </button>
      );
    }
    if (flow.step === "sent" && flow.primary?.kind !== "resend") {
      return (
        <button type="button" className="rm-btn rm-primary rm-big" disabled data-testid="money-sent">
          Sent · waiting for Juno
        </button>
      );
    }
    if (myFunding === "funded") {
      /* §6: once the host has anted, Start game takes the Ante's place (disabled until the table can start; the status
         sentence says why). A funded guest gets Withdraw deposit there -- and, past the server's grace for a host who
         hasn't started, Start game too (`money.start.canStart`, Play's existing rule). */
      const withdraw = isHost ? undefined : flow.others.find((action) => action.kind === "withdraw");
      const guestStart = !isHost && flow.primary?.kind === "start";
      return (
        <>
          {isHost || guestStart ? startButton(canStart, "money-action-start") : null}
          {withdraw !== undefined ? (
            <button type="button" className="rm-qbtn" onClick={() => setAsking("withdraw")} disabled={inFlight} title={withdraw.title} data-testid="money-action-withdraw">
              {withdraw.label}
            </button>
          ) : null}
        </>
      );
    }
    const primary = flow.primary;
    if (primary === null || primary.kind === "start") return null;
    const isAnte = primary.kind === "ante" || primary.kind === "verify";
    /* Guests before the host has anted: the Ante is shown, disabled (the lead sentence says why -- §6, open question 1). */
    const disabled = inFlight || flow.blocker !== null || primary.kind === "verify";
    return (
      <button
        type="button"
        className="rm-btn rm-primary rm-big"
        disabled={disabled}
        title={primary.kind === "verify" ? "Opens once the host's ante has opened the table on Juno." : primary.title}
        onClick={() => (primary.kind === "ante" ? pressAnte() : void table.run(primary.kind))}
        data-testid={`money-action-${primary.kind === "verify" ? "ante" : primary.kind}`}
      >
        {primary.kind === "connect" ? <KeplrMark /> : null}
        {isAnte ? `Ante ${ante}` : table.busy === primary.kind ? `${primary.label}…` : primary.label}
      </button>
    );
  };
  const keplrLine = approving ? (approvalStatus(approvals?.plan ?? [], approvals?.seen ?? []) ?? "Keplr shows each step before anything moves.") : "";

  const cancelEscrow = flow?.others.find((action) => action.kind === "cancel-escrow") ?? null;
  const hostMoneyOut = money !== null && (fundedSeats > 0 || escrowOpen);
  const termsLine = `${GAME_TYPE_COPY[type].label} · ${paceText(pace)} · ${bankText(variants.length)}`;
  const cash = startingCashForPlayers(players.length, variants);
  const certs = certLimitForPlayers(players.length, variants);

  return (
    <div className="rm" style={{ ...styles.root, ...chromeZoomFor(uiScale) }} data-testid="waiting-room-main">
      <style>{zoomAwareMediaCss(ROOM_DESIGN_CSS, uiScale)}</style>
      {/* Design note #1138: the shell's own title bar -- one control, one position, both screens. */}
      <TopBar onLeaveGame={onLeave} audio={audio} />
      <main className="rm-wrap">
        {/* ================================================================ the sign (§5) */}
        <section className="rm-gate" style={{ ["--rm-ed" as string]: EDITION_TOKEN[type] } as React.CSSProperties} aria-labelledby="rm-g-title" data-testid="room-sign">
          <div className="rm-g-top">
            <span className="rm-kick">Waiting room</span>
            <span className="rm-g-top-r">
              <span className="rm-g-four">
                <span className="rm-lab">Table</span>
                <SplitFlap text={code === null ? "----" : code.slice(-4)} width={4} className="rm-flap-sm" label={code === null ? "Private table" : `Table ${code.slice(-4)}`} />
              </span>
              <span className="rm-clock" aria-label="Time now, UTC">
                {clockText(now)}
              </span>
            </span>
          </div>
          <div className="rm-g-main">
            <Lockup type={type} as="h1" id="rm-g-title" />
            <dl className="rm-g-fields">
              <div className="rm-g-st">
                <dt>Status</dt>
                <dd>
                  <SplitFlap text={ROOM_STATUS_WORD[status]} width={10} className={`rm-flap-lg ${ROOM_STATUS_CLASS[status]}`} label={ROOM_STATUS_WORD[status]} testId="room-status" />
                </dd>
              </div>
              <div>
                <dt>Seats</dt>
                <dd>
                  <SplitFlap text={`${players.length}/${cap}`} width={3} className="rm-flap-sm" label={`${players.length} of ${cap} seats`} testId="room-seats" />
                  <span className="rm-pips" aria-hidden="true">
                    {Array.from({ length: cap }, (_, i) => (
                      <i key={i} className={i < players.length ? "rm-on" : undefined} />
                    ))}
                  </span>
                  <small>{exact ? "Exactly" : `Any count, up to ${cap}`}</small>
                </dd>
              </div>
              <div>
                <dt>Ante</dt>
                <dd>
                  {ante !== null ? <SplitFlap text={ante} width={Math.max(9, ante.length)} className="rm-flap-sm rm-flap-pink" label={ante} testId="room-ante" /> : <span>None</span>}
                  <small data-testid="room-funded">{fundedLine}</small>
                </dd>
              </div>
              <div>
                <dt>Pace</dt>
                <dd>{paceText(pace)}</dd>
              </div>
              <div>
                <dt>Bank</dt>
                <dd>{bankText(variants.length)}</dd>
              </div>
              <div>
                <dt>Host</dt>
                <dd>
                  {hostName}
                  {room !== null ? <small>Opened {utcHm(room.createdAtMs)} UTC</small> : null}
                </dd>
              </div>
              {variantRows.length > 0 ? (
                <div>
                  <dt>Variants</dt>
                  <dd>{variantRows.map((row) => row.title).join(", ")}</dd>
                </div>
              ) : null}
            </dl>
          </div>
          <div className="rm-g-foot">
            <span className="rm-roomline">
              <span className="rm-lab">Room</span>
              <code className="rm-code" data-testid="waiting-room-code">
                {code ?? roomCode}
              </code>
              {code !== null ? (
                <button type="button" className="rm-qbtn" onClick={copyCode} data-testid="copy-code">
                  {copied ? "Copied" : "Copy code"}
                </button>
              ) : null}
            </span>
            <p>{GAME_TYPE_COPY[type].blurb}</p>
          </div>
        </section>

        {/* ================================================================ your boarding pass (§6): the sign's full width,
             two halves -- who you are (left), everything you do before departure (right) */}
        <div className="rm-you-row">
          {me !== null && room !== null ? (
            <BoardingPass
              big
              name={nameOf(me)}
              seat={players.indexOf(me) + 1}
              seedText={`${me.id}|${players.indexOf(me)}`}
              color={resolvedColors[me.id] ?? SEAT_COLORS[0]}
              host={me.id === room.hostId}
              you
              away={false}
              meta={termsLine}
              ante={ante}
              torn={myFunding === "funded"}
              tearing={tearing.has(me.id)}
              stamp={stampOf(passState(me.id))}
              onName={(anchor) => openPanel(me.id, anchor)}
              panelOpen={panel?.playerId === me.id}
              testId="room-your-pass"
              actions={
                <div className="rm-p-act" data-testid="before-departure">
                  <p className="rm-p-say" role="status" data-testid="room-lead">
                    {lead}
                  </p>
                  {leadDetail !== null ? <p className="rm-why">{leadDetail}</p> : null}
                  {!isHost && money !== null && !anyMoney && !departing ? <p className="rm-why">The host can still change the ante until the first deposit.</p> : null}
                  {anteEditable && anteEditing ? (
                    <form
                      className="rm-ante-edit"
                      data-testid="ante-editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitAnte();
                      }}
                    >
                      <label htmlFor="rm-ante-in">Ante per seat</label>
                      <span className="rm-amount">
                        <input
                          id="rm-ante-in"
                          ref={anteInput}
                          inputMode="decimal"
                          autoComplete="off"
                          value={anteTyped}
                          onChange={(event) => {
                            setAnteDraft(event.target.value);
                            setAnteError(null);
                          }}
                          aria-describedby="rm-ante-note"
                          disabled={anteSending}
                          data-testid="ante-editor-input"
                        />
                        <span>{symbol}</span>
                        <button type="submit" className="rm-qbtn" disabled={anteSending || busy} data-testid="ante-editor-set">
                          {anteSending ? "Setting…" : "Set ante"}
                        </button>
                        <button type="button" className="rm-qbtn" disabled={anteSending} onClick={closeAnteEditor} data-testid="ante-editor-keep">
                          Keep {ante}
                        </button>
                      </span>
                      <p className="rm-why" id="rm-ante-note">
                        {anteBase === null
                          ? `Enter the ante in ${symbol}, like 10 or 2.5 (above zero).`
                          : `${anteFeeSentence(anteBelowMin ? (money?.terms.anteGross ?? anteBase) : anteBase, money?.terms.feeBps, exponent, symbol)} You can change the ante until the first deposit.`}
                      </p>
                    </form>
                  ) : null}
                  {!departing ? (
                    <div className="rm-p-foot">
                      {anteEditable && anteEditing ? null : passAction()}
                      {anteEditable && !anteEditing ? (
                        <button type="button" className="rm-qbtn" onClick={openAnteEditor} disabled={busy} data-testid="ante-editor-open">
                          Change ante
                        </button>
                      ) : null}
                      {onReleaseSeat ? (
                        <button
                          type="button"
                          className="rm-qbtn"
                          onClick={onReleaseSeat}
                          disabled={busy}
                          title={isHost ? "Give up your seat. The host role passes to the next player who joined; with nobody left, the table closes." : "Give up your seat and keep watching this table."}
                          data-testid="release-seat"
                        >
                          Give up seat
                        </button>
                      ) : null}
                      <p className="rm-keplr" role="status" aria-live="polite" data-testid="money-progress">
                        {keplrLine}
                      </p>
                    </div>
                  ) : null}
                  {money !== null ? <TermsLink className="rm-link" label="Terms of real-money play" testId="waiting-room-terms-link" /> : null}
                  {money !== null ? (
                    <div className="rm-money" data-testid="room-money-steps">
                      <MoneyPanelView room={room} table={table} services={services} busy={busy} asking={asking} setAsking={setAsking} layout="departure" />
                    </div>
                  ) : null}
                  {anteError !== null || error ? (
                    <p className="rm-err" role="alert" data-testid="waiting-room-error">
                      {anteError ?? error}
                    </p>
                  ) : null}
                </div>
              }
            >
              {!departing ? (
                <div className="rm-colour" role="group" aria-labelledby="rm-colour-l">
                  <span id="rm-colour-l">Set player colour:</span>
                  <span className="rm-swatches">
                    {SEAT_COLORS.map((color) => {
                      /* #1337: a seat's DEFAULT colour is held too -- the table sees colours, not intents. */
                      const holder = players.find((player) => resolvedColors[player.id] === color && player.id !== localPlayerId);
                      /* The swatch the seat is drawn in is the pressed one, chosen or assigned (#1337); pressing a
                         CHOSEN colour again hands the choice back to the game (#569). */
                      const mine = me.color === color;
                      const inUse = resolvedColors[me.id] === color;
                      const label = SEAT_COLOR_NAMES[color] ?? color;
                      return (
                        <button
                          key={color}
                          type="button"
                          className="rm-sw"
                          style={{ ["--c" as string]: color } as React.CSSProperties}
                          aria-pressed={inUse}
                          aria-label={label}
                          disabled={busy || holder !== undefined}
                          onClick={() => onSetColor(mine ? null : color)}
                          title={holder ? `${nameOf(holder)} has taken ${label}.` : mine ? `${label} — click again to let the game assign one.` : label}
                        />
                      );
                    })}
                  </span>
                </div>
              ) : null}
            </BoardingPass>
          ) : wasKicked ? (
            <div className="rm-nopass" data-testid="waiting-room-removed">
              <span className="rm-wtag">Removed</span>
              <p>You no longer hold a seat at this table.</p>
              <p className="rm-why">The host removed you from this table. You cannot rejoin it; leave and join or host another.</p>
              {error ? (
                <p className="rm-err" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="rm-nopass" data-testid="waiting-room-watching">
              <span className="rm-wtag">Watching</span>
              {/* Three cases, never confused: a seat this tab may take; a seat free but this is a read-only Watch tab (OD-19:
                  a seat is taken with Join, from the lobby); every seat taken. */}
              <p>{onTakeSeat ? "You are watching this table. Take a seat to play." : seatFree ? "You are watching this table. To play, join it from the lobby with its code." : "You are watching this table. Every seat is taken."}</p>
              {onTakeSeat ? (
                <div className="rm-actions">
                  <button type="button" className="rm-btn rm-primary rm-big" onClick={onTakeSeat} disabled={busy} data-testid="take-seat">
                    Take a seat
                  </button>
                </div>
              ) : null}
              <p className="rm-why">{onTakeSeat || seatFree ? (ante !== null ? `Taking a seat holds it for you. You board by anteing ${ante}.` : "Taking a seat holds it for you.") : "You can keep watching; the game is shown here when it starts."}</p>
              {error ? (
                <p className="rm-err" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {/* ================================================================ the Boarding board (§8) */}
        <section className="rm-board" aria-labelledby="rm-boarding-h" data-testid="boarding-board">
          <div className="rm-b-head">
            <h2 id="rm-boarding-h">
              Boarding
              <span className="rm-count" data-testid="boarding-count">
                {exact ? `${players.length} of ${cap} seats · exactly` : `${players.length} seated · up to ${cap}`}
              </span>
            </h2>
            <span className="rm-b-hint">Tap a name for their game history</span>
          </div>
          <ol className="rm-passes" aria-label="Every seat at this table">
            {Array.from({ length: Math.max(cap, players.length) }, (_, i) => {
              const player = players[i];
              if (player === undefined) return <OpenSeat key={`open-${i}`} seat={i + 1} exact={exact} ante={ante} />;
              const state = passState(player.id);
              const isMe = player.id === localPlayerId;
              const canKick = isHost && !isMe && room?.status === "waiting" && !departing && !busy && onKick !== undefined && player.id !== room?.hostId;
              const canTransfer = isHost && !isMe && money === null && !departing && onTransferHost !== undefined;
              return (
                <BoardingPass
                  key={player.id}
                  name={nameOf(player)}
                  seat={i + 1}
                  seedText={`${player.id}|${i}`}
                  color={resolvedColors[player.id] ?? SEAT_COLORS[i % SEAT_COLORS.length]}
                  host={player.id === room?.hostId}
                  you={isMe}
                  away={!player.online}
                  meta={PASS_STATE_TEXT[state]}
                  ante={ante}
                  torn={state === "paid"}
                  tearing={tearing.has(player.id)}
                  stamp={stampOf(state)}
                  hideStamp={kicking === player.id || handingOver === player.id}
                  onName={(anchor) => openPanel(player.id, anchor)}
                  panelOpen={panel?.playerId === player.id}
                  testId={money !== null ? `money-seat-${player.id}` : `room-pass-${player.id}`}
                >
                  {canKick || canTransfer ? (
                    <span className="rm-p-foot">
                      {kicking === player.id ? (
                        <>
                          <span className="rm-why">Remove {nameOf(player)}?</span>
                          <button
                            type="button"
                            className="rm-qbtn rm-solid-danger"
                            onClick={() => {
                              setKicking(null);
                              onKick?.(player.id);
                            }}
                            data-testid={`kick-confirm-${player.id}`}
                          >
                            Remove
                          </button>
                          <button type="button" className="rm-qbtn" onClick={() => setKicking(null)}>
                            Keep
                          </button>
                        </>
                      ) : handingOver === player.id ? (
                        <>
                          <span className="rm-why">Make {nameOf(player)} the host?</span>
                          <button
                            type="button"
                            className="rm-qbtn"
                            onClick={() => {
                              setHandingOver(null);
                              onTransferHost?.(player.id);
                            }}
                            data-testid={`transfer-confirm-${player.id}`}
                          >
                            Make host
                          </button>
                          <button type="button" className="rm-qbtn" onClick={() => setHandingOver(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <>
                          {canKick ? (
                            <button
                              type="button"
                              className="rm-qbtn rm-danger"
                              onClick={() => setKicking(player.id)}
                              aria-label={`Remove ${nameOf(player)} from the table`}
                              title="Remove this player. They cannot rejoin this room."
                              data-testid={`kick-${player.id}`}
                            >
                              ✕ Remove
                            </button>
                          ) : null}
                          {canTransfer ? (
                            <button type="button" className="rm-qbtn" onClick={() => setHandingOver(player.id)} title={`Make ${nameOf(player)} the host. You keep your seat.`} data-testid={`transfer-${player.id}`}>
                              Make host
                            </button>
                          ) : null}
                        </>
                      )}
                    </span>
                  ) : null}
                </BoardingPass>
              );
            })}
          </ol>
          <div className="rm-deal">
            <span className="rm-kick">At this count</span>
            <dl>
              <div>
                <dt>Players</dt>
                <dd>
                  <SplitFlap text={String(players.length)} width={1} className="rm-flap-gold" label={String(players.length)} />
                </dd>
              </div>
              <div>
                <dt>Each starts with</dt>
                <dd>
                  <SplitFlap text={cash !== null ? `$${cash.toLocaleString("en-US")}` : "--"} width={6} className="rm-flap-gold" label={cash !== null ? `$${cash.toLocaleString("en-US")}` : "not dealt below two players"} testId="room-cash" />
                </dd>
              </div>
              <div>
                <dt>Certificate limit</dt>
                <dd>
                  <SplitFlap text={certs !== null ? String(certs) : "--"} width={2} className="rm-flap-gold" label={certs !== null ? String(certs) : "not dealt below two players"} testId="room-certs" />
                </dd>
              </div>
            </dl>
          </div>
          <div className="rm-b-foot">Your seat is kept for your profile: reload, reconnect or sign in on another device and you are still seated.</div>
        </section>

        {/* ================================================================ Game settings and Variants (§9) */}
        <div className={variantRows.length > 0 ? "rm-lower rm-two" : "rm-lower"}>
          <section className="rm-sec rm-quiet" aria-labelledby="rm-settings-h" data-testid="game-settings">
            <h2 id="rm-settings-h">
              Game settings <small>Fixed when the table opened</small>
            </h2>
            <dl className="rm-terms">
              <div>
                <dt>Pace</dt>
                <dd>
                  <b data-testid="settings-pace">{paceText(pace)}</b>
                  <ClockRules pace={pace} feeBps={money?.terms.feeBps ?? null} open={clockOpen} onToggle={setClockOpen} testId="room-clock" />
                  {isHost && money === null && variants.mode === "async" && room?.status === "waiting" && !departing ? <DeadlineChooser gameId={room.gameId} clock={room.clock ?? null} sendOp={sendOp} /> : null}
                </dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>
                  <b>{VISIBILITY_COPY[visibility].label}</b>
                  <span>{VISIBILITY_COPY[visibility].blurb}</span>
                </dd>
              </div>
              <div>
                <dt>Bank</dt>
                <dd>
                  <b>{bankText(variants.length)}</b>
                </dd>
              </div>
            </dl>
            {/* §9.1: under the rows -- Skip the opening titles (seated players), Report a player, and the host's Cancel
                table under a hairline. Design note #1239: the titles are THIS browser's choice, not a term of the game. */}
            {me !== null ? (
              <label className="rm-skip">
                <input
                  type="checkbox"
                  checked={skipIntro}
                  onChange={(event) => {
                    setSkipIntroPreferred(event.target.checked);
                    setSkipIntro(event.target.checked);
                  }}
                />
                <span>
                  <b>Skip the opening titles</b>
                  <span>On this browser only. Other players still see them unless they tick this too.</span>
                </span>
              </label>
            ) : null}
            {onReport !== undefined ? (
              <p className="rm-why">
                <ReportPlayerControl room={room} onReport={onReport} />
              </p>
            ) : null}
            {isHost && !departing && room?.status === "waiting" && onCancelRoom ? (
              <div className="rm-host-end" data-testid="waiting-room-host-controls">
                {cancelling ? (
                  <div className="rm-confirm" role="group" aria-label="Cancel the table">
                    <p>Close this table for everyone? {hostMoneyOut ? "Every deposit comes back to its wallet, minus the fee." : "Nobody has anted, so nothing moves."}</p>
                    <div className="rm-actions">
                      <button
                        type="button"
                        className="rm-qbtn rm-solid-danger"
                        disabled={inFlight}
                        onClick={() => {
                          setCancelling(false);
                          /* Once the escrow is open the table closes on Juno (Play's CANCEL_FLOW: Keplr shows the
                             transaction, every deposit comes back minus the fee); before, it is the room's own cancel. */
                          if (cancelEscrow !== null) void table.run("cancel-escrow");
                          else onCancelRoom();
                        }}
                        data-testid="cancel-room-confirm"
                      >
                        Close the table for everyone
                      </button>
                      <button type="button" className="rm-qbtn" onClick={() => setCancelling(false)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="rm-qbtn rm-danger" onClick={() => setCancelling(true)} disabled={busy} title="Closes the table for everyone. Every deposit comes back to its wallet, minus the fee." data-testid="cancel-room">
                    Cancel table
                  </button>
                )}
              </div>
            ) : null}
          </section>
          {variantRows.length > 0 ? (
            <section className="rm-sec rm-quiet" aria-labelledby="rm-variants-h" data-testid="waiting-room-variants">
              <h2 id="rm-variants-h">Variants</h2>
              <ul className="rm-rules">
                {variantRows.map((row) => (
                  <li key={row.key}>
                    <b>{row.title}</b>
                    <span>{row.blurb}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </main>
      <RoomFooter />

      {panel !== null && panelPlayer !== null && room !== null ? (
        <PlayerPanel
          name={nameOf(panelPlayer)}
          seat={players.indexOf(panelPlayer) + 1}
          host={panelPlayer.id === room.hostId}
          playerId={panelPlayer.id}
          gameId={room.gameId}
          history={panelHistory(players.indexOf(panelPlayer))}
          seatedViewer={me !== null}
          anchor={panel.anchor}
          onClose={closePanel}
        />
      ) : null}
    </div>
  );
}

export default SandboxWaitingRoom;

/** A development build's no-ante table: its lead sentence (production tables are always anted). */
function freeTableLead(input: { departing: boolean; isHost: boolean; canStart: boolean; exact: boolean; cap: number; block: ReturnType<typeof waitingRoomBlock>; ready: boolean }): string {
  if (input.departing) return "Departing.";
  const waiting = input.block === "need-players" ? (input.exact ? `Waiting for every seat to be taken (${input.cap} players).` : "Waiting for at least 2 players.") : "Waiting for everyone to mark themselves ready.";
  if (input.isHost) return input.canStart ? "Everyone seated is ready. Start deals the game." : input.ready ? waiting : "No ante at this table (development build). Mark yourself ready, then start once everyone is.";
  return input.ready ? `You're ready. ${input.block === "host-to-start" ? "Waiting for the host to start the game…" : waiting}` : "No ante at this table (development build). Mark yourself ready when you're set.";
}

/* ==================================================================
    DESIGN NOTE 1258: THE HOLD IS DRAWN IN THE ROOM IT IS HOLDING FOR
   ==================================================================
   The frame between the lobby and the waiting room IS the waiting room -- its ground, its bar and its sign -- with a
   sentence where the table will be, for the one round trip the room's first view takes. */
export function SandboxWaitingRoomHold({
  roomCode,
  onLeave,
  audio,
  error = null,
}: Pick<SandboxWaitingRoomProps, "roomCode" | "onLeave" | "audio"> & {
  /** LIVE-2F/3D (C9-03): what the server said instead of a view -- said here, where the player is looking. */
  error?: string | null;
}) {
  const uiScale = useUiScale();
  return (
    <div className="rm" style={{ ...styles.root, ...chromeZoomFor(uiScale) }} data-testid="waiting-room-hold">
      <style>{zoomAwareMediaCss(ROOM_DESIGN_CSS, uiScale)}</style>
      <TopBar onLeaveGame={onLeave} audio={audio} />
      <main className="rm-wrap">
        <section className="rm-gate" aria-labelledby="rm-hold-h">
          <div className="rm-g-top">
            <span className="rm-kick" id="rm-hold-h">
              Waiting room
            </span>
            {roomCode ? <code className="rm-code">{roomCode}</code> : null}
          </div>
          <div className="rm-g-foot">
            <p role={error ? "status" : undefined}>{error ?? "Fetching the room…"}</p>
            <button type="button" className="rm-qbtn" onClick={onLeave}>
              Cancel
            </button>
          </div>
        </section>
      </main>
      <RoomFooter />
    </div>
  );
}

/** Phase 3 final clocks: the host of a no-ante Async table may change its action deadline until play begins. */
function DeadlineChooser({ gameId, clock, sendOp = roomOp }: { gameId: string; clock: RoomClockView | null; sendOp?: typeof roomOp }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = clock === null || clock.deadline === "no-deadline" ? "none" : String(clock.paceSecs ?? "none");
  return (
    <div>
      <label className="rm-why">
        Change the deadline:{" "}
        <select
          value={value}
          disabled={busy}
          aria-label="Action deadline"
          data-testid="wr-deadline"
          onChange={(event) => {
            const next = event.target.value;
            setBusy(true);
            setError(null);
            const op = next === "none" ? { type: CLOCK_OPS.policy, deadline: "no-deadline" as const } : { type: CLOCK_OPS.policy, deadline: "async-pace" as const, paceSecs: Number(next) };
            void sendOp(op, gameId).then((answer) => {
              setBusy(false);
              if (!answer.ok) setError(answer.reason);
            });
          }}
        >
          {CLOCK_ASYNC_PACES_SECS.map((secs) => (
            <option key={secs} value={String(secs)}>
              {paceLabel(secs)} per action
            </option>
          ))}
          <option value="none">No deadline</option>
        </select>
      </label>
      {error !== null ? (
        <p className="rm-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* Design note #1258: what the waiting room paints first, fetched while the player is still in the lobby -- now the
   boarding passes' rag paper (the design's only raster image). Idempotent: the browser dedupes a URL it holds. */
export function preloadWaitingRoomScene(): void {
  if (typeof Image === "undefined") return;
  const img = new Image();
  img.src = RAG_PAPER_URL;
}

const styles: Record<string, React.CSSProperties> = {
  /* Design note #1100: the waiting room paints its own ground (the design's ink), like its two neighbours. */
  root: {
    position: "relative",
    isolation: "isolate",
    width: "100%",
    minHeight: "100vh",
    backgroundColor: "#080808",
    boxSizing: "border-box",
  },
};

export { EDITION_NAME };
