/** @jest-environment jsdom */
//
// ==================================================================
//  HOST GAME (harness): THE THREE GROUPS ARE RADIO GROUPS (design notes #1448, #1448a)
// ==================================================================
//
// WHAT A SOURCE SCAN CANNOT CHECK, and therefore why this file renders:
//   1. ROVING TAB STOP. "Exactly one option in the group has `tabIndex=0`" is a statement about the rendered
//      tree after a value change, not about a line of source.
//   2. ARROWS MOVE FOCUS AND SELECTION TOGETHER. Before #1448 the arrow keys did nothing at all, and Tab
//      walked the group one radio at a time -- which is how a keyboard reached the reported state: a neutral
//      ring on one option while the green selection sat on another, one answer shown in two places.
//   3. A CLICK ON A NESTED CHILD SELECTS AND FOCUSES ITS OWNING RADIO. jsdom does not implement the browser's
//      "focus the button you clicked" default, which makes it an exact stand-in for WebKit, where that
//      default does not exist either. If the click handler did not focus the radio itself, this case fails
//      here and the bug would ship to Safari as a ring stranded on the option the user moved away from.
//   4. REMOUNTING CLEARS EVERYTHING, because there is no focus state to clear: the selected value alone
//      decides the Tab stop.
//
// `:focus-visible` IS NOT ASSERTED HERE -- jsdom does not implement it. The Chromium harness measures that
// half: ring on Tab and on every arrow, no ring after a pointer click, in all three groups.
//
// NO `@testing-library/react` IN THE TREE, so this is `createRoot` + `React.act`, the pattern
// `turnAttention.test.ts` established and `rulesOverview.test.tsx` follows.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/* #1651 (harness): EVERY DIALOG IN THIS FILE IS NOW A NATIVE `<dialog>` IN THE SHARED MODAL LAYER.
   `NativeModal` portals into `[data-modal-layer]` and throws if it is absent, so the harness renders
   `<ModalLayerHost />` beside its opener exactly as `GameRouter` does in the application. The dialog is the
   ELEMENT now, not a nested `role="dialog"` inside it, so every selector below reads
   `dialog[data-native-modal]`. */

import { ModalLayerHost } from "./ModalPortal";

import HostSetupCard from "./HostSetupCard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const GROUPS: Readonly<Record<string, ReadonlyArray<string>>> = {
  Game: ["host-type-standard", "host-type-plus", "host-type-levelPlayingField"],
  Pace: ["host-pace-live", "host-pace-async"],
  Visibility: ["host-visibility-public", "host-visibility-private"],
};
const DEFAULT_SELECTED: Readonly<Record<string, string>> = {
  Game: "host-type-standard",
  Pace: "host-pace-live",
  Visibility: "host-visibility-public",
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/* #1651 (harness): THE LAYER IS COMMITTED BEFORE THE DIALOG, on a root of its own, because `ModalPortal`
   resolves its container during render and a sibling rendered in the SAME commit is not in the DOM yet. This
   is what the application does too -- `GameRouter` mounts the layer with the screen, and a modal opens later. */
let layerHost: HTMLDivElement | null = null;
let layerRoot: Root | null = null;

function mountLayer() {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => {
    layerRoot!.render(<ModalLayerHost />);
  });
}

function unmountLayer() {
  act(() => layerRoot?.unmount());
  layerHost?.remove();
  layerRoot = null;
  layerHost = null;
}

function mount() {
  mountLayer();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<HostSetupCard busy={false} error={null} onClose={() => {}} onCreate={() => {}} />);
  });
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  unmountLayer();
  root = null;
  host = null;
}

const at = (testId: string): HTMLButtonElement => {
  const node = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`no such control: ${testId}`);
  return node;
};

/** The state of one group, in the terms the report asks for. */
const readGroup = (group: string) =>
  GROUPS[group].map((id) => {
    const node = at(id);
    return {
      id,
      checked: node.getAttribute("aria-checked"),
      tabIndex: node.tabIndex,
      active: document.activeElement === node,
    };
  });

const checkedIn = (group: string) => readGroup(group).filter((r) => r.checked === "true");
const tabStopsIn = (group: string) => readGroup(group).filter((r) => r.tabIndex === 0);
const activeIn = (group: string) => readGroup(group).filter((r) => r.active);

const press = (group: string, key: string) => {
  const anyOption = at(GROUPS[group][0]);
  act(() => {
    anyOption.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

/** A pointer click that lands on a CHILD of the radio, and -- like WebKit, and like jsdom -- does not move
 *  focus by itself. Whatever focus results is the component's own doing. */
const clickNestedChild = (testId: string) => {
  const child = at(testId).querySelector("span");
  if (!child) throw new Error(`${testId} has no child to click`);
  act(() => {
    child.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

beforeEach(mount);
afterEach(unmount);

describe("every Host Game group is one radio group, not a row of buttons (design note #1448)", () => {
  for (const group of Object.keys(GROUPS)) {
    describe(group, () => {
      it("has exactly one checked option and exactly one Tab stop, and they are the same option", () => {
        expect(checkedIn(group).map((r) => r.id)).toEqual([DEFAULT_SELECTED[group]]);
        expect(tabStopsIn(group).map((r) => r.id)).toEqual([DEFAULT_SELECTED[group]]);
        for (const row of readGroup(group)) {
          expect([row.id, row.tabIndex]).toEqual([row.id, row.checked === "true" ? 0 : -1]);
        }
      });

      it("moves focus and aria-checked together on every arrow key, and wraps", () => {
        const ids = GROUPS[group];
        at(ids[0]).focus();
        const walk: Array<[string, string]> = [];
        for (const [key, step] of [["ArrowRight", 1], ["ArrowDown", 1], ["ArrowLeft", -1], ["ArrowUp", -1]] as const) {
          const from = checkedIn(group)[0].id;
          press(group, key);
          const expected = ids[(ids.indexOf(from) + step + ids.length) % ids.length];
          walk.push([key, expected]);
          /* The three move as one: checked, the Tab stop, and the focus. If any pair could disagree, the
             screen could show the answer in one place and the caret in another -- the reported ambiguity. */
          expect([key, checkedIn(group).map((r) => r.id)]).toEqual([key, [expected]]);
          expect([key, tabStopsIn(group).map((r) => r.id)]).toEqual([key, [expected]]);
          expect([key, activeIn(group).map((r) => r.id)]).toEqual([key, [expected]]);
        }
        expect(walk.length).toBe(4);
        // wrapped forward off the end and back, so the last arrow returns to where it started
        expect(checkedIn(group).map((r) => r.id)).toEqual([ids[0]]);
      });

      it("ignores keys that are not arrows", () => {
        const before = readGroup(group);
        for (const key of ["a", "Escape", "PageDown", "Shift"]) press(group, key);
        expect(readGroup(group)).toEqual(before);
      });

      it("selects AND focuses the owning radio when the click lands on a nested child", () => {
        const ids = GROUPS[group];
        const target = ids[ids.length - 1];
        expect(target).not.toBe(DEFAULT_SELECTED[group]);
        clickNestedChild(target);
        expect(checkedIn(group).map((r) => r.id)).toEqual([target]);
        expect(tabStopsIn(group).map((r) => r.id)).toEqual([target]);
        expect(document.activeElement).toBe(at(target));
      });

      it("takes the focus off A when a pointer selects B", () => {
        const ids = GROUPS[group];
        const a = DEFAULT_SELECTED[group];
        const b = ids.find((id) => id !== a) as string;
        at(a).focus(); // stand-in for Tab: the keyboard is on A
        expect(document.activeElement).toBe(at(a));
        clickNestedChild(b);
        expect(document.activeElement).toBe(at(b));
        expect(document.activeElement).not.toBe(at(a));
        expect(checkedIn(group).map((r) => r.id)).toEqual([b]);
        expect(at(a).getAttribute("aria-checked")).toBe("false");
        expect(at(a).tabIndex).toBe(-1);
      });

      it("comes back clean when the dialog is closed and reopened", () => {
        const ids = GROUPS[group];
        const moved = ids[ids.length - 1];
        clickNestedChild(moved);
        at(moved).focus();
        expect(document.activeElement).toBe(at(moved));
        unmount();
        mount();
        /* Nothing survives, because nothing was stored: the Tab stop is derived from the value, and the value
           is back to its default. A remembered focus index would show up here as a Tab stop on `moved`. */
        expect(checkedIn(group).map((r) => r.id)).toEqual([DEFAULT_SELECTED[group]]);
        expect(tabStopsIn(group).map((r) => r.id)).toEqual([DEFAULT_SELECTED[group]]);
        /* Design note #1630 SUPERSEDES THE OLD `toEqual([])` HERE, and only for Game. The dialog now moves
           focus INTO itself when it opens, onto the selected Game radio -- so "nothing is focused after a
           remount" stopped being true for that group while remaining true for the other two.
           WHAT THE CASE WAS PROTECTING IS UNCHANGED AND IS ASSERTED HARDER. The point was that no focus is
           REMEMBERED: focus after a remount must be decided by the value, never by where it was last time.
           `moved` is the option that held focus before the unmount, so asserting focus is on the DEFAULT --
           not on `moved` -- says exactly that, and would catch a stored index that `[]` would also have
           caught. */
        expect(activeIn(group).map((r) => r.id)).toEqual(
          group === "Game" ? [DEFAULT_SELECTED[group]] : [],
        );
        expect(activeIn(group).map((r) => r.id)).not.toContain(moved);
      });
    });
  }

  it("gives the whole step exactly three Tab stops among its radios", () => {
    /* The count IS the claim. Before #1448 it was seven -- every option its own stop -- so Tab from the
       selected option landed on an unselected sibling in the SAME group and put a neutral ring beside a green
       one. Derived from the table, so a fourth group cannot be added without this number being revisited. */
    const all = Object.keys(GROUPS).flatMap((g) => tabStopsIn(g).map((r) => r.id));
    expect(all).toEqual(Object.keys(GROUPS).map((g) => DEFAULT_SELECTED[g]));
    expect(all.length).toBe(Object.keys(GROUPS).length);
    /* PLAY HOST A GAME (handoff §3.1): the Async card carries its own group of deadline chips -- a FOURTH group, with
       one Tab stop of its own. While Live is chosen no chip is checked (the table is Live) and the remembered pace
       (24h) stays the group's stop, so the keyboard can still reach it. */
    const everyRadio = Array.from(document.querySelectorAll('[role="radio"]')) as HTMLElement[];
    const chips = everyRadio.filter((n) => (n.getAttribute("data-testid") ?? "").startsWith("host-deadline-"));
    expect(chips.map((n) => n.getAttribute("data-testid"))).toEqual(["host-deadline-43200", "host-deadline-86400", "host-deadline-172800", "host-deadline-259200", "host-deadline-604800", "host-deadline-none"]);
    expect(chips.filter((n) => n.tabIndex === 0).map((n) => n.getAttribute("data-testid"))).toEqual(["host-deadline-86400"]);
    expect(chips.filter((n) => n.getAttribute("aria-checked") === "true")).toEqual([]);
    expect(everyRadio.length).toBe(Object.values(GROUPS).flat().length + chips.length);
    expect(everyRadio.filter((n) => n.tabIndex === 0).length).toBe(4);
  });

  it("keeps the groups independent", () => {
    /* Arrowing through Pace must not disturb Game or Visibility.
       #1630: COMPARED WITHOUT THE `active` FIELD, deliberately. Focus is a property of the DOCUMENT, not of a
       group -- there is only one of it, and moving it into Pace necessarily takes it off whichever option had
       it, which since #1630 is the selected Game radio on open. Including focus in this comparison made the
       case assert that focus never moves, which is not what independence means. What each group owns -- its
       value and its single Tab stop -- is compared exactly as before. */
    const answer = (name: string) => readGroup(name).map(({ id, checked, tabIndex }) => ({ id, checked, tabIndex }));
    const before = { Game: answer("Game"), Visibility: answer("Visibility") };
    at(GROUPS.Pace[0]).focus();
    press("Pace", "ArrowRight");
    expect(answer("Game")).toEqual(before.Game);
    expect(answer("Visibility")).toEqual(before.Visibility);
    expect(checkedIn("Pace").map((r) => r.id)).toEqual(["host-pace-async"]);
    // And the focus really did go to Pace, which is the other half of "independent".
    expect(activeIn("Pace").map((r) => r.id)).toEqual(["host-pace-async"]);
  });

  it("labels each group and carries the radio roles", () => {
    /* PLAY HOST A GAME (handoff §3.1): each group is named by its visible label ("Table", "Pace", "Visibility"), and
       the Async chips by their own ("Async deadline per action"). */
    const groups = Array.from(document.querySelectorAll('[role="radiogroup"]'));
    expect(groups.length).toBe(4);
    const nameOf = (g: Element) => g.getAttribute("aria-label") ?? document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent ?? null;
    expect(groups.map(nameOf)).toEqual(["Table", "Pace", "Async deadline per action", "Visibility"]);
    for (const [name, ids] of Object.entries(GROUPS)) {
      for (const id of ids) expect([name, id, at(id).getAttribute("role")]).toEqual([name, id, "radio"]);
    }
  });
});

describe("a deselected option looks like its never-selected peers (design note #1448a)", () => {
  /* THE PLAYTEST BUG was an inline `borderColor` longhand over a `border` shorthand: React cleared the longhand on
     deselect and left a black edge. PLAY HOST A GAME draws selection from the radio's own `aria-checked` in the
     stylesheet (`.rh-tcard[aria-checked="true"]`, `.rh-opt[aria-checked="true"]`), so no option carries an inline
     border at all -- a deselected option has nothing left over, by construction. Asserted on the rendered nodes. */
  for (const [group, ids] of Object.entries(GROUPS)) {
    it(`${group}: no inline border before or after a select-then-deselect round trip`, () => {
      const a = DEFAULT_SELECTED[group];
      const b = ids.find((id) => id !== a) as string;
      for (const id of ids) expect([id, at(id).style.border, at(id).style.borderColor]).toEqual([id, "", ""]);
      clickNestedChild(b);
      expect(at(a).getAttribute("aria-checked")).toBe("false");
      expect([at(a).style.border, at(a).style.borderColor, at(a).style.boxShadow]).toEqual(["", "", ""]);
    });
  }

  it("draws selection from aria-checked in the stylesheet, and never pairs a border shorthand with a borderColor longhand", () => {
    const { readStripped, sliceBetween } =
      require("../utils/sourceScan") as typeof import("../utils/sourceScan");
    const styles = sliceBetween(readStripped("components/HostSetupCard.tsx"),
      "const styles: Record<string, React.CSSProperties> = {", "\n};");
    expect(styles).not.toContain("borderColor:");
    const css = readStripped("components/room/roomDesignCss.ts");
    expect(css).toContain('.rh-tcard[aria-checked="true"] { border-color: var(--rm-gold);');
    expect(css).toContain('.rh-opt[aria-checked="true"] { border-color: var(--rm-gold);');
  });
});
