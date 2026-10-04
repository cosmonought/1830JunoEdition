// frontend/src/money/moneyTime.ts
//
// ==================================================================
//  PHASE 3 W2-K (U-44, owner OD-9(a)): THE ONE WAY A PLAYER READS A MONEY TIME
// ==================================================================
//
// Every money or deadline time a player reads -- funding closes, the host's Start grace, the payout's release, the
// resolver's deadline, the inactivity exit -- is written in the player's LOCAL time WITH AN EXPLICIT ZONE:
//
//   7:42 PM CDT                     (the same local day as now)
//   Tue, Oct 6, 7:42 PM CDT         (any other day -- a bare clock would name the wrong day)
//
// The zone and the 12/24-hour habit are the browser's own (`Intl`), so a player in Berlin reads "19:42 MESZ" or
// "19:42 GMT+2" -- whatever their browser calls its zone -- and never an unlabelled HH:MM. If the runtime cannot
// name a zone, the time is written in UTC and says so, rather than bare.
//
// Display only. Stored timestamps, the wire, the escrow's deadlines and machine evidence/logs (UTC) are untouched:
// this takes the instant the view already carries (epoch milliseconds) and returns a sentence fragment.
//
// The three copies this replaced (moneyFlow.ts, MoneyPanel.tsx, SettlementBand.tsx) each printed local "HH:MM" with
// no zone, while the server's money sentences said "HH:MM UTC" -- two conventions for one fact (backlog U-44).

export interface MoneyTimeOptions {
  /** The instant "today" is judged from (default: this device's clock). Pass the hook's `now` so a render agrees with itself. */
  readonly now?: number;
  /** IANA zone (default: the browser's). Tests pin one; production never passes it. */
  readonly timeZone?: string;
  /** Locale (default: the browser's). Tests pin one; production never passes it. */
  readonly locale?: string;
}

const dayKey = (ms: number, timeZone: string | undefined): string => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

const utcFallback = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** A money/deadline instant as the player reads it: local time with an explicit zone ("" for no instant). */
export function formatMoneyTime(ms: number | null | undefined, options: MoneyTimeOptions = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const { timeZone, locale } = options;
  const now = options.now ?? Date.now();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(ms);
  } catch {
    return utcFallback(ms);
  }
  /* The convention's one hard rule: never a bare clock. A runtime that names no zone gets UTC, labelled. */
  if (!parts.some((part) => part.type === "timeZoneName" && part.value.trim() !== "")) return utcFallback(ms);
  const clock = parts.map((part) => part.value).join("");
  if (Number.isFinite(now) && dayKey(ms, timeZone) === dayKey(now, timeZone)) return clock;
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", month: "short", day: "numeric" }).format(ms);
  return `${day}, ${clock}`;
}
