// frontend/src/components/lobbyDesignCss.ts
//
// PLAY LOBBY (approved design, "play-lobby-handoff" mockup/lobby.css): the lobby's stylesheet -- the header, the
// Departures and Under way boards, the split-flap cells, the seated list and the footer -- with the design's tokens,
// three widths (wide, 641-1080, phone) and reduced motion. One stylesheet string because a media query, a keyframe and
// a font face cannot be inline styles (design note #46's standing exception); every selector is under `.lb` or
// prefixed `lb-`, so nothing here reaches another screen. The breakpoints go through `zoomAwareMediaCss` at the mount,
// so they switch at the same effective width at every text size (W1-O).
//
// Fonts: Anton (display) and IBM Plex Mono 400/500/600 (data, flaps, clock), served from /fonts with their OFL
// licences; the UI copy stays in Play's system sans.

const PUBLIC = typeof process !== "undefined" && process.env && process.env.PUBLIC_URL ? process.env.PUBLIC_URL : "";

export const LOBBY_DESIGN_CSS = `
@font-face { font-family: "Anton"; src: url("${PUBLIC}/fonts/Anton-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("${PUBLIC}/fonts/IBMPlexMono-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("${PUBLIC}/fonts/IBMPlexMono-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("${PUBLIC}/fonts/IBMPlexMono-SemiBold.woff2") format("woff2"); font-weight: 600; font-display: swap; }

.lb {
  --lb-ink: #080808; --lb-panel: #0f0f0f; --lb-rule: #2a2a2a;
  --lb-text: #f2f0eb; --lb-dim: #c8c6c0; --lb-muted: #8a8a86;
  /* The design's faint step (#6e6c68) is 3.6-3.8:1 on the boards' grounds; #82807b is the nearest step that clears
     WCAG AA (4.5:1) on every ground it sits on (the seated list's #16120e included). */
  --lb-faint: #82807b;
  --lb-board: #0b0907; --lb-board-2: #0d0d0e; --lb-flap: #1a1612; --lb-flap-lo: #14110e;
  --lb-gold: #d7b56e; --lb-gilt: #f8e5a3; --lb-deep: #a78445;
  --lb-call: #ff8a5c; --lb-ante: #e052a6; --lb-paid: #7ee0a1;
  --lb-display: "Anton", "Impact", "Arial Narrow", sans-serif;
  --lb-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --lb-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--lb-text); font: 14px/1.5 var(--lb-sans);
  width: 100%; max-width: 1200px; margin-inline: auto; box-sizing: border-box;
}
.lb *, .lb *::before, .lb *::after { box-sizing: border-box; }
/* Zero specificity, so every button class below (Join, Watch, the doors, the filters) sets its own font and colour. */
:where(.lb) :where(button) { font: inherit; color: inherit; }
.lb button:focus-visible, .lb a:focus-visible { outline: 2px solid var(--lb-gilt); outline-offset: 2px; }
.lb-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* ---------------- the header: Ludum's lockup for Project 18XX, and the boardroom ---------------- */
.lb-hero { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); align-items: stretch; gap: 20px 24px; padding-block: 12px 28px; }
.lb-hero-l { position: relative; z-index: 1; display: grid; gap: 22px; align-content: end; min-width: 0; }
.lb-hero-art { --d: 96px; position: relative; container-type: size; min-height: 240px; margin: 0; min-width: 0; overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, transparent 14%, #000 56%, #000 86%, transparent 100%), linear-gradient(180deg, transparent 0%, #000 14%, #000 78%, transparent 100%);
  -webkit-mask-composite: source-in;
  mask-image: linear-gradient(90deg, transparent 0%, transparent 14%, #000 56%, #000 86%, transparent 100%), linear-gradient(180deg, transparent 0%, #000 14%, #000 78%, transparent 100%);
  mask-composite: intersect; }
.lb-hero-art img { position: absolute; max-width: none; width: auto; height: calc(100cqh / .6); top: calc(100cqh / .6 * -.1);
  right: calc((100cqh / .6 * 1.9397 * .28 - var(--d)) * -1); filter: brightness(.94) contrast(1.22); }
.lb-lockup { margin: 0; font-weight: 400; line-height: 1; }
.lb-lockup .lb-name { display: block; font: 400 44px/.88 var(--lb-display); text-transform: uppercase; color: var(--lb-text); margin-bottom: 14px; }
.lb-lockup .lb-num { display: block; font: 400 116px/.8 var(--lb-display); letter-spacing: -.01em; padding-block: .06em; margin-block: -.06em;
  background: linear-gradient(180deg, var(--lb-gilt) 0%, var(--lb-gold) 42%, var(--lb-deep) 58%, var(--lb-gold) 74%, var(--lb-gilt) 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: var(--lb-gold); }
.lb-dek { margin: 0; max-width: 46ch; color: var(--lb-dim); font-size: 15px; line-height: 1.55; }
.lb-doors { display: flex; gap: 10px; flex-wrap: wrap; }
.lb-btn { font: 700 15px/1 var(--lb-sans); padding: 13px 20px; border-radius: 10px; border: 1px solid #3a3a3a; background: #1c1c1c; color: var(--lb-text); cursor: pointer; }
.lb-btn.lb-primary { background: var(--lb-gold); border-color: var(--lb-gold); color: #120d06; }
.lb-btn:disabled { opacity: .55; cursor: default; }
.lb-door-error { margin: 0; font: 600 13px/1.45 var(--lb-sans); color: #ffb4a2; max-width: 52ch; }

/* ---------------- a board ---------------- */
.lb-board { background: var(--lb-board); border: 1px solid #221d17; border-radius: 6px; box-shadow: 0 0 0 6px #120f0c, 0 0 0 7px #221d17, 0 24px 60px rgba(0,0,0,.6); margin: 0 7px 36px; overflow: hidden; }
.lb-head { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 12px 24px; padding: 18px 22px 14px; border-bottom: 2px solid var(--lb-gold); }
.lb-head h2 { margin: 0; font: 400 44px/.9 var(--lb-display); text-transform: uppercase; letter-spacing: .01em; color: var(--lb-text); display: flex; align-items: baseline; gap: 14px; }
.lb-head h2 .lb-count { font: 500 13px/1 var(--lb-mono); letter-spacing: .08em; color: var(--lb-muted); text-transform: uppercase; }
.lb-tools { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
.lb-seg { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 6px; background: #17130f; border: 1px solid #2a231b; }
.lb-seg button { display: inline-flex; align-items: center; gap: 6px; font: 600 11px/1 var(--lb-mono); letter-spacing: .08em; text-transform: uppercase; padding: 7px 10px; border: 0; border-radius: 4px; background: none; color: var(--lb-muted); cursor: pointer; }
.lb-seg button[aria-checked="true"] { background: #2a2219; color: var(--lb-text); }
.lb-seg button i { width: 8px; height: 8px; border-radius: 1px; background: var(--ed); }
.lb-clock { font: 500 13px/1 var(--lb-mono); letter-spacing: .08em; color: var(--lb-gold); font-variant-numeric: tabular-nums; }

.lb-row, .lb-cols { display: grid; grid-template-columns: 58px minmax(0, 1fr) 122px 150px 164px 150px; column-gap: 16px; align-items: center; }
.lb-cols { padding: 10px 22px 8px; border-bottom: 1px solid #241e17; font: 500 11px/14px var(--lb-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--lb-faint); }
.lb-rows { list-style: none; margin: 0; padding: 0; }
.lb-row { position: relative; padding: 14px 22px 14px 26px; border-bottom: 1px solid #1c1813; box-shadow: inset 4px 0 0 var(--ed); transition: background-color .3s; }
.lb-row.lb-ping { animation: lb-ping 1.4s ease-out; }
@keyframes lb-ping { 0% { background-color: color-mix(in srgb, var(--ed) 26%, transparent); } 100% { background-color: transparent; } }
.lb-row.lb-leaving { transition: height .45s ease, opacity .45s ease, padding .45s ease; overflow: hidden; }
.lb-when { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; gap: 10px; align-self: stretch; padding-block: 5px 1px; }
.lb-time { font: 500 14px/1 var(--lb-mono); color: var(--lb-muted); font-variant-numeric: tabular-nums; }
.lb-when .lb-flap .lb-cell { font-size: 12px; color: var(--lb-dim); }
.lb-tbl { min-width: 0; display: grid; gap: 5px; }
.lb-ed { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.lb-ed .lb-nm { font: 400 26px/1 var(--lb-display); text-transform: uppercase; color: var(--ed); letter-spacing: .01em; }
.lb-ed .lb-nm .lb-plus { position: relative; top: -.34em; font-size: .9em; margin-left: .03em; }
.lb-ed .lb-bank { font: 500 12px/1 var(--lb-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--lb-dim); }
.lb-meta { display: flex; flex-wrap: wrap; gap: 2px 18px; font: 400 12.5px/1.45 var(--lb-mono); color: var(--lb-dim); min-width: 0; }
.lb-meta > span { min-width: 0; overflow-wrap: anywhere; }
.lb-meta em { font-style: normal; color: var(--lb-faint); margin-right: 6px; }
.lb-seatbtn { position: relative; display: grid; justify-items: start; gap: 6px; padding: 6px 26px 6px 8px; margin: -6px -8px; border: 1px solid #2a241c; border-radius: 6px; background: none; cursor: pointer; text-align: left; }
.lb-seatbtn::after { content: ""; position: absolute; right: 9px; top: 50%; width: 6px; height: 6px; border-right: 1.5px solid var(--lb-muted); border-bottom: 1.5px solid var(--lb-muted); transform: translateY(-70%) rotate(45deg); }
.lb-seatbtn[aria-expanded="true"]::after { transform: translateY(-30%) rotate(225deg); }
.lb-seatbtn:hover, .lb-seatbtn[aria-expanded="true"] { border-color: #4a3f31; background: #15110d; }
.lb-pips { display: flex; flex-wrap: wrap; gap: 3px; }
.lb-pips i { width: 8px; height: 8px; border: 1px solid #5a4d3c; }
.lb-pips i.lb-on { background: var(--ed); border-color: var(--ed); }
.lb-lab { font: 500 10px/1 var(--lb-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--lb-faint); }
.lb-ante { font: 500 13px/1.3 var(--lb-mono); color: var(--lb-text); min-width: 0; }
.lb-ante .lb-amt { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 7px; color: var(--lb-ante); font-weight: 600; }
.lb-ante em { font-style: normal; font-weight: 500; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--lb-faint); }
.lb-ante small { display: block; margin-top: 6px; font-size: 11px; color: var(--lb-muted); }
.lb-ante.lb-none { color: var(--lb-faint); }
.lb-act { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
.lb-join, .lb-watch { font: 700 13px/1 var(--lb-sans); padding: 9px 14px; border-radius: 8px; cursor: pointer; }
.lb-join { background: var(--lb-text); color: var(--lb-ink); border: 1px solid var(--lb-text); }
.lb-watch { background: none; color: var(--lb-muted); border: 1px solid #3a342c; font-weight: 600; }
.lb-join:disabled, .lb-watch:disabled { opacity: .55; cursor: default; }
.lb-only { font: 500 11px/1.3 var(--lb-mono); letter-spacing: .06em; color: var(--lb-faint); text-align: right; }
.lb-row:hover { background: #120f0c; }
.lb-refusal { padding: 10px 22px 12px 26px; border-bottom: 1px solid #1c1813; font: 600 13px/1.45 var(--lb-sans); color: #ffb4a2; }

/* ---------------- split-flap cells ---------------- */
.lb-flap { display: inline-flex; }
.lb-cells { display: inline-flex; gap: 2px; }
.lb-cell { position: relative; display: inline-grid; place-items: center; width: .82em; height: 1.42em; font: 600 17px/1 var(--lb-mono); color: var(--lb-text);
  background: linear-gradient(var(--lb-flap) 0 50%, var(--lb-flap-lo) 50% 100%); border-radius: 2px; box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 1px 0 #000; overflow: hidden; white-space: pre; }
.lb-cell::after { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: #050403; }
.lb-cell.lb-flip::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 50%; background: var(--lb-flap); transform-origin: 50% 100%; animation: lb-fold .07s linear forwards; z-index: 1; }
@keyframes lb-fold { from { transform: scaleY(1); } to { transform: scaleY(0); } }
.lb-flap.lb-sm .lb-cell { font-size: 14px; }
.lb-st-boarding .lb-cell { color: var(--lb-text); }
.lb-st-final-call .lb-cell { color: var(--lb-call); }
.lb-st-full .lb-cell { color: var(--lb-muted); }
.lb-st-under-way .lb-cell { color: var(--lb-gold); }

.lb-foot-note { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; padding: 14px 22px 16px; font: 400 12px/1.5 var(--lb-mono); color: var(--lb-muted); }
.lb-empty { padding: 18px 22px; font: 400 13px/1.5 var(--lb-mono); color: var(--lb-muted); list-style: none; }
.lb-status { padding: 18px 22px; margin: 0; font: 400 13px/1.5 var(--lb-mono); color: var(--lb-muted); }
.lb-status.lb-warn { color: #ffb4a2; }

/* ---------------- the second board: games under way ---------------- */
.lb-board.lb-under { background: var(--lb-board-2); }
.lb-under .lb-head { border-bottom-color: #3a3a3a; }
.lb-under .lb-head h2 { font-size: 34px; color: var(--lb-dim); }
.lb-under[data-open="false"] .lb-head { border-bottom-color: transparent; }
.lb-under[data-open="false"] .lb-body { display: none; }
.lb-toggle { font: 600 12px/1 var(--lb-mono); letter-spacing: .08em; text-transform: uppercase; padding: 9px 12px; border-radius: 6px; border: 1px solid #3a3a3a; background: #151515; color: var(--lb-dim); cursor: pointer; }
.lb-under .lb-row, .lb-under .lb-cols { grid-template-columns: 58px minmax(0, 1fr) 120px 190px 96px; }
.lb-under .lb-row { padding-block: 11px; border-bottom-color: #19191a; }
.lb-under .lb-ed .lb-nm { font-size: 22px; }

/* ---------------- the seated players ---------------- */
.lb-pop { position: fixed; z-index: 40; width: 340px; max-height: calc(100vh - 32px); overflow-y: auto; max-width: calc(100vw - 32px); background: #16120e; border: 1px solid #3a3128; border-radius: 10px; box-shadow: 0 18px 40px rgba(0,0,0,.6); padding: 14px 16px 12px; color: var(--lb-text); font: 14px/1.5 var(--lb-sans); }
.lb-pop h3 { margin: 0 0 8px; display: flex; justify-content: space-between; align-items: baseline; font: 600 11px/1 var(--lb-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--lb-muted); }
.lb-pop h3 button { border: 0; background: none; color: var(--lb-muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
.lb-pop ul { list-style: none; margin: 0; padding: 0; }
.lb-pop li { padding: 0; border-top: 1px solid #241e17; font: 400 13px/1.3 var(--lb-sans); color: var(--lb-text); }
.lb-pop li:first-child { border-top: 0; }
.lb-pop li.lb-open { padding: 8px 0; color: var(--lb-faint); font-style: italic; }
.lb-who { width: 100%; display: flex; align-items: baseline; gap: 10px; padding: 8px 2px; border: 0; background: none; cursor: pointer; text-align: left; color: var(--lb-text); }
.lb-who b { font-weight: 600; overflow-wrap: anywhere; }
.lb-who .lb-tag { font: 500 11px/1.3 var(--lb-mono); color: var(--lb-muted); }
.lb-who .lb-fund { margin-left: auto; font: 500 11px/1.3 var(--lb-mono); color: var(--lb-muted); white-space: nowrap; }
.lb-who .lb-fund.lb-paid { color: var(--lb-paid); }
.lb-who::after { content: ""; flex: none; width: 5px; height: 5px; margin-left: 4px; border-right: 1.5px solid var(--lb-muted); border-bottom: 1.5px solid var(--lb-muted); transform: translateY(-2px) rotate(45deg); }
.lb-who:not(:has(.lb-fund))::after { margin-left: auto; }
.lb-who[aria-expanded="true"]::after { transform: translateY(1px) rotate(225deg); }
.lb-who:hover b { text-decoration: underline; text-underline-offset: 3px; }
.lb-facts { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: #0f0c09; border: 1px solid #241e17; }
.lb-facts dt { margin: 6px 0 3px; font: 600 10px/1.2 var(--lb-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--lb-faint); }
.lb-facts dt:first-child { margin-top: 0; }
.lb-facts dd { margin: 0 0 2px; font: 400 12.5px/1.45 var(--lb-sans); color: var(--lb-dim); }
.lb-facts dd.lb-fin { display: flex; flex-wrap: wrap; gap: 2px 12px; font-family: var(--lb-mono); font-size: 12px; }
.lb-facts dd.lb-res { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 8px; font-family: var(--lb-mono); font-size: 12px; }
.lb-facts dd.lb-res b { font-weight: 600; color: var(--lb-text); }
.lb-pop p { margin: 8px 0 0; font: 400 12px/1.45 var(--lb-mono); color: var(--lb-muted); }
.lb-pop p.lb-agg { margin: 0 0 8px; padding-bottom: 8px; border-bottom: 1px solid #241e17; font: 500 12px/1.4 var(--lb-mono); color: var(--lb-ante); }
.lb-pop p.lb-agg em { font-style: normal; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--lb-faint); margin-right: 8px; }
.lb-pop p.lb-disc { font-size: 11px; color: var(--lb-faint); }

/* ---------------- the footer ---------------- */
.lb-footer { margin-top: auto; padding: 8px 16px 28px; display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 10px 28px; font: 700 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #c8c6c0; }
.lb-footer a { color: #c8c6c0; text-decoration: none; display: inline-flex; align-items: baseline; gap: 10px; }
.lb-footer a:hover span, .lb-footer a:focus-visible span { color: #f2f0eb; text-decoration: underline; text-underline-offset: 3px; }
.lb-footer a:focus-visible { outline: 2px solid #f8e5a3; outline-offset: 2px; }
.lb-footer .lb-lw { font: 400 20px/1 "Anton", "Impact", "Arial Narrow", sans-serif; letter-spacing: .01em; color: #f2f0eb; text-decoration: none !important; }
.lb-footer .lb-sep { width: 1px; height: 18px; background: #2a2a2a; }
@media (max-width: 640px) { .lb-footer { flex-direction: column; } .lb-footer .lb-sep { display: none; } }

/* ---------------- medium: rows on two lines ---------------- */
@media (max-width: 1080px) {
  .lb-row, .lb-cols { grid-template-columns: 52px minmax(0, 1fr) 120px 164px; row-gap: 12px; }
  .lb-row .lb-when { display: contents; }
  .lb-row .lb-time { grid-column: 1; grid-row: 1; }
  .lb-row .lb-f-code { grid-column: 1; grid-row: 2; align-self: center; }
  .lb-cols .lb-c-ante, .lb-cols .lb-c-act { display: none; }
  .lb-row .lb-ante { grid-column: 2; grid-row: 2; }
  .lb-row .lb-act { grid-column: 3 / 5; grid-row: 2; }
  .lb-under .lb-row, .lb-under .lb-cols { grid-template-columns: 52px minmax(0, 1fr) 110px 96px; }
  .lb-under .lb-row .lb-ante { grid-column: 2; grid-row: 2; }
  .lb-under .lb-row .lb-act { grid-column: 4; grid-row: 1; }
}
/* ---------------- phone: cards, a stacked header, the seated list as a bottom sheet ---------------- */
@media (max-width: 640px) {
  /* the drawing is a full-width backdrop (230px, bleeding over the 16px gutters, the man at the head of the table 40px
     from the right edge) with the title set into its lower left, in front of it; the line, the buttons and any
     refusal run full width below, 22px apart (design handoff §2, §9) */
  .lb-hero { grid-template-columns: minmax(0, 1fr); grid-template-areas: "top" "dek" "doors"; row-gap: 22px; padding-block: 4px 24px; }
  .lb-hero-l { display: contents; }
  .lb-lockup { grid-area: top; align-self: end; position: relative; z-index: 1; padding-bottom: 4px; }
  .lb-dek { grid-area: dek; } .lb-doors { grid-area: doors; } .lb-door-error { grid-row: 4; }
  .lb-hero-art { grid-area: top; --d: 40px; align-self: stretch; height: 230px; min-height: 0; margin: 0 -16px;
    -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 30%, #000 92%, transparent 100%), linear-gradient(180deg, transparent 0%, #000 12%, #000 70%, transparent 100%);
    mask-image: linear-gradient(90deg, transparent 0%, #000 30%, #000 92%, transparent 100%), linear-gradient(180deg, transparent 0%, #000 12%, #000 70%, transparent 100%); }
  .lb-lockup .lb-name { font-size: 30px; margin-bottom: 10px; }
  .lb-lockup .lb-num { font-size: 80px; }
  .lb-head h2 { font-size: 34px; }
  .lb-under .lb-head h2 { font-size: 28px; }
  .lb-head, .lb-cols, .lb-row, .lb-foot-note, .lb-empty, .lb-status, .lb-refusal { padding-left: 14px; padding-right: 14px; }
  .lb-row { padding-left: 18px; }
  .lb-cols { display: none; }
  .lb-row, .lb-under .lb-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 10px; }
  .lb-row .lb-when { grid-column: 2; grid-row: 3; justify-self: end; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .lb-under .lb-row .lb-when { grid-row: 3; }
  .lb-row .lb-tbl { grid-column: 1 / 3; }
  .lb-row .lb-seats { grid-column: 1; grid-row: 2; }
  .lb-row .lb-st { grid-column: 2; grid-row: 2; justify-self: end; }
  .lb-row .lb-ante { grid-column: 1; grid-row: 3; }
  .lb-row .lb-act { grid-column: 1 / 3; grid-row: 4; justify-content: flex-start; }
  .lb-under .lb-row .lb-seats { grid-column: 1; grid-row: 2; }
  .lb-under .lb-row .lb-ante { grid-column: 1; grid-row: 3; }
  .lb-under .lb-row .lb-act { grid-column: 2; grid-row: 2; justify-content: flex-end; }
  .lb-cell { font-size: 15px; }
  .lb-st .lb-cell { font-size: 13px; }
  .lb-pop { left: 16px !important; right: 16px; top: auto !important; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); width: auto; max-width: none; max-height: 70vh; }
}
@media (prefers-reduced-motion: reduce) { .lb-row.lb-ping { animation: none; } .lb-cell.lb-flip::before { animation: none; display: none; } .lb-row.lb-leaving { transition: none; } }
html[data-motion="reduced"] .lb-row.lb-ping { animation: none; } html[data-motion="reduced"] .lb-cell.lb-flip::before { animation: none; display: none; } html[data-motion="reduced"] .lb-row.lb-leaving { transition: none; }
`;
