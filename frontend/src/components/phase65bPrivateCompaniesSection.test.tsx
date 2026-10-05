/** @jest-environment jsdom */
//
// ==================================================================
//  6.5-B (K-01) HARNESS: THE PRIVATE COMPANIES SECTION, CLICKED THROUGH AGAINST A REAL ROOM
// ==================================================================
//
// The section is rendered for one seat at a time from the room's CURRENT board, and its callbacks submit to that
// room with the same message builders the shell uses -- so a click here travels the whole path a player's would
// (view -> message -> ingress -> reducer), and the next render reads the result back off the board. What is asserted
// is the rendered DOM: which buttons each seat has, whether they are live, and the sentence they carry.
//
// Then the Stock Round panel itself: the section sits BELOW the corporation listing, and a standing offer greys the
// share controls with the hold's own sentence.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PlayerPrivateTradePrompt, PrivateCompaniesSection } from "./PrivateCompaniesSection";
import StockRoundPanel from "./StockRoundPanel";
import type { GameStateResponse, RoundType } from "../gameEngine/gameState";
import * as T from "../utils/stockRoundPrivateTrade";
import { RoomSession } from "../utils/roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import * as F from "../utils/offerFixtures74";
import * as S from "../utils/offerMatrix74Support";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { P1, P2, P3, PRR, NYC, DH, MH } = F;
const LABELS: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [P3]: "Carol" };
const label = (address: string) => LABELS[address] ?? address;
const GAME = 1;

const seedBoard = (over: Record<string, unknown> = {}): GameStateResponse =>
  F.stockRoundBoard({
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10]], ipo: 60 },
    ],
    over: { consecutive_passes: 0, ...over } as never,
  });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = <E extends Element = HTMLElement>(testId: string) => host.querySelector<E>(`[data-testid="${testId}"]`);
const click = (node: Element | null) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const typeInto = (input: HTMLInputElement | null, value: string) => {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const choose = (select: HTMLSelectElement | null, value: string) => {
  if (!select) throw new Error("no select");
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

/** A room, and the section drawn for one seat off its current board, wired to submit as that seat. */
function table(seed: GameStateResponse) {
  let minted = 0;
  const session = new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: S.GRID },
    seed: { state: seed, waterfall: null },
    build: "b-65b",
    mintId: () => `c${(minted += 1)}`,
  });
  const sent: Array<{ actor: string; msg: unknown; kind: string; reason?: string }> = [];
  const submit = (actor: string, msg: unknown) => {
    const answer = session.submit({ actor, build: "b-65b", host: P1, msg: msg as never, baseIndex: session.nextIndex - 1 });
    sent.push({ actor, msg, kind: answer.kind, reason: (answer as { reason?: string }).reason });
    return answer;
  };
  const drawFor = (viewer: string | null, over: { sessionReady?: boolean; board?: GameStateResponse } = {}) => {
    const board = over.board ?? session.state;
    const model = T.privateTradeSectionModel(board, viewer, label);
    if (!model) throw new Error("no section");
    act(() => {
      root.render(
        <PrivateCompaniesSection
          model={model}
          viewer={viewer}
          proposalRefusal={(intent) => T.privateTradeProposalRefusal(board, viewer, intent, label)}
          onPropose={(intent) => viewer && submit(viewer, T.proposePrivateTradeMsg(GAME, intent))}
          onAnswer={(privateId, accept) => viewer && submit(viewer, T.answerPrivateTradeMsg(GAME, privateId, accept))}
          onRescind={(privateId) => viewer && submit(viewer, T.rescindPrivateTradeMsg(GAME, privateId))}
          sessionReady={over.sessionReady ?? true}
        />,
      );
    });
  };
  return { session, submit, sent, drawFor };
}

const answerButtons = () => [q("private-trade-accept"), q("private-trade-reject")].filter((node) => node !== null);
const priv = (state: GameStateResponse, id: number) => state.private_companies.find((entry) => entry.private_id === id)!;
const cashOf = (state: GameStateResponse, player: string) => Number(state.player_cash.find((row) => row.player === player)?.cash_vgp);

describe("a sell offer, sent from the card and accepted from the recipient's card", () => {
  it("Sell → choose recipient → asking price → Send Offer; the recipient's Accept settles it", () => {
    const t = table(seedBoard());
    t.drawFor(P1);
    // The seat holder's own private has Sell; the other player's has Buy. No answer controls anywhere.
    expect(q("private-trade-sell-4")?.textContent).toBe("Sell…");
    expect(q("private-trade-buy-3")?.textContent).toBe("Buy…");
    expect(answerButtons()).toHaveLength(0);

    click(q(`private-trade-sell-${MH}`));
    const send = q<HTMLButtonElement>("private-trade-send")!;
    // No price yet: greyed with the prompt, never a click the server would refuse.
    expect(send.disabled).toBe(true);
    expect(q("private-trade-refusal")?.textContent).toBe(T.PRICE_ENTRY_PROMPT);
    choose(q<HTMLSelectElement>("private-trade-recipient"), P3);
    typeInto(q<HTMLInputElement>("private-trade-price"), "150");
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(false);
    click(q("private-trade-send"));

    // THE DIRECTION: the viewer is the seller, the chosen recipient the buyer.
    expect(t.sent).toEqual([
      { actor: P1, msg: { ProposePrivateTrade: { game_id: GAME, private_id: MH, seller: P1, buyer: P3, price: 150 } }, kind: "applied", reason: undefined },
    ]);

    // The proposer's card: the offer and Rescind, nothing to answer.
    t.drawFor(P1);
    expect(q(`private-trade-offer-${MH}`)?.textContent).toContain("Alice offers to sell Mohawk & Hudson to Carol for $150 — waiting for Carol.");
    expect(q("private-trade-rescind")).not.toBeNull();
    expect(answerButtons()).toHaveLength(0);
    expect(q(`private-trade-sell-${MH}`)).toBeNull(); // no second offer while one stands
    expect(q(`private-trade-buy-${DH}`)).toBeNull();

    // A third player's card: the offer, and no control of any kind.
    t.drawFor(P2);
    expect(q(`private-trade-offer-${MH}`)?.textContent).toContain("waiting for Carol");
    expect(answerButtons()).toHaveLength(0);
    expect(q("private-trade-rescind")).toBeNull();

    // The recipient's card: Accept and Reject, live.
    t.drawFor(P3);
    expect(q<HTMLButtonElement>("private-trade-accept")!.disabled).toBe(false);
    expect(q<HTMLButtonElement>("private-trade-reject")!.disabled).toBe(false);
    expect(q("private-trade-rescind")).toBeNull();
    click(q("private-trade-accept"));
    expect(t.sent[1]).toEqual({ actor: P3, msg: { AnswerPrivateTrade: { game_id: GAME, private_id: MH, accept: true } }, kind: "applied", reason: undefined });
    expect(priv(t.session.state, MH).owner).toBe(P3);
    expect([cashOf(t.session.state, P1), cashOf(t.session.state, P3)]).toEqual([450, 150]);
    t.drawFor(P2);
    expect(q(`private-trade-owner-${MH}`)?.textContent).toBe("Carol");
    expect(q(`private-trade-offer-${MH}`)).toBeNull();
  });

  it("each recipient says, at the price typed, why they could not take it; a refused Send cannot be clicked", () => {
    const t = table(S.withCash(seedBoard(), P3, 40));
    t.drawFor(P1);
    click(q(`private-trade-sell-${MH}`));
    typeInto(q<HTMLInputElement>("private-trade-price"), "50");
    const options = Array.from(q<HTMLSelectElement>("private-trade-recipient")!.options).map((option) => option.textContent);
    expect(options).toEqual(["Bob", "Carol — Carol holds $40 and cannot pay $50."]);
    choose(q<HTMLSelectElement>("private-trade-recipient"), P3);
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(true);
    expect(q("private-trade-refusal")?.textContent).toBe("Carol holds $40 and cannot pay $50.");
    click(q("private-trade-send"));
    expect(t.sent).toHaveLength(0);
    // A malformed price is not a price.
    typeInto(q<HTMLInputElement>("private-trade-price"), "12.5");
    expect(q("private-trade-refusal")?.textContent).toBe(T.PRICE_ENTRY_PROMPT);
    // $0 is (a gift, D-24), and Cancel closes the form without sending anything.
    typeInto(q<HTMLInputElement>("private-trade-price"), "0");
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(false);
    click(q("private-trade-cancel"));
    expect(q(`private-trade-form-${MH}`)).toBeNull();
    expect(t.sent).toHaveLength(0);
  });
});

describe("a buy offer, sent from another player's card and rejected by its owner", () => {
  it("Buy → offered price → Send Offer names the displayed owner as seller and the viewer as buyer", () => {
    const t = table(seedBoard());
    t.drawFor(P1);
    click(q(`private-trade-buy-${DH}`));
    expect(q(`private-trade-form-${DH}`)?.textContent).toContain("Offer to");
    expect(q(`private-trade-form-${DH}`)?.textContent).toContain("Bob");
    expect(q("private-trade-recipient")).toBeNull(); // the recipient is the owner; nothing to choose
    typeInto(q<HTMLInputElement>("private-trade-price"), "60");
    click(q("private-trade-send"));
    expect(t.sent[0]).toMatchObject({ actor: P1, msg: { ProposePrivateTrade: { private_id: DH, seller: P2, buyer: P1, price: 60 } }, kind: "applied" });

    t.drawFor(P2);
    expect(q(`private-trade-offer-${DH}`)?.textContent).toContain("Buy offer");
    expect(q(`private-trade-offer-${DH}`)?.textContent).toContain("Alice offers Bob $60 for Delaware & Hudson — waiting for Bob.");
    click(q("private-trade-reject"));
    expect(t.sent[1]).toMatchObject({ actor: P2, msg: { AnswerPrivateTrade: { private_id: DH, accept: false } }, kind: "applied" });
    expect(priv(t.session.state, DH).owner).toBe(P2);
    expect(t.session.state.private_trade_offer ?? null).toBeNull();
  });
});

describe("rescission", () => {
  it("the proposer's Rescind withdraws it; the openers come back", () => {
    const t = table(seedBoard());
    t.submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 25 }));
    t.drawFor(P1);
    click(q("private-trade-rescind"));
    expect(t.sent[1]).toMatchObject({ actor: P1, msg: { RescindPrivateTrade: { private_id: DH } }, kind: "applied" });
    t.drawFor(P1);
    expect(q(`private-trade-offer-${DH}`)).toBeNull();
    expect(q(`private-trade-buy-${DH}`)).not.toBeNull();
  });
});

describe("wrong seats, watchers and the first Stock Round", () => {
  it("an off-turn seat has no opener on any card, even on its own private", () => {
    const t = table(seedBoard());
    t.drawFor(P2); // Bob owns the D&H, but it is Alice's turn
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("a seatless watcher reads the section and has no control at all", () => {
    const t = table(seedBoard());
    t.submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 25 }));
    t.drawFor(null);
    expect(q("private-companies-section")?.textContent).toContain("Read only");
    expect(q(`private-trade-offer-${DH}`)?.textContent).toContain("waiting for Bob");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("SR1: the note says trading opens later, and the seat holder's openers are greyed with rule 1's sentence", () => {
    const t = table(seedBoard({ macro_round_number: 1 }));
    t.drawFor(P1);
    expect(q("private-trade-first-round")?.textContent).toContain("first Stock Round");
    for (const id of [`private-trade-sell-${MH}`, `private-trade-buy-${DH}`]) {
      const button = q<HTMLButtonElement>(id)!;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Private companies may not be traded between players in the first Stock Round (rulebook 3.1).");
    }
    t.drawFor(P3);
    expect(q("private-trade-first-round")).not.toBeNull();
  });

  it("an Accept the buyer can no longer pay for is greyed with the authority's sentence; Reject stays live", () => {
    const t = table(seedBoard());
    t.submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: MH, seller: P1, buyer: P2, price: 250 }));
    t.drawFor(P2, { board: S.withCash(t.session.state, P2, 100) });
    expect(q<HTMLButtonElement>("private-trade-accept")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>("private-trade-accept")!.title).toBe("Bob holds $100 and cannot pay $250.");
    expect(q("private-trade-accept-refusal")?.textContent).toBe("Bob holds $100 and cannot pay $250.");
    expect(q<HTMLButtonElement>("private-trade-reject")!.disabled).toBe(false);
  });

  it("an unready session greys the seat's own controls", () => {
    const t = table(seedBoard());
    t.drawFor(P1, { sessionReady: false });
    expect(q<HTMLButtonElement>(`private-trade-sell-${MH}`)!.disabled).toBe(true);
  });
});

describe("the pointer in the consent slot", () => {
  const offerFor = (viewer: string | null) => {
    const t = table(seedBoard());
    t.submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 25 }));
    return T.privateTradeSectionModel(t.session.state, viewer, label)!.offer;
  };

  it("the recipient gets Accept, Reject and Show on Stocks; the proposer Rescind and Show; everybody else only the pointer", () => {
    const answers: Array<[number, boolean]> = [];
    const shown: number[] = [];
    const rescinded: number[] = [];
    const draw = (viewer: string | null) =>
      act(() => {
        root.render(
          <PlayerPrivateTradePrompt
            offer={offerFor(viewer)}
            answerBlockedReason={null}
            onAnswer={(id, accept) => answers.push([id, accept])}
            onRescind={(id) => rescinded.push(id)}
            onShowCard={(id) => shown.push(id)}
          />,
        );
      });
    draw(P2);
    expect(q("player-private-trade-prompt")?.textContent).toContain("This is your decision");
    click(q("player-private-trade-accept"));
    click(q("player-private-trade-reject"));
    click(q("player-private-trade-show"));
    expect(answers).toEqual([
      [DH, true],
      [DH, false],
    ]);
    expect(shown).toEqual([DH]);
    expect(q("player-private-trade-rescind")).toBeNull();
    for (const viewer of [P1, P3, null]) {
      draw(viewer);
      expect(q("player-private-trade-prompt")?.textContent).toContain("Waiting on Bob");
      expect(q("player-private-trade-accept")).toBeNull();
      expect(q("player-private-trade-reject")).toBeNull();
      expect(q("player-private-trade-show")).not.toBeNull();
      // Only the proposer (Alice) may withdraw it, from here as from the card.
      expect(q("player-private-trade-rescind") !== null).toBe(viewer === P1);
    }
    draw(P1);
    click(q("player-private-trade-rescind"));
    expect(rescinded).toEqual([DH]);
    expect(answers).toHaveLength(2);
  });

  it("renders nothing when no trade offer stands", () => {
    act(() => {
      root.render(
        <PlayerPrivateTradePrompt offer={null} answerBlockedReason={null} onAnswer={() => undefined} onRescind={() => undefined} onShowCard={() => undefined} />,
      );
    });
    expect(host.innerHTML).toBe("");
  });
});

describe("the Stock Round panel: the section below the listing, and the hold on the share controls", () => {
  const drawPanel = (board: GameStateResponse, viewer: string, withHold: boolean) => {
    const hold = withHold ? T.privateTradeHoldReason(board, label) : null;
    act(() => {
      root.render(
        <StockRoundPanel
          publicCompanies={board.public_companies}
          privateCompanies={board.private_companies}
          parValueFor={() => "90"}
          onSelectParValue={() => undefined}
          onBuyShare={() => undefined}
          onSellShares={() => undefined}
          sessionReady
          isMyTurn={board.player_addresses[board.active_player_index] === viewer}
          connectedAddress={viewer}
          macroRoundNumber={board.macro_round_number}
          playerCash={300}
          roundType={"StockRound" as RoundType}
          privateTrade={T.privateTradeSectionModel(board, viewer, label)}
          privateTradeProposalRefusal={(intent) => T.privateTradeProposalRefusal(board, viewer, intent, label)}
          onProposePrivateTrade={() => undefined}
          onAnswerPrivateTrade={() => undefined}
          onRescindPrivateTrade={() => undefined}
          offerHoldReason={hold}
        />,
      );
    });
  };
  /** Opens the card's share actions, unless they are already open (the active card survives a re-render). */
  const openCard = (ticker: string) => {
    if (host.querySelector(`button[aria-label="${ticker} — hide share actions"]`)) return;
    click(host.querySelector(`button[aria-label="${ticker} — show share actions"]`));
  };
  const buyButton = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => /^Buy\b/.test(button.textContent ?? "") && !button.dataset.testid);

  it("draws the Private Companies section after the corporation listing", () => {
    drawPanel(seedBoard(), P1, false);
    const section = q("private-companies-section")!;
    const listing = host.querySelector(`[aria-label="PRR ownership"]`)!;
    expect(section).not.toBeNull();
    // eslint-disable-next-line no-bitwise
    expect(listing.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("while an offer stands, the seat holder's Buy is greyed WITH the hold's sentence, and the panel says it once", () => {
    const t = table(seedBoard());
    // Without an offer the seat holder's Buy is live.
    drawPanel(t.session.state, P1, true);
    openCard("PRR");
    expect(buyButton()?.disabled).toBe(false);
    expect(q("stock-round-offer-hold")).toBeNull();

    t.submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 25 }));
    drawPanel(t.session.state, P1, true);
    const hold = "Delaware & Hudson is on offer between Bob and Alice for $25 and is waiting for an answer; nothing else can happen until it is answered or withdrawn.";
    expect(q("stock-round-offer-hold")?.textContent).toBe(hold);
    openCard("PRR");
    expect(buyButton()?.disabled).toBe(true);
    expect(buyButton()?.title).toBe(hold);
    // The share Sell too: same flag, same sentence.
    const sellShares = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => /^Sell \d+% Bundle$/.test(button.textContent ?? ""));
    expect(sellShares?.disabled).toBe(true);
    expect(sellShares?.title).toBe(hold);
    // And the trade's own Rescind is NOT held.
    expect(q<HTMLButtonElement>("private-trade-rescind")!.disabled).toBe(false);
  });

  it("without a model the panel draws no section (outside a Stock Round, or a caller without a board)", () => {
    act(() => {
      root.render(
        <StockRoundPanel
          publicCompanies={seedBoard().public_companies}
          parValueFor={() => "90"}
          onSelectParValue={() => undefined}
          onBuyShare={() => undefined}
          onSellShares={() => undefined}
          sessionReady
          isMyTurn={false}
          connectedAddress={null}
          roundType={"OperatingRound" as RoundType}
        />,
      );
    });
    expect(q("private-companies-section")).toBeNull();
  });
});

/* ================================================================== */
/* Phase 3 W3-J (AUD-25.13 #1, W2-F's deferred LOW): the offer's card is brought to the player who must answer it  */
/* ================================================================== */

describe("W3-J AUD-25.13 #1: scroll-to-card on the Stocks tab", () => {
  const SELL_MH = (price: number) => ({ privateId: MH, seller: P1, buyer: P3, price });
  let calls: Array<{ id: string; options: unknown }>;
  const proto = Element.prototype as unknown as { scrollIntoView?: (options?: unknown) => void };
  const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
  const original = proto.scrollIntoView;
  beforeEach(() => {
    calls = [];
    proto.scrollIntoView = function (this: Element, options?: unknown) {
      calls.push({ id: this.id, options });
    };
  });
  afterEach(() => {
    if (had) proto.scrollIntoView = original;
    else delete proto.scrollIntoView;
  });

  it("the recipient's section scrolls the offer's card into view once, as 'Show on Stocks' does", () => {
    const t = table(seedBoard());
    t.drawFor(P3);
    expect(calls).toEqual([]); // no offer, nothing to bring
    t.submit(P1, T.proposePrivateTradeMsg(GAME, SELL_MH(150)));
    t.drawFor(P3);
    expect(calls).toEqual([{ id: `private-trade-card-${MH}`, options: { block: "center", behavior: "smooth" } }]);
    // Re-renders of the same offer (a tick, the session key) do not scroll again.
    t.drawFor(P3);
    t.drawFor(P3, { sessionReady: false });
    expect(calls).toHaveLength(1);
  });

  it("a new offer -- the authority's next instance, same parties, same price -- scrolls again", () => {
    const t = table(seedBoard());
    t.submit(P1, T.proposePrivateTradeMsg(GAME, SELL_MH(150)));
    t.drawFor(P3);
    expect(calls).toHaveLength(1);
    // Rejected and re-offered between renders: the card's text is identical, the instance is not.
    expect(t.submit(P3, T.answerPrivateTradeMsg(GAME, MH, false)).kind).toBe("applied");
    expect(t.submit(P1, T.proposePrivateTradeMsg(GAME, SELL_MH(150))).kind).toBe("applied");
    t.drawFor(P3);
    expect(calls).toHaveLength(2);
  });

  it("the proposer, a third seat and a watcher have nothing to answer and are not moved", () => {
    const t = table(seedBoard());
    t.submit(P1, T.proposePrivateTradeMsg(GAME, SELL_MH(150)));
    t.drawFor(P1);
    t.drawFor(P2);
    t.drawFor(null);
    expect(calls).toEqual([]);
  });
});
