// frontend/src/components/routeSignalGeometry.test.ts
//
// Targeted unit + smoke coverage for the Train Route Pulse / Revenue Badge Animation geometry module.
// Per the task's explicit instruction, this file is run directly by file path -- it is NOT part of, and
// this change does NOT trigger, a full-suite run.

import {
  BADGE_HIT_COINCIDENCE_WINDOW_MS,
  BADGE_POP_ATTACK_MS,
  BADGE_POP_OVERSHOOT_MS,
  BADGE_POP_PEAK_COINCIDENCE,
  BADGE_POP_PEAK_SOLO,
  BADGE_POP_SETTLE_MS,
  BADGE_POP_UNDERSHOOT_COINCIDENCE,
  BADGE_POP_UNDERSHOOT_SOLO,
  badgePopScale,
  buildRouteSignalTrack,
  matchRevenueStopsToPath,
  mostRecentArrivalMs,
  pointOnRouteTrack,
  selectBadgeHitReaction,
  type BadgeHitCandidate,
  type BadgeHitReaction,
  type RouteSignalSegment,
} from "./routeSignalGeometry";

// Fixed, easy-to-reason-about clock for every test below: 10 units/sec, so 1 unit of distance == 100ms of
// real time. `PULSE_MS` mirrors the production pulse duration in these units-per-second terms without
// importing HexGridRenderer's own module-private constant.
const SPEED = 10;
const PULSE_MS = 350; // matches ROUTE_SIGNAL_PULSE_DURATION_SEC (0.35s) at this test's own SPEED.

/** Builds one candidate whose most recent arrival was `sinceMs` ago, on a route with the given loop length,
 *  by placing `distanceNow` exactly `sinceMs` worth of distance past `atDistance` (with no extra loops) --
 *  the simplest arrangement `mostRecentArrivalMs` can resolve back to `sinceMs`. VF-2 finalize pass: no
 *  `color` field any more -- the coincidence-window/arrival-timing math it exercises never depended on it,
 *  and the badge's own presentation (`badgePopScale`) takes no colour input at all. */
function candidateSince(sinceMs: number, totalLength = 1000): BadgeHitCandidate {
  const atDistance = 0;
  const distanceNow = atDistance + (sinceMs / 1000) * SPEED;
  return { totalLength, distanceNow, atDistance };
}

describe("mostRecentArrivalMs", () => {
  test("returns the real-time elapsed since the candidate's own arrival", () => {
    const candidate: BadgeHitCandidate = { totalLength: 20, distanceNow: 10, atDistance: 8 };
    // sinceUnits = ((10-8) % 20 + 20) % 20 = 2; at 4 units/sec that is 0.5s = 500ms.
    expect(mostRecentArrivalMs(candidate, 4)).toBeCloseTo(500, 6);
  });

  test("loop wrap-around: an arrival just before the loop boundary and 'now' just after it still resolves to the small real elapsed time, not almost a full lap", () => {
    // distanceNow has wrapped past 0 to 1; the marker sits at 19 on a loop of length 20 -- i.e. the signal
    // passed it 2 units ago, not 18 units (one lap minus 2) ago.
    const candidate: BadgeHitCandidate = { totalLength: 20, distanceNow: 1, atDistance: 19 };
    expect(mostRecentArrivalMs(candidate, 4)).toBeCloseTo(500, 6); // same 2 units / 4 units-per-sec as above
  });

  test("degenerate routes (no length, or non-positive speed) resolve to null rather than NaN/Infinity", () => {
    expect(mostRecentArrivalMs({ totalLength: 0, distanceNow: 5, atDistance: 1 }, 4)).toBeNull();
    expect(mostRecentArrivalMs({ totalLength: 20, distanceNow: 5, atDistance: 1 }, 0)).toBeNull();
  });
});

/** `selectBadgeHitReaction`'s `sinceMs` is a real elapsed-time computation (division/modulo on floats), so
 *  asserting it with `toEqual` against a clean integer is fragile by a fraction of a nanosecond -- these
 *  helpers check `kind` exactly and `sinceMs` with float tolerance, which is what actually matters (the
 *  scale-curve math downstream only ever needs millisecond-scale precision). VF-2 finalize pass: no `color`
 *  to assert any more -- `BadgeHitReaction` carries only `kind`/`sinceMs`. */
function expectSolo(reaction: ReturnType<typeof selectBadgeHitReaction>, sinceMs: number): void {
  expect(reaction?.kind).toBe("solo");
  expect(reaction?.sinceMs).toBeCloseTo(sinceMs, 6);
}

function expectCoincidence(reaction: ReturnType<typeof selectBadgeHitReaction>, sinceMs: number): void {
  expect(reaction?.kind).toBe("coincidence");
  expect(reaction?.sinceMs).toBeCloseTo(sinceMs, 6);
}

describe("selectBadgeHitReaction", () => {
  test("no candidates: nothing to show", () => {
    expect(selectBadgeHitReaction([], SPEED, PULSE_MS)).toBeNull();
  });

  test("a single candidate still within the pulse window produces a solo reaction", () => {
    const reaction = selectBadgeHitReaction([candidateSince(50)], SPEED, PULSE_MS);
    expectSolo(reaction, 50);
  });

  test("a single candidate whose arrival has already fully decayed produces nothing -- it does not stay popped until the next loop", () => {
    expect(selectBadgeHitReaction([candidateSince(PULSE_MS)], SPEED, PULSE_MS)).toBeNull();
    expect(selectBadgeHitReaction([candidateSince(PULSE_MS + 500)], SPEED, PULSE_MS)).toBeNull();
  });

  test("two hits well OUTSIDE the coincidence window are each their own solo reaction, read at their own moment", () => {
    // At the moment route A's signal has just arrived (50ms ago) and route B arrived long before that (already
    // faded past PULSE_MS), only A's own arrival drives it.
    const atA = selectBadgeHitReaction([candidateSince(50), candidateSince(PULSE_MS + 400)], SPEED, PULSE_MS);
    expectSolo(atA, 50);

    // Later, once A has also faded and B has just arrived, B's own arrival drives it alone -- two independent
    // reactions over time, never a blend, never a lingering trace of the other route.
    const atB = selectBadgeHitReaction([candidateSince(PULSE_MS + 400), candidateSince(50)], SPEED, PULSE_MS);
    expectSolo(atB, 50);
  });

  test("two hits INSIDE the coincidence window collapse into one, stronger reaction", () => {
    const reaction = selectBadgeHitReaction(
      [candidateSince(40), candidateSince(40 + BADGE_HIT_COINCIDENCE_WINDOW_MS - 1)],
      SPEED,
      PULSE_MS,
    );
    expectCoincidence(reaction, 40);
  });

  test("clearly inside vs clearly outside the coincidence window (a margin away from the exact edge, which floating-point real-time arithmetic cannot be expected to land on to the millisecond)", () => {
    const inside = selectBadgeHitReaction(
      [candidateSince(40), candidateSince(40 + BADGE_HIT_COINCIDENCE_WINDOW_MS - 10)],
      SPEED,
      PULSE_MS,
    );
    expectCoincidence(inside, 40);

    const outside = selectBadgeHitReaction(
      [candidateSince(40), candidateSince(40 + BADGE_HIT_COINCIDENCE_WINDOW_MS + 10)],
      SPEED,
      PULSE_MS,
    );
    expectSolo(outside, 40);
  });

  test("repeated SAME-route events are judged purely on arrival timing, never on train identity: two candidates inside the window still collapse to a coincidence", () => {
    const reaction = selectBadgeHitReaction([candidateSince(10), candidateSince(10 + 30)], SPEED, PULSE_MS);
    expect(reaction?.kind).toBe("coincidence");
  });

  test("repeated same-route events far enough apart each still get their own solo pop", () => {
    const reaction = selectBadgeHitReaction([candidateSince(30), candidateSince(PULSE_MS + 400)], SPEED, PULSE_MS);
    expectSolo(reaction, 30);
  });

  test("loop-boundary coincidence: two different routes with different loop lengths, one just past its own wrap and one mid-loop, still coincide when their REAL elapsed arrival times are close", () => {
    // Route A: loop length 30, just wrapped (distanceNow a hair past 0, marker at the far end of the loop).
    const routeA: BadgeHitCandidate = { totalLength: 30, distanceNow: 0.5, atDistance: 29.7 };
    // Route B: loop length 91 (unrelated period), comfortably mid-loop, arrived a moment ago.
    const routeB: BadgeHitCandidate = { totalLength: 91, distanceNow: 50.4, atDistance: 50 };
    // A's sinceUnits = ((0.5 - 29.7) % 30 + 30) % 30 = 0.8 -> 80ms at SPEED=10. B's sinceUnits = 0.4 -> 40ms.
    // 40ms apart, well inside the coincidence window, despite the two routes' loop periods sharing nothing.
    const reaction = selectBadgeHitReaction([routeA, routeB], SPEED, PULSE_MS);
    expect(reaction?.kind).toBe("coincidence");
  });

  test("BADGE_HIT_COINCIDENCE_WINDOW_MS is a concrete, named constant in the requested 100-150ms range", () => {
    expect(BADGE_HIT_COINCIDENCE_WINDOW_MS).toBeGreaterThanOrEqual(100);
    expect(BADGE_HIT_COINCIDENCE_WINDOW_MS).toBeLessThanOrEqual(150);
  });
});

/** VF-2 finalize pass: the scale-only mechanical pop's timing curve. Every value asserted here mirrors the
 *  approved visual-prototype comparison's own constants exactly (see VISUAL_FLOURISH_BACKLOG.md) -- this
 *  suite pins the curve's SHAPE (attack -> overshoot -> settle -> rest), not just its two named checkpoints,
 *  so a regression to a different easing or a dropped phase fails here. */
describe("badgePopScale", () => {
  test("no reaction (null) is always the resting badge, scale 1", () => {
    expect(badgePopScale(null)).toBe(1);
  });

  test("a reaction that has not started yet (negative sinceMs) is still at rest", () => {
    const reaction: BadgeHitReaction = { kind: "solo", sinceMs: -5 };
    expect(badgePopScale(reaction)).toBe(1);
  });

  describe("solo hit", () => {
    const solo = (sinceMs: number): BadgeHitReaction => ({ kind: "solo", sinceMs });

    test("reaches exactly the solo peak scale at the attack checkpoint (60ms)", () => {
      expect(badgePopScale(solo(BADGE_POP_ATTACK_MS))).toBeCloseTo(BADGE_POP_PEAK_SOLO, 9);
    });

    test("reaches exactly the solo undershoot at the overshoot checkpoint (130ms)", () => {
      expect(badgePopScale(solo(BADGE_POP_OVERSHOOT_MS))).toBeCloseTo(BADGE_POP_UNDERSHOOT_SOLO, 9);
    });

    test("is back to exactly 1 by the settle checkpoint (260ms), and stays there", () => {
      expect(badgePopScale(solo(BADGE_POP_SETTLE_MS))).toBeCloseTo(1, 9);
      expect(badgePopScale(solo(BADGE_POP_SETTLE_MS + 5000))).toBe(1);
    });

    test("the attack phase is monotonically increasing from rest to peak", () => {
      const rest = badgePopScale(solo(0));
      const mid = badgePopScale(solo(BADGE_POP_ATTACK_MS / 2));
      const peak = badgePopScale(solo(BADGE_POP_ATTACK_MS));
      expect(rest).toBeCloseTo(1, 9);
      expect(mid).toBeGreaterThan(rest);
      expect(peak).toBeGreaterThan(mid);
      expect(peak).toBeCloseTo(BADGE_POP_PEAK_SOLO, 9);
    });

    test("the overshoot phase passes BELOW 1 (a real undershoot, not just a lesser peak)", () => {
      expect(BADGE_POP_UNDERSHOOT_SOLO).toBeLessThan(1);
      const midOvershoot = badgePopScale(solo((BADGE_POP_ATTACK_MS + BADGE_POP_OVERSHOOT_MS) / 2));
      expect(midOvershoot).toBeLessThan(BADGE_POP_PEAK_SOLO);
    });
  });

  describe("coincidence hit", () => {
    const coincidence = (sinceMs: number): BadgeHitReaction => ({ kind: "coincidence", sinceMs });

    test("reaches exactly the coincidence peak scale at the attack checkpoint (60ms)", () => {
      expect(badgePopScale(coincidence(BADGE_POP_ATTACK_MS))).toBeCloseTo(BADGE_POP_PEAK_COINCIDENCE, 9);
    });

    test("reaches exactly the coincidence undershoot at the overshoot checkpoint (130ms)", () => {
      expect(badgePopScale(coincidence(BADGE_POP_OVERSHOOT_MS))).toBeCloseTo(BADGE_POP_UNDERSHOOT_COINCIDENCE, 9);
    });

    test("is back to exactly 1 by the settle checkpoint (260ms), and stays there", () => {
      expect(badgePopScale(coincidence(BADGE_POP_SETTLE_MS))).toBeCloseTo(1, 9);
      expect(badgePopScale(coincidence(BADGE_POP_SETTLE_MS + 5000))).toBe(1);
    });

    test("is a STRONGER pop than solo at every shared checkpoint (rule set item 7, carried over from the retired tint design)", () => {
      expect(BADGE_POP_PEAK_COINCIDENCE).toBeGreaterThan(BADGE_POP_PEAK_SOLO);
      expect(badgePopScale(coincidence(BADGE_POP_ATTACK_MS))).toBeGreaterThan(
        badgePopScale({ kind: "solo", sinceMs: BADGE_POP_ATTACK_MS }),
      );
    });
  });

  test("solo and coincidence share the same three timing checkpoints (only the magnitudes differ)", () => {
    expect(BADGE_POP_ATTACK_MS).toBeLessThan(BADGE_POP_OVERSHOOT_MS);
    expect(BADGE_POP_OVERSHOOT_MS).toBeLessThan(BADGE_POP_SETTLE_MS);
    // Total motion duration falls inside the brief's requested 220-300ms envelope.
    expect(BADGE_POP_SETTLE_MS).toBeGreaterThanOrEqual(220);
    expect(BADGE_POP_SETTLE_MS).toBeLessThanOrEqual(300);
  });
});

describe("matchRevenueStopsToPath", () => {
  // Minimal synthetic segments -- only hexIndex/cumulativeStart/length matter to the matcher.
  // `arrivalOffset` here plays the same role the old `length` parameter did before the 2026-09-20
  // correctness audit (design note 29): these synthetic segments only exercise the sequential-match
  // mechanics, so passing the same value through under its new name preserves every expected atDistance.
  const seg = (hexIndex: number, cumulativeStart: number, arrivalOffset: number): Pick<
    RouteSignalSegment,
    "hexIndex" | "cumulativeStart" | "arrivalOffset"
  > => ({ hexIndex, cumulativeStart, arrivalOffset });

  test("a simple 1:1 match lands at the end of that hex's own segment", () => {
    const events = matchRevenueStopsToPath(["A", "B", "C"], [{ hex: "B", value: 20 }], [seg(1, 5, 3)]);
    expect(events).toEqual([{ hexIndex: 1, atDistance: 8, value: 20 }]);
  });

  test("a hex with no matching stop (pass-through) is skipped without consuming the pointer", () => {
    const events = matchRevenueStopsToPath(
      ["A", "B", "C"],
      [{ hex: "C", value: 40 }],
      [seg(0, 0, 1), seg(1, 1, 1), seg(2, 2, 1)],
    );
    expect(events).toEqual([{ hexIndex: 2, atDistance: 3, value: 40 }]);
  });

  test("the same hex label visited twice produces two increasing-distance events, one per occurrence", () => {
    const events = matchRevenueStopsToPath(
      ["A", "B", "C", "B"],
      [
        { hex: "B", value: 10 },
        { hex: "B", value: 20 },
      ],
      [seg(1, 0, 4), seg(3, 10, 2)],
    );
    expect(events).toEqual([
      { hexIndex: 1, atDistance: 4, value: 10 },
      { hexIndex: 3, atDistance: 12, value: 20 },
    ]);
  });

  test("a matched hex with no segment (e.g. a genuinely disconnected waypoint) consumes the stop but records no event", () => {
    const events = matchRevenueStopsToPath(
      ["A", "B", "C"],
      [
        { hex: "B", value: 20 },
        { hex: "C", value: 30 },
      ],
      [seg(2, 5, 1)], // no segment for hexIndex 1 ("B")
    );
    // "B"'s stop is consumed (pointer advances) but yields no event since hexIndex 1 has no segment;
    // "C"'s stop is then matched normally.
    expect(events).toEqual([{ hexIndex: 2, atDistance: 6, value: 30 }]);
  });

  test("excess stops beyond what the path can match are simply left unmatched", () => {
    const events = matchRevenueStopsToPath(
      ["A", "B"],
      [
        { hex: "B", value: 20 },
        { hex: "Z", value: 99 },
      ],
      [seg(1, 0, 1)],
    );
    expect(events).toEqual([{ hexIndex: 1, atDistance: 1, value: 20 }]);
  });

  test("null hex labels (unresolved waypoints) are skipped entirely", () => {
    const events = matchRevenueStopsToPath([null, "B"], [{ hex: "B", value: 20 }], [seg(1, 0, 1)]);
    expect(events).toEqual([{ hexIndex: 1, atDistance: 1, value: 20 }]);
  });
});

describe("buildRouteSignalTrack + pointOnRouteTrack (real board fixture)", () => {
  // G5(-1,6) -> F6(0,5) -> G7(0,6): F6's own printed track is a single rail whose two authored endpoints
  // sit exactly on the board edges toward G5 and G7 (verified against the live tile-art catalog and
  // STATIC_BOARD_HEXES -- this is the real, unmodified geometry, not a simplification for the test), so this
  // triple is a genuine through-connection, not just three adjacent hexes. F6 itself is the same single-city
  // Gray hex perCityRevenue.test.ts already asserts pays exactly $30.
  const overlay = { hexes: [[-1, 6], [0, 5], [0, 6]] as Array<[number, number]>, variants: undefined };
  const tilesAt = () => undefined; // no laid tiles -- all three hexes are still preprinted
  const printedLabelAt = (q: number, r: number) => (q === 0 && r === 5 ? "F6" : undefined);
  const revenueStops = [{ hex: "F6", value: 30 }];

  test("produces a track with positive length and the one expected revenue event", () => {
    const track = buildRouteSignalTrack(overlay, tilesAt, printedLabelAt, revenueStops);
    expect(track).not.toBeNull();
    expect(track!.totalLength).toBeGreaterThan(0);
    expect(track!.segments.length).toBeGreaterThan(0);
    expect(track!.revenueEvents).toHaveLength(1);
    const event = track!.revenueEvents[0];
    expect(event.hexIndex).toBe(1);
    expect(event.value).toBe(30);
    // Correctness audit, 2026-09-20 (design note 29): F6's printed marker sits at its curve's own apex
    // (unit-hex `{x:0,y:0.5}`), not at either end -- so the arrival distance must land strictly BEFORE the
    // segment's far end (previously it always equalled `track.totalLength`, i.e. the far edge, which is
    // exactly the "generic per-hex position" bug this audit found and fixed) and strictly after its start.
    expect(event.atDistance).toBeGreaterThan(0);
    expect(event.atDistance).toBeLessThan(track!.totalLength);
    // Pinned to the real, measured value (F6's marker capsule first touched walking forward from this
    // segment's own start) so a regression back to "end of segment" -- or any other generic position --
    // fails this test rather than silently passing a loosened bound.
    expect(event.atDistance).toBeCloseTo(0.2738695097485762, 9);
    expect(event.atDistance / track!.totalLength).toBeCloseTo(0.2615056225507533, 9);
  });

  test("pointOnRouteTrack samples finite, non-NaN board points and wraps modulo totalLength", () => {
    const track = buildRouteSignalTrack(overlay, tilesAt, printedLabelAt, revenueStops)!;
    const size = 40;

    const atStart = pointOnRouteTrack(track, 0, size);
    const atHalf = pointOnRouteTrack(track, track.totalLength / 2, size);
    const atEnd = pointOnRouteTrack(track, track.totalLength, size);
    const atWrapped = pointOnRouteTrack(track, track.totalLength * 2.5, size);
    const atNegative = pointOnRouteTrack(track, -track.totalLength * 0.25, size);

    for (const point of [atStart, atHalf, atEnd, atWrapped, atNegative]) {
      expect(point).not.toBeNull();
      expect(Number.isFinite(point!.x)).toBe(true);
      expect(Number.isFinite(point!.y)).toBe(true);
    }

    // distance 0 and distance totalLength are the same point on a looping track (mod totalLength).
    expect(atEnd!.x).toBeCloseTo(atStart!.x, 6);
    expect(atEnd!.y).toBeCloseTo(atStart!.y, 6);

    // 2.5 lengths wraps to the same point as 0.5 lengths.
    expect(atWrapped!.x).toBeCloseTo(atHalf!.x, 6);
    expect(atWrapped!.y).toBeCloseTo(atHalf!.y, 6);

    // A negative distance wraps forward rather than producing NaN/negative-indexing artifacts.
    const atPositiveEquivalent = pointOnRouteTrack(track, track.totalLength * 0.75, size);
    expect(atNegative!.x).toBeCloseTo(atPositiveEquivalent!.x, 6);
    expect(atNegative!.y).toBeCloseTo(atPositiveEquivalent!.y, 6);
  });

  test("fewer than two hexes yields no track", () => {
    expect(buildRouteSignalTrack({ hexes: [[0, 5]], variants: undefined }, tilesAt, printedLabelAt)).toBeNull();
  });

  test("a route with no revenue stops still builds a travelling-signal track with no events", () => {
    const track = buildRouteSignalTrack(overlay, tilesAt, printedLabelAt);
    expect(track).not.toBeNull();
    expect(track!.totalLength).toBeGreaterThan(0);
    expect(track!.revenueEvents).toEqual([]);
  });
});
