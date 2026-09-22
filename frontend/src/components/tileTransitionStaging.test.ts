/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1465, 1471-1474 (harness): THE STAGING IS STRUCTURAL, SO IT IS SCANNED
// ==================================================================
//
// A layout effect that starts a transition, a frame clock that stops itself, a held ghost that is not painted
// over its own flourish: none of these is observable through jsdom, which has no canvas to paint on. They are
// properties of where code sits, so -- as with VF-1's once-per-sequence guards -- they are asserted against
// comment-stripped source (#490a), and each assertion names the design note it holds up.
//
// AND THE NEGATIVE HALF MATTERS MOST: the flourish may not reach into the rules. The description module, the
// painter and the shell are scanned for the imports and calls that would make presentation a participant in
// gameplay.

export {};

const { anchorIndex, readStripped, sliceBetween } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");

const DESCRIPTION = readStripped("components/tileTransition.ts");
const PAINTER = readStripped("components/tileTransitionCanvas.ts");
const RENDERER = readStripped("components/HexGridRenderer.tsx");
const SHELL = readStripped("App.tsx");

const count = (source: string, needle: string) => source.split(needle).length - 1;

describe("the flourish knows no rules (#1460, VF A-3/A-4)", () => {
  it("imports nothing that decides legality, placement or state", () => {
    for (const source of [DESCRIPTION, PAINTER]) {
      expect(source).not.toMatch(/from "\.\.\/gameEngine/);
      expect(source).not.toMatch(/from "\.\.\/utils/);
      expect(source).not.toContain("sandboxTileLegality");
      expect(source).not.toContain("tokenMigration");
      expect(source).not.toContain("stationConnectivity");
      expect(source).not.toContain("tileUpgrades");
      expect(source).not.toContain("messageSchema");
    }
  });

  it("dispatches nothing, waits on nothing, and names no tile", () => {
    for (const source of [DESCRIPTION, PAINTER]) {
      expect(source).not.toContain("runGameplayAction");
      expect(source).not.toContain("dispatch");
      expect(source).not.toContain("setTimeout");
      expect(source).not.toContain("await ");
      expect(source).not.toMatch(/tile_?[iI]d\s*===\s*\d/);
    }
  });

  it("is invisible to the shell: App.tsx neither imports it nor waits for it", () => {
    expect(SHELL).not.toContain("tileTransition");
  });
});

describe("the board stages a lay (#1465)", () => {
  const detection = sliceBetween(RENDERER, "useLayoutEffect(() => {", "}, [mapGrid, previewTile, publicCompanies, boardId, hexSize]);");

  it("starts a transition in a LAYOUT effect, before the draw effect paints the new state", () => {
    expect(detection).toContain("changedPresentedHexes(");
    expect(detection).toContain("beginTileTransition(");
    expect(RENDERER.indexOf("useLayoutEffect(() => {")).toBeGreaterThan(-1);
  });

  it("snaps every changed hex before deciding whether one may play, and plays only a single animatable change", () => {
    const snap = detection.indexOf("transitions.delete(");
    const awaited = detection.indexOf("awaitedLayLands(awaitedLaysRef.current, changes, previousCommitted, nextCommitted)");
    const single = detection.indexOf("if (changes.length !== 1) return;");
    const gate = detection.indexOf("if (landsStagedLay || change.to === null || !isAnimatableChange(change.from, change.to)) return;");
    const begin = detection.indexOf("beginTileTransition(");
    expect(snap).toBeGreaterThan(-1);
    expect(awaited).toBeGreaterThan(snap);
    expect(single).toBeGreaterThan(awaited);
    expect(gate).toBeGreaterThan(single);
    expect(begin).toBeGreaterThan(gate);
  });

  it("drops everything when the board changes under it", () => {
    expect(detection).toContain("if (previous.boardId !== boardId) {");
    expect(detection).toContain("transitions.clear();");
    expect(detection).toContain("awaitedLaysRef.current.clear();");
  });

  it("runs its frame clock only while a transition does, and cancels it on cleanup", () => {
    const clock = sliceBetween(RENDERER, "const transitions = tileTransitionsRef.current;\n    if (transitions.size === 0) return undefined;", "}, [tileTransitionEpoch]);");
    expect(clock).toContain("requestAnimationFrame(step)");
    expect(clock).toContain("if (transitions.size > 0) handle = requestAnimationFrame(step);");
    expect(clock).toContain("return () => cancelAnimationFrame(handle);");
  });

  it("reads the board's existing reduced-motion convention rather than a setting of its own", () => {
    expect(RENDERER).toContain('matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true');
    expect(RENDERER).toContain("reducedMotion: prefersReducedMotion()");
  });

  it("hands the hex back by time, and only while it still presents the tile the transition was built for", () => {
    const lookup = sliceBetween(RENDERER, "const transitionAt = (q: number, r: number)", "const laidAtPreview");
    expect(lookup).toContain("if (t >= 1) return null;");
    expect(lookup).toContain("samePresented(presentedTileAt(mapGrid, drawnCommitted, q, r), transition.to)");
    // Design note #1471: a proposal on the hex is what the player is looking at, whatever else is running there.
    expect(lookup).toContain("if (proposingAt(q, r)) return null;");
  });

  it("draws a staged hex from its frame in the tile pass's own place", () => {
    const tilePass = sliceBetween(RENDERER, "for (const tile of presentedGrid.tiles) {", "drawHexPath(ctx, center, hexSize);");
    expect(tilePass).toContain("transitionAt(tile.q, tile.r)");
    expect(tilePass).toContain("drawTileTransitionFill(ctx, center, hexSize, stagedFrame)");
    expect(tilePass).toContain("drawTileTransitionArt(ctx, center, hexSize, stagedFrame)");
    expect(tilePass).toContain("continue;");
  });

  it("changes the printed passes only through the presented grid, which is the grid itself when nothing is previewed", () => {
    expect(RENDERER).toContain("const presentedGrid: MapGridResponse = previewEntry");
    expect(RENDERER).toContain(": mapGrid;");
    /* ==================================================================
        AMENDED: THE END ANCHOR WAS THE LAST DEPENDENCY, WHICH IS NOT A STABLE THING TO BE
       ==================================================================
       It read `tileTransitionTick,\n  ]);` -- the draw callback's dependency array, identified by whatever
       happened to be last in it. VF-2 then appended `routeSignalTick` for the route pulse's own frame
       clock, and this slice stopped resolving: `sliceBetween` threw, so the case failed loudly rather
       than passing over an empty region (#886's whole reason for making it throw).
       NOTHING WAS WRONG WITH THE CODE. A dependency array grows every time the callback reads something
       new, so anchoring on its last entry is anchoring on the next feature. Re-anchored past it, on the
       effect that CALLS `draw` -- the first `useEffect` after the callback, which is structural rather
       than incidental and cannot be pushed along by another dependency. */
    const draw = sliceBetween(RENDERER, "const draw = useCallback(() => {", "useEffect(() => {\n    draw();");
    expect(count(draw, "hexHasLaidTile(mapGrid,")).toBe(0);
    // The slice really covers the callback, which is the check that keeps this from going vacuous again.
    expect(draw).toContain("for (const tile of presentedGrid.tiles) {");
  });
});

describe("the tile being chosen is a proposal, and the confirm builds into it (#1471)", () => {
  const tilePass = sliceBetween(RENDERER, "for (const tile of presentedGrid.tiles) {", "drawHexPath(ctx, center, hexSize);");

  it("draws the proposal in the tile pass, with the flourish's painter, after a running transition and before any other tile drawing", () => {
    const staged = tilePass.indexOf("drawTileTransitionFill(ctx, center, hexSize, stagedFrame)");
    const proposal = tilePass.indexOf("if (proposingAt(tile.q, tile.r)) {");
    expect(staged).toBeGreaterThan(-1);
    expect(proposal).toBeGreaterThan(staged);
    expect(tilePass).toContain("const proposal = proposedTileFrame(tile.tile_id, tile.orientation);");
    expect(tilePass).toContain("drawTileTransitionFill(ctx, center, hexSize, proposal, { rimDash: [5, 4] });");
    expect(tilePass).toContain("drawTileTransitionArt(ctx, center, hexSize, proposal)");
    // One painter for a proposal and a transition: the ghost's own drawing path is gone.
    expect(RENDERER).not.toContain("previewCatalogEntry");
    expect(count(RENDERER, "drawTileTransitionFill(")).toBe(2);
  });

  it("is a proposal only until it is sent", () => {
    const proposing = sliceBetween(RENDERER, "const proposingAt = (q: number, r: number) =>", "const transitionAt = (q: number, r: number)");
    expect(proposing).toContain("drawnPreview.committed !== true");
  });

  it("starts a confirmed proposal's transition from the proposal it was drawing, holding its value still", () => {
    const detection = sliceBetween(RENDERER, "useLayoutEffect(() => {", "}, [mapGrid, previewTile, publicCompanies, boardId, hexSize]);");
    expect(detection).toContain("const proposed = previous.previewTile;");
    expect(detection).toContain("proposed.committed !== true");
    expect(detection).toContain("proposed.tileId === change.to.tileId");
    expect(detection).toContain("proposed.orientation === change.to.orientation");
    expect(detection.indexOf("const provisional =")).toBeLessThan(detection.indexOf("beginTileTransition("));
    const begin = sliceBetween(RENDERER, "function beginTileTransition(input: {", "export function HexGridRenderer(");
    expect(begin).toContain("reducedMotion: prefersReducedMotion(),\n    provisional,");
    // Design notes #1472, #1473: its tokens and reservation markers ride from the confirm, so their places are read for it
    // as for any transition; only its value is left where the proposal printed it.
    expect(begin).not.toContain("if (provisional) {");
    expect(begin).toContain("reservationsFrom.set(home.companyId, homeReservationPoints(home, previousLaid, hexSize).map(unit));");
    expect(begin).toContain("badgeFrom: provisional ? null : outgoingValueBadge(previousLaid, label),");
    expect(begin).toContain("moving: new Map(),");
  });

  it("prints a proposal's value washed and commits it where its tile commits", () => {
    const values = sliceBetween(RENDERER, "const stagedBadge = transitionAt(tile.q, tile.r);", 'const badgeText = archetype === "DoubleCity" ? "NY" : "B";');
    expect(values).toContain("badgePresentationAt(stagedBadge.transition.plan, stagedBadge.t)");
    expect(values).toContain(": proposingAt(tile.q, tile.r)");
    expect(values).toContain("PROPOSED_BADGE");
    /* ==================================================================
        AMENDED: THE PAINTER SPLIT IN TWO, AND THIS SIDE DELIBERATELY TAKES THE UNDEFERRED HALF
       ==================================================================
       It named `printValue`, which was the only painter when #1471 wrote this. VF-2's route pulse split
       it: `paintTileBadge` still draws the badge, and `printValue` now wraps it in `paintBadge`, which
       DEFERS a reacting badge so it can be elevated above the tokens.
       AND THE REVEAL-CROSSING SPLIT MUST NOT BE DEFERRED, which is why the code reads the way it does
       rather than the way this case did. Each half here is drawn inside a `withRevealSide` clip; deferring
       one of them would replay it later, outside that clip, and paint the whole badge twice at two
       different alphas. VF-2 records the decision in place ("keeps the pre-existing draw order ... for
       this one edge case only") and it is the correct one.
       SO THE ASSERTION FOLLOWS THE CODE TO `paintTileBadge`, and the rule #1471 was really making is
       unchanged and still asserted: the committed side claims the slot at full alpha, the proposal's side
       is drawn into the ledger AS IT STOOD BEFORE THE CLAIM at the provisional alpha, and the two are
       separated by the reveal front. The `printValue` absence is asserted too, so a future tidy-up that
       "unifies" these onto the deferring painter fails here instead of drawing the badge twice. */
    expect(values).toContain('withRevealSide(ctx, center, hexSize, badge.front, "west", () => paintTileBadge(1, claimedHexSlots));');
    expect(values).toContain('withRevealSide(ctx, center, hexSize, badge.front, "east", () => paintTileBadge(provisionalAlpha, before));');
    const crossing = values.slice(values.indexOf("const before = new Map<string, Set<number>>();"));
    expect(crossing).not.toContain("printValue(");
    // And the ordinary, non-crossing cases DO go through the deferring painter, which is the control.
    expect(values).toContain("printValue(1, claimedHexSlots);");
    expect(values).toContain("printValue(badge.provisionalAlpha, claimedHexSlots);");
  });
});

describe("the commit front sweeps the tile's bottom layer (#1473)", () => {
  const fill = sliceBetween(PAINTER, "export function drawTileTransitionFill(", "function pathThrough(");

  it("draws the front's edge with the fill -- over the fills, under the rim, the rails, the centres and every later pass", () => {
    const fills = fill.indexOf("ctx.fill();");
    const edge = fill.indexOf("drawRevealEdge(ctx, center, size, front)");
    const rim = fill.indexOf("ctx.stroke();");
    expect(fills).toBeGreaterThan(-1);
    expect(edge).toBeGreaterThan(fills);
    expect(rim).toBeGreaterThan(edge);
    // Once, and never with the art: the tile pass draws the art after the fill, and every badge after the tile.
    expect(count(PAINTER, "drawRevealEdge(ctx, center, size, front)")).toBe(1);
    expect(sliceBetween(PAINTER, "export function drawTileTransitionArt(", "function sideLayer(")).not.toContain("drawRevealEdge");
  });

  it("draws the edge as a hairline, a third of its old width", () => {
    const edge = sliceBetween(PAINTER, "const REVEAL_EDGE = {", "} as const;");
    expect(edge).toContain("width: 0.01,");
    expect(edge).toContain("minPx: 0.5,");
  });

  it("lays each side's finished art under its side of the front, and clips as it draws only where it cannot", () => {
    const art = sliceBetween(PAINTER, "export function drawTileTransitionArt(", "function sideLayer(");
    expect(art).toContain("laySides(ctx, center, size, frame, front)) return;");
    expect(art).toContain("bySide(ctx, center, size, frame, (side) => drawArtSide(ctx, center, size, frame, side));");
    const lay = sliceBetween(PAINTER, "function laySides(", "function drawArtSide(");
    expect(lay).toContain("drawArtSide(layer, center, size, frame, side);");
    expect(lay).toContain("ctx.drawImage(layer.canvas, 0, 0, width, height, left, top, width, height);");
    expect(lay.indexOf('paint(committed, "committed", "west");')).toBeLessThan(lay.indexOf('paint(provisional, "provisional", "east");'));
    // A fill hidden under an opaque one is not drawn under a clip either.
    expect(fill).toContain("const fills = opaque > 0 ? layers.slice(opaque) : layers;");
  });
});

describe("a lay is staged once, however long its picture takes to come true (#1468)", () => {
  /* The renderer's own decision, driven through the shell's sequences: what the grid holds and what `previewTile`
     holds, render by render. `plays` applies the layout effect's gate -- a single change, not a lay already staged,
     animatable -- which the ordering case above pins to the effect itself. */
  const { awaitedLayLands, changedPresentedHexes, committedPreviewOf } = require("./HexGridRenderer") as typeof import("./HexGridRenderer");
  const { isAnimatableChange } = require("./tileTransition") as typeof import("./tileTransition");
  type Grid = import("./HexGridRenderer").MapGridResponse;
  type Render = { grid: Grid; preview: { q: number; r: number; tileId: number; orientation: number; committed?: boolean } | null };
  const grid = (...tiles: Array<[number, number, number, number]>): Grid => ({
    game_id: 1,
    tiles: tiles.map(([q, r, tileId, orientation]) => ({ q, r, tile_id: tileId, orientation, landmark: null })),
  });
  const plays = (renders: Render[], withAwait = true) => {
    const awaited = new Map<string, { tileId: number; orientation: number }>();
    const played: string[] = [];
    for (let i = 1; i < renders.length; i += 1) {
      const previousCommitted = committedPreviewOf(renders[i - 1].preview);
      const nextCommitted = committedPreviewOf(renders[i].preview);
      const changes = changedPresentedHexes(renders[i - 1].grid, previousCommitted, renders[i].grid, nextCommitted);
      if (changes.length === 0) continue;
      const lands = withAwait ? awaitedLayLands(awaited, changes, previousCommitted, nextCommitted) : false;
      if (changes.length !== 1) continue;
      const [change] = changes;
      if (lands || change.to === null || !isAnimatableChange(change.from, change.to)) continue;
      played.push(`${change.q},${change.r}:#${change.to.tileId}@${change.to.orientation}`);
    }
    return played;
  };
  const empty = grid();
  const laid = grid([3, 4, 8, 2]);
  const ghost = (committed: boolean) => ({ q: 3, r: 4, tileId: 8, orientation: 2, committed });

  it("does not play while tiles are only being chosen and turned", () => {
    expect(plays([
      { grid: empty, preview: null },
      { grid: empty, preview: { q: 3, r: 4, tileId: 7, orientation: 0 } },
      { grid: empty, preview: { q: 3, r: 4, tileId: 8, orientation: 1 } },
      { grid: empty, preview: ghost(false) },
      { grid: empty, preview: null },
    ])).toEqual([]);
  });

  it("plays once at the confirm, in a solo sandbox and in a room whose grid lands in time", () => {
    const solo = [{ grid: empty, preview: ghost(false) }, { grid: laid, preview: ghost(true) }, { grid: laid, preview: null }];
    const room = [{ grid: empty, preview: ghost(false) }, { grid: empty, preview: ghost(true) }, { grid: laid, preview: ghost(true) }, { grid: laid, preview: null }];
    expect(plays(solo)).toEqual(["3,4:#8@2"]);
    expect(plays(room)).toEqual(["3,4:#8@2"]);
  });

  it("does not play a second time when the ghost was dropped before the grid landed the lay", () => {
    const late = [
      { grid: empty, preview: ghost(false) },
      { grid: empty, preview: ghost(true) }, // confirmed: the flourish plays
      { grid: empty, preview: null }, // the clock, a click, or a new preview drops the ghost
      { grid: laid, preview: null }, // the lay lands late
    ];
    expect(plays(late, false)).toEqual(["3,4:#8@2", "3,4:#8@2"]); // the duplicate this note removes
    expect(plays(late)).toEqual(["3,4:#8@2"]);
  });

  it("forgets the wait once the board moves on, and plays a new send as usual", () => {
    const refusedThenElsewhere = [
      { grid: empty, preview: null },
      { grid: empty, preview: ghost(true) },
      { grid: empty, preview: null }, // refused: the ghost is dropped and the lay never lands
      { grid: grid([5, 5, 9, 0]), preview: null }, // another lay, elsewhere
      { grid: grid([5, 5, 9, 0], [3, 4, 8, 2]), preview: null }, // the same tile laid here later, by anyone
    ];
    expect(plays(refusedThenElsewhere)).toEqual(["3,4:#8@2", "5,5:#9@0", "3,4:#8@2"]);
    const resent = [
      { grid: empty, preview: null },
      { grid: empty, preview: ghost(true) },
      { grid: empty, preview: null },
      { grid: empty, preview: ghost(true) }, // sent again: a new confirmed lay
      { grid: laid, preview: ghost(true) },
      { grid: laid, preview: null },
    ];
    expect(plays(resent)).toEqual(["3,4:#8@2", "3,4:#8@2"]);
  });
});

describe("tokens are the pass's own answer, seated (#1466, #1472)", () => {
  it("resolves a token's place in exactly one function, asked by the pass, of the tile under a proposal, and by a starting transition", () => {
    // The board component and its helpers -- the picker's thumbnail below it is a separate surface (#698).
    const board = RENDERER.slice(0, anchorIndex(RENDERER, "export interface TilePreviewThumbnailProps"));
    expect(count(board, "function stationTokenMark(")).toBe(1);
    expect(count(board, "stationTokenMark({")).toBe(3);
    // The slot lookup lives inside that one function and nowhere else on the board.
    expect(count(board, "tileCitySlotPoints(")).toBe(1);
    const mark = sliceBetween(RENDERER, "function stationTokenMark(", "function homeReservationPoints(");
    expect(mark).toContain("tileCitySlotPoints(");
  });

  it("moves a token only when it stood on the hex before the change, and never invents one", () => {
    const pass = sliceBetween(RENDERER, "const mark = stationTokenMark({ company, q, r, hexSize, laidTile, previewCity, occupantsByCity });", "withHexClip(ctx, tokenCenter, hexSize");
    expect(pass).toContain("tokensFrom.get(company.company_id)");
    expect(pass).toContain("if (stagedToken && stoodAt) {");
    expect(pass).not.toContain("drawStationTokenMarker");
  });

  it("seats a token by the city indices authoritative state gave it, on the tile before and on the tile now (#1472)", () => {
    const begin = sliceBetween(RENDERER, "function beginTileTransition(input: {", "export function HexGridRenderer(");
    expect(begin).toContain("city: mark.city,");
    const pass = sliceBetween(RENDERER, "const mark = stationTokenMark({ company, q, r, hexSize, laidTile, previewCity, occupantsByCity });", "withHexClip(ctx, tokenCenter, hexSize");
    expect(pass).toContain("fromCity: stoodAt.city,");
    expect(pass).toContain("toCity: mark.city,");
    // No second opinion about who is who: nothing on the board pairs tokens with slots by distance.
    expect(DESCRIPTION).not.toMatch(/tokensFrom|company_id|station_tokens/);
  });

  it("draws each token once per hex as a piece, in the pass's fixed order, with at most one planned place under it (#1472, #1473)", () => {
    const tokenPass = sliceBetween(RENDERER, "const occupantsByCity = occupantsByCityFor(publicCompanies);", "for (const landmark of LANDMARK_HEXES) {");
    expect(tokenPass).toContain("for (const company of publicCompanies) {");
    expect(tokenPass).toContain("for (const [q, r] of company.station_token_hexes) {");
    // One piece per company per hex, pushed only while it is drawn as a piece, and at most one planned place: never a
    // second real token, and never a copy at the destination that is not the faint planned place.
    expect(count(tokenPass, "drawStationTokenMarker(")).toBe(2);
    expect(count(tokenPass, "tokenMarkers.push(")).toBe(1);
    expect(count(tokenPass, "plannedPlaces.push(")).toBe(1);
    expect(tokenPass.indexOf("if (physical) {")).toBeLessThan(tokenPass.indexOf("tokenMarkers.push("));
    // One seat per frame; the other asks are only whether the ride moves the token at all.
    expect(count(tokenPass, "tokenPositionAt(plan, stagedToken.t, ride)")).toBe(1);
    // Two tokens overlapping at a gather are drawn in the roster's order, not re-sorted by where they stand.
    expect(tokenPass).not.toContain(".sort(");
    // The one opacity in the pass is a planned place's: a piece is never see-through.
    expect(count(tokenPass, "globalAlpha")).toBe(1);
    expect(tokenPass).toContain("ctx.globalAlpha = PROVISIONAL.pieceAlpha * plannedPresence;");
  });
});

describe("a piece the lay moves rides in, and a token's planned place waits for it (#1473)", () => {
  const pass = sliceBetween(RENDERER, "const drawStationTokenPass = () =>", "for (const landmark of LANDMARK_HEXES) {");

  it("draws every planned place first, then the reservation markers, then the tokens", () => {
    const planned = pass.indexOf("plannedPlaces.forEach((draw) => draw());");
    const reserved = pass.indexOf("reservationMarkers.forEach((draw) => draw());");
    const tokens = pass.indexOf("tokenMarkers.forEach((draw) => draw());");
    expect(planned).toBeGreaterThan(-1);
    expect(planned).toBeLessThan(reserved);
    expect(reserved).toBeLessThan(tokens);
    // Every reservation and token marker waits for its layer: nothing is drawn straight onto the canvas in between.
    expect(count(pass, "reservationMarkers.push(")).toBe(1);
    expect(count(pass, "tokenMarkers.push(")).toBe(1);
  });

  it("while a tile is being chosen, draws a token the confirm will move only at its planned place", () => {
    /* NAMED APART FROM THE `proposing` SLICE ABOVE, which is a slice of RENDERER while this is a slice of
       `pass`. Both were called `proposing`, and `sourceScanSweep` reported five phantom missing anchors
       for this case because it cannot follow a slice-of-a-slice and bound these to the other declaration
       instead. The suite passed throughout -- a `toContain` against the wrong region would have failed --
       so this is a naming fault that only the sweep could see, which is the sweep earning its keep. */
    const proposalToken = sliceBetween(pass, "} else if (proposalPlan?.plan && proposingAt(q, r)) {", "if (plannedPresence > 0) {");
    // Where the token stands now, asked exactly as a starting transition asks it: of the tile under the proposal.
    expect(proposalToken).toContain("laidTile: laidUnderPreview,");
    expect(proposalToken).toContain("previewCity: undefined,");
    // Of the very ride a confirm plays, so the token that is only planned here is the token that rides in.
    expect(proposalToken).toContain("tokenPositionAt(plan, t, ride)");
    expect(proposalToken).toContain("plannedPresence = 1;");
    expect(proposalToken).toContain("physical = false;");
  });

  it("from the confirm, keeps a moving token's planned place under the real token until the commit settles it there", () => {
    const staged = sliceBetween(pass, "if (stagedToken && stoodAt) {", "} else if (proposalPlan?.plan && proposingAt(q, r)) {");
    expect(staged).toContain("plannedPresence = pieceTargetPresence(plan, stagedToken.t);");
    // Design note #1474: and only there. The description answers none for a lay nobody proposed here, so another seat's
    // token rides in with nothing waiting for it; the renderer holds no second opinion about which lays those are.
    expect(DESCRIPTION).toContain("if (plan.reducedMotion || !plan.provisional) return 0;");
    expect(count(pass, "pieceTargetPresence(")).toBe(1);
    expect(staged).not.toContain("physical = false;");
    // At exactly the place the token lands: the authority's, never the ride's.
    const planned = sliceBetween(pass, "if (plannedPresence > 0) {", "if (physical) {");
    expect(planned).toContain("mark.point,");
    expect(planned).toContain("mark.radius,");
    expect(planned).not.toContain("resolved");
  });

  it("gives a reservation marker no planned place: a moving one leaves the proposal and rides in from the confirm", () => {
    const reservations = sliceBetween(pass, "const settledPoints = homeReservationPoints(home, homeLaidTile, hexSize);", "reservationMarkers.push(");
    expect(reservations).toContain("reservationPositionAt(plan, stagedHome.t,");
    expect(reservations).toContain("homeReservationPoints(home, laidUnderPreview, hexSize)");
    expect(reservations).toContain("points = settledPoints.filter((point) => !leaving.includes(point));");
    // Only a marker the lay moves leaves the proposal; one it does not move keeps its place.
    expect(reservations).toContain("if (moves && !leaving.includes(place)) leaving.push(place);");
    expect(reservations).not.toContain("plannedPlaces");
    expect(reservations).not.toContain("globalAlpha");
  });

  it("plans the proposal's transition as its confirm would, once per proposal", () => {
    const planning = sliceBetween(RENDERER, "const proposalPlan = (() => {", "const sampleStaged = ");
    expect(planning).toContain("drawnPreview.committed === true");
    expect(planning).toContain("isAnimatableChange(from, to)");
    expect(planning).toContain("const reducedMotion = prefersReducedMotion();");
    expect(planning).toContain("provisional: true,");
    expect(planning).toContain("if (proposalPlanRef.current?.key !== key) {");
  });
});

describe("a transition sounds its own beats, through the one shared helper (#1474)", () => {
  const clock = sliceBetween(RENDERER, "const transitions = tileTransitionsRef.current;\n    if (transitions.size === 0) return undefined;", "}, [tileTransitionEpoch]);");
  const AUDIO = readStripped("utils/audio.ts");
  const CONTROLS = readStripped("components/AudioControls.tsx");

  it("sounds from the frame clock and nowhere else: not the draw, not the proposal, not a starting transition", () => {
    expect(clock).toContain("const reached = cuesReached(transition.cues, transition.cuesDealt, elapsed);");
    expect(clock).toContain("playVariantCue(TILE_TRANSITION_SFX[cue], currentSfxEnabled())");
    expect(count(RENDERER, "playVariantCue(")).toBe(1);
    expect(count(RENDERER, "cuesReached(")).toBe(1);
    // AMENDED: re-anchored past the dependency array -- see the note on the same slice above.
    const draw = sliceBetween(RENDERER, "const draw = useCallback(() => {", "useEffect(() => {\n    draw();");
    expect(draw).toContain("for (const tile of presentedGrid.tiles) {");
    const detection = sliceBetween(RENDERER, "useLayoutEffect(() => {", "}, [mapGrid, previewTile, publicCompanies, boardId, hexSize]);");
    for (const elsewhere of [draw, detection]) {
      expect(elsewhere).not.toContain("playVariantCue");
      expect(elsewhere).not.toContain("cuesReached");
      expect(elsewhere).not.toContain("cuesDealt");
    }
  });

  it("keeps each transition's count on the transition, from its own plan, starting at none, and moved only by the clock", () => {
    const begin = sliceBetween(RENDERER, "function beginTileTransition(input: {", "export function HexGridRenderer(");
    expect(begin).toContain("cues: tileTransitionCues(plan),");
    expect(begin).toContain("cuesDealt: 0,");
    expect(count(RENDERER, "tileTransitionCues(")).toBe(1);
    expect(count(RENDERER, "cuesDealt =")).toBe(1);
    expect(clock).toContain("transition.cuesDealt = reached.dealt;");
    // It iterates the running transitions and nothing else, so a superseded or cleared one is never asked again.
    expect(clock).toContain("transitions.forEach((transition, key) => {");
  });

  it("sounds a reached cue only while the draw shows its transition, and passes over one it does not", () => {
    // Before the end that removes it, and not under a proposal on its hex -- the two things `transitionAt` refuses.
    expect(clock).toContain("const over = elapsed >= transition.plan.durationMs;");
    expect(clock).toContain("const proposal = presentedInputsRef.current?.previewTile ?? null;");
    const placeholder = (name: string) => ["$", "{", name, "}"].join("");
    expect(clock).toContain(
      `const hidden = proposal !== null && proposal.committed !== true && key === \`${placeholder("proposal.q")},${placeholder("proposal.r")}\`;`,
    );
    expect(clock).toContain("if (!over && !hidden) {");
    expect(clock).toContain("if (over) transitions.delete(key);");
    // The count moves either way, so a cue passed over is never played late.
    expect(clock.indexOf("transition.cuesDealt = reached.dealt;")).toBeLessThan(clock.indexOf("if (!over && !hidden) {"));
    const lookup = sliceBetween(RENDERER, "const transitionAt = (q: number, r: number)", "const laidAtPreview");
    expect(lookup).toContain("if (proposingAt(q, r)) return null;");
    expect(lookup).toContain("if (t >= 1) return null;");
  });

  it("plays through the helper every cue uses, under the master switch, with no player, seek or rate of its own", () => {
    expect(RENDERER).toContain('import { currentSfxEnabled, playVariantCue, preloadCues } from "../utils/audio";');
    for (const source of [RENDERER, DESCRIPTION, PAINTER]) {
      expect(source).not.toContain("new Audio");
      expect(source).not.toContain("AudioContext");
      expect(source).not.toContain(".play(");
      expect(source).not.toContain("currentTime");
      expect(source).not.toContain("playbackRate");
    }
    // The switch the shell's one control flips, mirrored where the board reads it at the moment a cue is due.
    expect(AUDIO).toContain("export function currentSfxEnabled(): boolean {");
    expect(AUDIO).toContain("export function mirrorSfxEnabled(enabled: boolean): void {");
    expect(CONTROLS).toContain("mirrorSfxEnabled(audio.sfxEnabled);");
    expect(CONTROLS).toContain("}, [audio.sfxEnabled]);");
    // The helper itself is unchanged: the mute is still its first question.
    expect(AUDIO).toContain("export function playVariantCue(file: string, enabled: boolean, options: CueOptions = {}): void {\n  if (!enabled) return;");
  });

  it("warms its clips once, with the board", () => {
    expect(RENDERER).toContain("useEffect(() => {\n    void preloadCues(Object.values(TILE_TRANSITION_SFX));\n  }, []);");
    expect(count(RENDERER, "preloadCues(")).toBe(1);
  });

  it("times its cues by the plan's beats alone: no figure of its own, no timer, and no tile", () => {
    const cues = sliceBetween(DESCRIPTION, "export function tileTransitionCues(", "export function cuesReached(");
    const reached = sliceBetween(DESCRIPTION, "export function cuesReached(", "function planConstruction(");
    for (const source of [cues, reached, clock]) {
      expect(source).not.toMatch(/\b(128|200|240|368|388|416|439|812|1052|1088|1328)\b/);
      expect(source).not.toContain("setTimeout");
      expect(source).not.toMatch(/tile_?[iI]d/);
    }
    /* Three independent triggers and no recipe: each cue asks its own question of the plan. The railroad-work cue
       asks one beat and nothing else -- whether the transition does track work at all, and when it starts, is the
       plan's answer, not the audio's (#1475). */
    expect(cues).toContain('if (railroadWorkStart !== null) cues.push({ cue: "track", at: railroadWorkStart });');
    expect(cues).toContain('if (plan.components.stationMutation && stationEmergence !== null) cues.push({ cue: "mutation", at: stationEmergence });');
    expect(cues).toContain('cues.push({ cue: "upgrade", at: revealStart });');
    expect(cues).not.toContain("else");
    // One cue for the whole of a transition's track work: the clip is never pushed twice, and never re-timed.
    expect(count(cues, 'cue: "track"')).toBe(1);
  });

  it("names three clips that are in public/audio, and wires no other", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const { TILE_TRANSITION_SFX } = require("./tileTransition") as typeof import("./tileTransition");
    expect(Object.values(TILE_TRANSITION_SFX).sort()).toEqual(["mutation.mp3", "track.mp3", "upgrade.mp3"]);
    for (const file of Object.values(TILE_TRANSITION_SFX)) {
      expect(fs.existsSync(path.join(__dirname, "..", "..", "public", "audio", file))).toBe(true);
    }
    /* The confirm's green check and the selector's red X keep the feedback they have: no accepted / rejected clip is
       wired anywhere in the app (#1475 -- left for a later general UI-audio pass). */
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(at) : /\.(ts|tsx)$/.test(entry.name) ? [at] : [];
      });
    const sources = walk(path.join(__dirname, ".."));
    expect(sources.length).toBeGreaterThan(100);
    for (const file of sources) {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/(accepted|rejected)\.mp3/);
    }
  });
});
