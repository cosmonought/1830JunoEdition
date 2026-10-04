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
 * AROUND the app: by the time it paints, the shell has been unmounted and its callbacks with it.
 *
 * So the shell registers a SOURCE here while it is in a room: a function that builds the same export text
 * `copySandboxLog` builds, from the shell's refs, at call time. It is cleared when the shell leaves the room or
 * unmounts, so a crash somewhere else later (the Lobby, say) can never hand over a previous table's log as evidence.
 *
 * THE CRASH SCREEN READS IT FIRST. `getDerivedStateFromError` runs in the render phase, before React commits the
 * fallback and runs the crashed tree's effect cleanups -- so the boundary snapshots the text there, while the source
 * is still registered, and copies that snapshot when the player presses the button.
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

/** Copy an export (by default, the registered source's text now) to the clipboard, falling back to the browser
 *  console (#1334: a debug tool that fails silently is worse than none). Never throws. */
export async function copyGameLogExport(snapshot?: string | null): Promise<GameLogCopyOutcome> {
  const text = snapshot === undefined ? readGameLogExport() : snapshot;
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
