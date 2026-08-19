// frontend/src/styles/turnHandoff.test.ts
//
// ==================================================================
//  DESIGN NOTE 597 (harness): THE CUE HAS TO END
// ==================================================================
//
// REPORTED: the acting seat's colour "is still too subtle... If it were a
// little more dynamic somehow, players would notice 'for sure' when their
// turn has come back around."
//
// The fix is a one-shot sweep across the band, and the property that makes it
// work is that it STOPS. An animation left running is the failure it replaces
// -- the existing my-turn pulse is `infinite`, which is why it is wallpaper
// within a few minutes and carries no arrival.
//
// Animations cannot be asserted from a canvas or a jsdom layout, so these pin
// the CSS itself: the shape a reviewer would have to check by eye, checked by
// a machine instead. That is a narrower guarantee than "it looks right", and
// it is the half that regresses silently -- somebody adding `infinite` to
// make it "more visible" would undo the whole design and no screenshot would
// show it.

import { TURN_HANDOFF_SWEEP_CSS } from "./animations";

describe("the handoff sweep", () => {
  it("runs exactly once", () => {
    /* THE PROPERTY THE WHOLE NOTE RESTS ON. `infinite` here would make this
       the same wallpaper as the pulse it supplements. */
    expect(TURN_HANDOFF_SWEEP_CSS).toMatch(/app-turn-band-sweep [\d]+ms [a-z-]+ 1;/);
    expect(TURN_HANDOFF_SWEEP_CSS).not.toMatch(/app-turn-band-sweep[^;]*infinite/);
  });

  it("blooms once too, on your own turn", () => {
    expect(TURN_HANDOFF_SWEEP_CSS).toMatch(/app-turn-band-bloom [\d]+ms [a-z-]+ 1;/);
    expect(TURN_HANDOFF_SWEEP_CSS).not.toMatch(/app-turn-band-bloom[^;]*infinite/);
  });

  it("makes your own turn the louder of the two", () => {
    /* "Somebody's turn began" and "YOUR turn began" are different news. If
       the two ever matched, the one handoff that requires the reader to DO
       something would be as quiet as the three that do not. */
    const base = /animation: app-turn-band-sweep (\d+)ms/.exec(TURN_HANDOFF_SWEEP_CSS);
    const mine = /animation-duration: (\d+)ms/.exec(TURN_HANDOFF_SWEEP_CSS);
    expect(base).not.toBeNull();
    expect(mine).not.toBeNull();
    expect(Number(mine![1])).toBeGreaterThan(Number(base![1]));
  });

  it("keeps the band and drops only the motion under reduced motion", () => {
    /* Design note #26's standing bargain: a cue that cannot be switched off
       is an accessibility problem, and a cue that DISAPPEARS when motion is
       reduced is an information problem. The colour is the information; the
       sweep is the arrival. Only the second may go. */
    const reduced = TURN_HANDOFF_SWEEP_CSS.slice(
      TURN_HANDOFF_SWEEP_CSS.indexOf("prefers-reduced-motion"),
    );
    expect(reduced).toMatch(/animation:\s*none/);
    // The band's own fill is an inline style on the element, so nothing in
    // the reduced-motion block may touch `background-color`.
    expect(reduced).not.toMatch(/background-color/);
  });

  it("spans the full width rather than an edge", () => {
    /* The other half of the report: a 6px vertical sliver on the left margin
       is the least visible place a colour can go on a wide panel. */
    expect(TURN_HANDOFF_SWEEP_CSS).toMatch(/\.app-turn-band\s*\{[^}]*left:\s*0/);
    expect(TURN_HANDOFF_SWEEP_CSS).toMatch(/\.app-turn-band\s*\{[^}]*right:\s*0/);
    expect(TURN_HANDOFF_SWEEP_CSS).toMatch(/\.app-turn-band\s*\{[^}]*top:\s*0/);
  });

  it("cannot intercept a click", () => {
    // It sits over the top edge of a bar full of buttons.
    expect(TURN_HANDOFF_SWEEP_CSS).toMatch(/pointer-events:\s*none/);
  });
});
