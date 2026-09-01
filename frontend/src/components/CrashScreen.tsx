import React from "react";
import { ACTION_GREEN, ACTION_GREEN_BORDER, ACTION_GREEN_INK } from "../styles/palette";

/* ==================================================================
 *  DESIGN NOTE 761: A WHITE SCREEN IS A REPORT NOBODY CAN FILE
 * ==================================================================
 *
 * REPORTED: "when a corporation floats and the President places its home station, if they do not do so before
 * the next player buys a stock, both players' screens turn white and the game crashes."
 *
 * THE APP HAD NO ERROR BOUNDARY AT ALL, so React did what React does with an uncaught render throw: unmounted
 * the entire tree and left the page blank. The error was written to the browser console and nowhere a player
 * would look.
 *
 * THIS DOES NOT FIX THE CRASH AND IS NOT PRETENDING TO. I drove the reported sequence through the reducer --
 * float a corporation, leave the home token unplaced, apply the next player's purchase -- and nothing threw;
 * the resulting state is correct and still reports one pending token. So the fault is in RENDER, where a
 * reducer harness cannot reach it, and the message this screen prints is the thing that will identify it.
 *
 * WHAT IT IS FOR, THEN: turning a blank page into a paste. The stack is on screen and selectable, with a
 * copy button, because "both screens turned white" is a report I cannot act on and three lines of stack is
 * one I can fix in minutes -- exactly how the Vercel TS7053 failure got solved in a single exchange.
 *
 * DELIBERATELY NOT A RETRY. Re-rendering the same state would hit the same throw, and a button that appears
 * to offer recovery and silently does nothing is worse than no button. Reload is honest: the log replays from
 * Firestore, so in a room it genuinely does restore the game.
 *
 * AND IT IS DELIBERATELY UGLY-SIMPLE. This component renders when the app is already broken, so it uses no
 * shared styles, no design tokens, no imports beyond React -- anything it depended on could be the thing that
 * threw.
 */

interface CrashScreenState {
  error: Error | null;
  info: string | null;
}

export class CrashScreen extends React.Component<
  { children?: React.ReactNode },
  CrashScreenState
> {
  constructor(props: { children?: React.ReactNode }) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error: Error): Partial<CrashScreenState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    /* THE COMPONENT STACK IS THE USEFUL HALF. A minified production stack names `t` and `o`; the component
       stack names the panel, which is what turns "it went white" into a file to open. */
    this.setState({ info: info.componentStack ?? null });
    // Kept so the browser console still has it verbatim for anyone who opens devtools.
    // eslint-disable-next-line no-console
    console.error("Project 18XX crashed while rendering:", error, info.componentStack);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children ?? null;

    const report = [
      `Project 18XX render crash`,
      `${error.name}: ${error.message}`,
      error.stack ?? "(no stack)",
      "--- component stack ---",
      info ?? "(none)",
    ].join("\n");

    return (
      <div
        style={{
          minHeight: "100vh",
          padding: "32px",
          backgroundColor: "#0f0f0f",
          color: ACTION_GREEN_INK,
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          boxSizing: "border-box",
        }}
      >
        <h1 style={{ fontSize: "20px", margin: "0 0 8px" }}>Project 18XX hit a rendering error</h1>
        <p style={{ margin: "0 0 4px", color: "#c8c6c0", lineHeight: 1.5 }}>
          The game state is safe — it lives in the action log, not in this page. Reloading replays it.
        </p>
        <p style={{ margin: "0 0 20px", color: "#a8a6a0", fontSize: "13px", lineHeight: 1.5 }}>
          Copying the details below and sending them is what makes this fixable.
        </p>

        <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 16px",
              borderRadius: "8px",
              border: `1px solid ${ACTION_GREEN_BORDER}`,
              backgroundColor: ACTION_GREEN,
              color: "#f2f0eb",
              fontSize: "14px",
              fontWeight: 700,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Reload and replay
          </button>
          <button
            type="button"
            onClick={() => {
              /* `navigator.clipboard` is absent on an insecure origin and can reject. The text is selectable
                 below either way, so a failure here costs nothing and must not throw inside the screen whose
                 whole job is to survive. */
              void navigator.clipboard?.writeText(report).catch(() => undefined);
            }}
            style={{
              padding: "8px 16px",
              borderRadius: "8px",
              border: "1px solid #4a4a4a",
              backgroundColor: "#1c1c1c",
              color: "#c8c6c0",
              fontSize: "14px",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Copy error details
          </button>
        </div>

        <pre
          style={{
            margin: 0,
            padding: "14px",
            borderRadius: "10px",
            border: "1px solid #2a2a2a",
            backgroundColor: "#0f0f0f",
            color: "#c8c6c0",
            fontSize: "12px",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "60vh",
            overflow: "auto",
          }}
        >
          {report}
        </pre>
      </div>
    );
  }
}
