// frontend/src/utils/gameLogExportSource.ts
//
// W1-N / AUD-01.09: the game log's export, reachable from outside the game shell -- the crash screen.
//
/* ==================================================================
 *  THE CRASH SCREEN CAN STILL HAND OVER THE LOG
 * ==================================================================
 *
 * The log export was a hidden Ctrl+Shift+L inside `App.tsx` (`copySandboxLog`, #1334). The game shell now also
 * offers it as a visible "Copy game log" button in the top bar, and the crash screen (#761) needs the same export
 * -- the moment a render throws is exactly when the log is the evidence. But `CrashScreen` is the error boundary
 * AROUND the app: when it renders, the shell has been unmounted and its callbacks with it.
 *
 * So the shell registers a SOURCE here: a function that builds the same export text `copySandboxLog` builds, from
 * the shell's refs, at call time. The shell sets it whenever it enters or leaves a room and deliberately does NOT
 * clear it on unmount -- an unmount caused by a crash is precisely when the crash screen must still reach it. A
 * refresh starts a fresh module, so nothing outlives the page.
 *
 * Dependency-free on purpose: `CrashScreen` imports it, and anything the crash screen depends on could be the
 * thing that threw. */

export type GameLogExportSource = () => string | null;

let source: GameLogExportSource | null = null;

/** The shell's registration. `null` when this tab is not in a room (there is no log to export). */
export function setGameLogExportSource(next: GameLogExportSource | null): void {
  source = next;
}

/** The export text, or `null` when nothing is registered or building it throws -- a crash screen must not crash. */
export function readGameLogExport(): string | null {
  if (!source) return null;
  try {
    const text = source();
    return typeof text === "string" && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Whether a log export is available right now. */
export function hasGameLogExport(): boolean {
  return source !== null;
}

export type GameLogCopyOutcome = "copied" | "console" | "unavailable";

/** Copy the export to the clipboard, falling back to the browser console (#1334: a debug tool that fails silently is
 *  worse than none). Never throws. */
export async function copyGameLogExport(): Promise<GameLogCopyOutcome> {
  const text = readGameLogExport();
  if (text === null) return "unavailable";
  const toConsole = (): GameLogCopyOutcome => {
    // eslint-disable-next-line no-console
    console.log(text);
    return "console";
  };
  try {
    if (!navigator.clipboard?.writeText) return toConsole();
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return toConsole();
  }
}
