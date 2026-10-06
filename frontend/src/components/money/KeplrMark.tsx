// frontend/src/components/money/KeplrMark.tsx
//
// ==================================================================
//  PHASE 3 W2-K (U-15, owner OD-9(b)) + PHASE 3 FINAL §16: THE SLOTS FOR KEPLR'S OFFICIAL ICON AND WORDMARK -- ASSET
//  PENDING IN THIS TREE
// ==================================================================
//
// The owner's ruling: Keplr is shown with its OFFICIAL brand assets only, never a fabricated, redrawn or approximated
// one. The owner has supplied the official standalone ICON and WORDMARK (2026-10-06), but neither file is in this
// repository or reachable from the environment this pass ran in -- so both slots render NOTHING and every surface keeps
// its plain-text "Keplr". Nothing here is drawn, traced, scraped or approximated, and nothing may be.
//
// WHERE THEY SHOW (once supplied):
//   ICON       compact wallet controls -- `KeplrMark` (default): "Connect Keplr" in the money panel, the account dialog's
//              Authorization Wallet step, "Forgot password?" and the profile menu's "Change Authorization Wallet".
//   WORDMARK   larger explanatory surfaces -- `KeplrWordmark`: the account dialog's Authorization Wallet explanation.
//
// ASSET PLACEMENT NOTE (for integration; the files exactly as Keplr's brand kit delivers them, unmodified):
//   1. put them beside this file, e.g. `brand/keplr-icon.svg` and `brand/keplr-wordmark.svg`;
//   2. replace the two constants below with
//        import keplrIcon from "./brand/keplr-icon.svg";
//        import keplrWordmark from "./brand/keplr-wordmark.svg";
//        export const KEPLR_OFFICIAL_ICON: KeplrLogoAsset | null = { src: keplrIcon, width: <w>, height: <h> };
//        export const KEPLR_OFFICIAL_WORDMARK: KeplrLogoAsset | null = { src: keplrWordmark, width: <w>, height: <h> };
//      using each asset's own intrinsic size (a mark is scaled to the text, never stretched);
//   3. flip `keplrMark.test.tsx`'s "asset pending" pins to expect the marks.
// A mark is decorative beside text that already says what the control does, so it carries `alt=""`.

import React from "react";

export interface KeplrLogoAsset {
  /** A URL the bundler gives for the official file. */
  readonly src: string;
  /** The asset's intrinsic size, for its aspect ratio. */
  readonly width: number;
  readonly height: number;
}

/** ASSET PENDING (owner, OD-9(b) / §16): null until the official Keplr ICON is in the tree. Never a stand-in. */
export const KEPLR_OFFICIAL_ICON: KeplrLogoAsset | null = null;
/** ASSET PENDING (owner, §16): null until the official Keplr WORDMARK is in the tree. Never a stand-in. */
export const KEPLR_OFFICIAL_WORDMARK: KeplrLogoAsset | null = null;
/** W2-K's name for the compact mark (the icon). */
export const KEPLR_OFFICIAL_LOGO: KeplrLogoAsset | null = KEPLR_OFFICIAL_ICON;

export interface KeplrMarkProps {
  /** Which asset to show (default: the official icon, which may be pending). */
  readonly asset?: KeplrLogoAsset | null;
  /** The mark's height in px; the width follows the asset's own ratio. */
  readonly size?: number;
}

function Mark({ asset, size, testId }: { asset: KeplrLogoAsset | null; size: number; testId: string }): JSX.Element | null {
  if (asset === null) return null;
  const width = asset.height > 0 ? Math.round((asset.width * size) / asset.height) : size;
  return <img src={asset.src} alt="" aria-hidden="true" width={width} height={size} style={{ display: "inline-block", verticalAlign: "-0.2em", marginRight: "7px", flex: "none" }} data-testid={testId} />;
}

/** Keplr's official ICON (compact controls), or nothing while the asset is pending (the text names Keplr either way). */
export function KeplrMark({ asset = KEPLR_OFFICIAL_ICON, size = 16 }: KeplrMarkProps): JSX.Element | null {
  return <Mark asset={asset} size={size} testId="keplr-mark" />;
}

/** Keplr's official WORDMARK (larger explanatory surfaces), or nothing while the asset is pending. */
export function KeplrWordmark({ asset = KEPLR_OFFICIAL_WORDMARK, size = 20 }: KeplrMarkProps): JSX.Element | null {
  return <Mark asset={asset} size={size} testId="keplr-wordmark" />;
}

export default KeplrMark;
