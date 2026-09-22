// frontend/src/components/badgeHitPresentation.test.ts
//
// ==================================================================
//  VF-2 FINALIZE PASS: SCALE-ONLY MECHANICAL POP -- PRESENTATION CONTRACT
// ==================================================================
//
// The pure timing math (`badgePopScale` and friends) has its own numeric coverage in
// routeSignalGeometry.test.ts. What is left to pin down here is the DRAWING/ORDERING contract that math
// can't check on its own: that the pop scales the badge about its own centre rather than a corner, that the
// badge's fill/border/text never take a colour input again, that a resting badge keeps the board's existing
// draw order untouched, that an actively-reacting badge is the one and only thing elevated above station
// tokens, and that reduced motion still suppresses the pop entirely (never falls back to the retired colour
// flush). Source-scan style (design note #490a / `sourceScan.ts`): every assertion below is an ABSENCE or a
// PRESENCE check against comment-stripped source, so a design note quoting a string cannot satisfy it in
// place of the implementation actually doing so.

import { readStripped, sliceBetween } from "../utils/sourceScan";

const PRIMS = readStripped("components/hexCanvasPrimitives.ts");
const GEOMETRY = readStripped("components/routeSignalGeometry.ts");
const LIVERY = readStripped("styles/routeLivery.ts");
const GRID = readStripped("components/HexGridRenderer.tsx");

describe("the badge-hit reaction carries no colour at all any more (VF-2 finalize)", () => {
  test("BadgeHitVisual is scale-only", () => {
    const body = sliceBetween(PRIMS, "export interface BadgeHitVisual {", "}");
    expect(body).toContain("scale: number");
    expect(body).not.toContain("color");
    expect(body).not.toContain("whiteMix");
  });

  test("drawBadgeShape fills plain white unconditionally -- no hit-driven tint branch survives", () => {
    const body = sliceBetween(PRIMS, "export function drawBadgeShape(", "\n}");
    expect(body).toContain('ctx.fillStyle = "#FFFFFF"');
    expect(body).not.toContain("brightenTowardWhite");
    expect(body).not.toContain("hit");
  });

  test("drawValueBadgeAt's text is always plain black, never hit-derived", () => {
    const body = sliceBetween(PRIMS, "export function drawValueBadgeAt(", "\n}");
    expect(body).toContain('ctx.fillStyle = "#000000"');
  });

  test("the retired tint constants are gone from routeLivery.ts", () => {
    expect(LIVERY).not.toContain("BADGE_HIT_MAX_TINT_SOLO");
    expect(LIVERY).not.toContain("BADGE_HIT_MAX_TINT_COINCIDENCE");
    expect(LIVERY).not.toContain("BADGE_HIT_NEUTRAL_COLOR");
  });

  test("ROUTE_TRAIN_COLORS itself is untouched -- the route highlight is still the only colour carrier", () => {
    expect(LIVERY).toContain("export const ROUTE_TRAIN_COLORS: readonly string[] = [");
    expect(LIVERY).toContain('"#38bdf8", // azure');
    expect(LIVERY).toContain('"#a78bfa", // violet');
  });

  test("BadgeHitCandidate and BadgeHitReaction carry no colour field", () => {
    const candidate = sliceBetween(GEOMETRY, "export interface BadgeHitCandidate {", "}");
    expect(candidate).not.toContain("color");
    const reaction = sliceBetween(GEOMETRY, "export interface BadgeHitReaction {", "}");
    expect(reaction).not.toContain("color");
  });

  test("selectBadgeHitReaction's own return values carry no colour", () => {
    const body = sliceBetween(GEOMETRY, "export function selectBadgeHitReaction(", "\n}");
    expect(body).not.toContain("color");
  });
});

describe("the pop scales the whole printed badge about its own centre (item 6)", () => {
  test("drawValueBadgeAt's transform is translate(center) -> scale -> translate(-center), wrapping both the shape and the text", () => {
    const body = sliceBetween(PRIMS, "export function drawValueBadgeAt(", "\n}");
    const translateIn = body.indexOf("ctx.translate(badgeCenter.x, badgeCenter.y);");
    const scaleAt = body.indexOf("ctx.scale(scale, scale);");
    const translateOut = body.indexOf("ctx.translate(-badgeCenter.x, -badgeCenter.y);");
    const shapeAt = body.indexOf("drawBadgeShape(ctx, badgeCenter, badgeRadius, shape)");
    const textAt = body.indexOf("ctx.fillText(label, badgeCenter.x, badgeCenter.y);");
    for (const at of [translateIn, scaleAt, translateOut, shapeAt, textAt]) {
      expect(at).toBeGreaterThan(-1);
    }
    // Order matters: pivot to the centre, scale, pivot back, THEN draw shape and text -- both inside the
    // transform, so fill/border/text scale together as one object and the value stays exactly centred.
    expect(translateIn).toBeLessThan(scaleAt);
    expect(scaleAt).toBeLessThan(translateOut);
    expect(translateOut).toBeLessThan(shapeAt);
    expect(shapeAt).toBeLessThan(textAt);
  });

  test("drawBadgeShape itself takes no scale/hit parameter -- the transform is the caller's job, applied once around everything", () => {
    const signature = PRIMS.slice(
      PRIMS.indexOf("export function drawBadgeShape("),
      PRIMS.indexOf("): void {", PRIMS.indexOf("export function drawBadgeShape(")),
    );
    expect(signature).not.toContain("hit");
    expect(signature).not.toContain("scale");
  });

  test("an undefined hit (or scale 1) skips the transform entirely -- a resting badge is pixel-equivalent to always having no reaction", () => {
    const body = sliceBetween(PRIMS, "export function drawValueBadgeAt(", "\n}");
    expect(body).toContain("const scale = hit?.scale ?? 1;");
    expect(body).toContain("const scaling = scale !== 1;");
    expect(body).toContain("if (scaling) {");
    expect(body).toContain("if (scaling) ctx.restore();");
  });
});

describe("draw order (item 5): only an ACTIVELY REACTING badge is elevated above station tokens", () => {
  test("badgeHitVisualForHex still returns undefined immediately under reduced motion -- never a fallback pop, never the retired flush", () => {
    const body = sliceBetween(
      GRID,
      "const badgeHitVisualForHex = (q: number, r: number): BadgeHitVisual | undefined => {",
      "\n    };",
    );
    const reducedMotionAt = body.indexOf("if (routeSignalReducedMotion) return undefined;");
    const candidatesAt = body.indexOf("const candidates: BadgeHitCandidate[] = [];");
    expect(reducedMotionAt).toBeGreaterThan(-1);
    expect(candidatesAt).toBeGreaterThan(-1);
    // The reduced-motion check is the FIRST thing the function does, before any candidate/reaction work.
    expect(reducedMotionAt).toBeLessThan(candidatesAt);
  });

  test("badgeHitVisualForHex returns undefined once badgePopScale has settled back to 1, not just once selectBadgeHitReaction expires", () => {
    const body = sliceBetween(
      GRID,
      "const badgeHitVisualForHex = (q: number, r: number): BadgeHitVisual | undefined => {",
      "\n    };",
    );
    expect(body).toContain("const scale = badgePopScale(reaction);");
    expect(body).toContain("return scale !== 1 ? { scale } : undefined;");
  });

  test("a resting badge (no hit) is drawn immediately by paintBadge -- the existing draw order is untouched for it", () => {
    const body = sliceBetween(GRID, "const paintBadge = (hit: BadgeHitVisual | undefined, draw: () => void): void => {", "\n    };");
    expect(body).toContain("if (hit) activeBadgeRedraws.push(draw);");
    expect(body).toContain("else draw();");
  });

  test("activeBadgeRedraws is declared, and flushed exactly once, AFTER drawStationTokenPass() -- never before it", () => {
    expect(GRID).toContain("const activeBadgeRedraws: Array<() => void> = [];");
    const tokenPassAt = GRID.indexOf("drawStationTokenPass();");
    const flushAt = GRID.indexOf("activeBadgeRedraws.forEach((draw) => draw());");
    expect(tokenPassAt).toBeGreaterThan(-1);
    expect(flushAt).toBeGreaterThan(-1);
    expect(tokenPassAt).toBeLessThan(flushAt);
    // Exactly one flush call site -- a second one would risk drawing an elevated badge twice.
    expect(GRID.split("activeBadgeRedraws.forEach((draw) => draw());")).toHaveLength(2);
  });

  test("every drawValueBadge/drawValueBadgeAt call site in the main render pass goes through paintBadge, not a bare call", () => {
    // Every remaining bare call is inside paintBadge's own `draw` closures (the ones just verified above) or
    // inside `drawStationTokenPass`'s herald branch, which is also wrapped in `paintBadge` now (verified via
    // the `heraldHit`/`paintBadge` pairing below) -- so a plain `badgeHitVisualForHex(...)` argument threaded
    // straight into a draw call would mean a spot this pass missed.
    expect(GRID).not.toMatch(/drawValueBadge(?:At)?\([^)]*badgeHitVisualForHex\(/s);
  });

  test("the herald's own badge (drawn inside drawStationTokenPass) is paintBadge-gated too", () => {
    expect(GRID).toContain("const heraldHit = badgeHitVisualForHex(home.q, home.r);");
    expect(GRID).toContain("paintBadge(heraldHit, () =>");
  });
});

describe("VF-2 finalize pass did not touch route geometry, route signal timing, or ROUTE_TRAIN_COLORS", () => {
  test("route signal speed/pulse-duration constants are present and untouched by value", () => {
    expect(GRID).toContain("const ROUTE_SIGNAL_SPEED_UNITS_PER_SEC = 3.2;");
    expect(GRID).toContain("const ROUTE_SIGNAL_PULSE_DURATION_SEC = 0.35;");
  });

  test("the 120ms coincidence window constant is untouched", () => {
    expect(GEOMETRY).toContain("export const BADGE_HIT_COINCIDENCE_WINDOW_MS = 120;");
  });

  test("badgePopScale never calls anything route-geometry-related -- pure arithmetic on kind/sinceMs only", () => {
    const body = sliceBetween(GEOMETRY, "export function badgePopScale(", "\n}");
    expect(body).not.toContain("pointOnRouteTrack");
    expect(body).not.toContain("buildRouteSignalTrack");
  });
});
