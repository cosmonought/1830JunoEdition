// frontend/src/utils/seatColor.test.ts
//
// ==================================================================
//  DESIGN NOTE 569 (harness): SIX SEATS, SIX COLOURS, NO COLLISIONS
// ==================================================================
//
// The colour is no longer decoration -- it stripes the action bar during the
// two seat-driven rounds (design note #570), so "which seat is up" is read
// off it. Two seats sharing a colour is then not a cosmetic problem: it is
// two players who cannot tell whose turn it is from the cue that exists to
// tell them.

import {
  SEAT_COLORS,
  SEAT_COLOR_NAMES,
  seatColor,
  setRoomColors,
  takenSeatColors,
} from "./playerLabels";

afterEach(() => setRoomColors({}));

describe("the palette", () => {
  it("seats every 1830 table without repeating", () => {
    // Six is the maximum, so the palette must not wrap before it.
    expect(SEAT_COLORS).toHaveLength(6);
    expect(new Set(SEAT_COLORS).size).toBe(6);
  });

  it("names every colour, for the picker's accessible labels", () => {
    /* A swatch with no name is a control a screen reader announces as
       "button". The picker is optional; being unusable is not. */
    for (const color of SEAT_COLORS) {
      expect(SEAT_COLOR_NAMES[color]).toBeTruthy();
    }
  });

  it("stays clear of the corporation liveries", () => {
    /* Design note #569, on instruction: a player stripe in a corporate hue
       would read as a claim about that corporation, on a screen where the
       two sit side by side. Compared as literal values because that is the
       property that actually matters -- a near-miss is arguably worse than
       a match, but an exact match is unarguable. */
    const CORPORATE = ["#1a4f8a", "#c8102e", "#2e7d32", "#f2a900", "#5a2d82", "#00838f"];
    for (const color of SEAT_COLORS) {
      expect(CORPORATE).not.toContain(color.toLowerCase());
    }
  });
});

describe("seatColor", () => {
  it("assigns by index when nobody has chosen", () => {
    expect(seatColor("p-ada", 0)).toBe(SEAT_COLORS[0]);
    expect(seatColor("p-ben", 1)).toBe(SEAT_COLORS[1]);
  });

  it("gives six seats six different colours", () => {
    /* The property, not the mapping. `seatColor` is free to change which
       index gets which hue; it is not free to hand two seats the same one. */
    const assigned = Array.from({ length: 6 }, (_, i) => seatColor(`p-${i}`, i));
    expect(new Set(assigned).size).toBe(6);
  });

  it("prefers a seat's own choice", () => {
    setRoomColors({ "p-ada": SEAT_COLORS[4] });
    expect(seatColor("p-ada", 0)).toBe(SEAT_COLORS[4]);
  });

  it("leaves unchosen seats on their assigned colour", () => {
    // A mixed table -- some players care, some do not.
    setRoomColors({ "p-ada": SEAT_COLORS[4] });
    expect(seatColor("p-ben", 1)).toBe(SEAT_COLORS[1]);
  });

  it("never returns empty, whatever it is asked", () => {
    /* It feeds a `borderLeft` and a `backgroundColor`. An empty string is a
       silently invisible stripe, which looks like the feature was never
       built rather than like a bug. */
    expect(seatColor("", 0)).toBeTruthy();
    expect(seatColor("p-nobody", 99)).toBeTruthy();
  });
});

describe("takenSeatColors", () => {
  it("reports what other players hold", () => {
    setRoomColors({ "p-ada": SEAT_COLORS[0], "p-ben": SEAT_COLORS[1] });
    expect(takenSeatColors("p-ada").has(SEAT_COLORS[1])).toBe(true);
  });

  it("does not count the asking player's own colour against them", () => {
    /* Otherwise the picker greys out the swatch you are currently on, and
       the control appears to have refused a choice you already made. */
    setRoomColors({ "p-ada": SEAT_COLORS[0] });
    expect(takenSeatColors("p-ada").has(SEAT_COLORS[0])).toBe(false);
  });

  it("is empty before anybody chooses", () => {
    // Assigned colours must NOT block: a seat that never opened the picker
    // has no claim on the hue it happens to be wearing.
    expect(takenSeatColors().size).toBe(0);
  });
});
