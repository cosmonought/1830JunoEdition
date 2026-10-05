// W3-H evidence, VF/K-4: render the fallback capacity glyph (CapacityMark capacity=null) beside the
// 4->3 mark and the RustMark, inside the product's own warning-capsule styles, at uiScale 0.63/1.0/1.5.
// Two scaling mechanisms are shown: the product's CSS `zoom` (chromeZoomFor) and plain font-size scaling.
import React from "react";
import { createRoot } from "react-dom/client";
import { CapacityMark, RustMark } from "../../../src/components/WarningMarks";
import { styles, chromeZoomFor } from "../../../src/styles/appStyles";

const SCALES = [0.63, 1.0, 1.5];

function Row({ critical }: { critical: boolean }) {
  const shell = { ...styles.phaseShiftBadge, ...(critical ? styles.phaseShiftBadgeCritical : styles.phaseShiftBadgeWarn), animation: "none" };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
      <span data-mark="fallback" style={shell}>
        <CapacityMark capacity={null} /> Train Limit Drops in 2 Buys
      </span>
      <span data-mark="figures" style={shell}>
        <CapacityMark capacity={{ from: 4, to: 3 }} /> Train Limit Drops in 2 Buys
      </span>
      <span data-mark="rust" style={shell}>
        <RustMark /> 2-Trains Rust in 2 Buys
      </span>
    </div>
  );
}

function App() {
  return (
    <div style={{ padding: 16, background: "#1b1d22" }}>
      {SCALES.map((scale) => (
        <section key={`z${scale}`} data-scale={scale} data-mode="zoom" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>uiScale {scale} - CSS zoom (chromeZoomFor)</div>
          <div style={{ ...chromeZoomFor(scale), minHeight: undefined }}>
            <Row critical={false} />
            <Row critical={true} />
          </div>
        </section>
      ))}
      {SCALES.map((scale) => (
        <section key={`f${scale}`} data-scale={scale} data-mode="font" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>uiScale {scale} - font-size scaling ({(11 * scale).toFixed(2)}px label)</div>
          <div className="fontScaled" style={{ ["--s" as string]: scale }}>
            <style>{`.fontScaled span[data-mark]{font-size:calc(11px * var(--s)) !important}`}</style>
            <Row critical={false} />
          </div>
        </section>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
(window as any).__ready = true;
