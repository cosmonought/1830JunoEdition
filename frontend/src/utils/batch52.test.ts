/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1060-1063 (harness): THE MONEY MACHINE AND THE BROADCAST
// ==================================================================
//
// TWO ITEMS THAT SHARE A SHAPE: a notification whose AUDIENCE or whose FORM was decided once, correctly, and
// then outlived the reason. The dividend receipt was a toast because #738 needed something every client
// raised; it stayed a toast when what it needed was legibility over a coloured board. The train purchase was
// scoped to its own dispatcher because #718 was correcting "toast notifications for literally every action";
// it stayed scoped when it became the one action whose news belongs to the whole table.
//
// ONE CLAIM IN THE REPORT WAS NOT TRUE, and the cases below record it rather than quietly not implementing
// it: "Ensure this toast triggers on every single train purchase, regardless of the remaining supply. Do not
// hide it behind a 'low supply' threshold check." There was no threshold. `deservesActionReceipt` has named
// `BuyHardwareFromPool` since #718 with no condition on the depot, and the sentence has always carried the
// count whatever it was. The audience gate was the whole of the bug.

export {};

const { trainPurchaseToastLine, describeGameplayAction } =
  require("./actionLog") as typeof import("./actionLog");
const { deservesActionReceipt } = require("./actionReceipt") as typeof import("./actionReceipt");
const {
  MONEY_MACHINE_SFX,
  MONEY_MACHINE_FALL_MS,
  MONEY_MACHINE_LINGER_MS,
  MONEY_MACHINE_SLIDE_MS,
} = require("../components/DividendMoneyMachine") as typeof import("../components/DividendMoneyMachine");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const APP = readStripped("App.tsx");
const MACHINE = readStripped("components/DividendMoneyMachine.tsx");
const LOG = readStripped("utils/actionLog.ts");
const FLASH = readStripped("components/RevenueModifierFlash.tsx");

const CO = 3;
/** A board whose depot still has stock, so the tier lookup both sentences make resolves. */
const board = (ownedByCo: readonly string[]): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    operating_sub_phase: "Hardware",
    macro_round_number: 2,
    sub_round_index: 1,
    player_addresses: ["p1"],
    active_player_index: 0,
    active_operating_order: [CO],
    active_corporation_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    public_companies: [
      {
        company_id: CO,
        ticker: "C&O",
        is_floated: true,
        treasury: "800",
        last_route_revenue: "0",
        station_token_hexes: [[0, 0]],
        owned_trains: ownedByCo,
      },
    ],
  }) as unknown as GameStateResponse;

const context = (before: GameStateResponse, after: GameStateResponse) => ({
  gameState: before,
  afterState: after,
  mapGrid: { game_id: 1, tiles: [] } as unknown as MapGridResponse,
  era: "Yellow" as const,
  labelForAddress: (address: string) => address,
});

const buy = { BuyHardwareFromPool: { game_id: 1, protocol_id: CO } } as never;

/* ------------------------------------------------------------------ */
/* The broadcast                                                       */
/* ------------------------------------------------------------------ */

describe("a train leaving the depot is news for everybody", () => {
  it("no longer suppresses the toast on every screen but the buyer's", () => {
    /* REPORTED: "The train purchase notification is currently only firing locally for the active player."
       THE DIAGNOSIS WAS RIGHT AND THE MECHANISM WAS NOT A TRANSPORT ONE. Nothing needed broadcasting: every
       client already runs `runGameplayAction` for every action (#738), and the toast was thrown away on
       arrival by an actor comparison. The fix is a condition, not an emission -- asserted here because the
       report's own framing ("update the websocket/event emission logic") would send the next reader looking
       for something this app does not have. */
    const gate = sliceBetween(APP, "deservesActionReceipt(msg) &&", "showActionToast(");
    expect(gate).toContain("globallyBroadcast !== null ||");
  });

  it("keeps the narrow scope for every other receipt", () => {
    /* #718's RULE SURVIVES WHERE IT WAS AIMED. "'Did it go through' is a question about a button you
       pressed" is still true of the emergency purchase's siblings, so the actor comparison is still in the
       expression -- widened by an OR, not deleted. A change that dropped it outright would toast every
       player for every receipt, which is the report #718 exists to answer. */
    const gate = sliceBetween(APP, "deservesActionReceipt(msg) &&", "showActionToast(");
    expect(gate).toContain("(options?.actor ?? viewerAddressRef.current) === viewerAddressRef.current");
  });

  it("is still silent during a replay", () => {
    /* THE GUARD THAT MAKES WIDENING THE AUDIENCE SAFE. Joining a room replays every train the table has ever
       bought; without #825's early return, widening this would carpet a new player's screen with a decade of
       purchases. `showActionToast` returns before doing anything during a rebuild. */
    const raiser = sliceBetween(APP, "const showActionToast = useCallback(", "}, []);");
    expect(raiser).toContain("if (replayingHistory) return;");
  });

  it("has no supply threshold to remove, and never had one", () => {
    /* THE CLAIM THAT WAS NOT TRUE: "Do not hide it behind a 'low supply' threshold check." Asserted as the
       absence it always was -- `deservesActionReceipt` answers on the message KEY alone, so a depot with six
       trains and a depot with one produce the same answer. Recorded rather than silently skipped, because a
       reader of this batch should not go looking for a threshold that was removed. */
    expect(deservesActionReceipt({ BuyHardwareFromPool: { protocol_id: CO } })).toBe(true);
    expect(deservesActionReceipt({ EmergencyBuyHardware: { protocol_id: CO } })).toBe(true);
  });
});

describe("the toast says the short form and the log says the long one", () => {
  it("renders the specified sentence", () => {
    // "[Corporation] bought a [Tier]-train. Depot: [X] remaining."
    const line = trainPurchaseToastLine(buy, context(board([]), board(["2"])) as never);
    expect(line).toMatch(/^C&O bought a \d-train\. Depot: \d+ remaining\.$/);
  });

  it("drops the price and the treasury the log keeps", () => {
    /* THE WHOLE REASON THIS IS A SECOND SENTENCE. The corner has room for one clause; the Activity Log is a
       record and keeps the figures a player may want to check later. */
    const short = trainPurchaseToastLine(buy, context(board([]), board(["2"])) as never) ?? "";
    const long = describeGameplayAction(buy, context(board([]), board(["2"])) as never) ?? "";
    expect(short).not.toContain("$");
    expect(long).toContain("for $");
    expect(long).toContain("Treasury");
  });

  it("agrees with the log about the tier and the count", () => {
    /* #794's RULE IS ABOUT SNAPSHOTS, NOT LENGTH -- its report was a toast and a log naming two different
       figures because they were built from two different states. Two sentences from one `context` cannot do
       that, and this is the case that says so: whatever the long line claims about the tier and the depot,
       the short one claims too. */
    const ctx = context(board([]), board(["2"])) as never;
    const short = trainPurchaseToastLine(buy, ctx) ?? "";
    const long = describeGameplayAction(buy, ctx) ?? "";
    const tier = short.match(/bought a (\S+)-train/)?.[1];
    const left = short.match(/Depot: (\S+) remaining/)?.[1];
    expect(tier).toBeTruthy();
    expect(left).toBeTruthy();
    expect(long).toContain(`bought a ${tier}-train`);
    expect(long).toContain(`Remaining depot supply: ${left}/`);
  });

  it("declines for anything that is not a depot purchase", () => {
    // `null` rather than a guess, so the caller falls back to the full label instead of an empty toast.
    expect(trainPurchaseToastLine({ LayTile: { protocol_id: CO } } as never, context(board([]), board([])) as never))
      .toBeNull();
  });

  it("is built beside the sentence it shortens", () => {
    // #891: a depot count worded in two files is two files that can disagree about it.
    expect(LOG).toContain("export function trainPurchaseToastLine");
    expect(APP).toContain("trainPurchaseToastLine(msg, {");
  });
});

/* ------------------------------------------------------------------ */
/* The money machine                                                   */
/* ------------------------------------------------------------------ */

describe("the dividend arrives instead of being described", () => {
  it("raises the overlay and no longer raises the receipt toast", () => {
    /* SPECIFIED: "Completely disable the default fast-fading toast notification for dividend payouts."
       ASSERTED AS BOTH HALVES. The overlay firing is not evidence the toast stopped -- the failure worth
       catching is two notifications for one payout, which is what every other item in the last three batches
       has been about. */
    expect(APP).toContain("showDividendPayout({");
    expect(APP).not.toContain("receipt.headline");
  });

  it("leaves the era announcement its toast", () => {
    /* THE CONTROL. `showDividendToast` is #738's shared-path raiser and the era change still uses it -- a
       change that deleted the function rather than one caller would have taken the era toast with it. */
    expect(APP).toContain("const showDividendToast = useCallback(");
    expect(APP).toContain("showDividendToast(");
  });

  it("takes the reducer's figure and the settled balances", () => {
    /* #795: "the figure a player is told they received is no longer this module's opinion" -- `receipt.amount`
       comes from `dividendSplit`, the value the reducer actually spends. And #670's before/after is read off
       the two states rather than added here, which is what stopped #723's preview and debit disagreeing. */
    const raise = sliceBetween(APP, "showDividendPayout({", "});");
    expect(raise).toContain("amount: receipt.amount");
    expect(raise).toContain("cashBefore: beforeCash");
    expect(raise).toContain("cashAfter: settled");
  });

  it("shows nothing rather than half a movement", () => {
    // #562: a missing figure and a real one are different facts, and a count-up needs both ends.
    expect(APP).toContain("if (beforeCash !== null && settled !== null) {");
  });

  it("is silent during a replay", () => {
    /* LOUDER THAN A TOAST AND SO MORE IMPORTANT TO GATE. An unguarded overlay would run a 900ms animation and
       a sound for every dividend in the log while a joining client rebuilt the board. */
    const raiser = sliceBetween(APP, "const showDividendPayout = useCallback(", "}, []);");
    expect(raiser).toContain("if (replayingHistory) return;");
  });

  it("restarts for a second payout rather than inheriting a finished one", () => {
    // #697's token, for #697's reason: two dividends can pay one viewer the same amount from one corporation.
    expect(APP).toContain("moneyMachineTokenRef.current += 1;");
    expect(MACHINE).toContain("key={event.token}");
  });
});

describe("the merge is animated, and the figures do not depend on it", () => {
  it("updates the total at the impact rather than at the mount", () => {
    /* SPECIFIED: "The `+$[Payout]` physically merges into the `$[Current Total]`, updating the sum
       immediately upon impact." A number cannot be swapped by a keyframe, so the phase is React state and
       only the travel is CSS. */
    expect(MACHINE).toContain('const shown = phase === "falling" ? event.cashBefore : event.cashAfter;');
  });

  it("times the impact rather than waiting for an animation event", () => {
    /* A BACKGROUND TAB THROTTLES `animationend` AND CAN DROP IT. A payout that never merged would leave the
       old total on screen and never fire the cue; a late timer is recoverable, a missing event is not. */
    expect(MACHINE).toContain("window.setTimeout(() => {");
    expect(MACHINE).not.toContain("animationend");
  });

  it("adds up to the specified 900ms fall", () => {
    expect(MONEY_MACHINE_FALL_MS).toBe(900);
    // And the lifetime is fall + linger + fade, in that order, with nothing negative.
    expect(MONEY_MACHINE_LINGER_MS).toBeGreaterThan(0);
    expect(MONEY_MACHINE_SLIDE_MS).toBeGreaterThan(0);
  });

  it("survives reduced motion with every figure intact", () => {
    /* ==================================================================
        THE HOUSE RULE THIS FEATURE COULD HAVE BEEN THE FIRST TO BREAK
       ==================================================================
       #606: "the information is the sentence, never the movement", and every keyframe in this app is wrapped
       in `prefers-reduced-motion`. An animation whose merge IS the message would be the first surface where
       turning motion off costs a player a figure.
       SO THE REDUCED PATH IS THE SAME FACTS WITHOUT THE TRAVEL -- the panel appears merged, and because the
       total is React state rather than a keyframe there is nothing to lose by not animating. */
    expect(MACHINE).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = sliceBetween(MACHINE, "@media (prefers-reduced-motion: reduce) {", "}\n`");
    expect(reduced).toContain(".app-money-machine-fall { animation: none;");
  });

  it("animates only the two properties that do not re-lay the panel out", () => {
    // `translateY` and `opacity`: the pair the compositor can do without touching layout, and the pair every
    // other animation in this app confines itself to.
    /* BOUNDED BY THE NEXT RULE, NOT BY THE FIRST `}`. A first draft ended this at `"}"`, which stops at the
       end of the `from` line and leaves the `to` line -- where the actual travel is written -- outside the
       slice. An implementation that animated `height` on the way down would have passed. `sliceBetween`
       throws on a MISSING anchor and says nothing about a loose one, which is the trap the last batch found
       the hard way. */
    const css = sliceBetween(MACHINE, "@keyframes app-money-machine-drop", ".app-money-machine {");
    expect(css).toContain("translateY");
    expect(css).toContain("opacity");
    expect(css).not.toContain("height");
    expect(css).not.toContain("margin");
  });

  it("reports without receiving, over a board that must stay clickable", () => {
    // `ActionToast`'s standing rule, and it matters more here: this sits over the map, where a swallowed
    // click is a lost tile lay.
    expect(MACHINE).toContain('pointerEvents: "none"');
  });

  it("puts dark ground under light ink, which is the stated requirement", () => {
    /* "A distinct background (e.g. semi-transparent dark gray or frosted glass) so the text is fully legible
       against the game board and colored heralds." The blur is additive -- an engine that ignores
       `backdrop-filter` still gets the solid layer, which is where the legibility comes from. */
    const panel = sliceBetween(MACHINE, "panel: {", "},");
    expect(panel).toContain("backgroundColor: \"rgba(18, 21, 29, 0.9)\"");
    expect(panel).toContain("backdropFilter");
  });
});

describe("the till slides in and out", () => {
  it("arrives from the right edge and leaves the same way", () => {
    // "Slides in from the right edge of the screen (`translateX(100%)` to `0`)" and back out.
    const arrive = sliceBetween(MACHINE, "@keyframes app-money-machine-in", "@keyframes");
    expect(arrive).toContain("translateX(100%)");
    expect(arrive).toContain("translateX(0)");
    const leave = sliceBetween(MACHINE, ".app-money-machine-out {", "}");
    expect(leave).toContain("translateX(100%)");
  });

  it("lingers about two seconds on the merged total", () => {
    // "The panel lingers for ~2 seconds so players can read the total."
    expect(MONEY_MACHINE_LINGER_MS).toBeGreaterThanOrEqual(1800);
    expect(MONEY_MACHINE_LINGER_MS).toBeLessThanOrEqual(2400);
  });
});

describe("reduced motion is a different schedule, not just a stilled one", () => {
  it("asks the media query in JavaScript, not only in CSS", () => {
    /* ==================================================================
        THE HALF A STYLESHEET CANNOT DO
       ==================================================================
       SPECIFIED: "trigger the local audio at 0ms ... instantly disappear without sliding." The cue fires from
       a `setTimeout` at the 900ms impact and the total changes on a React state flip; neither is reachable
       from `@media`. A CSS-only implementation would leave a reduced-motion player looking at a static panel
       showing the OLD total for 900 silent milliseconds and then jumping -- worse than the animation it was
       meant to spare them. */
    expect(MACHINE).toContain('window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true');
    expect(MACHINE).toContain("const quiet = prefersReducedMotion();");
  });

  it("starts merged and sounds at 0ms", () => {
    expect(MACHINE).toContain('setPhase(quiet ? "merged" : "falling");');
    const branch = sliceBetween(MACHINE, "if (quiet) {", "} else {");
    expect(branch).toContain("onImpact();");
  });

  it("takes the fall and the slide out of the clock", () => {
    /* THE TIMINGS ARE ARITHMETIC ON `quiet`, so the linger is the same either way and the two removals are
       the fall before it and the slide after -- which is exactly what "skip the slide-in entirely" and
       "instantly disappear" ask for, expressed as zeroes rather than as a second code path. */
    expect(MACHINE).toContain("const settled = quiet ? 0 : MONEY_MACHINE_FALL_MS;");
    expect(MACHINE).toContain("(quiet ? 0 : MONEY_MACHINE_SLIDE_MS)");
  });

  it("keeps the payout figure on screen when there is no merge to absorb it", () => {
    /* "DISPLAYING THE +$[PAYOUT] STATICALLY NEXT TO IT." The merged phase hides the payer line, which is the
       point of a merge; with nothing to watch it absorb, hiding it would delete the figure the panel is
       about. Handled in the media block so the component needs no second render path. */
    const reduced = sliceBetween(MACHINE, "@media (prefers-reduced-motion: reduce) {", "}\n`");
    expect(reduced).toContain(".app-money-machine-landed { opacity: 1; }");
    expect(reduced).toContain(".app-money-machine { animation: none; }");
    expect(reduced).toContain(".app-money-machine-out { transition: none;");
  });
});

/* ------------------------------------------------------------------ */
/* The neutral roll                                                    */
/* ------------------------------------------------------------------ */

describe("an unchanged roll confirms itself", () => {
  it("no longer suppresses the flash on a normal outcome", () => {
    /* REPORTED: "When the variant rolls an unchanged revenue state (0% modifier), cleanly flash the screen
       white and briefly display a `+0%` ... to confirm the roll was executed."
       AND SILENCE ON A THIRD OF THE FACES LOOKED LIKE FAILURE. `revenueOutcome(roll) !== "normal"` was the
       gate; it is gone, and only the haunting's suppression remains. */
    expect(APP).toContain("if (!cue.suppressStandardVisuals) {");
    expect(APP).not.toContain('revenueOutcome(roll) !== "normal" &&');
  });

  it("passes a hard zero rather than the nominal swing", () => {
    /* ==================================================================
        THE #938 TRAP THIS BATCH COULD EASILY HAVE WALKED INTO
       ==================================================================
       `revenueDeltaPercent` IS `percent - 100`, so a 90% roll whose rounding gave the corporation back its
       printed figure would flash `-10%` -- the precise lie #938 wrote its predicate to prevent, reintroduced
       by removing the gate. The outcome still decides the figure; it just decides a figure now instead of
       deciding silence. */
    expect(APP).toContain('revenueOutcome(roll) === "normal" ? 0 : revenueDeltaPercent(roll)');
  });

  it("reads +0% in white, with no arrows to claim a direction", () => {
    /* #953 PUT THE ARROWS THERE TO SAY DIRECTION -- "up-arrows floating upward" for a bonus, down for a
       malus. An unchanged roll has none, and six drifting triangles that mean nothing are worse than none.
       WHITE FOR THE SAME REASON: green rises and red falls (#973), so a third hue on that axis would invite
       the reader to ask which way it points. */
    expect(FLASH).toContain("const neutral = shown.delta === 0;");
    expect(FLASH).toContain("(neutral ? [] : ARROW_POSITIONS).map(");
    expect(FLASH).toContain("neutral ? NEUTRAL_COLOR :");
    expect(FLASH).toContain("neutral ? NEUTRAL_EDGE :");
    expect(FLASH).toContain('{bonus || neutral ? "+" : "-"}');
  });

  it("would have rendered a neutral roll as a malus before this batch", () => {
    /* THE REASON THE GATE COULD NOT SIMPLY BE DELETED. Every branch read `bonus ? green : red` and
       `delta > 0` is false at zero, so a neutral roll arriving at this component would have flashed red with
       falling arrows and printed `-0%`. Asserted as the absence of that shape: no bare two-way is left. */
    expect(FLASH).not.toContain("color: bonus ? BONUS_EDGE : MALUS_EDGE,");
    expect(FLASH).not.toContain('{bonus ? "+" : "-"}');
  });

  it("keeps the sound the neutral bucket already had", () => {
    /* ASKED whether the neutral state should be silent now that it flashes; ruled to keep it. It was never
       silent -- `BUCKET_FALLBACK.unchanged` has been `coins-clinking.mp3` since #1040 -- so "make it silent"
       would have been a removal rather than a decision not to add. */
    const sfx = readStripped("utils/variantSfx.ts");
    expect(sfx).toContain('unchanged: "coins-clinking.mp3"');
  });
});

describe("the cue lands on the merge", () => {
  it("fires from the impact callback, not from the mount", () => {
    /* SPECIFIED: "Trigger `money-machine.mp3` at the exact moment the numbers merge." The component owns the
       timing and the shell owns the playing, so the mute and the radio ducking stay in the one helper every
       other cue goes through (#1041). */
    expect(MACHINE).toContain("onImpact();");
    const handler = sliceBetween(APP, "const handleMoneyMachineImpact = useCallback(", "}, []);");
    expect(handler).toContain("playVariantCue(MONEY_MACHINE_SFX, sfxEnabledRef.current)");
  });

  it("names a file that is actually on disk", () => {
    /* #1040's LESSON, WHICH COST A SILENT FEATURE. Two spec filenames turned out not to match what shipped
       (`iec-crack.mp3`, `carcosa_awaits.mp3`), and a missing cue fails silently -- `playVariantCue` catches
       the error and moves on. So the name is checked against the filesystem rather than against the brief. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const audio = path.join(__dirname, "..", "..", "public", "audio", MONEY_MACHINE_SFX);
    expect(fs.existsSync(audio)).toBe(true);
  });

  it("honours the mute like every other cue", () => {
    // `playVariantCue` returns early when sound is off and reference-counts the radio duck (#1041).
    expect(APP).toContain("sfxEnabledRef.current");
  });
});
