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
import { CORPORATION_LIVERY_COLORS } from "../styles/corporationLivery";

afterEach(() => setRoomColors({}));

/** Perceptual distance between two hex colours, CIE76 (Lab Euclidean).
 *
 *  LIVES HERE RATHER THAN IN `styles/`, because it has one caller and adding a
 *  colour-science module to production for a test's benefit is how unused
 *  infrastructure gets adopted -- the hazard `corporationLivery.ts` records
 *  about its own deleted constants. If a second caller appears, it moves.
 *
 *  See design note #1097 below for why CIE76 and not CIEDE2000. */
function cie76(a: string, b: string): number {
  const toLab = (hex: string): [number, number, number] => {
    const channel = (i: number) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, bl] = [channel(1), channel(3), channel(5)];
    // sRGB -> XYZ (D65), then XYZ -> Lab.
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

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
       two sit side by side.

       ==================================================================
        DESIGN NOTE 1097: THIS TEST WAS GUARDING SIX COLOURS THAT DO NOT EXIST
       ==================================================================
       IT COMPARED AGAINST A HARDCODED LIST -- `#1a4f8a`, `#2e7d32`, `#f2a900`,
       `#5a2d82`, `#00838f` -- none of which is a livery. They predate design
       notes #408/#428, which replaced the invented palette with the physical
       board's colours and consolidated the table into `corporationLivery.ts`.
       The list was never updated, so for eight corporations this test compared
       the seats against nothing at all and passed by construction.

       WHAT IT MISSED, concretely: Moss `#4f8a5c` sat 8.2 dE from the B&M's
       green -- the same colour, to a reader -- and this is the guard that
       existed to prevent exactly that.

       SO IT READS THE REAL TABLE NOW, and it checks SEPARATION rather than
       identity. The original note already knew that was the right property
       ("a near-miss is arguably worse than a match") and settled for equality
       because it was unarguable; a near-miss is what actually shipped. The
       floor is 20 in CIE76, which is the metric implemented below. CIE76 AND
       NOT CIEDE2000, deliberately: the perceptually-correct formula is forty
       lines of trigonometry, and the numbers here are not close enough for
       the difference to decide anything. The gap it has to straddle is wide --
       old Moss against the B&M scores 12.3 and the tightest colour being kept
       scores 23.1 -- so any floor in between separates the cases, and 20 sits
       clear of both edges. If a future palette needs a finer judgement than
       that, THAT is when the better formula earns its length.

       Brick against the CPR's brown is the tightest surviving pair (16.7) and
       is EXEMPTED BY NAME rather than by lowering the bar, so it stays visible
       as a known exception instead of quietly setting the standard. */
    const EXEMPT = new Set(["#a8593f"]); // Brick vs CPR -- see TECH_DEBT TD-4.
    for (const color of SEAT_COLORS) {
      if (EXEMPT.has(color.toLowerCase())) continue;
      for (const [id, livery] of Object.entries(CORPORATION_LIVERY_COLORS)) {
        const separation = cie76(color, livery);
        expect([color, id, separation >= 20]).toEqual([color, id, true]);
      }
    }
  });

  it("keeps the seats apart from each other too", () => {
    /* The picker guarantees two players never SHARE a colour; it does not
       guarantee the two colours can be told apart. Same floor, same reason. */
    for (let i = 0; i < SEAT_COLORS.length; i += 1) {
      for (let j = i + 1; j < SEAT_COLORS.length; j += 1) {
        const separation = cie76(SEAT_COLORS[i], SEAT_COLORS[j]);
        expect([SEAT_COLORS[i], SEAT_COLORS[j], separation >= 20]).toEqual([
          SEAT_COLORS[i],
          SEAT_COLORS[j],
          true,
        ]);
      }
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
