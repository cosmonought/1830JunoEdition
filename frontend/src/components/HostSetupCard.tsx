// frontend/src/components/HostSetupCard.tsx
//
/* ==================================================================
    DESIGN NOTE 1415: THE TERMS ARE CHOSEN BEFORE THE ROOM EXISTS
   ==================================================================
   ASKED: "Host Game" opens a first screen -- the game type as three boxes, the pace, public or private -- and
   "Continue" opens the house rules: the ante, the player count, the tile set, the bank, and the four rule
   variants, each tagged with what it does to the game. "Create Room" then opens the waiting room with those
   choices shown as terms, not controls.
   TWO STEPS RATHER THAN ONE LONG FORM, because the first step changes what the second offers: the type decides
   which tile-set tag is shown (easier on the printed map, recommended on 18XX+, nothing under the Level Playing
   Field, which brings the tray), which bank is recommended, and how many seats the board has. Choosing the type
   RESETS the second step to that type's recommended defaults -- "recommended options default on" -- so a host
   who goes back and changes the type is not left holding the previous type's choices.
   THE ANTE IS A PLACEHOLDER. Real JUNO moves through the wallet, which is not wired to this screen yet; the
   control is shown disabled at 0 so the flow reads whole, and the line under it says where the fee goes.
   MOUNTED AT THE LOBBY'S ROOT like the rejoin cards (#1360): the scene is `pointer-events: none`, and a card
   inside it is a card nobody can click. */

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import {
  BANK_SIZE_BY_LENGTH,
  GAME_LENGTH_BLURB,
  GAME_MODE_COPY,
  GAME_TYPE_COPY,
  GAME_TYPE_ORDER,
  VARIANT_COPY,
  type GameLength,
  type GameMode,
  type GameType,
  type GameVariants,
  type VariantTag,
  plusTilesTagFor,
  recommendedLengthFor,
  recommendedVariantsFor,
} from "../gameEngine/gameVariants";
import { MIN_PLAYERS, maxPlayersFor } from "../gameEngine/gameSetup";
import { DEFAULT_ROOM_SETUP, type RoomSetup, type RoomVisibility } from "../utils/sandboxRoomSummary";

/** The type boxes' sentences, as asked. `GAME_TYPE_COPY`'s blurbs are the waiting room's and the Lobby's older
 *  form's; these are the host's first screen, which reads them side by side. */
export const HOST_TYPE_BLURB: Readonly<Record<GameType, string>> = {
  standard: "The classic game.",
  plus: "A larger map, suitable for higher player counts or less blocking at lower player counts.",
  levelPlayingField: "A rebalanced map with additional tiles, private companies, and railroads.",
};

export const VISIBILITY_COPY: Readonly<Record<RoomVisibility, { label: string; blurb: string }>> = {
  public: { label: "Public", blurb: "Listed under Join Game. Anyone can join, and anyone can watch." },
  private: { label: "Private", blurb: "Unlisted. Players join by room code only, and nobody can watch." },
};

/** The four rule variants in the order the house-rules step reads them, each with its tag. The titles are the
 *  short forms asked for on this screen; the blurbs are the shared copy (#961a), so the rule reads the same
 *  here as in the waiting room. */
export const HOUSE_RULE_ROWS: ReadonlyArray<{
  key: "gentleRust" | "dynamicStockMarket" | "delayedAuction" | "unpredictableRevenue";
  title: string;
  tag: VariantTag;
}> = [
  { key: "gentleRust", title: "Gentle Rust", tag: "easier" },
  { key: "dynamicStockMarket", title: "Dynamic Market", tag: "riskier" },
  { key: "delayedAuction", title: "Delayed Auction", tag: "harder" },
  { key: "unpredictableRevenue", title: "Unpredictable Routes", tag: "chaotic" },
];

/** The dev-subsidy line under the ante -- the project's gas-subsidisation rule, said where the money is set. */
export const ANTE_SUBSIDY_NOTE =
  "Antes are off for the playtest. When they are on, a small share of every ante funds the developer treasury that pays players' transaction fees.";

export interface HostSetupCardProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (variants: GameVariants, setup: RoomSetup) => void;
}

type Step = "type" | "rules";

export function HostSetupCard({ busy, error, onClose, onCreate }: HostSetupCardProps) {
  const [step, setStep] = useState<Step>("type");
  const [type, setType] = useState<GameType>("standard");
  const [mode, setMode] = useState<GameMode>("live");
  const [visibility, setVisibility] = useState<RoomVisibility>(DEFAULT_ROOM_SETUP.visibility);
  const [variants, setVariants] = useState<GameVariants>(() => recommendedVariantsFor("standard", "live"));
  const [playerCount, setPlayerCount] = useState<number | null>(null);

  const seatMax = maxPlayersFor(variants);
  const tileTag = plusTilesTagFor(type);
  const recommendedLength = recommendedLengthFor(type);

  const continueToRules = () => {
    /* The recommended defaults for the type chosen -- see the note at the top. An exact count the new board
       cannot seat goes back to "any". */
    const next = recommendedVariantsFor(type, mode);
    setVariants(next);
    setPlayerCount((current) => (current !== null && current > maxPlayersFor(next) ? null : current));
    setStep("rules");
  };

  const create = () => {
    onCreate({ ...variants, mode }, { visibility, playerCount, anteUjuno: DEFAULT_ROOM_SETUP.anteUjuno });
  };

  return (
    <div style={styles.backdrop} role="presentation" onClick={busy ? undefined : onClose}>
      <div
        style={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={step === "type" ? "Host a game" : "House rules"}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={styles.header}>
          <span style={styles.heading}>{step === "type" ? "Host a game" : "House rules"}</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close" disabled={busy}>
            ×
          </button>
        </div>

        {step === "type" ? (
          <>
            <Section title="Game type">
              <div style={styles.typeGrid}>
                {GAME_TYPE_ORDER.map((candidate) => {
                  const selected = candidate === type;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      style={{ ...styles.typeBox, ...(selected ? styles.typeBoxSelected : {}) }}
                      onClick={() => setType(candidate)}
                      data-testid={`host-type-${candidate}`}
                    >
                      <span style={styles.typeLabel}>{GAME_TYPE_COPY[candidate].label}</span>
                      <span style={styles.typeBlurb}>{HOST_TYPE_BLURB[candidate]}</span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Pace">
              <Segmented<GameMode>
                value={mode}
                options={(["live", "async"] as const).map((key) => ({
                  key,
                  label: GAME_MODE_COPY[key].label,
                  blurb: GAME_MODE_COPY[key].blurb,
                }))}
                onChange={setMode}
                name="pace"
              />
            </Section>

            <Section title="Visibility">
              <Segmented<RoomVisibility>
                value={visibility}
                options={(["public", "private"] as const).map((key) => ({
                  key,
                  label: VISIBILITY_COPY[key].label,
                  blurb: VISIBILITY_COPY[key].blurb,
                }))}
                onChange={setVisibility}
                name="visibility"
              />
            </Section>

            <div style={styles.footer}>
              <button type="button" style={styles.secondaryButton} onClick={onClose}>
                Cancel
              </button>
              <button type="button" style={styles.primaryButton} onClick={continueToRules} data-testid="host-continue">
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={styles.terms}>
              {GAME_TYPE_COPY[type].label} · {GAME_MODE_COPY[mode].label} · {VISIBILITY_COPY[visibility].label}
            </p>

            <Section title="Set Ante">
              <div style={styles.row}>
                <input style={{ ...styles.input, ...styles.inputDisabled }} value="0 JUNO" disabled aria-label="Ante" readOnly />
              </div>
              <p style={styles.note}>{ANTE_SUBSIDY_NOTE}</p>
            </Section>

            <Section title="Player Count">
              <select
                style={styles.select}
                aria-label="Player count"
                value={playerCount === null ? "any" : String(playerCount)}
                onChange={(event) => setPlayerCount(event.target.value === "any" ? null : Number(event.target.value))}
                data-testid="host-player-count"
              >
                <option value="any">Any — starts with {MIN_PLAYERS} or more, up to {seatMax}</option>
                {Array.from({ length: seatMax - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
                  <option key={n} value={n}>
                    Exactly {n}
                  </option>
                ))}
              </select>
              <p style={styles.note}>
                {playerCount === null
                  ? "The host may start once two seats are ready; the table closes when the board's seats are full."
                  : `Nobody may join past ${playerCount}, and the game starts only when exactly ${playerCount} seats are ready.`}
              </p>
            </Section>

            <Section title="Tile Set">
              {tileTag ? (
                <ToggleRow
                  title={VARIANT_COPY.plusTiles.label}
                  tag={tileTag.tag}
                  blurb={`${VARIANT_COPY.plusTiles.blurb} ${tileTag.note}`}
                  checked={variants.plusTiles}
                  onChange={(checked) => setVariants((current) => ({ ...current, plusTiles: checked }))}
                  testId="host-plus-tiles"
                />
              ) : (
                <p style={styles.note}>The Level Playing Field brings the Project 18XX+ tile set.</p>
              )}
            </Section>

            <Section title="Bank Size">
              <select
                style={styles.select}
                aria-label="Bank size"
                value={variants.length}
                onChange={(event) => setVariants((current) => ({ ...current, length: event.target.value as GameLength }))}
                data-testid="host-bank-size"
              >
                {(["short", "standard", "long"] as const).map((length) => (
                  <option key={length} value={length}>
                    ${BANK_SIZE_BY_LENGTH[length].toLocaleString("en-US")}
                    {length === recommendedLength ? " (recommended)" : ""}
                  </option>
                ))}
              </select>
              <p style={styles.note}>{GAME_LENGTH_BLURB[variants.length]}</p>
            </Section>

            {HOUSE_RULE_ROWS.map((row) => (
              <ToggleRow
                key={row.key}
                title={row.title}
                tag={row.tag}
                blurb={VARIANT_COPY[row.key].blurb}
                checked={variants[row.key]}
                onChange={(checked) => setVariants((current) => ({ ...current, [row.key]: checked }))}
                testId={`host-rule-${row.key}`}
              />
            ))}

            {error && <p style={styles.warning}>{error}</p>}

            <div style={styles.footer}>
              <button type="button" style={styles.secondaryButton} onClick={() => setStep("type")} disabled={busy}>
                Back
              </button>
              <button
                type="button"
                style={{ ...styles.primaryButton, ...(busy ? styles.disabled : {}) }}
                onClick={create}
                disabled={busy}
                data-testid="host-create-room"
              >
                {busy ? "Opening…" : "Create Room"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default HostSetupCard;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <span style={styles.sectionTitle}>{title}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  name,
}: {
  value: T;
  options: ReadonlyArray<{ key: T; label: string; blurb: string }>;
  onChange: (value: T) => void;
  name: string;
}) {
  return (
    <div style={styles.segmented} role="radiogroup" aria-label={name}>
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={selected}
            style={{ ...styles.segment, ...(selected ? styles.segmentSelected : {}) }}
            onClick={() => onChange(option.key)}
            data-testid={`host-${name}-${option.key}`}
          >
            <span style={styles.segmentLabel}>{option.label}</span>
            <span style={styles.segmentBlurb}>{option.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

const TAG_TEXT: Readonly<Record<VariantTag, string>> = {
  recommended: "recommended",
  easier: "easier",
  riskier: "riskier",
  harder: "harder",
  chaotic: "chaotic",
};

function ToggleRow({
  title,
  tag,
  blurb,
  checked,
  onChange,
  testId,
}: {
  title: string;
  tag: VariantTag | null;
  blurb: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <label style={styles.toggleRow}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid={testId} style={styles.checkbox} />
      <span style={styles.toggleText}>
        <span style={styles.toggleTitle}>
          {title}
          {tag && <span style={{ ...styles.tag, ...(tag === "recommended" ? styles.tagRecommended : {}) }}>({TAG_TEXT[tag]})</span>}
        </span>
        <span style={styles.toggleBlurb}>{blurb}</span>
      </span>
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 4200,
    pointerEvents: "auto", // #1360
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
    overflowY: "auto",
  },
  card: {
    width: "min(600px, 100%)",
    maxHeight: "calc(100vh - 48px)",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    padding: "18px 20px",
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800 },
  closeButton: { background: "none", border: "none", color: "#8a8a86", cursor: "pointer", fontSize: FONT_SIZE.heading, lineHeight: 1 },
  terms: { margin: 0, fontSize: FONT_SIZE.small, color: "#8a8a86", letterSpacing: "0.02em" },
  section: { display: "flex", flexDirection: "column", gap: "6px" },
  sectionTitle: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8a8a86" },
  typeGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" },
  typeBox: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    textAlign: "left",
    cursor: "pointer",
    minHeight: "96px",
  },
  typeBoxSelected: { borderColor: "#6fae86", backgroundColor: "#173327", boxShadow: "inset 0 0 0 1px #6fae86" },
  typeLabel: { fontSize: FONT_SIZE.body, fontWeight: 800 },
  typeBlurb: { fontSize: FONT_SIZE.micro, color: "#c8c6c0", lineHeight: 1.4 },
  segmented: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px" },
  segment: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    textAlign: "left",
    cursor: "pointer",
  },
  segmentSelected: { borderColor: "#6fae86", backgroundColor: "#173327", boxShadow: "inset 0 0 0 1px #6fae86" },
  segmentLabel: { fontSize: FONT_SIZE.small, fontWeight: 800 },
  segmentBlurb: { fontSize: FONT_SIZE.micro, color: "#c8c6c0", lineHeight: 1.4 },
  row: { display: "flex", gap: "8px", alignItems: "center" },
  input: {
    flex: 1,
    padding: "7px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.body,
    fontVariantNumeric: "tabular-nums",
  },
  inputDisabled: { color: "#6e6c68", cursor: "not-allowed" },
  select: {
    padding: "7px 10px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.small,
  },
  note: { fontSize: FONT_SIZE.micro, color: "#8a8a86", lineHeight: 1.4, margin: 0 },
  toggleRow: { display: "flex", gap: "10px", alignItems: "flex-start", cursor: "pointer" },
  checkbox: { marginTop: "3px" },
  toggleText: { display: "flex", flexDirection: "column", gap: "2px" },
  toggleTitle: { fontSize: FONT_SIZE.small, fontWeight: 800, display: "flex", gap: "6px", alignItems: "baseline" },
  tag: { fontSize: FONT_SIZE.micro, fontWeight: 600, color: "#8a8a86" },
  tagRecommended: { color: "#9ed8b4" },
  toggleBlurb: { fontSize: FONT_SIZE.micro, color: "#c8c6c0", lineHeight: 1.4 },
  warning: { fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.4, margin: 0 },
  footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px", marginTop: "4px" },
  secondaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
  },
  primaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  disabled: { borderColor: "#3a3a3a", backgroundColor: "#1c1c1c", color: "#6e6c68", cursor: "not-allowed" },
};
