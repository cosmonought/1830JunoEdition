// frontend/src/components/TrustFacts.tsx
//
// ==================================================================
//  PHASE 3 (P3-ACCT): FACTS ABOUT A PLAYER'S HISTORY HERE -- NEVER A SCORE
// ==================================================================
//
// The owner's direction: no composite trust score. A player deciding whether to sit at a stranger's real-money table
// reads a few FACTS from this server's own records, each under the heading it belongs to:
//
//   Profile history       member since; completed real-money games; disputes (unresolved now / closed by the
//                         resolver); inactivity exits (the escrow's own exit for a table that stopped).
//   Prior relationships   distinct ESTABLISHED opponents: other profiles this one completed a real-money game with,
//                         each counted once. P3-ACCT POLICY (owner ruling 2026-10-05): a profile is established once it
//                         has completed at least one real-money game (cancelled, annulled and free games never count).
//                         The server derives the number; a null (an older server) reads "not counted".
//   Identity assurance    PHASE 3 FINAL: since when the account's current AUTHORIZATION WALLET has been designated (no
//                         address). It is the account's own authority (it recovers it), proven by a signature -- not a
//                         payout wallet (each table pays the wallet anted there) and not whatever wallet a browser has
//                         connected.
//
// None of these proves who controls an account, and the panel says so. No id, username, address, IP or device signal
// is ever shown -- the server never sends one (`utils/trustApi.ts` reads the answer strictly).

import React, { useEffect, useState } from "react";

import { myTrustFacts, tableTrustFacts, type TrustFacts } from "../utils/trustApi";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { useSession } from "../utils/useSession";
import { SANDBOX_INK, SANDBOX_TEXT, SANDBOX_TITLE } from "../styles/palette";
import { FONT_SIZE } from "../styles/typography";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The server says the age exactly under a week, then in whole weeks. */
const ageOf = (days: number): string => (days < 7 ? plural(days, "day") : `about ${plural(Math.floor(days / 7), "week")}`);

export const TRUST_FACTS_DISCLAIMER = "Facts from this server's records, not a rating. None of them proves who controls an account.";

/** One profile's facts, under the three headings. */
export function TrustFactsList({ facts, testId = "trust-facts" }: { facts: TrustFacts; testId?: string }): JSX.Element {
  const disputes = facts.unresolvedDisputes === 0 && facts.disputedGames === 0 ? "none" : `${facts.unresolvedDisputes} unresolved now · ${facts.disputedGames} closed by the resolver`;
  return (
    <dl style={trustStyles.list} data-testid={testId}>
      <dt style={trustStyles.group}>Profile history</dt>
      <dd style={trustStyles.fact}>
        Member since {facts.memberSince} ({ageOf(facts.accountAgeDays)})
      </dd>
      <dd style={trustStyles.fact}>{plural(facts.completedMoneyGames, "completed real-money game")}</dd>
      <dd style={trustStyles.fact}>Disputes: {disputes}</dd>
      <dd style={trustStyles.fact}>Inactivity exits: {facts.inactivityExits === 0 ? "none" : facts.inactivityExits}</dd>
      <dt style={trustStyles.group}>Prior relationships</dt>
      <dd style={trustStyles.fact} data-testid={`${testId}-relationships`}>
        {facts.establishedOpponents === null ? "Established opponents aren't counted by this server." : `${plural(facts.establishedOpponents, "established opponent")} (completed real-money games together)`}
      </dd>
      <dt style={trustStyles.group}>Identity assurance</dt>
      <dd style={trustStyles.fact} data-testid={`${testId}-authorization`}>
        {facts.authorizationWalletSince === null ? "Authorization Wallet: not shown by this server" : `Account secured by an Authorization Wallet since ${facts.authorizationWalletSince}`}
      </dd>
    </dl>
  );
}

/** The seats of a table, each with its facts (read once per table and seat list). */
export function TableTrustFacts({ gameId, players, port }: { gameId: string; players: ReadonlyArray<{ id: string; nickname: string }>; port?: SessionPort }): JSX.Element | null {
  const [seats, setSeats] = useState<ReadonlyMap<string, TrustFacts> | null>(null);
  const roster = players.map((player) => player.id).join(",");
  /* Re-review N5: the facts are for signed-in players only (the server refuses a visitor) -- read again the moment this
     page signs in (or as someone else). */
  const session = useSession(port ?? sessionPort());
  const signedInAs = session.state === "ready" ? (session.account?.name ?? "") : null;
  useEffect(() => {
    if (signedInAs === null) {
      setSeats(null);
      return undefined;
    }
    let live = true;
    void tableTrustFacts(gameId, port).then((answer) => {
      if (live) setSeats(answer.ok ? answer.seats : null);
    });
    return () => {
      live = false;
    };
  }, [gameId, roster, port, signedInAs]);
  if (seats === null || seats.size === 0) return null;
  return (
    <details style={trustStyles.box} data-testid="table-trust-facts">
      <summary style={trustStyles.summary}>Players' history here</summary>
      <p style={trustStyles.note}>{TRUST_FACTS_DISCLAIMER}</p>
      {players.map((player) => {
        const facts = seats.get(player.id);
        if (facts === undefined) return null;
        return (
          <div key={player.id} style={trustStyles.seat}>
            <p style={trustStyles.name}>{player.nickname}</p>
            <TrustFactsList facts={facts} testId={`trust-facts-${player.id}`} />
          </div>
        );
      })}
    </details>
  );
}

/** PLAY WAITING ROOM (handoff §8): ONE seat's facts, for the player panel a seated viewer opens from a name -- the same
 *  read as `TableTrustFacts` (the server answers seated, signed-in players only, and refuses anyone else), shown for the
 *  one player tapped. Nothing while it can't be read. */
export function SeatTrustFacts({ gameId, playerId, port }: { gameId: string; playerId: string; port?: SessionPort }): JSX.Element | null {
  const [seats, setSeats] = useState<ReadonlyMap<string, TrustFacts> | null>(null);
  const session = useSession(port ?? sessionPort());
  const signedInAs = session.state === "ready" ? (session.account?.name ?? "") : null;
  useEffect(() => {
    if (signedInAs === null) {
      setSeats(null);
      return undefined;
    }
    let live = true;
    void tableTrustFacts(gameId, port).then((answer) => {
      if (live) setSeats(answer.ok ? answer.seats : null);
    });
    return () => {
      live = false;
    };
  }, [gameId, playerId, port, signedInAs]);
  const facts = seats?.get(playerId);
  if (facts === undefined) return null;
  return <TrustFactsList facts={facts} testId={`trust-facts-${playerId}`} />;
}

/** The account's own facts (the profile menu). */
export function MyTrustFacts({ port }: { port?: SessionPort }): JSX.Element | null {
  const [facts, setFacts] = useState<TrustFacts | null>(null);
  useEffect(() => {
    let live = true;
    void myTrustFacts(port).then((answer) => {
      if (live) setFacts(answer);
    });
    return () => {
      live = false;
    };
  }, [port]);
  if (facts === null) return null;
  return (
    <details style={trustStyles.box} data-testid="my-trust-facts">
      <summary style={trustStyles.summary}>What other players see about you</summary>
      <p style={trustStyles.note}>{TRUST_FACTS_DISCLAIMER}</p>
      <TrustFactsList facts={facts} testId="my-trust-facts-list" />
    </details>
  );
}

const trustStyles: Record<"box" | "summary" | "note" | "seat" | "name" | "list" | "group" | "fact", React.CSSProperties> = {
  box: { margin: "8px 0", fontSize: FONT_SIZE.small, color: SANDBOX_INK },
  summary: { cursor: "pointer", color: SANDBOX_TITLE, fontWeight: 700 },
  note: { margin: "6px 0", fontSize: FONT_SIZE.small, color: SANDBOX_TEXT },
  seat: { margin: "8px 0 0" },
  name: { margin: "0 0 2px", fontWeight: 700 },
  list: { margin: 0 },
  group: { margin: "6px 0 2px", fontWeight: 700, color: SANDBOX_TEXT },
  fact: { margin: "0 0 2px 12px" },
};
