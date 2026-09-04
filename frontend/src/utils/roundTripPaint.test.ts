/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1145 (harness): CODE THAT WAS WRITTEN WHEN DISPATCH WAS INSTANT
// ==================================================================
//
// REPORTED as two bugs: "when clicking the green checkmark to lay a tile, the screen briefly flashes with the
// empty hex before the tile is laid ... the exact same thing happens with station token placement", and "the
// auto-skip through Operating subphases is briefly flashing each subphase's Action Bar before landing on the
// actionable one". The report adds, correctly, "this feels related to the lag issue above".
//
// IT IS ONE FAULT WEARING THREE FACES, and naming it is most of the fix. SOLO sandbox applies the reducer
// INSIDE the click: `runGameplayAction` reaches no `await`, so the dispatch and the state change are one
// React commit and there is no moment between them to draw. A ROOM appends to Firestore and returns (#522,
// "the log is the game"); the board moves when the snapshot comes back. Every place that assumed those two
// instants were the same instant now has a round trip inside it, and paints whatever it was holding there:
//
//   THE TILE    the ghost was cleared at the near end of the trip and the tile arrived at the far end.
//   THE TOKEN   the confirm ring closed and the marker comes from `public_companies`, which had not moved.
//   THE BAR     #1094's freeze released when the skip was SENT rather than when the step MOVED.
//
// SO THE PROPERTY EVERY CASE BELOW GUARDS IS THE SAME ONE: nothing is released on the strength of having
// dispatched. Each release waits for the board. And because a board can REFUSE, each release also has a
// deadline -- a held picture that outlives its refusal is a worse bug than the flash, and a quieter one.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const HEX = readStripped("components/HexGridRenderer.tsx");

describe("the tile ghost is released by the board, not by the click", () => {
  it("marks the lay sent instead of erasing it", () => {
    /* THE CONFIRM STILL CLOSES THE RING -- the player answered it -- and that is the half of the old
       `handleDismissRadial` that was right. Only the tile stays. Asserted as the absence of the erase from
       the confirm path, because a `setPreviewTile(null)` reintroduced there is the whole bug returning. */
    expect(APP).toContain("const handleRingConfirmed = useCallback(() => {");
    const confirmed = sliceBetween(APP, "const handleRingConfirmed = useCallback(() => {", "}, []);");
    expect(confirmed).toContain("setRadialSelector(null)");
    expect(confirmed).toContain("committed: true");
    expect(confirmed).not.toContain("setPreviewTile(null)");
    /* And the cancel path is UNTOUCHED: dismissing a ring the player did not confirm must still take the
       ghost with it, or a cancelled preview would linger for four seconds. */
    const dismiss = sliceBetween(APP, "const handleDismissRadial = useCallback(() => {", "}, []);");
    expect(dismiss).toContain("setPreviewTile(null)");
  });

  it("draws a sent tile as a tile rather than as a proposal", () => {
    /* THE DASHES ARE THE ONLY DIFFERENCE, which is what makes the swap invisible: the fill and the track were
       always drawn exactly as a laid tile draws them. If the held ghost stayed dashed the player would watch
       a dashed hex become a solid one -- better than an empty flash, and still a flash. */
    expect(HEX).toContain("if (!previewTile.committed) ctx.setLineDash([5, 4]);");
  });

  it("waits for the tile, not merely for the hex", () => {
    /* AN UPGRADE LANDS ON A HEX THAT ALREADY HOLDS A TILE. A release keyed on "is there a tile here" would
       fire on the render that drew the ghost, which is every upgrade in the game -- the exact case where the
       flash is most visible, since the hex flicks back to the OLD tile rather than to bare ground. */
    const release = sliceBetween(APP, "if (!previewTile?.committed) return undefined;", "}, [previewTile, mapGrid]);");
    expect(release).toContain("tile.tile_id === tileId");
    expect(release).toContain("tile.q === q && tile.r === r");
  });
});

describe("the in-flight token is shown to the canvas and to nothing else", () => {
  it("overlays the roster on the one wire the board reads", () => {
    /* THE CONTAINMENT IS THE DESIGN. An unlanded token that reached route legality would be #891 with
       consequences -- two clients computing different legal routes from the same log -- and it would stay
       invisible until they disagreed. `boardCompanies` exists on exactly one prop. */
    expect(APP).toContain("publicCompanies={boardCompanies}");
    expect(APP).toContain("const boardCompanies = useMemo(() => {");
    const memo = sliceBetween(APP, "const boardCompanies = useMemo(() => {", "}, [gameState?.public_companies, committedStation]);");
    expect(memo).toContain("if (!roster || !committedStation) return roster;");
    /* ONE CONSUMER, AND THE COUNT IS THE ASSERTION. A second `boardCompanies` reader is how this becomes a
       rules input by accident.
       TWO, because `readStripped` drops comments: the declaration and the single prop that reads it. The
       mentions in prose do not count, which is the point of measuring the stripped source. */
    expect(APP.split("boardCompanies").length - 1).toBe(2);
  });

  it("never turns an unknown token list into a claim", () => {
    /* `station_tokens`' own type comment: an empty list beside a non-empty `station_token_hexes` means "this
       chain does not know", never "no tokens". Seeding a first entry would flip that meaning and switch the
       renderer off the heuristic that is currently drawing every other token correctly. */
    const memo = sliceBetween(APP, "const boardCompanies = useMemo(() => {", "}, [gameState?.public_companies, committedStation]);");
    expect(memo).toContain("company.station_tokens && company.station_tokens.length > 0");
  });

  it("does not draw a token the company already has", () => {
    /* Idempotent against the arrival: once the roster carries the hex, the overlay adds nothing, so the
       release and the draw cannot briefly double up. */
    const memo = sliceBetween(APP, "const boardCompanies = useMemo(() => {", "}, [gameState?.public_companies, committedStation]);");
    expect(memo).toContain("company.station_token_hexes.some(([hq, hr]) => hq === q && hr === r)");
  });
});

describe("a held picture always has a deadline", () => {
  it("gives both holds the same bound, from one constant", () => {
    /* A LAY CAN BE REFUSED -- `applySandboxLayTile` takes a `layRefused` arm, #891 refuses one the treasury
       cannot cover, and an append can fail outright. Without a deadline the refusal leaves a solid tile drawn
       on a hex that does not have one, held forever, and the player's only clue is a log line.
       ONE CONSTANT FOR BOTH, so the tile and the token cannot come to disagree about how long a round trip
       may take. */
    expect(APP).toContain("const COMMITTED_PREVIEW_MS = 4000;");
    expect(APP).toContain("window.setTimeout(() => setPreviewTile(null), COMMITTED_PREVIEW_MS)");
    expect(APP).toContain("window.setTimeout(() => setCommittedStation(null), COMMITTED_PREVIEW_MS)");
  });

  it("clears its timer, so a burst of board updates cannot stack them", () => {
    expect(APP).toContain("return () => window.clearTimeout(timer);");
  });
});

describe("the action bar's freeze waits for the step to move", () => {
  it("holds while the skip is in flight, not merely until it is sent", () => {
    /* ==================================================================
        DESIGN NOTE 1145 NARROWS #1094'S THIRD CLAUSE
       ==================================================================
       #1094 froze the bar on "reason present, my turn, and this key not already spent", and the third clause
       was right for a reason that has since expired: solo sandbox spends the key and moves the step in the
       same commit. In a room the spend happens at the near end of a round trip and the step moves at the far
       end, so the freeze released into exactly the window it existed to cover -- and the one-second `now`
       tick alone guarantees a render inside it.
       ASSERTED AS THE PRESENCE OF THE IN-FLIGHT ARM, since the old expression is a strict prefix of the new
       one and a `toContain` on the old text would pass against both. */
    expect(APP).toContain("skipDispatchedForRef.current === autoSkipKey");
    expect(APP).toContain("skipDispatchedForRef.current = key;");
  });

  it("keeps #1094's protection against a freeze that outlives its dispatch", () => {
    /* THE CLAUSE IS NARROWED, NOT DELETED, and that distinction is the test. Returning to a step whose key is
       already spent finds the ref holding a key that is no longer current -- so the bar is NOT frozen, which
       is the stuck-freeze case #1094 was defending against. A freeze keyed on the reason alone would have
       held the bar for the rest of the turn. */
    expect(APP).toContain("!autoSkippedRef.current.has(autoSkipKey) || skipDispatchedForRef.current === autoSkipKey");
  });

  it("still draws the settled step while a run resolves", () => {
    /* #1094's own mechanism, untouched: two states instead of five. */
    expect(APP).toContain("const displayedSubPhase = autoSkipPending ? settledSubPhaseRef.current : orSubPhase;");
    expect(APP).toContain("orSubPhase={displayedSubPhase}");
  });
});
