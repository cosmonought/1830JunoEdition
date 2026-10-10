// frontend/src/components/room/roomDesignCss.ts
//
// PLAY HOST A GAME + WAITING ROOM (approved design, "play-host-waiting-handoff" mockup/room.css): the two screens'
// stylesheet -- the tokens (§2), the sign (§5), the boarding passes on rag paper and their tear (§6), your pass's two halves,
// the Boarding board (§8), the settings (§9), the host dialog (§3), three widths (wide, 761-1080, phone, §14) and
// reduced motion (§15). One stylesheet string because a media query, a keyframe and a font face cannot be inline styles
// (design note #46's standing exception). Every selector is under `.rm` (the waiting room) or `.rh` (the host dialog,
// which is a native dialog in the top layer) and every class is `rm-` prefixed -- so nothing here reaches the controls
// this screen hosts from elsewhere ("Confirm it's you", the tablemate facts, the report form). The split-flap cells are
// the lobby's own `SplitFlap` (`lb-` classes), styled here for these two roots. The breakpoints go through
// `zoomAwareMediaCss` at the mount, so they switch at the same effective width at every text size (W1-O).
//
// THE ONE CHANGE TO A TOKEN: `--rm-faint` is #82807b, not the design's #6e6c68 -- the lobby's own correction, the
// nearest step that clears WCAG AA (4.5:1) on every board ground it sits on.

const PUBLIC = typeof process !== "undefined" && process.env && process.env.PUBLIC_URL ? process.env.PUBLIC_URL : "";

/** The paper of the boarding passes (handoff §1: a 512 x 512 seamless tile of heavy cotton-rag stock). */
export const RAG_PAPER_URL = `${PUBLIC}/images/rag-paper.jpg`;

export const ROOM_DESIGN_CSS = `
@font-face { font-family: "Anton"; src: url("${PUBLIC}/fonts/Anton-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("${PUBLIC}/fonts/IBMPlexMono-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("${PUBLIC}/fonts/IBMPlexMono-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("${PUBLIC}/fonts/IBMPlexMono-SemiBold.woff2") format("woff2"); font-weight: 600; font-display: swap; }

.rm, .rh {
  --rm-ink: #080808; --rm-panel: #0f0f0f; --rm-rule: #2a2a2a;
  --rm-text: #f2f0eb; --rm-dim: #c8c6c0; --rm-muted: #8a8a86; --rm-faint: #82807b;
  --rm-board: #0b0907; --rm-line: #241e17; --rm-edge: #3a3128;
  --rm-gold: #d7b56e; --rm-gilt: #f8e5a3; --rm-deep: #a78445;
  --rm-e-18xx: #d7b56e; --rm-e-plus: #59b578; --rm-e-lpf: #5b8ef0;
  --rm-call: #ff8a5c; --rm-ante: #e052a6; --rm-ok: #7ee0a1; --rm-warn: #ff9b8a; --rm-chaos: #b9a2ff;
  --rm-rag: url("${RAG_PAPER_URL}");
  --rm-display: "Anton", "Impact", "Arial Narrow", sans-serif;
  --rm-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --rm-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  /* the lobby's flap tokens, for SplitFlap's cells */
  --lb-flap: #1a1612; --lb-flap-lo: #14110e; --lb-text: #f2f0eb; --lb-mono: var(--rm-mono);
  color: var(--rm-text); font: 14px/1.5 var(--rm-sans);
}
.rm *, .rm *::before, .rm *::after, .rh *, .rh *::before, .rh *::after { box-sizing: border-box; }
/* Zero specificity, so every button class below sets its own font and colour. */
:where(.rm, .rh) :where(button, input) { font: inherit; color: inherit; }
.rm button:focus-visible, .rm input:focus-visible, .rm a:focus-visible, .rm summary:focus-visible,
.rh button:focus-visible, .rh input:focus-visible, .rh a:focus-visible, .rh summary:focus-visible { outline: 2px solid var(--rm-gilt); outline-offset: 2px; }
.rm-sr, .rm .lb-sr, .rh .lb-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* ---- the page */
.rm { min-height: 100vh; display: flex; flex-direction: column; background: var(--rm-ink); }
.rm-wrap { width: 100%; max-width: 1200px; margin-inline: auto; padding-inline: 16px; }

/* ---- split-flap cells (the lobby's) */
.rm .lb-flap, .rh .lb-flap { display: inline-flex; vertical-align: middle; }
.rm .lb-cells, .rh .lb-cells { display: inline-flex; gap: 2px; }
.rm .lb-cell, .rh .lb-cell { position: relative; display: inline-grid; place-items: center; width: .82em; height: 1.42em; font: 600 17px/1 var(--rm-mono); color: var(--rm-text);
  background: linear-gradient(var(--lb-flap) 0 50%, var(--lb-flap-lo) 50% 100%); border-radius: 2px; box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 1px 0 #000; overflow: hidden; white-space: pre; }
.rm .lb-cell::after, .rh .lb-cell::after { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: #050403; }
.rm .lb-cell.lb-flip::before, .rh .lb-cell.lb-flip::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 50%; background: var(--lb-flap); transform-origin: 50% 100%; animation: rm-fold .07s linear forwards; z-index: 1; }
@keyframes rm-fold { from { transform: scaleY(1); } to { transform: scaleY(0); } }
.rm-flap-lg .lb-cell { font-size: 30px !important; }
.rm-flap-sm .lb-cell { font-size: 14px !important; }
.rm-flap-xs .lb-cell { font-size: 12px !important; color: var(--rm-dim) !important; }
.rm-flap-pink .lb-cell { color: var(--rm-ante) !important; }
.rm-flap-gold .lb-cell { font-size: 16px !important; color: var(--rm-gold) !important; }
.rm .lb-st-boarding .lb-cell, .rh .lb-st-boarding .lb-cell { color: var(--rm-text); }
.rm .lb-st-final-call .lb-cell { color: var(--rm-call); }
.rm .lb-st-full .lb-cell { color: var(--rm-muted); }
.rm .lb-st-under-way .lb-cell { color: var(--rm-gold); }

.rm-lab { font: 500 10px/1.2 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--rm-faint); }
.rm-kick { font: 600 11px/1 var(--rm-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--rm-gold); }
.rm-pips { display: inline-flex; gap: 3px; vertical-align: middle; }
.rm-pips i { width: 8px; height: 8px; border: 1px solid #5a4d3c; }
.rm-pips i.rm-on { background: var(--rm-ed); border-color: var(--rm-ed); }

/* ---- the lockup: Project 18XX's title type */
.rm-lockup { margin: 0; font-weight: 400; line-height: 1; justify-self: start; }
.rm-lockup .rm-name { display: block; font: 400 36px/.88 var(--rm-display); text-transform: uppercase; color: var(--rm-text); margin-bottom: 10px; }
.rm-lockup .rm-num { display: block; font: 400 116px/.8 var(--rm-display); letter-spacing: -.01em; white-space: nowrap; padding-block: .06em; margin-block: -.06em;
  background: linear-gradient(180deg, var(--rm-gilt) 0%, var(--rm-gold) 42%, var(--rm-deep) 58%, var(--rm-gold) 74%, var(--rm-gilt) 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: var(--rm-gold); }
.rm-lockup .rm-plus { display: inline-block; line-height: .8; padding-block: .06em; margin-block: -.06em; transform: translateY(-.395em); margin-left: .02em;
  background: inherit; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.rm-lockup .rm-sub { display: block; margin-top: 10px; font: 600 12px/1 var(--rm-mono); letter-spacing: .28em; text-transform: uppercase; color: var(--rm-gold); white-space: nowrap; }

/* ---- the sign: this table's departure */
.rm-gate { --rm-ed: var(--rm-e-18xx); position: relative; margin: 8px 0 34px; background: var(--rm-board); border: 1px solid #221d17; border-radius: 6px;
  box-shadow: inset 6px 0 0 var(--rm-ed), 0 0 0 6px #120f0c, 0 0 0 7px #221d17, 0 24px 60px rgba(0,0,0,.6); overflow: hidden; }
.rm-g-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px 24px; padding: 14px 22px 12px 28px; border-bottom: 2px solid var(--rm-gold); }
.rm-g-top-r { display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; }
.rm-g-four { display: inline-flex; align-items: center; gap: 10px; }
.rm-clock { font: 500 13px/1 var(--rm-mono); letter-spacing: .08em; color: var(--rm-gold); font-variant-numeric: tabular-nums; }
.rm-g-main { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 26px 40px; align-items: end; padding: 24px 22px 24px 34px; }
.rm-g-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 24px; margin: 0; }
.rm-g-fields > div { min-width: 0; }
.rm-g-fields .rm-g-st { grid-column: 1 / -1; }
.rm-g-fields dt { font: 500 10px/1.2 var(--rm-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--rm-faint); margin-bottom: 8px; }
.rm-g-fields dd { margin: 0; font: 500 15px/1.3 var(--rm-mono); color: var(--rm-text); display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.rm-g-fields dd small { flex-basis: 100%; font: 400 12px/1.35 var(--rm-mono); color: var(--rm-muted); }
.rm-g-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 32px; padding: 12px 22px 14px 34px; border-top: 1px solid var(--rm-line); background: #0d0b09; }
.rm-roomline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.rm-code { font: 600 15px/1 var(--rm-mono); letter-spacing: .08em; color: var(--rm-text); user-select: all; }
.rm-g-foot p { margin: 0; flex: 1 1 320px; min-width: 0; font-size: 13.5px; color: var(--rm-dim); }

/* ---- buttons */
.rm-btn { font: 700 15px/1 var(--rm-sans) !important; padding: 13px 20px; border-radius: 10px; border: 1px solid #3a3a3a; background: #1c1c1c; color: var(--rm-text) !important; cursor: pointer; }
.rm-btn.rm-primary { background: var(--rm-gold); border-color: var(--rm-gold); color: #120d06 !important; }
.rm-btn:disabled { cursor: not-allowed; background: #17140f; border-color: #2a241c; color: var(--rm-faint) !important; }
.rm-btn.rm-big { font-size: 17px !important; padding: 15px 24px; }
.rm-qbtn { font: 600 12.5px/1 var(--rm-sans) !important; padding: 8px 11px; border-radius: 7px; border: 1px solid #3a342c; background: none; color: var(--rm-dim) !important; cursor: pointer; white-space: nowrap; }
.rm-qbtn:hover:not(:disabled) { border-color: #5a4d3c; color: var(--rm-text) !important; }
.rm-qbtn:disabled { cursor: not-allowed; opacity: .6; }
.rm-qbtn.rm-danger { color: var(--rm-warn) !important; border-color: #5a2f28; }
.rm-qbtn.rm-solid-danger { background: #3a1a15; color: #ffd2c8 !important; border-color: #6a3229; }
.rm-link { border: 0; background: none; padding: 0; font: 600 13px/1.4 var(--rm-sans) !important; color: var(--rm-gold) !important; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; justify-self: start; }

/* ---- boards */
.rm-board { background: var(--rm-board); border: 1px solid #221d17; border-radius: 6px; box-shadow: 0 0 0 6px #120f0c, 0 0 0 7px #221d17, 0 24px 60px rgba(0,0,0,.6); overflow: hidden; min-width: 0; }
.rm-b-head { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 8px 24px; padding: 16px 22px 12px; border-bottom: 2px solid var(--rm-gold); }
.rm-b-head h2 { margin: 0; font: 400 36px/.9 var(--rm-display); text-transform: uppercase; letter-spacing: .01em; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; color: var(--rm-text); }
.rm-b-head h2 .rm-count { font: 500 13px/1 var(--rm-mono); letter-spacing: .08em; color: var(--rm-muted); text-transform: none; }
.rm-b-hint { font: 400 12px/1.4 var(--rm-mono); color: var(--rm-muted); }
.rm-b-foot { padding: 12px 22px 14px; font: 400 12px/1.5 var(--rm-mono); color: var(--rm-muted); border-top: 1px solid var(--rm-line); }

/* ---- your boarding pass: the sign's full width (or the Watching / Removed panel in its place) */
.rm-you-row { display: grid; margin-bottom: 40px; }

/* the boarding passes: heavy cotton-rag stock (each shows its own patch) in warm ink; two pieces joined at a perforation */
.rm-passes { list-style: none; margin: 0; padding: 22px; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 18px 24px; }
.rm-pass { --c: #555; --stub: 86px; --tx: 10px; --ty: 6px; --rot: -2deg;
  --p-ink: #1C1610; --p-ink-2: #3F3426; --p-ink-3: #5F5341; --p-rule: #B2A283; --p-perf: #8C7C60; --p-pink: #A3245F; --p-paper: #D9CAB0;
  position: relative; display: grid; grid-template-columns: minmax(0, 1fr) var(--stub); min-height: 150px; color: var(--p-ink); filter: drop-shadow(0 7px 12px rgba(0,0,0,.5)); }
.rm-pass > .rm-p-main, .rm-pass > .rm-p-stub { background: var(--rm-rag) var(--bx, 0px) var(--by, 0px) / 512px 512px, var(--p-paper); box-shadow: inset 0 0 20px rgba(96, 66, 30, .2); }
.rm-pass::before, .rm-pass::after { content: ""; position: absolute; z-index: 1; right: calc(var(--stub) - 8px); width: 16px; height: 16px; border-radius: 50%; background: var(--ground, var(--rm-board)); }
.rm-pass::before { top: -8px; } .rm-pass::after { bottom: -8px; }
.rm-p-main { position: relative; display: grid; gap: 8px; align-content: start; min-width: 0; padding: 14px 16px 14px 18px; border: 1px solid var(--p-rule); border-right: 0; border-left: 5px solid var(--c); border-radius: 8px 0 0 8px; }
.rm-p-stub { display: grid; justify-items: center; align-content: space-between; gap: 6px; padding: 14px 8px 12px; border: 1px solid var(--p-rule); border-left: 2px dashed var(--p-perf); border-radius: 0 8px 8px 0; text-align: center; transform-origin: 0 0; }
.rm-pass.rm-you > .rm-p-main { border-top-color: #9C7C3E; border-bottom-color: #9C7C3E; }
.rm-pass.rm-you > .rm-p-stub { border-top-color: #9C7C3E; border-bottom-color: #9C7C3E; border-right-color: #9C7C3E; }
.rm .rm-pass :focus-visible { outline-color: var(--p-ink); }
.rm-pass.rm-open { filter: none; color: var(--rm-faint); }
.rm-pass.rm-open > .rm-p-main, .rm-pass.rm-open > .rm-p-stub { background: transparent; box-shadow: none; border-color: var(--rm-edge); border-style: dashed; }
.rm-pass.rm-open > .rm-p-main { border-left: 1px dashed var(--rm-edge); }
.rm-pass.rm-open::before, .rm-pass.rm-open::after { display: none; }
.rm-p-flat { display: contents; }
.rm-p-kick { font: 500 10px/1.2 var(--rm-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--p-ink-3); }
.rm-p-who { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.rm-pname { min-width: 0; max-width: 100%; padding: 0; border: 0; background: none; cursor: pointer; font: 400 28px/1.05 var(--rm-display) !important; text-transform: uppercase; letter-spacing: .01em; color: var(--p-ink) !important; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rm-pname:hover { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }
.rm-tag { font: 600 10px/1 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; padding: 4px 6px; border: 1px solid var(--p-rule); border-radius: 3px; color: var(--p-ink-2); }
.rm-tag.rm-tag-you { color: #74561C; border-color: #9C7C3E; }
.rm-tag.rm-tag-away { color: var(--p-ink-3); border-style: dashed; }
.rm-p-meta { font: 400 12px/1.4 var(--rm-mono); color: var(--p-ink-2); }
.rm-p-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 2px; }
.rm-openlab { font: italic 400 13px/1.3 var(--rm-mono); color: var(--rm-faint); }
.rm-seatnum { font: 400 38px/.9 var(--rm-display); color: var(--p-ink); }
.rm-p-stub .rm-lab { color: var(--p-ink-3); }
.rm-stub-amt { font: 600 11px/1.2 var(--rm-mono); color: var(--p-pink); overflow-wrap: anywhere; }
.rm-pass.rm-open .rm-p-kick, .rm-pass.rm-open .rm-seatnum, .rm-pass.rm-open .rm-p-stub .rm-lab, .rm-pass.rm-open .rm-stub-amt { color: var(--rm-faint); }
/* the tear */
.rm-pass.rm-torn::before, .rm-pass.rm-torn::after { display: none; }
.rm-pass.rm-torn > .rm-p-main { clip-path: var(--cut-main); }
.rm-pass.rm-torn > .rm-p-stub { clip-path: var(--cut-stub); border-left-color: transparent; transform: translate(var(--tx), var(--ty)) rotate(var(--rot)); }
.rm-pass.rm-tearing > .rm-p-stub { animation: rm-tear .6s cubic-bezier(.3,.6,.2,1) both; }
@keyframes rm-tear { 0% { transform: none; } 20% { transform: translate(1px, -1px) rotate(.7deg); } 100% { transform: translate(var(--tx), var(--ty)) rotate(var(--rot)); } }
.rm-stamp { position: absolute; z-index: 2; right: calc(var(--stub) + 12px); bottom: 14px; transform: rotate(-7deg); padding: 5px 8px 4px; border: 2px solid currentColor; border-radius: 4px;
  font: 400 16px/1 var(--rm-display); letter-spacing: .06em; text-transform: uppercase; color: var(--p-pink); opacity: .88; mix-blend-mode: multiply; pointer-events: none; }
.rm-stamp.rm-sent { opacity: .42; }
.rm-stamp.rm-new { animation: rm-thunk .42s cubic-bezier(.2,.9,.3,1.2) both; }
.rm-pass.rm-tearing .rm-stamp.rm-new { animation-delay: .55s; }
@keyframes rm-thunk { 0% { transform: rotate(-7deg) scale(1.9); opacity: 0; } 65% { transform: rotate(-7deg) scale(.94); opacity: .95; } 100% { transform: rotate(-7deg) scale(1); opacity: .88; } }

/* your own pass, in hand */
.rm-pass.rm-big { --stub: 120px; --ground: var(--rm-ink); --tx: 12px; --ty: 8px; min-height: 230px; }
.rm-pass.rm-big > .rm-p-main { gap: 12px; padding: 20px 22px 20px 26px; border-left-width: 7px; }
.rm-pass.rm-big .rm-pname { font-size: 46px !important; }
.rm-pass.rm-big .rm-p-meta { font-size: 13px; }
.rm-pass.rm-big .rm-seatnum { font-size: 58px; }
.rm-pass.rm-big .rm-stub-amt { font-size: 13px; }
.rm-pass.rm-big .rm-stamp { font-size: 24px; bottom: 22px; right: calc(var(--stub) + 22px); }
.rm-colour { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.rm-colour > span:first-child { font: 600 11px/1 var(--rm-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--p-ink-2); }
.rm-swatches { display: flex; flex-wrap: wrap; gap: 7px; }
.rm-sw { width: 26px; height: 26px; border-radius: 6px; border: 2px solid transparent; background: var(--c); cursor: pointer; padding: 0; box-shadow: 0 0 0 1px rgba(28,22,16,.28); }
.rm-sw[aria-pressed="true"] { border-color: var(--p-ink); box-shadow: 0 0 0 2px var(--p-paper), 0 0 0 3px var(--p-ink); }
.rm-sw:disabled { cursor: not-allowed; opacity: .55; background-image: linear-gradient(135deg, transparent 44%, var(--p-paper) 44% 56%, transparent 56%); }
.rm-keplr { flex-basis: 100%; margin: 0; font: 500 12.5px/1.45 var(--rm-mono); color: var(--p-ink-2); }
/* the pass's controls are printed on paper: ink buttons */
.rm-pass .rm-btn.rm-primary { background: var(--p-ink); border-color: var(--p-ink); color: #EFE5D2 !important; }
.rm-pass .rm-btn:disabled { background: rgba(140,124,96,.2); border-color: var(--p-rule); color: #5F5341 !important; }
.rm-pass .rm-qbtn { color: var(--p-ink-2) !important; border-color: var(--p-rule); }
.rm-pass .rm-qbtn:hover:not(:disabled) { border-color: var(--p-ink-2); color: var(--p-ink) !important; }
.rm-pass .rm-qbtn.rm-danger { color: #9A1E1E !important; border-color: #C29488; }
.rm-pass .rm-qbtn.rm-solid-danger { background: #9A1E1E; color: #F4E9DA !important; border-color: #9A1E1E; }
.rm-pass .rm-why { color: var(--p-ink-3); }
.rm-pass .rm-link { color: var(--p-ink-2) !important; font-weight: 600; }
.rm-pass .rm-link:hover { color: var(--p-ink) !important; }
.rm-pass .rm-err { color: #9A1E1E; }
/* your pass has two halves: who you are (left), and what you do before departure (right) */
.rm-pass.rm-big > .rm-p-main { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 30px; align-content: stretch; }
.rm-p-id, .rm-p-act { display: grid; gap: 12px; align-content: start; min-width: 0; }
.rm-p-act { padding-left: 30px; border-left: 1px dashed var(--p-rule); }
.rm-p-say { margin: 0; font: 600 15px/1.5 var(--rm-sans); color: var(--p-ink); max-width: 46ch; }
.rm-pass .rm-ante-edit { border-color: var(--p-rule); background: rgba(255, 250, 238, .28); }
.rm-pass .rm-ante-edit label { color: var(--p-pink); }
.rm-pass .rm-amount input { background: #EFE5D2; border-color: var(--p-rule); color: var(--p-ink) !important; }
.rm-pass .rm-amount > span { color: var(--p-ink-2); }
/* Play's own money steps (Confirm it's you, the wallet questions, the deposit's terms, the exit confirmations, the
   pending transaction, the escrow details) keep their own dark look: inset on the paper, so they stay legible. */
.rm-pass .rm-money { padding: 10px 12px; border-radius: 8px; background: #121010; color: var(--rm-text); box-shadow: inset 0 0 0 1px rgba(28,22,16,.5); }
.rm-pass .rm-money:empty { display: none; }
/* A stamp (Sent, Boarded) lands at the foot of your pass's right half: room is kept for it there, so the inset money
   steps never sit under it (a multiplied stamp over a dark box would vanish). */
.rm-pass.rm-big:has(> .rm-stamp) > .rm-p-main > .rm-p-act { padding-bottom: 58px; }
.rm-nopass { display: grid; align-content: center; gap: 14px; min-height: 200px; padding: 24px 26px; border: 1px dashed var(--rm-edge); border-radius: 8px; }
.rm-nopass p { margin: 0; color: var(--rm-dim); font-size: 16px; }
.rm-nopass { justify-items: start; min-height: 0; }
.rm-nopass .rm-why { font-size: 13px; color: var(--rm-muted); }
.rm-wtag { justify-self: start; font: 600 11px/1 var(--rm-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--rm-gold); padding: 6px 8px; border: 1px solid #5a4a2c; border-radius: 4px; }

/* before departure */
.rm-sec { display: grid; gap: 14px; align-content: start; min-width: 0; }
.rm-sec > h2, .rm-sec > h3 { margin: 0; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px 12px; padding-bottom: 8px; border-bottom: 2px solid var(--rm-gold);
  font: 400 26px/1 var(--rm-display); text-transform: uppercase; letter-spacing: .01em; color: var(--rm-text); }
.rm-sec > h2 small, .rm-sec > h3 small { font: 400 12px/1.3 var(--rm-mono); letter-spacing: 0; text-transform: none; color: var(--rm-muted); }
.rm-sec.rm-quiet > h2, .rm-sec.rm-quiet > h3 { border-bottom-color: #3a3a3a; font-size: 22px; color: var(--rm-dim); }
.rm-lead { margin: 0; font: 500 15px/1.5 var(--rm-sans); color: var(--rm-gilt); }
.rm-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.rm-why { margin: 0; font: 400 12.5px/1.5 var(--rm-mono); color: var(--rm-muted); }
.rm-err { margin: 0; font: 500 13px/1.5 var(--rm-mono); color: var(--rm-warn); }
.rm-sub-h { margin: 6px 0 0; padding-top: 12px; border-top: 1px solid var(--rm-line); font: 600 10px/1.2 var(--rm-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--rm-faint); }
.rm-ante-edit { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid #4a2a40; border-radius: 8px; background: #140d11; }
.rm-ante-edit label { font: 600 10px/1.2 var(--rm-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--rm-ante); }
.rm-amount { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0; }
.rm-amount input { width: 7em; padding: 9px 10px; border-radius: 7px; border: 1px solid #4a3a44; background: #0f0b0d; color: var(--rm-text) !important; font: 600 16px/1.2 var(--rm-mono) !important; }
.rm-amount > span { font: 600 13px/1 var(--rm-mono); color: var(--rm-dim); }
.rm-skip { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.rm-skip input { margin: 3px 0 0; accent-color: var(--rm-gold); }
.rm-skip b { display: block; font: 600 13.5px/1.35 var(--rm-sans); }
.rm-skip span span { display: block; font: 400 12.5px/1.45 var(--rm-sans); color: var(--rm-muted); }
.rm-host-end { display: grid; gap: 10px; justify-items: start; padding-top: 14px; border-top: 1px solid var(--rm-line); }
.rm-confirm { display: grid; gap: 10px; padding: 12px 14px; border-radius: 8px; border: 1px solid #5a2f28; background: #170f0c; }
.rm-confirm p { margin: 0; font: 400 13px/1.5 var(--rm-sans); color: var(--rm-dim); }
/* Play's money steps that keep their own look (Confirm it's you, the wallet questions, the terms) sit on the page ground */
.rm-money { display: grid; gap: 10px; min-width: 0; }

/* what this many players are dealt */
.rm-deal { display: flex; flex-wrap: wrap; align-items: end; gap: 14px 28px; padding: 16px 22px; border-top: 1px solid var(--rm-line); background: #0d0b09; }
.rm-deal .rm-kick { align-self: center; color: var(--rm-muted); }
.rm-deal dl { display: flex; flex-wrap: wrap; gap: 14px 28px; margin: 0; }
.rm-deal dt { font: 500 10px/1.2 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--rm-faint); margin-bottom: 6px; }
.rm-deal dd { margin: 0; }

/* settings */
.rm-lower { display: grid; grid-template-columns: minmax(0, 1fr); gap: 30px 36px; margin: 40px 0; }
.rm-lower.rm-two { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }
.rm-terms { display: grid; gap: 14px; margin: 0; }
.rm-terms > div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 4px 14px; }
.rm-terms dt { font: 500 10px/1.6 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--rm-faint); padding-top: 2px; }
.rm-terms dd { margin: 0; display: grid; gap: 4px; min-width: 0; }
.rm-terms dd b { font: 600 14px/1.35 var(--rm-sans); color: var(--rm-text); }
.rm-terms dd > span { font: 400 12.5px/1.5 var(--rm-sans); color: var(--rm-muted); }
details.rm-more summary { cursor: pointer; font: 500 12px/1.4 var(--rm-mono); color: var(--rm-gold); list-style: none; justify-self: start; }
details.rm-more summary::-webkit-details-marker { display: none; }
details.rm-more summary::before { content: "+ "; }
details.rm-more[open] summary::before { content: "− "; }
.rm-clockrules { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 6px; max-width: 76ch; font: 400 12.5px/1.5 var(--rm-sans); color: var(--rm-muted); }
.rm-clockrules li::marker { color: var(--rm-faint); }
.rm-clockrules li:first-child { color: var(--rm-dim); font-weight: 600; }
.rm-rules { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.rm-rules li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px 8px; }
.rm-rules li::before { content: "✓"; color: var(--rm-gold); font-weight: 700; }
.rm-rules b { font: 600 14px/1.35 var(--rm-sans); }
.rm-rules span { grid-column: 2; font: 400 12.5px/1.5 var(--rm-sans); color: var(--rm-muted); }

/* ---- the player panel: the lobby's popover (a bottom sheet on phones) */
.rm-pop { position: fixed; z-index: 30; width: 340px; max-height: calc(100vh - 32px); overflow-y: auto; max-width: calc(100vw - 32px); background: #16120e; border: 1px solid #3a3128; border-radius: 10px; box-shadow: 0 18px 40px rgba(0,0,0,.6); padding: 14px 16px 12px; color: var(--rm-text); }
.rm-pop h3 { margin: 0 0 10px; display: flex; align-items: baseline; gap: 10px; font: 400 24px/1 var(--rm-display); text-transform: uppercase; color: var(--rm-text); }
.rm-pop h3 small { font: 500 11px/1 var(--rm-mono); letter-spacing: .1em; color: var(--rm-muted); }
.rm-pop h3 button { margin-left: auto; border: 0; background: none; color: var(--rm-muted) !important; font: 400 24px/1 var(--rm-sans) !important; cursor: pointer; padding: 0 4px; }
.rm-facts { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: #0f0c09; border: 1px solid var(--rm-line); }
.rm-facts dt { margin: 6px 0 3px; font: 600 10px/1.2 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--rm-faint); }
.rm-facts dt:first-child { margin-top: 0; }
.rm-facts dd { margin: 0 0 2px; font: 400 12.5px/1.45 var(--rm-sans); color: var(--rm-dim); }
.rm-facts dd.rm-fin { display: flex; flex-wrap: wrap; gap: 2px 12px; font-family: var(--rm-mono); font-size: 12px; }
.rm-facts dd.rm-res { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 8px; font-family: var(--rm-mono); font-size: 12px; }
.rm-facts dd.rm-res b { font-weight: 600; color: var(--rm-text); }
.rm-pop > p, .rm-pop .rm-pop-note { margin: 6px 0 0; font: 400 11px/1.45 var(--rm-mono); color: var(--rm-faint); }
.rm-pop .rm-pop-sub { margin: 0 0 6px; font: 500 10px/1.2 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--rm-faint); }

/* ---- the Ludum footer (the lobby's) */
.rm-foot { margin-top: auto; padding: 8px 16px 28px; display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 10px 28px; }
.rm-foot > a { font: 700 12px/1.5 var(--rm-sans); color: var(--rm-dim); text-decoration: none; display: inline-flex; align-items: baseline; gap: 10px; }
.rm-foot > a:hover span, .rm-foot > a:focus-visible span { color: var(--rm-text); text-decoration: underline; text-underline-offset: 3px; }
/* Play's credit (AppFooter) sits in this row as it is: only its full-width bar box is released. */
.rm-foot > footer { width: auto !important; padding: 0 !important; margin: 0 !important; }
.rm-foot .rm-lw { font: 400 20px/1 var(--rm-display); letter-spacing: .01em; color: var(--rm-text); }
.rm-foot .rm-sep { width: 1px; height: 18px; background: var(--rm-rule); }

/* ---- host a game (a native dialog: the board is the card) */
.rh { width: min(980px, 100%); display: flex; flex-direction: column; overflow: hidden; background: var(--rm-board); border: 1px solid #221d17; border-radius: 6px;
  box-shadow: 0 0 0 6px #120f0c, 0 0 0 7px #221d17, 0 24px 60px rgba(0,0,0,.6); }
.rh:focus { outline: none; }
.rh:focus-visible { outline: 2px solid var(--rm-gilt); outline-offset: -2px; }
.rh-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.rh-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: 10px 24px; padding: 18px 22px 12px; border-bottom: 2px solid var(--rm-gold); }
.rh-head h2 { margin: 0; font: 400 40px/.9 var(--rm-display); text-transform: uppercase; color: var(--rm-text); }
.rh-head h2:focus { outline: none; }
.rh-head h2:focus-visible { outline: 2px solid var(--rm-gilt); outline-offset: 2px; }
.rh-head-r { display: flex; align-items: center; gap: 16px; }
.rh-steps { display: flex; gap: 16px; font: 600 11px/1 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--rm-faint); }
.rh-steps b { color: var(--rm-gold); font-weight: 600; }
.rh-close { border: 0; background: none; color: var(--rm-muted) !important; font: 400 26px/1 var(--rm-sans) !important; cursor: pointer; padding: 0 4px; }
.rh-preview { padding: 14px 22px 16px; border-bottom: 1px solid var(--rm-line); background: #0d0b09; display: grid; gap: 10px; }
.rh-prow { --rm-ed: var(--rm-e-18xx); display: grid; grid-template-columns: 58px minmax(0, 1fr) 122px 150px 164px; column-gap: 16px; align-items: center; padding: 12px 16px 12px 20px; background: var(--rm-board); border: 1px solid var(--rm-line); border-radius: 4px; box-shadow: inset 4px 0 0 var(--rm-ed); }
.rh-when { display: flex; flex-direction: column; gap: 10px; }
.rh-time { font: 500 14px/1 var(--rm-mono); color: var(--rm-muted); }
.rh-ed { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.rh-nm { font: 400 26px/1 var(--rm-display); text-transform: uppercase; color: var(--rm-ed); }
.rh-nm .rm-plus, .rh-tl .rm-plus { position: relative; top: -.34em; font-size: .9em; margin-left: .03em; }
.rh-bank { font: 500 12px/1 var(--rm-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--rm-dim); }
.rh-meta { display: flex; flex-wrap: wrap; gap: 2px 18px; font: 400 12.5px/1.45 var(--rm-mono); color: var(--rm-dim); }
.rh-meta em { font-style: normal; color: var(--rm-faint); margin-right: 6px; }
.rh-tbl { display: grid; gap: 5px; min-width: 0; }
.rh-seats { display: grid; gap: 6px; }
.rh-ante { font: 600 13px/1.3 var(--rm-mono); color: var(--rm-ante); }
.rh-ante em { font-style: normal; font-weight: 500; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--rm-faint); margin-right: 7px; }
.rh-body { padding: 22px; display: grid; gap: 26px; }
.rh-field { display: grid; gap: 10px; align-content: start; min-width: 0; }
.rh-fl { font: 600 11px/1.2 var(--rm-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--rm-gold); }
.rh-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.rh-tcard { --rm-ed: var(--rm-e-18xx); display: grid; gap: 10px; align-content: start; padding: 10px 10px 14px; border-radius: 8px; border: 1px solid var(--rm-edge); background: #120f0c; cursor: pointer; text-align: left; color: var(--rm-text); }
.rh-tcard[aria-checked="true"] { border-color: var(--rm-gold); box-shadow: 0 0 0 1px var(--rm-gold); background: #17120c; }
.rh-well { display: grid; place-items: center; aspect-ratio: 4 / 3; max-width: 100%; border-radius: 4px; background: var(--rm-board); box-shadow: inset 0 0 0 1px var(--rm-line); overflow: hidden; container-type: inline-size; }
.rh-well .rm-lockup { justify-self: center; }
.rh-well .rm-lockup .rm-name { font-size: 7.5cqi; margin-bottom: 1.6cqi; }
.rh-well .rm-lockup .rm-num { font-size: 26cqi; }
.rh-well .rm-lockup .rm-sub { margin-top: 5px; font-size: 6px; }
.rh-tl { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font: 400 22px/1 var(--rm-display); text-transform: uppercase; color: var(--rm-ed); padding-inline: 4px; }
.rh-tl i { font-style: normal; font: 700 14px/1 var(--rm-sans); color: var(--rm-gold); }
.rh-tcard p { margin: 0; padding-inline: 4px; font-size: 13px; color: var(--rm-dim); }
.rh-opt { display: grid; align-content: start; gap: 4px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--rm-edge); background: #120f0c; cursor: pointer; text-align: left; color: var(--rm-text); }
.rh-opt b { font: 600 15px/1.3 var(--rm-sans); }
.rh-opt span { font: 400 12.5px/1.45 var(--rm-sans); color: var(--rm-muted); }
.rh-opt[aria-checked="true"] { border-color: var(--rm-gold); box-shadow: 0 0 0 1px var(--rm-gold); background: #17120c; }
.rh-opt[aria-checked="true"] b { color: var(--rm-gilt); }
.rh-nums { display: flex; flex-wrap: wrap; gap: 6px; }
.rh-nums button { min-width: 48px; padding: 10px 12px; border-radius: 7px; border: 1px solid var(--rm-edge); background: #120f0c; cursor: pointer; font: 600 15px/1 var(--rm-mono) !important; color: var(--rm-dim) !important; }
.rh-nums button[aria-checked="true"] { border-color: var(--rm-gold); background: #2a2219; color: var(--rm-gilt) !important; }
.rh-nums button[aria-checked="true"] small { color: var(--rm-dim); }
.rh-nums button small, .rh-nums .rh-fixed small { display: block; margin-top: 4px; font: 500 9.5px/1 var(--rm-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--rm-faint); }
.rh-nums .rh-fixed { min-width: 48px; padding: 10px 12px; border-radius: 7px; border: 1px solid var(--rm-edge); font: 600 15px/1 var(--rm-mono); color: var(--rm-dim); text-align: center; }
.rh-paces { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.rh-pcard { display: grid; align-content: start; gap: 12px; padding-bottom: 14px; border-radius: 8px; border: 1px solid var(--rm-edge); background: #120f0c; }
.rh-pcard[data-on="true"] { border-color: var(--rm-gold); box-shadow: 0 0 0 1px var(--rm-gold); background: #17120c; }
.rh-pcard .rh-opt, .rh-pcard .rh-opt[aria-checked="true"] { border: 0; box-shadow: none; background: none; padding-bottom: 0; }
.rh-pcard .rh-nums { padding-inline: 14px; gap: 5px; }
.rh-pcard .rh-nums button, .rh-pcard .rh-nums .rh-fixed { min-width: 0; padding: 9px 10px; }
/* The design dims the chips of the pace card not chosen to 55% opacity; that takes their labels under WCAG AA, so they
   are dimmed by colour instead (the muted step: 5.3:1 on the card), and still read as the remembered choice. */
.rh-pcard[data-on="false"] .rh-nums button, .rh-pcard[data-on="false"] .rh-nums .rh-fixed { color: var(--rm-muted) !important; border-color: #2a241c; }
.rh-pcard[data-on="false"] .rh-nums button[aria-checked="false"][tabindex="0"] { border-color: var(--rm-edge); }
.rh-pcard[data-on="true"] .rh-nums .rh-fixed { border-color: var(--rm-gold); background: #2a2219; color: var(--rm-gilt); }
.rh-pcard[data-on="true"] .rh-nums .rh-fixed small { color: var(--rm-dim); }
.rh-nums button.rh-any { min-width: 64px; }
.rh-fnote { margin: 0; font: 400 12.5px/1.5 var(--rm-sans); color: var(--rm-muted); max-width: 70ch; }
.rh-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px 32px; }
.rh-toggle { display: grid; align-content: start; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--rm-edge); background: #120f0c; cursor: pointer; }
.rh-toggle input { margin: 3px 0 0; accent-color: var(--rm-gold); width: 16px; height: 16px; }
.rh-toggle b { font: 600 14px/1.35 var(--rm-sans); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rh-toggle .rh-bl { grid-column: 2; font: 400 12.5px/1.45 var(--rm-sans); color: var(--rm-muted); }
.rh-vt { font: 600 9.5px/1 var(--rm-mono); letter-spacing: .12em; text-transform: uppercase; padding: 3px 5px; border-radius: 3px; border: 1px solid currentColor; }
.rh-vt.rh-easier { color: var(--rm-ok); } .rh-vt.rh-riskier { color: var(--rm-call); } .rh-vt.rh-harder { color: var(--rm-warn); } .rh-vt.rh-chaotic { color: var(--rm-chaos); } .rh-vt.rh-recommended { color: var(--rm-gold); }
.rh-ack { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; border: 1px solid #5a2f28; background: #170f0c; cursor: pointer; }
.rh-ack input { margin: 3px 0 0; accent-color: var(--rm-warn); }
.rh-ack span { font: 400 13px/1.45 var(--rm-sans); color: var(--rm-dim); }
.rh-amount { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0; }
.rh-amount input { width: 7em; padding: 9px 10px; border-radius: 7px; border: 1px solid #4a3a44; background: #0f0b0d; color: var(--rm-text) !important; font: 600 16px/1.2 var(--rm-mono) !important; }
.rh-amount span { font: 600 13px/1 var(--rm-mono); color: var(--rm-dim); }
.rh-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; padding: 14px 22px 18px; border-top: 1px solid var(--rm-line); flex: none; }
.rh-foot .rm-why { flex: 1 1 260px; }
.rh-gate { color: var(--rm-call) !important; }

@media (max-width: 1240px) {
  .rm-pass.rm-big { margin-right: 14px; }   /* room for the torn stub to drop away inside the page */
}
@media (max-width: 1080px) {
  .rm-lower.rm-two { grid-template-columns: minmax(0, 1fr); }
  .rm-pass.rm-big > .rm-p-main { grid-template-columns: minmax(0, 1fr); row-gap: 16px; }
  .rm-p-act { padding: 16px 0 0; border-left: 0; border-top: 1px dashed var(--p-rule); }
  .rh-prow { grid-template-columns: 52px minmax(0, 1fr) 120px 150px; row-gap: 10px; }
  .rh-prow .rh-ante { grid-column: 2; grid-row: 2; }
}
@media (max-width: 760px) {
  .rm-g-main { grid-template-columns: minmax(0, 1fr); padding: 20px 16px 20px 24px; }
  .rm-lockup .rm-name { font-size: 26px; margin-bottom: 8px; }
  .rm-lockup .rm-num { font-size: 78px; }
  .rm-g-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .rm-flap-lg .lb-cell { font-size: 22px !important; }
  .rm-g-top, .rm-g-foot { padding-left: 24px; padding-right: 16px; }
  .rm-b-head, .rm-deal, .rm-b-foot { padding-left: 14px; padding-right: 14px; }
  .rm-passes { padding: 16px 14px; grid-template-columns: minmax(0, 1fr); }
  .rm-pass.rm-big { --stub: 92px; --tx: 8px; --ty: 6px; }
  .rm-pass.rm-big > .rm-p-main { padding: 16px 14px 16px 18px; }
  .rm-pass.rm-big .rm-pname { font-size: 36px !important; }
  .rm-pass.rm-big .rm-seatnum { font-size: 44px; }
  .rm-pass.rm-big .rm-stamp { font-size: 19px; right: calc(var(--stub) + 12px); }
  .rm-pass { --tx: 7px; }
  .rm-terms > div { grid-template-columns: minmax(0, 1fr); }
  .rm-pop { left: 16px !important; right: 16px; top: auto !important; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); width: auto; max-width: none; }
  .rm-foot { flex-direction: column; } .rm-foot .rm-sep { display: none; }
  .rh-cards { grid-template-columns: minmax(0, 1fr); }
  .rh-tcard { grid-template-columns: 128px minmax(0, 1fr); align-items: center; }
  .rh-tcard .rh-well { grid-row: 1 / 3; }
  .rh-two, .rh-paces { grid-template-columns: minmax(0, 1fr); }
  .rh-prow { grid-template-columns: minmax(0, 1fr) auto; }
  .rh-prow .rh-when { grid-column: 2; grid-row: 3; }
  .rh-prow .rh-tbl { grid-column: 1 / 3; }
  .rh-prow .rh-seats { grid-column: 1; grid-row: 2; }
  .rh-prow .rh-st { grid-column: 2; grid-row: 2; justify-self: end; }
  .rh-prow .rh-ante { grid-column: 1; grid-row: 3; }
  .rh-body, .rh-head, .rh-preview, .rh-foot { padding-left: 14px; padding-right: 14px; }
  .rh-head h2 { font-size: 32px; }
}
@media (prefers-reduced-motion: reduce) {
  .rm-stamp.rm-new, .rm-pass.rm-tearing > .rm-p-stub { animation: none; }
  .rm .lb-cell.lb-flip::before, .rh .lb-cell.lb-flip::before { animation: none; display: none; }
}
html[data-motion="reduced"] .rm-stamp.rm-new, html[data-motion="reduced"] .rm-pass.rm-tearing > .rm-p-stub { animation: none; }
html[data-motion="reduced"] .rm .lb-cell.lb-flip::before, html[data-motion="reduced"] .rh .lb-cell.lb-flip::before { animation: none; display: none; }
`;
