// How the game ended, and who won.
//
// 1830 stops when the bank breaks or a president goes bankrupt. Both were
// reachable and neither had a surface. The REASON leads and the standings
// follow (#1): a broken bank is the ordinary conclusion of a long game and a
// bankruptcy is somebody's disaster, so a modal printing only a scoreboard would
// leave the room arguing about which had occurred.
//
// See docs/ai_architecture/stock_market.md, GameOverModal.tsx #0 / #1.

import React, { useCallback, useEffect, useState } from "react";
import { ChartsPage, AutopsyTable } from "./EpilogueCharts";
import { AccoladesCeremony } from "./AccoladesCeremony";
import { AccoladeBadges } from "./accoladeGlyphs";
import type { CeremonyCue } from "../utils/ceremonySounds";
import type { GameHistory } from "../utils/gameHistory";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import type { PlayerStanding } from "../gameEngine/endgame";
import CarcosaMark from "./CarcosaMark";

/** #1432: what the page tabs say. */
const PAGE_TITLES = {
  standings: "Standings",
  autopsy: "Corporations",
  charts: "Charts",
} as const;

export type GameEndReason = "bankruptcy" | "bank-broken";

/** "1st", "2nd", "3rd", "4th"... for the placed banner (#1430). */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
}

export interface GameOverModalProps {
  /** `null` while the game is still running -- the modal is absent, not
   *  hidden, so nothing renders behind the rest of the UI. */
  reason: GameEndReason | null;
  standings: readonly PlayerStanding[];
  /** ==================================================================
   *   DESIGN NOTE 1091: THE FOG'S OWN COLUMN OF THE SCOREBOARD
   *  ==================================================================
   *
   * RULED: "If the game ends and a corporation still possesses a train with the active Carcosa flag, DO NOT
   * ALTER ANY FINAL SCORES. On the final post-game scoreboard, append the Yellow Sign icon next to the name
   * of the player who is President of that corporation. Display this exact flavor text beneath the final
   * standings."
   *
   * A SEPARATE PROP RATHER THAN A FIELD ON `PlayerStanding`, and the ruling's first sentence is the reason.
   * `PlayerStanding` is what `rankPlayers` computes and every number on this modal comes from it; putting the
   * curse inside it would put a piece of flavour in the structure that decides who won, one careless sort
   * away from mattering. Beside it, it cannot touch a score.
   *
   * ONE ENTRY PER CURSED CORPORATION, not per player: a president of two cursed corporations gets two
   * epitaphs, which is the honest reading and also funnier. */
  carcosa?: readonly { presidentAddress: string; epitaph: string }[];
  /** Who the viewer is, for the "You Won!" / "You Went Bankrupt!" line.
   *  `null` for a spectator, who gets the standings without a verdict. */
  viewerAddress: string | null;
  /** The pool the payout column divides. Displayed so the estimate is
   *  legible as an estimate. */
  totalAnte: number;
  /** Named for the bankruptcy headline. */
  bankruptLabel: string | null;
  /* ==================================================================
      DESIGN NOTE 900: DISMISSIBLE, BECAUSE THE BOARD IS THE POST-MORTEM
     ==================================================================
     REQUESTED: "Make the Game End modal dismissible (and re-openable) so players can view the final board
     state."
     AND IT IS THE OPPOSITE CASE TO #896'S. That modal blocks because what it says changes the turn you are
     about to take; this one has no turn after it. The game is over, the numbers are settled, and the only
     thing left to do is look at the map you spent two hours building -- which the modal was covering.
     RE-OPENABLE IS THE HALF THAT MAKES IT SAFE. A dismissible modal with no way back would lose the standings
     for good, so the shell keeps a control to raise it again; `onDismiss` is only ever a hide. */
  onDismiss: () => void;
  /** Design note #899: closes the room and dispatches the payout. Any player may. `null` once it is closed,
   *  or in a local game with nothing to settle -- the button becomes a statement instead of a control. */
  onCloseRoom: (() => void) | null;
  /** What the auto-close countdown reads, already formatted. `null` when nothing is counting. */
  autoCloseIn: string | null;
  /** Whether the room has already been closed and the payout dispatched. */
  roomClosed: boolean;
  /* ==================================================================
      DESIGN NOTE 1411: THE EPILOGUE IS PAGED -- STANDINGS, THEN THE CHARTS
     ==================================================================
     REQUESTED: "start with the final network and everything like it is, and then have a 'Next' button that
     shows a chart of corporations stock price movements over the rounds (clickable to show who owned how
     much at each round), then a final chart showing player net worth movement across the game."
     The first page is unchanged. `history` (`utils/gameHistory.ts`, the log replayed and sampled per round)
     feeds two further pages, and the three helpers below are the shell's naming and colouring, passed in so
     this component still does not learn what a seat or a livery is. `null` history hides the pager. */
  history?: GameHistory | null;
  playerLabel?: (address: string) => string;
  playerColor?: (address: string) => string;
  corporationColor?: (companyId: number) => string;
  /** #1419: fired at each moment of the ceremony, for its sound. */
  onCeremonyCue?: (cue: CeremonyCue) => void;
  /** #1420: back to the lobby. Absent hides the button (a room with nothing to leave). */
  onLeaveGame?: () => void;
  /** #1423: whether the ceremony's clips are decodable yet; the ceremony holds its first card until so. */
  ceremonySoundsReady?: boolean;
}

export function GameOverModal({
  reason,
  standings,
  carcosa,
  viewerAddress,
  totalAnte,
  bankruptLabel,
  onDismiss,
  onCloseRoom,
  autoCloseIn,
  roomClosed,
  history = null,
  playerLabel = (address) => address,
  playerColor = () => "#8a8a86",
  corporationColor = () => "#8a8a86",
  onCeremonyCue,
  onLeaveGame,
  ceremonySoundsReady = true,
}: GameOverModalProps) {
  // #1411/#1414/#1416: the pages, by name. Hooks first.
  const [page, setPage] = useState(0);
  /* ==================================================================
      DESIGN NOTE 1432: THE CEREMONY RUNS ONCE; THE PAGES ANIMATE ON FIRST SIGHT; THE DOTS ARE TABS
     ==================================================================
     "when I back into the Accolades page, it replays the whole ceremony instead of just showing the final
     result" -- the page components unmount when the page changes, so the ceremony's own state was lost.
     `seen` is the modal's memory of which pages have been shown: the ceremony animates only while
     "accolades" is not in it (Replay on the settled page still re-runs it), and each chart page draws its
     lines on only the first time. The set clears with the history -- a new game, not a minimise. */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  /* ==================================================================
      DESIGN NOTE 1433: THE CEREMONY IS ITS OWN STAGE; THE BADGES GO ON THE TABLES
     ==================================================================
     RULED: "have the Accolades thing be its own modal, and then put its badges on the Standings and Autopsy
     pages ... Standings > Corporations (Autopsy sounds grim) > Charts, and within Charts have all three
     (Revenue, Prices, Net Worth) be toggleable". So the modal has two stages. The CEREMONY stage is the
     whole panel: the animated ceremony (once -- `seen` remembers, #1432) and a Continue button. The PAGES
     stage is the tabs (Standings, Corporations, Charts, Net worth -- #1434), Standings first -- the result is the first thing after the ceremony -- and every
     player's and corporation's awards ride their table row as badges (`AccoladeBadges`), so the settled
     accolades page has nothing left to say and is gone. "Accolades" in the footer brings the ceremony stage
     back, settled, with its own Replay -- GONE in #1436 ("they're reprinted on players and corps anyway").
     The Charts page (`ChartsPage`) toggles between the four. */
  const [stage, setStage] = useState<"ceremony" | "pages">("ceremony");
  useEffect(() => {
    setSeen(new Set());
    setPage(0);
    setStage("ceremony");
  }, [history]);
  const hasCeremony = Boolean(history && history.rounds.length > 1 && history.ceremony.length > 0);
  const inCeremony = hasCeremony && stage === "ceremony";
  const pages: ReadonlyArray<"standings" | "autopsy" | "charts"> =
    history && history.rounds.length > 1 ? ["standings", "autopsy", "charts"] : ["standings"];
  const pageCount = pages.length;
  const current = Math.min(page, pageCount - 1);
  const showing = pages[current];
  /* A page counts as seen once it has been on screen with the modal up; the animating components latch the
     flag at mount, so the flip to "seen" a moment later changes nothing they are doing. */
  const seenKey = inCeremony ? "ceremony" : showing;
  const firstSight = !seen.has(seenKey); // the ceremony and Net worth; the Charts page keeps its own keys
  useEffect(() => {
    if (!reason) return;
    setSeen((prev) => (prev.has(seenKey) ? prev : new Set(prev).add(seenKey)));
  }, [seenKey, reason]);
  const markSeen = useCallback((key: string) => setSeen((prev) => (prev.has(key) ? prev : new Set(prev).add(key))), []);
  const leavePage = (next: number) => setPage(next);
  if (!reason) return null;

  const viewer = standings.find((row) => row.address === viewerAddress) ?? null;

  /* Design note #1: the verdict is about the VIEWER, and the two headline
     cases are not opposites -- a player can be neither. A spectator, or a
     player who simply came third, gets the neutral heading rather than a
     consolation message nobody asked for. */
  const verdict = !viewer
    ? null
    : viewer.isBankrupt
      ? { text: "You Went Bankrupt!", style: styles.verdictLost }
      : viewer.isWinner
        ? { text: "You Won!", style: styles.verdictWon }
        : { text: `You came in ${ordinal(viewer.rank)} place.`, style: styles.verdictPlaced }; // #1430

  return (
    /* Design note #900: the backdrop dismisses, unlike #896's. Nothing is pending behind it. */
    <div
      className="game-over-backdrop"
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Game Over"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      {/* #1418: the rise over the outro's held frame -- a fade, not a cut. Inline styles cannot express
          keyframes (#46's escape hatch). */}
      <style>{GAME_OVER_CSS}</style>
      <div style={styles.panel}>
        <span style={styles.kicker}>Game Over</span>

        <div style={styles.body}>
        {/* #1417: the ceremony -- animated on open, settled after; Replay re-runs it. #1433: its own stage. */}
        {inCeremony && history && (
          <AccoladesCeremony history={history} playerLabel={playerLabel} playerColor={playerColor} onCue={onCeremonyCue} ready={ceremonySoundsReady} animate={firstSight} />
        )}

        {/* Design note #1: why, before who. */}
        {!inCeremony && showing === "standings" && (
          <>
        <h2 style={styles.reasonHeading}>
          {reason === "bankruptcy"
            ? `${bankruptLabel ?? "A president"} went bankrupt.`
            : "The Bank has run out of money."}
        </h2>
        {/* ==================================================================
             DESIGN NOTE 1430: THE STANDINGS PAGE IS THE HEADLINE, THE VERDICT AND THE TABLE
            ==================================================================
            RULED: the explanatory paragraph goes -- and its bank-break sentence was wrong besides ("ends the
            moment the Bank cannot pay"; the game plays out the Operating Round set, #898) -- and the five
            core accolades repeated here go too, the ceremony having just shown them. What stays: the reason
            as a title, one banner for the viewer (won, went bankrupt, or came nth), and the table. */}
        {verdict && <div style={{ ...styles.verdict, ...verdict.style }}>{verdict.text}</div>}

        {/* ---- Standings ---- */}
        <div style={styles.table} role="table" aria-label="Final standings">
          <div style={{ ...styles.row, ...styles.headRow }} role="row">
            <span style={styles.cellRank}>#</span>
            <span style={styles.cellName}>Player</span>
            <span style={styles.cellNum}>Cash</span>
            <span style={styles.cellNum}>Stock</span>
            <span style={styles.cellNum}>Privates</span>
            <span style={styles.cellNumStrong}>Net worth</span>
            <span style={styles.cellPayout}>Payout</span>
            {hasCeremony && <span style={styles.cellBadges}>Accolades</span>}
          </div>

          {/* ==================================================================
               DESIGN NOTE 900: THE HIGHLIGHT FINDS YOU; THE BADGE NAMES THE WINNER
              ==================================================================
              REQUESTED: "keep the Winner badge on the winning player, but change the row highlighting.
              Instead of highlighting the winner's row for everyone, highlight the local player's own row so
              they can easily find their own stats."
              THE TWO MARKS WERE DOING ONE JOB AND IT WAS THE LESS USEFUL ONE. `WINNER` already says who won,
              in words, on the row it belongs to -- so tinting that same row said it twice, and left the
              question every player actually opens this table with ("where am I?") unanswered. At six seats
              that is a real scan.
              A SPECTATOR GETS NO HIGHLIGHT AT ALL, which is correct rather than a gap: `viewerAddress` is
              `null` for them, they have no row, and tinting the winner's row as a consolation would put the
              highlight back where it started. */}
          {standings.map((row) => {
            const isViewer = viewerAddress !== null && row.address === viewerAddress;
            return (
            <div
              key={row.address}
              role="row"
              /* Bankruptcy still wins the tint, and it is last for that reason: a player who went bankrupt
                 needs to see THAT before they see which row is theirs. */
              style={{
                ...styles.row,
                ...(isViewer ? styles.rowViewer : {}),
                ...(row.isBankrupt ? styles.rowBankrupt : {}),
              }}
            >
              <span style={styles.cellRank}>{row.rank}</span>
              <span style={styles.cellName}>
                {row.label}
                {/* Design note #1091: the sign rides the NAME, beside the tags rather than in the numbers --
                    "do not alter any final scores" is the ruling, and a mark in a figure column would read
                    as one. */}
                {(carcosa ?? []).some((entry) => entry.presidentAddress === row.address) && (
                  <CarcosaMark meaning="president" size={13} />
                )}
                {isViewer && <span style={styles.tagYou}>YOU</span>}
                {row.isWinner && <span style={styles.tagWinner}>WINNER</span>}
                {row.isBankrupt && <span style={styles.tagBankrupt}>BANKRUPT</span>}
              </span>
              <span style={styles.cellNum}>${row.cash}</span>
              <span style={styles.cellNum}>${row.stockValue}</span>
              <span style={styles.cellNum}>${row.privateValue}</span>
              <span style={styles.cellNumStrong}>${row.netWorth}</span>
              <span style={styles.cellPayout}>${row.expectedPayout.toFixed(2)}</span>
              {/* #1433: what they won, on their row. */}
              {hasCeremony && history && (
                <span style={styles.cellBadges}>
                  <AccoladeBadges accolades={history.ceremony.filter((a) => a.scope === "player" && a.holder === row.address)} />
                </span>
              )}
            </div>
            );
          })}
        </div>

        {/* Design note #4 in `endgame.ts`: the payout is an ESTIMATE and the
            modal says so where the number is, not in a footnote nobody
            reads. Overstating this would be promising real money on a split
            the contract has not agreed to. */}
        <p style={styles.payoutNote}>
          Payout estimated by share of net worth against a ${totalAnte} pool. The payout
          distribution is settled on-chain when the room closes.
        </p>

        {/* #1430: the "X wins with $Y" line is gone -- the WINNER tag on the row says it. */}

        {/* Design note #1091: "beneath the final standings", and after the winner -- the game's result is the
            headline and this is the epilogue. Each line is built by `carcosaEpitaph` rather than assembled
            here, so the two substitutions are testable without a renderer. */}
        {(carcosa ?? []).map((entry) => (
          <p key={`${entry.presidentAddress}-${entry.epitaph}`} style={styles.carcosaEpitaph}>
            {entry.epitaph}
          </p>
        ))}

        {/* Design note #899: the closure controls, and the countdown stated as a fact rather than as a
            threat. Every client runs its own timer and any player may press the button, so this is not "you
            have fifteen minutes to act" -- it is "this will finish itself if nobody gets to it". */}
          </>
        )}
        {!inCeremony && showing === "charts" && history && (
          <ChartsPage history={history} corporationColor={corporationColor} playerLabel={playerLabel} playerColor={playerColor} seen={seen} onShown={markSeen} />
        )}
        {!inCeremony && showing === "autopsy" && history && (
          <AutopsyTable history={history} playerLabel={playerLabel} corporationColor={corporationColor} />
        )}
        </div>

        <div style={styles.footer}>
          <span style={styles.footerNote}>
            {roomClosed
              ? "The room is closed and the payout has been dispatched."
              : autoCloseIn
                ? `Closing automatically in ${autoCloseIn}. Any player may close it now.`
                : "Any player may close the room to settle the payout."}
          </span>
          {/* ==================================================================
               DESIGN NOTE 1436: THE PAGER IS THE DOTS AGAIN, APART FROM THE ACTIONS
              ==================================================================
              RULED: "return the navigation to the dots that you used originally" -- after "the Back and Next
              buttons look like the buttons to go to Accolades, View Final Board, and Leave Game". So the dots
              are back, clickable, with chevrons either side that are NOT buttons in the action style (no
              box, just the glyph), and the pager stands in the middle of the footer on its own, away from
              the actions on the right. No page name beside it (#1436a): a name of changing width shifted
              the chevrons under the pointer as the pages turned; the dots carry the names as tooltips. The Accolades button is gone (#4): "they're reprinted on players and
              corps anyway". */}
          {!inCeremony && pageCount > 1 && (
            <span style={styles.pager} role="tablist" aria-label={`Page ${current + 1} of ${pageCount}`}>
              <button type="button" style={styles.pagerArrow} onClick={() => leavePage(Math.max(0, current - 1))} disabled={current === 0} aria-label="Previous page">
                ‹
              </button>
              {pages.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={i === current}
                  title={PAGE_TITLES[name]}
                  style={{ ...styles.pageDot, ...(i === current ? styles.pageDotOn : {}) }}
                  onClick={() => leavePage(i)}
                  data-testid={`game-over-tab-${name}`}
                />
              ))}
              <button type="button" style={styles.pagerArrow} onClick={() => leavePage(Math.min(pageCount - 1, current + 1))} disabled={current === pageCount - 1} aria-label="Next page">
                ›
              </button>
            </span>
          )}
          <span style={styles.footerButtons}>
            {inCeremony && (
              <button type="button" style={styles.primaryButton} onClick={() => setStage("pages")} data-testid="ceremony-continue">
                Continue ▸
              </button>
            )}
            <button type="button" style={styles.secondaryButton} onClick={onDismiss}>
              View final board
            </button>
            {onLeaveGame && (
              <button type="button" style={{ ...styles.secondaryButton, ...styles.leaveButton }} onClick={onLeaveGame} data-testid="game-over-leave">
                ↩ Leave game
              </button>
            )}
            {onCloseRoom && (
              <button type="button" style={styles.primaryButton} onClick={onCloseRoom}>
                Close Room
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

const GAME_OVER_CSS = `
@keyframes game-over-in { from { opacity: 0; } to { opacity: 1; } }
.game-over-backdrop { animation: game-over-in 700ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .game-over-backdrop { animation: none !important; } }
`;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(6, 8, 12, 0.86)",
    padding: "8px",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    /* #1409: "The Game Over modal is too small, it's hard to read the table and everything compressed into
       it." #1417: "It needs to just be full screen. Having to scroll within the modal is painful." So it IS
       the screen, to within the 8px the backdrop keeps: the whole viewport, the gold rule across the top.
       Still on the layer radius (`shapeAndPlacement` #1: a floating surface keeps its step) -- at this size
       the corners read as the screen's own. The pages lay out into the height (`flex: 1` on the page body)
       and the footer stays pinned; only a page taller than the window -- a seven-player standings table on a
       short laptop -- scrolls, and it scrolls the page body, not the frame. */
    width: "100%",
    height: "100%",
    padding: "22px 36px",
    gap: "14px",
    backgroundColor: "#0f0f0f",
    border: "1px solid #3a3a3a",
    borderTop: "3px solid #c9a227",
    borderRadius: RADIUS.layer,
    boxSizing: "border-box",
    overflow: "hidden",
  },
  body: { display: "flex", flexDirection: "column", gap: "14px", flex: 1, minHeight: 0, overflowY: "auto" },
  kicker: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  reasonHeading: { margin: 0, fontSize: "28px", fontWeight: 800, color: "#f0e2b8" }, // #1409
  reasonBody: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: 1.55, color: "#c8c6c0" }, // #1409
  verdict: {
    margin: "4px 0",
    padding: "10px 14px",
    borderRadius: RADIUS.card,
    fontSize: "22px", // #1409
    fontWeight: 800,
    textAlign: "center",
    borderWidth: "1px",
    borderStyle: "solid",
  },
  verdictWon: { backgroundColor: "#17301f", borderColor: "#3f7a55", color: "#9fe9bb" },
  verdictLost: { backgroundColor: "#2a1618", borderColor: "#6b2f2f", color: "#f0c9c9" },
  table: {
    display: "flex",
    flexDirection: "column",
    gap: "4px", // #1409
    padding: "12px 14px",
    backgroundColor: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: RADIUS.card,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 10px", // #1409
    borderRadius: RADIUS.control,
    fontSize: FONT_SIZE.strong, // #1409: was `small`
    fontVariantNumeric: "tabular-nums",
    color: "#c8c6c0",
  },
  headRow: {
    fontSize: FONT_SIZE.small, // #1409
    fontWeight: 800,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  /* Design note #900: BLUE, NOT GREEN. The winner tint was green and green reads as "good news"; this mark
     answers "which row is mine", which is true whether the news is good or not. A player who came fourth
     should not have their own row congratulating them. */
  rowViewer: { backgroundColor: "#152436", color: "#dbe8f7" },
  rowBankrupt: { backgroundColor: "#2a1618", color: "#f0c9c9" },
  cellRank: { flex: "0 0 30px", color: "#8a8a86" },
  cellName: { flex: "1 1 auto", display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
  cellNum: { flex: "0 0 110px", textAlign: "right" }, // #1409: room for five figures at the larger size
  cellNumStrong: { flex: "0 0 124px", textAlign: "right", fontWeight: 800, color: "#f2f0eb" },
  // #1430: the payout column, green and bold -- it is the money.
  cellPayout: { flex: "0 0 110px", textAlign: "right", fontWeight: 800, color: "#7ee0a1" },
  cellBadges: { flex: "0 1 200px", display: "inline-flex", justifyContent: "flex-end", minWidth: 0 },
  verdictPlaced: { backgroundColor: "#1c1c1c", borderColor: "#3a3a3a", color: "#e8e6e0" },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
    marginTop: "6px",
    paddingTop: "10px",
    borderTop: "1px solid #2a2a2a",
  },
  footerNote: { fontSize: FONT_SIZE.small, color: "#8a8a86", lineHeight: 1.4, flex: "1 1 220px" }, // #1409
  footerButtons: { display: "flex", gap: "8px", flex: "none" },
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
    border: "1px solid #7a6320",
    backgroundColor: "#3b3113",
    color: "#f0dfa8",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  /* #1436: the pager -- dots, clickable, chevrons that are not action buttons, the page's name beside. */
  pager: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "0 8px" },
  pagerArrow: {
    border: "none",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontSize: "22px",
    lineHeight: 1,
    padding: "0 6px",
    cursor: "pointer",
  },
  pageDot: {
    width: "10px",
    height: "10px",
    padding: 0,
    borderRadius: RADIUS.circle,
    border: "none",
    backgroundColor: "#3a3a3a",
    cursor: "pointer",
  },
  pageDotOn: { backgroundColor: "#c9a227" },
  /* #1436: "Add a return arrow and/or some kind of color (red?) to the Leave Game button". */
  leaveButton: { borderColor: "#7a3a3a", color: "#e08a84" },
  tagYou: {
    marginLeft: "6px",
    padding: "1px 6px",
    borderRadius: RADIUS.pill,
    border: "1px solid #3f5f8a",
    backgroundColor: "#1d3350",
    color: "#bcd4f0",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
  },
  tagWinner: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    color: "#0f0f0f",
    backgroundColor: "#7ee0a1",
    borderRadius: RADIUS.control,
    padding: "0 5px",
  },
  tagBankrupt: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    color: "#f0c9c9",
    border: "1px solid #6b2f2f",
    borderRadius: RADIUS.control,
    padding: "0 5px",
  },
  payoutNote: { margin: 0, fontSize: FONT_SIZE.micro, color: "#8a8a86", lineHeight: 1.45 },
  winnerLine: { margin: 0, fontSize: FONT_SIZE.body, color: "#f2f0eb" },
  /* Design note #1091: the Yellow Sign's amber, italic, quieter than the winner's line above it. It is the
     last thing on a scoreboard and it is not a result -- a player who never saw the sign should be able to
     read past it, and one who did should recognise the colour from the Activity Log lines that led here. */
  carcosaEpitaph: {
    margin: "2px 0 0",
    fontSize: FONT_SIZE.small,
    fontStyle: "italic",
    lineHeight: 1.5,
    color: "#e2d3a2",
  },
};

export default GameOverModal;
