// frontend/src/utils/routeOverlaySource.test.ts
//
// [PRESENTATION CORRECTION]: the map's route drafting/display boundary is exactly two predicates --
// `isRouteBuilderArmed` (may this client edit?) and `selectActingPresenceEntry` (whose presence, if
// anyone's, should this client display?). Both are asserted here as arithmetic, per #882/#875's own
// argument for why this sort of decision belongs in a pure module rather than inside a React effect.

import { isRouteBuilderArmed, selectActingPresenceEntry } from "./routeOverlaySource";

describe("isRouteBuilderArmed", () => {
  // 1. acting player can manually edit route drafts during Routes.
  it("arms for the acting player during the Routes sub-phase", () => {
    expect(isRouteBuilderArmed({ inRunTrainsSubPhase: true, isMyTurn: true })).toBe(true);
  });

  // 2/3. non-acting viewer cannot mutate a local route draft, and never auto-drafts, during someone else's
  // Routes step.
  it("does not arm for a non-acting viewer during the Routes sub-phase", () => {
    expect(isRouteBuilderArmed({ inRunTrainsSubPhase: true, isMyTurn: false })).toBe(false);
  });

  it("does not arm for the acting player outside the Routes sub-phase", () => {
    expect(isRouteBuilderArmed({ inRunTrainsSubPhase: false, isMyTurn: true })).toBe(false);
  });

  it("does not arm for a non-acting viewer outside the Routes sub-phase", () => {
    expect(isRouteBuilderArmed({ inRunTrainsSubPhase: false, isMyTurn: false })).toBe(false);
  });
});

describe("selectActingPresenceEntry", () => {
  const acting = { playerId: "pres", actingCompanyId: 7, routeDrafts: { 0: [[1, 1]] } };
  const otherCorp = { playerId: "someone-else", actingCompanyId: 3, routeDrafts: { 0: [[2, 2]] } };

  // 4. watcher sees the acting player's published route drafts.
  it("returns the entry naming the operating corporation", () => {
    expect(selectActingPresenceEntry([otherCorp, acting], 7)).toBe(acting);
  });

  // 5. watcher does not display a fresh presence draft belonging to a non-acting corporation.
  it("returns null when no entry names the operating corporation and more than one candidate is drafting", () => {
    const otherCorpA = { playerId: "a", actingCompanyId: 3, routeDrafts: { 0: [[1, 1]] } };
    const otherCorpB = { playerId: "b", actingCompanyId: 4, routeDrafts: { 0: [[2, 2]] } };
    expect(selectActingPresenceEntry([otherCorpA, otherCorpB], 7)).toBeNull();
  });

  it("returns null when the only entries present belong to a different corporation", () => {
    expect(selectActingPresenceEntry([otherCorp], 7)).toBeNull();
  });

  it("returns null on an empty presence list, rather than inventing a route", () => {
    expect(selectActingPresenceEntry([], 7)).toBeNull();
  });

  // 6. acting player's map likewise must not display an unrelated non-actor presence draft: the same
  // selector is what the acting viewer's own branch would consult if it ever fell back to presence, and it
  // must never surface a stranger's entry there either.
  it("never returns an entry whose actingCompanyId names a different corporation, even if it is the only one drafting", () => {
    // Named entries are authoritative in either direction: an entry that explicitly names a corporation is
    // never treated as ambiguous filler for a different one, even when it is the sole drafter.
    expect(selectActingPresenceEntry([otherCorp], 7)).toBeNull();
  });

  // #1386's pre-existing fallback: an older/malformed document with no actingCompanyId at all is accepted
  // ONLY when it is the sole drafting entry.
  it("falls back to the sole drafting entry when nothing names the corporation (legacy/malformed presence)", () => {
    const unlabelled = { playerId: "legacy-client", routeDrafts: { 1: [[3, 3]] } };
    expect(selectActingPresenceEntry([unlabelled], 7)).toBe(unlabelled);
  });

  it("does not guess between two unlabelled drafting entries", () => {
    const unlabelledA = { playerId: "a", routeDrafts: { 0: [[1, 1]] } };
    const unlabelledB = { playerId: "b", routeDrafts: { 0: [[2, 2]] } };
    expect(selectActingPresenceEntry([unlabelledA, unlabelledB], 7)).toBeNull();
  });

  it("ignores entries with no drafts at all when falling back", () => {
    const idle = { playerId: "idle", actingCompanyId: null, routeDrafts: {} };
    expect(selectActingPresenceEntry([idle], 7)).toBeNull();
  });

  // 7. effective route-overlay count is bounded by the operating corporation's own roster, not by the
  // number of presence publishers: however many entries are in the list, selection yields at most one.
  it("never returns more than one entry regardless of how many presence documents exist", () => {
    const many = [
      { playerId: "a", actingCompanyId: 1, routeDrafts: { 0: [[1, 1]] } },
      { playerId: "b", actingCompanyId: 2, routeDrafts: { 0: [[2, 2]] } },
      acting,
      { playerId: "c", actingCompanyId: 4, routeDrafts: { 0: [[3, 3]] } },
    ];
    const result = selectActingPresenceEntry(many, 7);
    expect(result).toBe(acting);
  });
});
