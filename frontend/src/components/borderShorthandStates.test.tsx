/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1449 (harness): A LONGHAND OVER A SHORTHAND CANNOT BE TAKEN BACK
// ==================================================================
//
// THE FAILURE CLASS, found by auditing the one `HostSetupCard` instance (#1448a) across the whole frontend:
//
//   base object:      { border: "1px solid #3a3a3a" }          <- SHORTHAND
//   state object:     { borderColor: "#c9a227" }               <- LONGHAND, conditional
//   style={{ ...base, ...(on ? state : {}) }}
//
// React diffs inline styles KEY BY KEY. When `on` goes false it clears `borderColor` and does NOT rewrite
// `border`, because `border` is the same string in both renders. Clearing the longhand removes the colour
// from the declaration outright, and what is left is measured, verbatim:
//
//   border-width: 1px; border-style: solid; border-image: initial;
//
// with no colour at all. THE REPLACEMENT IS NOT EVEN CONSISTENT, which is why this arrived as several
// unrelated-looking playtest reports: Chromium computed `rgb(0, 0, 0)` on the <button> cases and, where the
// state also set `borderWidth`, `3px` (the initial `medium`) in `currentColor` -- a WHITE ring on a market
// cell whose neighbours carry a 1px #2a2a2a rule. It persists until the element unmounts.
//
// WHAT IS ASSERTED HERE. Two behavioural cases, one per correction category -- a selection moving between
// peers, and enabled -> disabled -> enabled -- driven through the real components, plus the multi-longhand
// case that also orphaned the width. The assertions are on the INLINE STYLE ATTRIBUTE, which is where the
// damage is and which means the same thing in jsdom and in a browser; jsdom does not resolve `currentColor`
// or `medium`, so the computed consequence is measured in the Chromium harness instead.
//
// THE RULE ALREADY EXISTED. `utils/styleShorthand.ts` (design note #732) diagnosed this exact mechanism
// for `background` on the Tiles tab, listed `border` among its risky shorthands, and its own test even
// named the border family as "the one this codebase is next likeliest to hit". What was missing was a
// SWEEP: `shorthandClashes` was only ever fed hand-made objects. The guard below supplies the missing
// half -- it walks every JSX `style` attribute and hands the real base/overlay pairs to that same rule.
//
// AND ONE STRUCTURAL CASE, for the corrected files whose transitions need a game in progress to reach.
// It re-runs the audit's own rule over every component and asserts the class is extinct -- which is worth
// more than six mounts, because it also catches the next one somebody writes.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
/* The parser is the point of the guard below: `ts` has to be a namespace as well as a value, which a
   `require` binding is not. */
import * as ts from "typescript";

import { AutoModePicker } from "./AutoModePicker";
import { ModalLayerHost } from "./ModalPortal";
import { JoinGameCard } from "./JoinGameCard";
import { StockMarketPreview } from "./StockMarketPreview";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
/* #1651: the modal layer, committed on a root of its own BEFORE anything that portals into it -- `ModalPortal`
   resolves its container during render, so a layer rendered as a sibling in the same commit is not in the DOM
   yet. `GameRouter` arranges the same order in the application. Nothing about the border question changed;
   `JoinGameCard` is simply a native `<dialog>` in that layer now. */
let layerHost: HTMLDivElement | null = null;
let layerRoot: Root | null = null;
const mount = (node: React.ReactNode) => {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot!.render(<ModalLayerHost />));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(node));
};
const update = (node: React.ReactNode) => act(() => root.render(node));
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => layerRoot?.unmount());
  layerHost?.remove();
  layerRoot = null;
  layerHost = null;
});

/** Every border declaration the element is actually carrying. `border` is read back from the longhands
 *  because that is how the CSSOM serialises it once a longhand has touched it. */
const borderOf = (n: Element) => {
  const s = (n as HTMLElement).style;
  return {
    shorthand: s.border,
    width: s.borderTopWidth || s.borderWidth,
    style: s.borderTopStyle || s.borderStyle,
    color: s.borderTopColor || s.borderColor,
    raw: n.getAttribute("style") ?? "",
    /* The declarations as a SET. React rewrites `border` in place, which moves it to the end of the
       serialised `style` attribute; the order of non-conflicting declarations is not a fact about the
       rendered element, so comparing the raw string would fail on a correct fix. */
    decls: declMap(n),
  };
};

const declMap = (n: Element): Record<string, string> =>
  Object.fromEntries(
    (n.getAttribute("style") ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const at = d.indexOf(":");
        return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
      }),
  );

describe("a state that ends gives the element its base border back (design note #1449)", () => {
  it("selection moving between peers: the option that WAS on matches one that never was", () => {
    /* CATEGORY A. `AutoModePicker` stands for `rungActive`, `trainChipActive`, `pathHexPaying` and the two
       market-cell marks: one base with a `border` shorthand, one conditional variant that recoloured it. */
    mount(<AutoModePicker mode="pass" onSwitch={() => {}} />);
    const pass = () => document.querySelector('[data-testid="auto-mode-pass"]')!;
    const buy = () => document.querySelector('[data-testid="auto-mode-buy"]')!;

    const neverSelected = borderOf(buy());
    expect(neverSelected.color).not.toBe("");
    const selected = borderOf(pass());
    expect(selected.color).not.toBe(neverSelected.color); // the state really is visible

    update(<AutoModePicker mode="buy" onSwitch={() => {}} />);

    const deselected = borderOf(pass());
    expect(deselected.color).not.toBe("");                       // 1. no colourless declaration
    expect(deselected.color).toBe(neverSelected.color);          // 2. exactly the base colour
    expect(deselected.width).toBe(neverSelected.width);
    expect(deselected.style).toBe(neverSelected.style);
    // 3. the same DECLARATIONS as a peer that was never selected -- every border key, same values
    const borderKeys = (d: Record<string, string>) =>
      Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith("border") && !k.includes("radius")));
    /* Against the snapshot taken BEFORE the switch -- `buy` is the selected one now. */
    expect(borderKeys(deselected.decls)).toEqual(borderKeys(neverSelected.decls));
    // 4. no orphan: a width or style declaration is never left without a colour beside it
    expect("border-style" in deselected.decls && !("border-color" in deselected.decls)).toBe(false);
  });

  it("enabled -> disabled -> enabled: the green edge comes back, without a remount", () => {
    /* #1651: `JoinGameCard` is a native `<dialog>` in the shared modal layer now, and `ModalPortal` resolves
       its container during render -- so the layer has to be in the DOM before the card is rendered, exactly
       as `GameRouter` arranges it in the application. Nothing about the border question changed. */
    /* CATEGORY B. `JoinGameCard` stands for `primaryButtonDisabled` in `AutoPassModal` and `SeatPinModal`,
       `disabled` in `RejoinByPinCard`, `confirmButtonDisabled` and `runButtonDisabled`. */
    const props = { error: null, onClose: () => {}, onJoin: async () => null, onRejoin: () => {}, onClearError: () => {} };
    mount(<JoinGameCard busy={false} {...props} />);
    const button = () => document.querySelector('[data-testid="join-by-code"]')!;
    const idle = borderOf(button());
    const node = button();
    expect(idle.color).not.toBe("");

    update(<JoinGameCard busy {...props} />);
    const busy = borderOf(button());
    expect(busy.color).not.toBe(idle.color);   // the disabled look is real

    update(<JoinGameCard busy={false} {...props} />);
    expect(button()).toBe(node);               // 5. the same DOM node -- no remount was needed
    const back = borderOf(button());
    expect(back.color).toBe(idle.color);
    expect(back.width).toBe(idle.width);
    expect(back.style).toBe(idle.style);
    expect(back.decls).toEqual(idle.decls);   // same declarations; React may reorder them, which is not a fact
    expect("border-style" in back.decls && !("border-color" in back.decls)).toBe(false);
  });

  it("a state that set the WIDTH too gives the width back, not the initial `medium`", () => {
    /* The worst of the class. `cellLanding` set `borderColor` AND `borderWidth` over a `border` shorthand, so
       a cell the mark had left kept `border-style: solid` alone -- Chromium then drew 3px of `currentColor`,
       a white ring on a #2a2a2a grid. */
    const props = {
      company: { company_id: 1, ticker: "PRR" },
      startNode: { x: 5, y: 3 },
      positions: [{ company_id: 1, ticker: "PRR", x: 5, y: 3 }] as never,
      action: "pay" as const,
    };
    mount(<StockMarketPreview {...props} projectedNode={{ x: 6, y: 3 }} />);
    const cells = () => Array.from(document.querySelectorAll("#dummy, div[title]"));
    const all = cells();
    expect(all.length).toBeGreaterThan(50);

    const markedAt = all.findIndex((n) => borderOf(n).width === "2px");
    expect(markedAt).toBeGreaterThanOrEqual(0);
    const plain = borderOf(all.find((n) => borderOf(n).width === "1px" && borderOf(n).style === "solid")!);

    update(<StockMarketPreview {...props} projectedNode={{ x: 7, y: 3 }} />);
    const after = cells();
    expect(after[markedAt]).toBe(all[markedAt]); // same node, no remount
    const former = borderOf(after[markedAt]);
    expect(former.width).toBe(plain.width);
    expect(former.style).toBe(plain.style);
    expect(former.color).toBe(plain.color);
    expect(former.color).not.toBe("");
  });
});

describe("the class is extinct across the frontend (design note #1449)", () => {
  /* The audit's own rule, run as a test, and AST-AWARE rather than a brace scanner.
     WHY THE REWRITE. The first version resolved NAMED style objects only, and its hand-rolled parser gave up
     silently on files whose literals confused it. Re-run with the TypeScript parser over every JSX `style`
     attribute, it found 25 more conflicts in 16 files that the named-object pass never saw -- all of them
     written INLINE: `...(on ? { borderColor: x } : {})` beside a base that sets `border`, a colour computed
     from a seat in the JSX itself, a side-shorthand base with a bare `borderLeftColor` variant.

     WHAT COUNTS AS REMOVABLE. A property is removable when a render can produce the object WITHOUT it:
     inside a conditional spread, inside one branch of a ternary that returns style objects, or written with a
     value that can be `undefined`/`null`. A property present in EVERY branch is not removable, and neither is
     one the base also declares unconditionally -- React then sees a change, which it applies.

     THE ESCAPE HATCH, for whoever this fails on: declare the SAME property the base declares. A longhand over
     a shorthand is only safe when nothing can remove it, and a conditional spread always can. */
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const SRC = path.join(__dirname, "..");

  /* THE RULE IS #732's, not a second copy of it. This file finds the pairs; `shorthandClashes` decides. */
  const { shorthandClashes, RISKY_SHORTHANDS } =
    require("../utils/styleShorthand") as typeof import("../utils/styleShorthand");
  const TRACKED = new Set<string>(
    Object.keys(RISKY_SHORTHANDS).concat(...Object.keys(RISKY_SHORTHANDS).map((k) => RISKY_SHORTHANDS[k].slice())),
  );
  const isBorder = (name: string) => TRACKED.has(name) && name.indexOf("border") === 0;

  function offenders(file: string, src: string): string[] {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const objects = new Map<string, ts.ObjectLiteralExpression>();
    const funcs = new Map<string, ts.SignatureDeclaration>();
    const unwrap = (e: ts.Expression): ts.Expression => {
      let x = e;
      while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
      return x;
    };
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrap(node.initializer);
        if (ts.isObjectLiteralExpression(init)) {
          objects.set(node.name.text, init);
          init.properties.forEach((prop) => {
            if (ts.isPropertyAssignment(prop) && prop.name) {
              const v = unwrap(prop.initializer);
              if (ts.isObjectLiteralExpression(v)) objects.set(`${(node.name as ts.Identifier).text}.${prop.name.getText(sf)}`, v);
            }
          });
        } else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) funcs.set(node.name.text, init);
      }
      if (ts.isFunctionDeclaration(node) && node.name) funcs.set(node.name.text, node);
      ts.forEachChild(node, collect);
    };
    collect(sf);

    const returnedObject = (fn: ts.SignatureDeclaration): ts.ObjectLiteralExpression | null => {
      const body = (fn as ts.FunctionLikeDeclaration).body;
      if (!body) return null;
      if (ts.isBlock(body)) {
        let found: ts.ObjectLiteralExpression | null = null;
        const seek = (n: ts.Node): void => {
          if (found) return;
          if (ts.isReturnStatement(n) && n.expression) {
            const e = unwrap(n.expression);
            if (ts.isObjectLiteralExpression(e)) { found = e; return; }
          }
          ts.forEachChild(n, seek);
        };
        seek(body);
        return found;
      }
      const b = unwrap(body as ts.Expression);
      return ts.isObjectLiteralExpression(b) ? b : null;
    };

    const isNullish = (x: ts.Expression): boolean => {
      const u = unwrap(x);
      return (ts.isIdentifier(u) && u.text === "undefined") || u.kind === ts.SyntaxKind.NullKeyword ||
             (ts.isStringLiteral(u) && u.text === "");
    };
    const isOr = (k: ts.SyntaxKind) => k === ts.SyntaxKind.AmpersandAmpersandToken ||
      k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken;

    type Bag = { always: Map<string, true>; maybe: Map<string, true> };
    const empty = (): Bag => ({ always: new Map(), maybe: new Map() });
    const branches = (t: Bag, f: Bag, out: Bag) => {
      t.always.forEach((v, k) => (f.always.has(k) ? out.always : out.maybe).set(k, v));
      f.always.forEach((v, k) => { if (!t.always.has(k)) out.maybe.set(k, v); });
      t.maybe.forEach((v, k) => out.maybe.set(k, v));
      f.maybe.forEach((v, k) => out.maybe.set(k, v));
    };
    const maybeAll = (r: Bag, out: Bag) => {
      r.always.forEach((v, k) => out.maybe.set(k, v));
      r.maybe.forEach((v, k) => out.maybe.set(k, v));
    };

    function props(expr: ts.Expression | undefined, depth: number): Bag {
      const out = empty();
      if (!expr || depth > 8) return out;
      const e = unwrap(expr);
      if (ts.isObjectLiteralExpression(e)) {
        e.properties.forEach((p) => {
          if (ts.isSpreadAssignment(p)) {
            const sp = unwrap(p.expression);
            if (ts.isConditionalExpression(sp)) branches(props(sp.whenTrue, depth + 1), props(sp.whenFalse, depth + 1), out);
            else if (ts.isBinaryExpression(sp) && isOr(sp.operatorToken.kind)) maybeAll(props(sp.right, depth + 1), out);
            else { const r = props(sp, depth + 1); r.always.forEach((v, k) => out.always.set(k, v)); r.maybe.forEach((v, k) => out.maybe.set(k, v)); }
          } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
            const nm = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
            if (!nm) return;
            if (!isBorder(nm)) return;
            let removable = false;
            if (ts.isPropertyAssignment(p)) {
              const v = unwrap(p.initializer);
              if (ts.isConditionalExpression(v)) removable = isNullish(v.whenTrue) || isNullish(v.whenFalse);
              else if (ts.isBinaryExpression(v) && isOr(v.operatorToken.kind)) removable = true;
            }
            (removable ? out.maybe : out.always).set(nm, true);
          }
        });
        return out;
      }
      if (ts.isConditionalExpression(e)) { branches(props(e.whenTrue, depth + 1), props(e.whenFalse, depth + 1), out); return out; }
      if (ts.isBinaryExpression(e) && isOr(e.operatorToken.kind)) { maybeAll(props(e.right, depth + 1), out); return out; }
      if (ts.isPropertyAccessExpression(e) || ts.isIdentifier(e)) {
        const key = e.getText(sf);
        const obj = objects.get(key) || objects.get(key.split(".").slice(-2).join("."));
        if (obj) { const r = props(obj, depth + 1); r.always.forEach((v, k) => out.always.set(k, v)); r.maybe.forEach((v, k) => out.maybe.set(k, v)); }
        return out;
      }
      if (ts.isCallExpression(e)) {
        const name = e.expression.getText(sf);
        const fn = funcs.get(name) || funcs.get(name.split(".").pop() as string);
        if (fn) { const obj = returnedObject(fn);
          if (obj) { const r = props(obj, depth + 1); r.always.forEach((v, k) => out.always.set(k, v)); r.maybe.forEach((v, k) => out.maybe.set(k, v)); } }
        return out;
      }
      return out;
    }

    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name && node.name.getText(sf) === "style" && node.initializer) {
        const init = node.initializer;
        const expr = ts.isJsxExpression(init) ? init.expression : undefined;
        if (expr) {
          const { always, maybe } = props(expr, 0);
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          /* A property the base ALSO declares unconditionally cannot be removed -- React sees a change and
             re-applies it. `StockRoundPanel`'s `projectionBlock` declares both `borderTop` and
             `borderTopColor` for exactly this reason, and is correct. */
          const baseObj: Record<string, true> = {};
          const overlayObj: Record<string, true> = {};
          always.forEach((_v, k) => { baseObj[k] = true; });
          maybe.forEach((_v, k) => { if (!always.has(k)) overlayObj[k] = true; });
          for (const clash of shorthandClashes(baseObj, overlayObj)) {
            found.push(`line ${line}: unconditional \`${clash.shorthand}\` + removable \`${clash.longhand}\``);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  it("no JSX style attribute composes a removable border longhand over an unconditional shorthand", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if ((name.endsWith(".tsx") || name.endsWith(".ts")) && !name.includes(".test.")) files.push(p);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const f of files) {
      for (const hit of offenders(f, fs.readFileSync(f, "utf8"))) bad.push(`${path.relative(SRC, f)}: ${hit}`);
    }
    expect(bad).toEqual([]);
  });
});
