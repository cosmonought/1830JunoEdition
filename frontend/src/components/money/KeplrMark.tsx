// frontend/src/components/money/KeplrMark.tsx
//
// ==================================================================
//  PHASE 3 W2-K (U-15, owner OD-9(b)) + PHASE 3 FINAL §16: KEPLR'S OFFICIAL ICON AND WORDMARK
// ==================================================================
//
// The owner's ruling: Keplr is shown with its OFFICIAL brand assets only, never a fabricated, redrawn or approximated
// one. Both files are Keplr's own SVGs from its brand kit (https://www.keplr.app/brand, "Download All -- all assets
// including SVG files", `keplr brand kit/SVGs/`), committed byte for byte and never line-ending converted
// (`brand/.gitattributes`):
//   brand/keplr-icon.svg      <- keplr-icon-radii.svg   the brand page's "Keplr Original Icon"     100 x 101
//   brand/keplr-wordmark.svg  <- keplr-logo-icon.svg    the brand page's "Keplr Original Logo"     220 x 67
//                                (the icon with white "Keplr" lettering, for Play's dark surfaces)
// Nothing here is drawn, traced or approximated, and nothing may be: a change of artwork is a new file from the kit.
//
// WHERE THEY SHOW:
//   ICON       compact wallet controls -- `KeplrMark` (default): "Connect Keplr" in the money panel, the account dialog's
//              Authorization Wallet step, "Forgot password?" and the profile menu's "Change Authorization Wallet".
//   WORDMARK   larger explanatory surfaces -- `KeplrWordmark`: the account dialog's Authorization Wallet explanation.
// Each is scaled to the text at its own intrinsic ratio, never stretched. A mark is decorative beside text that already
// says what the control does, so it carries `alt=""`.

import React from "react";

import keplrIcon from "./brand/keplr-icon.svg";
import keplrWordmark from "./brand/keplr-wordmark.svg";

export interface KeplrLogoAsset {
  /** A URL the bundler gives for the official file. */
  readonly src: string;
  /** The asset's intrinsic size, for its aspect ratio. */
  readonly width: number;
  readonly height: number;
}

/** Keplr's official ICON (owner, OD-9(b) / §16), at the file's own size. */
export const KEPLR_OFFICIAL_ICON: KeplrLogoAsset | null = { src: keplrIcon, width: 100, height: 101 };
/** Keplr's official WORDMARK (owner, §16), at the file's own size. */
export const KEPLR_OFFICIAL_WORDMARK: KeplrLogoAsset | null = { src: keplrWordmark, width: 220, height: 67 };
/** W2-K's name for the compact mark (the icon). */
export const KEPLR_OFFICIAL_LOGO: KeplrLogoAsset | null = KEPLR_OFFICIAL_ICON;

export interface KeplrMarkProps {
  /** Which asset to show (default: the official icon). */
  readonly asset?: KeplrLogoAsset | null;
  /** The mark's height in px; the width follows the asset's own ratio. */
  readonly size?: number;
}

function Mark({ asset, size, testId }: { asset: KeplrLogoAsset | null; size: number; testId: string }): JSX.Element | null {
  if (asset === null) return null;
  const width = asset.height > 0 ? Math.round((asset.width * size) / asset.height) : size;
  return <img src={asset.src} alt="" aria-hidden="true" width={width} height={size} style={{ display: "inline-block", verticalAlign: "-0.2em", marginRight: "7px", flex: "none" }} data-testid={testId} />;
}

/** Keplr's official ICON (compact controls); the text beside it names Keplr either way. */
export function KeplrMark({ asset = KEPLR_OFFICIAL_ICON, size = 16 }: KeplrMarkProps): JSX.Element | null {
  return <Mark asset={asset} size={size} testId="keplr-mark" />;
}

/** Keplr's official WORDMARK (larger explanatory surfaces). */
export function KeplrWordmark({ asset = KEPLR_OFFICIAL_WORDMARK, size = 20 }: KeplrMarkProps): JSX.Element | null {
  return <Mark asset={asset} size={size} testId="keplr-wordmark" />;
}

export default KeplrMark;
