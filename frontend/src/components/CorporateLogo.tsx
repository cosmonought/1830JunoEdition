// Design note #410: the historical logo, with the ticker as `onError` fallback.
// One component for both the livery stripe and the Operating Round card.
//
// Three asset traps, all recorded in the docs because each fails invisibly:
// the directory is `Logos` with a capital L (case-insensitive dev filesystem,
// case-sensitive production host); the files are WEBP with a `.svg` name, so a
// host serving `image/svg+xml` makes every logo silently degrade to text; and
// `B&O`/`C&O` carry an ampersand, so the FILENAME (not the separator) is
// `encodeURIComponent`d.
//
// See docs/ai_architecture/ui_shell_layout.md, CorporateLogo.tsx #410.

import React, { useEffect, useState } from "react";

/** Where the logos live, relative to the site root. Capital L,
 *  deliberately -- see the note above. */
export const LOGO_BASE_PATH = "/Logos";

/** The files' real format. See "THE FILES ARE WEBP, NOT SVG" above: this
 *  tracks what the bytes ARE, not what they were once named. */
export const LOGO_EXTENSION = "webp";

/** The URL for one corporation's logo. Pure and exported so the encoding can be
 *  tested without a DOM -- a regression here is invisible on a case-insensitive
 *  dev machine. */
export function logoSrcFor(ticker: string): string {
  return `${LOGO_BASE_PATH}/${encodeURIComponent(ticker)}.${LOGO_EXTENSION}`;
}

export interface CorporateLogoProps {
  /** The corporation's ticker -- both the filename and the fallback text. */
  ticker: string;
  /** Rendered box height in px. The width is capped proportionally so a wide
   *  logo cannot push its neighbours out of the row. */
  size?: number;
  /** Ink for the text fallback. Inherited when omitted, which is what the
   *  livery stripe wants -- it has already computed a contrasting colour. */
  color?: string;
  /** Hover text. Usually the corporation's full historical name. */
  title?: string;
  /** Style applied to the TEXT fallback only, so a caller can keep its
   *  existing typography when the image is unavailable. */
  fallbackStyle?: React.CSSProperties;
  /* Design note #429: the default width cap (`size * 2.4`) is for the livery
     STRIPE. Market-chart occupant tokens are CIRCLES, where a 2.4x herald runs out
     of both sides and `overflow: hidden` crops it -- worse than the text fallback,
     since a cropped herald looks like a fault and an acronym looks like a
     decision. `undefined` keeps the existing ratio, so this is a pure addition. */
  maxWidth?: number;
}

export function CorporateLogo({
  ticker,
  size = 32,
  color,
  title,
  fallbackStyle,
  maxWidth,
}: CorporateLogoProps) {
  const [failed, setFailed] = useState(false);

  /* A different corporation is a different file, and a file that has not been
     tried yet has not failed. React reuses the component instance when only the
     props change, so without this one missing logo would poison the slot for every
     corporation rendered through the same element afterwards. */
  useEffect(() => setFailed(false), [ticker]);

  if (failed) {
    return (
      <span style={{ ...fallbackStyle, color: color ?? fallbackStyle?.color }} title={title}>
        {ticker}
      </span>
    );
  }

  return (
    <img
      src={logoSrcFor(ticker)}
      /* The ticker, not "logo" -- a screen reader announcing "PRR" is
         announcing the same thing the sighted player reads, whereas "PRR
         logo" describes the medium rather than the corporation. */
      alt={ticker}
      title={title}
      onError={() => setFailed(true)}
      style={{
        height: `${size}px`,
        /* Capped rather than fixed square. Historical heralds have wildly different
           aspect ratios -- a square box would letterbox some, and an uncapped width lets
           the widest one shove the float badge off the end of the stripe. */
        maxWidth: `${maxWidth ?? Math.round(size * 2.4)}px`,
        /* Never distort a herald. `contain` fits the whole mark inside the
           box and leaves the spare axis empty. */
        objectFit: "contain",
        objectPosition: "left center",
        display: "block",
        /* The stripe is a flex row whose height comes from its tallest
           child; `flexShrink` stops a wide logo being squeezed instead of
           the text beside it. */
        flexShrink: 0,
      }}
    />
  );
}

export default CorporateLogo;
