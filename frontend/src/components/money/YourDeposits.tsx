// frontend/src/components/money/YourDeposits.tsx
//
// ==================================================================
//  ESCROW-4 (brief §15): "YOUR DEPOSITS" -- THE WAY BACK TO MONEY WHOSE TABLE IS AWKWARD OR GONE
// ==================================================================
//
// A deposit sits in escrow on Juno whether or not its table is still in the lobby: the room may have expired or been
// cancelled, the host may have left, the player may be on another device. This list is the server's answer to "which
// escrow seats do my linked wallets hold?" (`POST /gs/api/money/deposits`, built from the ticket ledger and a chain
// read, never from this browser), with the wallet actions each one allows -- Withdraw, Cancel (the creator), Refund
// everyone (after the funding deadline) -- signed by this browser against its own pinned escrow after a chain read of
// the seat, and "Open table" when the table can still be opened. If the server can't be reached, the transactions this
// browser itself sent are listed from its own record, so a withdrawal is never hidden behind the waiting room.

import React, { useCallback, useEffect, useRef, useState } from "react";

import type { MoneyDepositEntry } from "../../utils/moneyProtocol";
import { formatAmount, shortWallet } from "../../utils/moneyProtocol";
import type { SessionPort } from "../../utils/sessionBootstrap";
import { depositEntryExit, reconcilePending, resendPending, type ActionOutcome, type EscrowExit } from "../../money/moneyActions";
import { yourDeposits } from "../../money/moneyApi";
import { bumpLocal, moneyServices, useMoneySession, type MoneyServices } from "../../money/moneySession";
import { browserKeplrLock, KEPLR_BUSY_SENTENCE } from "../../money/keplrLock";
import { TermsLink } from "../InfoPages";
import { buttonStyle, moneyStyles as styles } from "./moneyStyles";

export interface YourDepositsProps {
  /** Open a table by its game id (as "Your tables" does). */
  onOpen: (gameId: string) => void;
  port?: SessionPort;
  services?: MoneyServices;
}

const STATE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  FUNDING: "funding",
  FUNDED: "fully funded, not started",
  IN_PROGRESS: "game in progress",
  SETTLEABLE: "payout recorded",
  DISPUTED: "disputed",
  SETTLED: "paid out",
  CANCELLED: "cancelled",
  ANNULLED: "annulled",
});

const EXIT_LABEL: Readonly<Record<EscrowExit, string>> = Object.freeze({ withdraw: "Withdraw", "cancel-escrow": "Cancel escrow", "refund-after-deadline": "Refund everyone" });

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ create: "table-opening deposit", join: "deposit", withdraw: "withdrawal", cancel: "cancel", "set-consent-key": "signing-key change", challenge: "dispute", "liveness-settle": "inactivity close", finalize: "payout release" });

export function YourDeposits({ onOpen, port, services }: YourDepositsProps): JSX.Element | null {
  const svc = services ?? moneyServices();
  /* Re-render when this browser's pending records change (a send from here, a record dropped). */
  useMoneySession();
  const pinned = svc.pin();
  const [entries, setEntries] = useState<readonly MoneyDepositEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /* Single flight by ref: a second click lands before React re-renders the disabled button. */
  const busyRef = useRef<string | null>(null);
  const [said, setSaid] = useState<{ key: string; outcome: ActionOutcome } | null>(null);

  const load = useCallback(async () => {
    /* This browser's own transactions first: what Juno included or can no longer include stops blocking (M4). */
    const notice = await reconcilePending(null, svc, port);
    if (notice !== null) setSaid({ key: "reconcile", outcome: { ok: true, notice } });
    const answer = await yourDeposits(port);
    if (answer.ok) {
      setEntries(answer.value);
      setFailure(null);
    } else {
      setEntries(null);
      /* A server without real-money tables has no such route: nothing to say. */
      setFailure(answer.code === "not-found" || answer.code === "unavailable" ? null : answer.reason);
    }
  }, [port, svc]);

  const local = pinned.ok ? svc.pending.all().filter((record) => (record.chainGameId !== null && (record.kind === "create" || record.kind === "join")) || record.playerId.startsWith("wallet:")) : [];
  const waiting = local.length > 0;
  useEffect(() => {
    if (!pinned.ok) return undefined;
    void load();
    /* While this browser has a transaction on its way, look again now and then (it is dropped once Juno answers). */
    if (!waiting) return undefined;
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned.ok, waiting]);

  if (!pinned.ok) return null;
  const listed = entries ?? [];
  const unsent = local.filter((record) => record.stage === "signed");
  const localDeposits = local.filter((record) => record.chainGameId !== null && (record.kind === "create" || record.kind === "join") && record.stage !== "signed");
  if (listed.length === 0 && failure === null && local.length === 0) return null;

  const act = async (key: string, run: () => Promise<ActionOutcome>) => {
    if (busyRef.current !== null) return;
    busyRef.current = key;
    setBusy(key);
    setSaid(null);
    /* W1-K (money review L4): a withdrawal or a cancel opens Keplr -- one Keplr conversation at a time across tabs.
       Re-review NIT: whatever happens, the latch is released (a thrown step reads as a refusal, never a stuck button). */
    let outcome: ActionOutcome;
    try {
      const locked = await (svc.keplrLock ?? browserKeplrLock()).withLock(run);
      outcome = locked.kind === "ran" ? locked.value : { ok: false, reason: KEPLR_BUSY_SENTENCE };
    } catch {
      outcome = { ok: false, reason: "That didn't complete. Check this list (it reads Juno) before trying again." };
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
    setSaid({ key, outcome });
    bumpLocal();
    void load();
  };

  const fmt = (entry: MoneyDepositEntry, base: string) => formatAmount(base, entry.deployment.exponent, entry.deployment.symbol);

  return (
    <section style={{ ...styles.band, borderTop: "none", paddingTop: 0 }} aria-label="Your deposits" data-testid="your-deposits">
      <p style={styles.bandTitle}>
        Your deposits <TermsLink style={{ fontWeight: 400, marginLeft: "8px" }} testId="deposits-terms-link" />
      </p>
      {failure !== null ? <p style={styles.blocker}>{failure}</p> : null}
      {listed.length > 0 ? (
        <ul style={styles.list}>
          {listed.map((entry) => {
            const key = `${entry.chainGameId}|${entry.wallet}`;
            return (
              <li key={key} style={styles.entry} data-testid="your-deposit">
                <span style={styles.detail}>
                  <strong>{fmt(entry, entry.grossDeposit)}</strong> from {shortWallet(entry.wallet)} · escrow game {entry.chainGameId} on {entry.deployment.chainId} · {STATE_WORDS[entry.chainState] ?? entry.chainState}
                </span>
                <span style={styles.faint}>
                  {entry.relation === "duplicate"
                    ? "A second escrow your wallet opened for this table (the table uses another one). Cancel it to get the deposit back, minus the fee."
                    : entry.relation === "unlinked"
                      ? "This deposit isn't linked to your seat anymore: relink it from the table (free), or withdraw it."
                      : entry.chainState !== "FUNDING" && entry.chainState !== "FUNDED"
                        ? "The game has started: the deposit stays in escrow until it is settled or cancelled on Juno."
                        : entry.tableOpen
                          ? "Its table is open."
                          : "Its table is closed; the deposit is still yours on Juno."}{" "}
                  {entry.netDeposit !== "0" && (entry.chainState === "FUNDING" || entry.chainState === "FUNDED") ? `Refundable now: ${fmt(entry, entry.netDeposit)} (the fee isn't refunded).` : ""}
                </span>
                <span style={styles.row}>
                  {(["withdraw", "cancel-escrow", "refund-after-deadline"] as const)
                    .filter((exit) => entry.actions.includes(exit))
                    .map((exit) => (
                      <button key={exit} type="button" style={buttonStyle(exit === "cancel-escrow" ? "danger" : "secondary", busy !== null)} disabled={busy !== null} onClick={() => void act(key, () => depositEntryExit(entry, exit, svc, port))} data-testid={`your-deposit-${exit}`}>
                        {busy === key ? `${EXIT_LABEL[exit]}…` : EXIT_LABEL[exit]}
                      </button>
                    ))}
                  {entry.actions.includes("open-table") || entry.actions.includes("relink") ? (
                    <button type="button" style={buttonStyle("secondary", false)} onClick={() => onOpen(entry.gameId)} data-testid="your-deposit-open">
                      Open table
                    </button>
                  ) : null}
                </span>
                {said !== null && said.key === key ? <span style={said.outcome.ok ? styles.notice : styles.error}>{said.outcome.ok ? (said.outcome.notice ?? "Sent.") : said.outcome.reason}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {entries === null && localDeposits.length > 0 ? (
        <ul style={styles.list}>
          {localDeposits.map((record) => {
            const entry: MoneyDepositEntry = {
              gameId: record.gameId,
              tableOpen: false,
              deployment: pinned.pin,
              chainGameId: record.chainGameId as string,
              wallet: record.sender,
              grossDeposit: "0",
              netDeposit: "0",
              chainState: "unknown",
              fundingDeadline: null,
              relation: "bound",
              creator: record.kind === "create",
              /* The escrow's creator leaves by Cancel (every deposit comes back); a joiner by Withdraw. */
              actions: [record.kind === "create" ? "cancel-escrow" : "withdraw"],
            };
            const exit: EscrowExit = record.kind === "create" ? "cancel-escrow" : "withdraw";
            const key = `local|${record.txHash}`;
            return (
              <li key={key} style={styles.entry} data-testid="your-deposit-local">
                <span style={styles.detail}>
                  This browser sent a deposit from {shortWallet(record.sender)} to escrow game {record.chainGameId} (transaction {record.txHash.slice(0, 10)}…).
                </span>
                <span style={styles.row}>
                  <button type="button" style={buttonStyle(exit === "cancel-escrow" ? "danger" : "secondary", busy !== null)} disabled={busy !== null} onClick={() => void act(key, () => depositEntryExit(entry, exit, svc, port))}>
                    {EXIT_LABEL[exit]}
                  </button>
                  <button type="button" style={buttonStyle("secondary", false)} onClick={() => onOpen(record.gameId)}>
                    Open table
                  </button>
                </span>
                {said !== null && said.key === key ? <span style={said.outcome.ok ? styles.notice : styles.error}>{said.outcome.ok ? (said.outcome.notice ?? "Sent.") : said.outcome.reason}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {unsent.length > 0 ? (
        <ul style={styles.list}>
          {unsent.map((record) => (
            <li key={`unsent|${record.txHash}`} style={styles.entry} data-testid="your-deposit-unsent">
              <span style={styles.detail}>
                This browser signed a {KIND_WORDS[record.kind] ?? "transaction"} from {shortWallet(record.sender)} (transaction {record.txHash.slice(0, 10)}…) that may not have reached Juno.
              </span>
              <span style={styles.row}>
                <button type="button" style={buttonStyle("primary", busy !== null)} disabled={busy !== null} onClick={() => void act(`unsent|${record.txHash}`, () => resendPending(record, svc, port))} data-testid="your-deposit-resend">
                  Send again
                </button>
              </span>
              {said !== null && said.key === `unsent|${record.txHash}` ? <span style={said.outcome.ok ? styles.notice : styles.error}>{said.outcome.ok ? (said.outcome.notice ?? "Sent.") : said.outcome.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {said !== null && said.key === "reconcile" && said.outcome.ok ? <p style={styles.notice}>{said.outcome.notice}</p> : null}
      <span style={styles.row}>
        <button type="button" style={styles.quiet} onClick={() => void load()} data-testid="your-deposits-refresh">
          Check again
        </button>
      </span>
    </section>
  );
}

export default YourDeposits;
