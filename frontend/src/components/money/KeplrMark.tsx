// frontend/src/components/money/KeplrMark.tsx
//
// ==================================================================
//  PHASE 3 W2-K (U-15, owner OD-9(b)): THE SLOT FOR KEPLR'S OFFICIAL LOGO -- ASSET PENDING
// ==================================================================
//
// The owner's ruling: Keplr is shown with its OFFICIAL logo only. No official asset is in the tree yet, so this
// renders NOTHING and the money surfaces keep their plain-text "Keplr" (the connect step says "Connect Keplr to fund
// your seat"; the button's tooltip names Keplr). Nothing here is drawn, traced, scraped or approximated, and nothing
// may be: a home-made mark is exactly what the ruling forbids.
//
// TO ADD THE OFFICIAL ASSET (owner-supplied, unmodified, from Keplr's own brand kit):
//   1. put the file beside this one, e.g. `brand/keplr-logo.svg` (keep Keplr's file as delivered);
//   2. replace `KEPLR_OFFICIAL_LOGO` below with
//        import keplrLogo from "./brand/keplr-logo.svg";
//        export const KEPLR_OFFICIAL_LOGO: KeplrLogoAsset | null = { src: keplrLogo, width: <w>, height: <h> };
//      using the asset's own intrinsic size (the mark is scaled to the text, never stretched);
//   3. flip `keplrMark.test.tsx`'s "asset pending" pin to expect the mark.
// The mark is decorative beside text that already says what the control does, so it carries `alt=""`.

import React from "react";

export interface KeplrLogoAsset {
  /** A URL the bundler gives for the official file. */
  readonly src: string;
  /** The asset's intrinsic size, for its aspect ratio. */
  readonly width: number;
  readonly height: number;
}

/** ASSET PENDING (owner, OD-9(b)): null until the official Keplr logo is supplied. Never a stand-in. */
export const KEPLR_OFFICIAL_LOGO: KeplrLogoAsset | null = null;

export interface KeplrMarkProps {
  /** Which asset to show (default: the official one, which may be pending). */
  readonly asset?: KeplrLogoAsset | null;
  /** The mark's height in px; the width follows the asset's own ratio. */
  readonly size?: number;
}

/** Keplr's official mark, or nothing while the asset is pending (the surrounding text names Keplr either way). */
export function KeplrMark({ asset = KEPLR_OFFICIAL_LOGO, size = 16 }: KeplrMarkProps): JSX.Element | null {
  if (asset === null) return null;
  const width = asset.height > 0 ? Math.round((asset.width * size) / asset.height) : size;
  return <img src={asset.src} alt="" aria-hidden="true" width={width} height={size} style={{ display: "inline-block", verticalAlign: "-0.2em", marginRight: "7px", flex: "none" }} data-testid="keplr-mark" />;
}

export default KeplrMark;
