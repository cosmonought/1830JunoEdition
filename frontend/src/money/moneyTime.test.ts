/** @jest-environment node */
// PHASE 3 W2-K (U-44, owner OD-9(a)): every money/deadline time a player reads is their LOCAL time with an EXPLICIT
// zone -- never a bare HH:MM -- from one formatter; a time on another local day names the day. The zone and locale
// are pinned here; production passes neither and gets the browser's.

import { formatMoneyTime } from "./moneyTime";
import { readStripped } from "../utils/sourceScan";

/* 00:42 UTC on 4 Oct 2026 is 7:42 PM CDT on Saturday 3 Oct in Chicago, 02:42 CEST on Sunday 4 Oct in Berlin. */
const AT = Date.UTC(2026, 9, 4, 0, 42);
const CHICAGO = { timeZone: "America/Chicago", locale: "en-US" } as const;
/* Intl separates "7:42" and "PM" with a narrow no-break space; compare words, not space characters. */
const words = (text: string) => text.replace(/\s+/g, " ");

describe("W2-K: one money-time formatter, local time with an explicit zone", () => {
  it("writes the owner's shape on the same local day: 7:42 PM CDT", () => {
    expect(words(formatMoneyTime(AT, { ...CHICAGO, now: Date.UTC(2026, 9, 3, 23, 0) }))).toBe("7:42 PM CDT");
  });

  it("names the day when the instant is on another local day than now", () => {
    expect(words(formatMoneyTime(AT, { ...CHICAGO, now: Date.UTC(2026, 9, 2, 15, 0) }))).toBe("Sat, Oct 3, 7:42 PM CDT");
    /* "Today" is the PLAYER's day: 23:00 UTC on 3 Oct is still Saturday in Chicago, already Sunday in Tokyo. */
    expect(words(formatMoneyTime(AT, { timeZone: "Asia/Tokyo", locale: "en-US", now: Date.UTC(2026, 9, 3, 14, 0) }))).toMatch(/^Sun, Oct 4, 9:42 AM GMT\+9|^Sun, Oct 4, 9:42 AM JST$/);
  });

  it("follows the browser's own zone and clock habit, and always says the zone", () => {
    const now = AT;
    expect(words(formatMoneyTime(AT, { timeZone: "Europe/Berlin", locale: "de-DE", now }))).toBe("02:42 MESZ");
    expect(words(formatMoneyTime(AT, { timeZone: "UTC", locale: "en-GB", now }))).toBe("00:42 UTC");
    for (const timeZone of ["America/Chicago", "America/Los_Angeles", "Europe/London", "Asia/Kolkata", "Australia/Adelaide", "UTC"]) {
      for (const locale of ["en-US", "en-GB", "fr-FR", "ja-JP"]) {
        const text = words(formatMoneyTime(AT, { timeZone, locale, now }));
        /* Never a bare clock: something follows the minutes. */
        expect(text).not.toMatch(/^\d{1,2}:\d\d$/);
        expect(text).toMatch(/\d{1,2}[:h.]\d\d.*\S/);
      }
    }
  });

  it("is empty for no instant, so a sentence can say what it says instead", () => {
    expect(formatMoneyTime(null)).toBe("");
    expect(formatMoneyTime(undefined)).toBe("");
    expect(formatMoneyTime(Number.NaN)).toBe("");
    expect(formatMoneyTime(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("falls back to a LABELLED UTC time, never a bare one, when the runtime names no zone", () => {
    const real = Intl.DateTimeFormat;
    const spy = jest.spyOn(Intl, "DateTimeFormat").mockImplementation(((locale?: string | string[], options?: Intl.DateTimeFormatOptions) => {
      const inner = new real(locale, options);
      return { format: (ms: number) => inner.format(ms), formatToParts: (ms: number) => inner.formatToParts(ms).filter((part) => part.type !== "timeZoneName") } as unknown as Intl.DateTimeFormat;
    }) as unknown as typeof Intl.DateTimeFormat);
    try {
      expect(formatMoneyTime(AT, CHICAGO)).toBe("00:42 UTC");
    } finally {
      spy.mockRestore();
    }
  });

  it("is the only clock formatter on the money surfaces (the three divergent HH:MM copies are gone)", () => {
    for (const file of ["money/moneyFlow.ts", "components/money/MoneyPanel.tsx", "components/money/SettlementBand.tsx", "components/money/YourDeposits.tsx", "components/money/HostStakeSection.tsx"]) {
      const source = readStripped(file);
      expect({ file, hhmm: /\bhhmm\b|getHours\(|getMinutes\(|toLocaleTimeString\(|toISOString\(/.test(source) }).toEqual({ file, hhmm: false });
    }
    for (const file of ["money/moneyFlow.ts", "components/money/MoneyPanel.tsx"]) {
      expect({ file, uses: readStripped(file).includes("formatMoneyTime(") }).toEqual({ file, uses: true });
    }
    /* W2-M (AUD-20.07): the band's one time -- the resolver's deadline in the dispute confirm -- is worded by
       moneyFlow's `disputeConfirmSentence` (which uses the formatter above), as is its dispute record. */
    const band = readStripped("components/money/SettlementBand.tsx");
    expect({ uses: band.includes("formatMoneyTime(") || (band.includes("disputeConfirmSentence(") && band.includes("disputeRecordLines(")) }).toEqual({ uses: true });
  });
});
