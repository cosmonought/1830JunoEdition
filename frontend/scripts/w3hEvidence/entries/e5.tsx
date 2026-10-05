// W3-H evidence, VF/E-5: the VF-3 float ceremony on a scrolled Stock Round tab under the sticky action dock.
// The tree mirrors App.tsx's shell: appRoot (+ chromeZoomFor) > [actionDock (sticky, zIndex 50) > actionBar,
// main canvasPane > StockRoundPanel]. Only real styles objects are used for those wrappers.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { StockRoundPanel, type CorporationFloatEvent } from "../../../src/components/StockRoundPanel";
import { styles, chromeZoomFor } from "../../../src/styles/appStyles";
import type { RoundType } from "../../../src/gameEngine/gameState";
import { eightCorporations, TICKERS } from "../fixtures";
import * as floatConstants from "../../../src/components/corporationFloatFocus";

(window as any).__floatConstants = floatConstants;
const companies = eightCorporations();

function Shell() {
  const [floatEvent, setFloatEvent] = useState<CorporationFloatEvent | null>(null);
  (window as any).__float = (companyId: number, token: number) =>
    setFloatEvent({ companyId, ticker: TICKERS[companyId], token });
  return (
    <div style={{ ...styles.appRoot, ...chromeZoomFor(1) }}>
      <div style={styles.actionDock} data-sticky-dock="true" role="region" aria-label="Game actions">
        <div style={{ ...styles.actionBar, background: "#24262c", padding: "10px 16px", minHeight: 48 }} data-testid="bar">
          <strong>Stock Round 2</strong>
          <button type="button">Pass</button>
          <span style={{ opacity: 0.7 }}>sticky action dock (zIndex 50)</span>
        </div>
      </div>
      <div style={{ height: 120, padding: 12, opacity: 0.6 }}>tab strip / spacer (scrolls away)</div>
      <main style={styles.canvasPane}>
        <StockRoundPanel
          onPresidencyCue={() => undefined}
          floatEvent={floatEvent}
          onFloatCue={() => ((window as any).__cues = ((window as any).__cues ?? 0) + 1)}
          publicCompanies={companies}
          parValueFor={() => "90"}
          onSelectParValue={() => undefined}
          onBuyShare={() => undefined}
          onSellShares={() => undefined}
          sessionReady
          isMyTurn={false}
          connectedAddress={null}
          roundType={"StockRound" as RoundType}
          transaction={null}
        />
        <div style={{ height: 1400 }} />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
(window as any).__ready = true;
