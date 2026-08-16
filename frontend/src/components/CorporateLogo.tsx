// frontend/src/components/CorporateLogo.tsx
//
// ==================================================================
//  DESIGN NOTE 410: THE HISTORICAL LOGO, WITH THE TICKER BEHIND IT
// ==================================================================
//
// REPORTED: the Stock Cards use plain text abbreviations, which lacks
// visual immersion. Replace the abbreviation in the coloured header stripe
// with the corporation's logo, sized to fit, with an `onError` fallback to
// the text.
//
// ONE COMPONENT, TWO SURFACES. The stripe is the requirement's subject and
// the Operating Round's corporation card is the other place a corporation
// announces itself. Both render this, so a corporation cannot be a logo on
// one screen and an acronym on the other -- the same reasoning the palette
// mirrors carry in design note #408.
//
// ==================================================================
//  THE DIRECTORY IS `Logos`, NOT `logos`
// ==================================================================
//
// The requirement specifies `/logos/${abbreviation}.svg`. The files are in
// `public/Logos/` with a capital L, and this points at the real name.
//
// It matters in exactly one place, and it is the place that is hard to test
// for: the dev server runs on a case-INSENSITIVE filesystem, where
// `/logos/PRR.svg` and `/Logos/PRR.svg` are the same file and both work.
// Most production static hosts are case-SENSITIVE, where the lowercase path
// is a 404 against a directory that plainly exists. The failure would
// therefore never appear in development and every logo would silently
// degrade to the text fallback in production -- which, because the fallback
// is graceful, would look like a feature that was never built rather than
// one that broke.
//
// Changing one string here is cheaper than renaming eight asset files, and
// far cheaper than the bug. If the folder is ever renamed to lowercase,
// this is the single line to follow it.
//
// ==================================================================
//  THE FILES ARE WEBP, NOT SVG
// ==================================================================
//
// The requirement specified `/logos/${abbreviation}.svg`, and the eight
// files were named `.svg`. They are not SVGs: every one carries the
// `RIFF....WEBP` magic number and not one contains an `<svg>` element. They
// are raster images that were given a vector extension.
//
// That combination fails in a way worth spelling out, because it would have
// looked like nothing was wrong. A static host maps `.svg` to
// `Content-Type: image/svg+xml`; a browser handed that type parses the body
// as XML rather than sniffing it; WebP bytes are not XML, so the decode
// fails and `onError` fires. The graceful fallback below would then have
// rendered the text ticker on every card -- which is exactly what the cards
// looked like BEFORE this feature, so the feature would have appeared
// unbuilt rather than broken, on every host, forever.
//
// So the extension follows the actual format. The files were renamed to
// `.webp` (bytes untouched) and this builds `.webp` paths. Confirmed by the
// harness, which reads the magic number of each file rather than trusting
// its name -- the check that would have caught this in the first place.
//
// IF REAL VECTOR LOGOS ARRIVE LATER, this constant is the one line to
// change, and the harness's format check will start demanding `<svg>`.
//
// ==================================================================
//  THE AMPERSAND
// ==================================================================
//
// `B&O` and `C&O` carry an ampersand. In a URL path segment `&` is a legal
// sub-delimiter, so a browser would usually fetch it unescaped -- but
// "usually" is doing real work in that sentence: it is the query-string
// separator, and any proxy, CDN rewrite rule or logging layer between the
// app and the file is entitled to treat it as one. `encodeURIComponent`
// makes the path unambiguous everywhere for the cost of two characters.
//
// It encodes the FILENAME only, not the directory separator -- which is why
// the base path is concatenated rather than run through the same call.

import React, { useEffect, useState } from "react";

/** Where the logos live, relative to the site root. Capital L,
 *  deliberately -- see the note above. */
export const LOGO_BASE_PATH = "/Logos";

/** The files' real format. See "THE FILES ARE WEBP, NOT SVG" above: this
 *  tracks what the bytes ARE, not what they were once named. */
export const LOGO_EXTENSION = "webp";

/**
 * The URL for one corporation's logo.
 *
 * Pure and exported so the encoding can be tested without a DOM: the two
 * tickers that need it are exactly the two the requirement names, and a
 * regression here is invisible on a case-insensitive dev machine.
 */
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
}

export function CorporateLogo({
  ticker,
  size = 32,
  color,
  title,
  fallbackStyle,
}: CorporateLogoProps) {
  const [failed, setFailed] = useState(false);

  /* A different corporation is a different file, and a file that has not
     been tried yet has not failed. Without this, one missing logo would
     poison the slot for every corporation rendered through the same element
     afterwards -- React reuses the component instance when only the props
     change, so `failed` would persist across the swap. */
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
        /* Capped rather than fixed square. These are historical heralds with
           wildly different aspect ratios -- the NYC oval is far wider than
           the PRR keystone -- so a square box would letterbox some and crop
           none, while an uncapped width lets the widest one shove the float
           badge off the end of the stripe. */
        maxWidth: `${Math.round(size * 2.4)}px`,
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
