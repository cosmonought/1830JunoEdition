// frontend/src/utils/tablePolicy.ts
//
// ==================================================================
//  PHASE 3 FINAL (§13, owner ruling 2026-10-06): EVERY PLAYER GAME IS ANTED
// ==================================================================
//
// The product offers no free player mode: a game is hosted with a real ante on Juno's escrow, and a seat is taken by
// depositing it. So the host card has no "play for fun" choice (the stake is required, and when the server isn't
// opening real-money tables nothing can be hosted), and a no-ante table in the public list -- which a production
// server never creates (`server/src/rooms/roomHost.ts`, `ANTE_REQUIRED`) -- is offered to Watch only. The server is
// the authority either way: it refuses a no-ante table's creation, seat and start outside development mode.
//
// THE ONE EXCEPTION is the internal development-identity build (`REACT_APP_DEV_IDENTITY=1`, never a production bundle --
// the build's `scanDevIdentity` guard), which keeps no-ante tables for internal fixtures against a development server.
// Nothing here fakes an ante, and no escrow economics change.

import { DEV_IDENTITY_BUILD } from "./devIdentity";

/** Whether this build offers no-ante tables at all (internal development-identity builds only). */
export const FREE_TABLES_OFFERED: boolean = DEV_IDENTITY_BUILD;

/** Said where a game would be hosted when the server isn't opening real-money tables. */
export const ANTE_UNAVAILABLE_SENTENCE =
  "Every game here is played for a real ante, and real-money tables aren't open on this server right now, so a game can't be hosted. You can still watch games and read the rules.";

/** Said on a no-ante table in the public list (Watch only). */
export const NO_ANTE_WATCH_ONLY = "No ante — watch only";

/* ==================================================================
    PLAY HOST A GAME (handoff §11): ANY-COUNT MONEY TABLES ARE GATED, NOT REDESIGNED
   ==================================================================
   The approved design offers "Any (up to N)" first, and by default. Deployed Escrow 2.1 requires every seat chosen when
   its game is created to fund before it can start, so an Any-count money table cannot exist on it: the server refuses a
   real-money create without an exact count (`moneyTables.prepareCreate`), and so does this page (`stakeChoice`). Owner
   decision: the escrow is corrected early in Phase 4. Until that correction is certified and this flag turns on WITH
   it, Any stays visible, first and selected by default -- never hidden, never quietly turned into an exact count, its
   copy unchanged -- and Create table says why it is blocked and asks for an exact count. No-ante development tables
   (`FREE_TABLES_OFFERED`) take Any as they always have. */
export const ANY_COUNT_MONEY_TABLES: boolean = false;

/** Said beside a blocked Create table while Any is chosen on a money table. */
export const ANY_COUNT_BLOCKED_SENTENCE =
  "Any-count tables with an ante open once Juno's corrected escrow is certified. For now, choose an exact number of players to create this table.";
