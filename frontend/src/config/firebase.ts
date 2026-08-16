// frontend/src/config/firebase.ts
//
// Firebase App + Firestore initialization (Step 4: Real-Time Integration).
//
// ===================================================================
//  DESIGN NOTE 0: THE ARCHITECTURAL BOUNDARY THIS FILE SITS ON
// ===================================================================
//
// Firebase is WEB2 AND OFF-CHAIN ONLY. It carries exactly three things:
//
//   1. Chat            -- `games/{gameId}/chat`
//   2. Player presence -- `games/{gameId}/seats/{address}.lastSeen`
//   3. Room discovery  -- the `games/` collection, i.e. the pre-game staging
//                         lobby that exists BEFORE a room is on-chain at all
//
// The Juno contract remains the SINGLE source of truth for game state,
// rules, board tiles, treasuries, turn order and turn execution. Nothing in
// this module -- or anything reading from it -- may store, derive, mirror or
// validate official game state. Firestore is in Test Mode (open read/write);
// treating anything it returns as authoritative would mean treating an
// anonymous, unauthenticated, client-writable document as authoritative.
//
// The one field that looks like it crosses the line and does not:
// `RoomDoc.chainGameId`. That is a POINTER, not state -- the `u64` the
// contract itself assigned at `CreateGameRoom` and emitted as a tx
// attribute. It is written once by the host from a confirmed transaction
// result and thereafter only ever used as the argument to a real
// `GetGameState` query. If Firestore lies about it, the query returns a
// different room or fails outright; it cannot make the contract agree.
// `firestore.rules` (repo root) enforces this in the database itself --
// `chainGameId` is write-once, and no client may write any field named for
// game state.
//
// ===================================================================
//  DESIGN NOTE 1: WHY THIS FILE DOES NOT THROW AT IMPORT
// ===================================================================
//
// Identical reasoning to `../config.ts`'s own design note #0, and the same
// failure it was written to prevent. That module used to validate at module
// scope, which crashed the whole bundle before React could mount whenever
// `.env` was incomplete, and made the documented Offline Sandbox Mode
// unreachable. Firebase would reintroduce exactly that bug in a new place:
// `initializeApp` with a missing `apiKey`/`projectId` throws synchronously,
// and if that call sat at module scope it would take down the app at
// `import` time -- for a subsystem that only carries CHAT AND LOBBY. Losing
// the entire rail map because nobody configured a chat backend is an absurd
// failure mode, so it is structurally prevented here rather than merely
// avoided by convention.
//
// So the same two-tier rule applies:
//
//   - READING config never throws. Unset values are `undefined`, meaning
//     "no real-time backend" -- a legitimate state in which the board, the
//     tile catalog and every on-chain query still work perfectly.
//   - REQUIRING a live Firestore handle throws, and only at the moment an
//     operation genuinely needs one (opening the lobby, sending a chat
//     message). The error names the exact missing variable.
//
// `getFirestoreDb()` returns `null` rather than throwing, and every caller
// in `utils/lobby.ts` / `components/ChatBox.tsx` is written to degrade to a
// clearly-labelled "real-time features unavailable" state on `null`.
//
// ===================================================================
//  DESIGN NOTE 2: LAZY, IDEMPOTENT INITIALIZATION
// ===================================================================
//
// Initialization is deferred to first use and memoised, for three separate
// reasons that each independently require it:
//
//   - Design note #1: it must not run at import.
//   - `React.StrictMode` (see `index.tsx` design note #3) double-invokes
//     effects in development. An effect that initializes Firebase would run
//     twice, and `initializeApp` throws `app/duplicate-app` on a second call
//     with the same name. The `getApps().length` check below makes a second
//     call reuse the existing instance instead.
//   - Webpack HMR re-executes a changed module while the previous Firebase
//     app is still live in the same page, which is the same duplicate-app
//     collision arriving by a different route. Same guard covers it.
//
// ===================================================================
//  DESIGN NOTE 3: VALIDATION IS SHAPE-ONLY, AND ONLY FOR WHAT FIRESTORE USES
// ===================================================================
//
// Matching `../config.ts` design note #3: this checks the shape of each
// value to catch "still a placeholder" and "left unset", not to verify the
// credentials are real. A wrong-but-well-formed `projectId` is caught by
// Firestore with a clear permission/not-found error; a placeholder was not,
// which is the whole reason for the check.
//
// Only THREE variables are actually required, because this app uses
// Firestore and nothing else:
//
//   REACT_APP_FIREBASE_API_KEY      -- required
//   REACT_APP_FIREBASE_PROJECT_ID   -- required
//   REACT_APP_FIREBASE_APP_ID       -- required
//
// `authDomain` (Firebase Auth), `storageBucket` (Cloud Storage) and
// `messagingSenderId` (FCM) are passed through when present but are NOT
// required, because no code path here touches those products. Requiring
// them would fail the app for a missing value it never reads -- the precise
// species of dishonest validation `../config.ts` exists to avoid. Revisit
// the moment Auth is added (which it should be, before Test Mode lapses --
// see `firestore.rules`).
//
// NOTHING SECRET GOES HERE. Every one of these values ships to the browser
// in plain text, exactly like the chain config. A Firebase "API key" is a
// public project identifier, not a credential -- it identifies which
// project a request is for and grants nothing on its own. What actually
// protects the data is `firestore.rules`, which is why that file matters
// far more than any value below.

import { initializeApp, getApps, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

// Design note #2 of `../config.ts`: the reads MUST be literal
// `process.env.REACT_APP_FOO` expressions -- `react-scripts` substitutes
// them textually at build time, and neither destructuring nor dynamic
// indexing is substituted (both silently yield `undefined` in a production
// bundle). `readOptional` is shared from `../config` and takes the
// already-read VALUE for exactly that reason.
import { readOptional } from "../config";

/** Named so a duplicate-app collision (design note #2) is legible in a
 *  stack trace rather than showing Firebase's anonymous `[DEFAULT]`. */
const FIREBASE_APP_NAME = "18cosmos";

/* ------------------------------------------------------------------ */
/* Raw values. Reading these NEVER throws -- design note #1.           */
/* ------------------------------------------------------------------ */

export const FIREBASE_API_KEY = readOptional(process.env.REACT_APP_FIREBASE_API_KEY);
export const FIREBASE_PROJECT_ID = readOptional(process.env.REACT_APP_FIREBASE_PROJECT_ID);
export const FIREBASE_APP_ID = readOptional(process.env.REACT_APP_FIREBASE_APP_ID);
export const FIREBASE_AUTH_DOMAIN = readOptional(process.env.REACT_APP_FIREBASE_AUTH_DOMAIN);
export const FIREBASE_STORAGE_BUCKET = readOptional(process.env.REACT_APP_FIREBASE_STORAGE_BUCKET);
export const FIREBASE_MESSAGING_SENDER_ID = readOptional(
  process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
);

/* ------------------------------------------------------------------ */
/* Shape checks -- design note #3.                                      */
/* ------------------------------------------------------------------ */

/** Browser API keys Google issues are `AIza` + 35 more URL-safe characters.
 *  Rejects `"your-api-key-here"`, `"AIza..."` and similar placeholders. */
function looksLikeApiKey(value: string): boolean {
  return /^AIza[0-9A-Za-z_-]{35}$/.test(value);
}

/** Project ids are lowercase alphanumerics and hyphens, 6-30 chars, and
 *  cannot start or end with a hyphen. Rejects `"your-project-id"`? No --
 *  that is a WELL-FORMED project id and deliberately passes: this is a
 *  shape check, not an existence check (design note #3). It does reject the
 *  dotted/underscored/uppercase placeholders people actually paste. */
function looksLikeProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

/** App ids are `1:<sender>:web:<hash>`. The literal colons make this the
 *  most reliably placeholder-proof of the three. */
function looksLikeAppId(value: string): boolean {
  return /^1:\d+:web:[0-9a-f]+$/i.test(value);
}

interface FieldCheck {
  name: string;
  value: string | undefined;
  ok: (value: string) => boolean;
  hint: string;
}

const REQUIRED_FIELDS: readonly FieldCheck[] = [
  {
    name: "REACT_APP_FIREBASE_API_KEY",
    value: FIREBASE_API_KEY,
    ok: looksLikeApiKey,
    hint: "a browser API key beginning 'AIza'",
  },
  {
    name: "REACT_APP_FIREBASE_PROJECT_ID",
    value: FIREBASE_PROJECT_ID,
    ok: looksLikeProjectId,
    hint: "a lowercase project id such as 'eighteen-cosmos'",
  },
  {
    name: "REACT_APP_FIREBASE_APP_ID",
    value: FIREBASE_APP_ID,
    ok: looksLikeAppId,
    hint: "an app id shaped '1:123456789:web:abc123def456'",
  },
];

/** The first configuration problem, or `null` if Firestore can be reached.
 *  Safe to call anywhere and never throws -- mirrors `../config.ts`'s
 *  `chainConfigError()`, and is what the UI uses to explain itself. */
export function firebaseConfigError(): string | null {
  for (const field of REQUIRED_FIELDS) {
    if (field.value === undefined) {
      return (
        `[firebase] ${field.name} is not set, so real-time chat and the lobby are ` +
        "unavailable. Add it to frontend/.env (see .env.example) and RESTART the dev " +
        "server — react-scripts substitutes REACT_APP_* at build time. The rail map, " +
        "tile catalog and every on-chain query work without it."
      );
    }
    if (!field.ok(field.value)) {
      return (
        `[firebase] ${field.name} is set to "${field.value}", which is not ${field.hint}. ` +
        "This is almost always a leftover placeholder. Copy the real value from the " +
        "Firebase console: Project settings -> General -> Your apps -> SDK setup and configuration."
      );
    }
  }
  return null;
}

/** Whether every required Firebase value is present AND well-formed.
 *
 *  `false` means real-time features are off: no lobby, no chat, no
 *  presence. Use it to LABEL the UI honestly, not to hide the failure --
 *  a player who sees "Real-time offline" and a reason is informed; one who
 *  sees an empty room list is misled into thinking nobody is playing. */
export function isFirebaseConfigured(): boolean {
  return firebaseConfigError() === null;
}

/* ------------------------------------------------------------------ */
/* Lazy, idempotent initialization -- design note #2.                   */
/* ------------------------------------------------------------------ */

let cachedApp: FirebaseApp | null = null;
let cachedDb: Firestore | null = null;
/** Set if `initializeApp`/`getFirestore` themselves threw. Cached so a
 *  broken config produces one console error, not one per render of every
 *  component that asks for a handle. */
let initFailure: string | null = null;

function buildOptions(): FirebaseOptions {
  // Non-null assertions are safe here and ONLY here: this is called solely
  // behind an `isFirebaseConfigured()` gate, which has already proven all
  // three required values are present and well-formed.
  return {
    apiKey: FIREBASE_API_KEY!,
    projectId: FIREBASE_PROJECT_ID!,
    appId: FIREBASE_APP_ID!,
    // Optional -- omitted entirely rather than passed as `undefined`, so
    // the SDK falls back to its own conventional defaults where it has
    // them (e.g. `<projectId>.firebaseapp.com`) instead of seeing an
    // explicitly blank value.
    ...(FIREBASE_AUTH_DOMAIN ? { authDomain: FIREBASE_AUTH_DOMAIN } : {}),
    ...(FIREBASE_STORAGE_BUCKET ? { storageBucket: FIREBASE_STORAGE_BUCKET } : {}),
    ...(FIREBASE_MESSAGING_SENDER_ID ? { messagingSenderId: FIREBASE_MESSAGING_SENDER_ID } : {}),
  };
}

/** The initialized Firebase app, or `null` when unconfigured. */
export function getFirebaseApp(): FirebaseApp | null {
  if (cachedApp) return cachedApp;
  if (initFailure) return null;
  if (!isFirebaseConfigured()) return null;

  try {
    // Design note #2: StrictMode's double-invoked effects and Webpack HMR
    // both re-enter this. Reuse rather than re-initialize -- a second
    // `initializeApp` under the same name throws `app/duplicate-app`.
    const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    cachedApp = existing ?? initializeApp(buildOptions(), FIREBASE_APP_NAME);
    return cachedApp;
  } catch (error) {
    initFailure = error instanceof Error ? error.message : String(error);
    // Deliberately console.error, not throw: an unreachable chat backend
    // must not be able to unmount the board (design note #1).
    console.error("[firebase] initializeApp failed; real-time features disabled.", error);
    return null;
  }
}

/** The Firestore handle, or `null` when Firebase is unconfigured or failed
 *  to initialize.
 *
 *  `null` is a supported, meaningful state -- pass it straight through and
 *  render a "real-time offline" affordance. Do NOT coerce it or assert past
 *  it; every consumer in this codebase already branches on it. */
export function getFirestoreDb(): Firestore | null {
  if (cachedDb) return cachedDb;

  const app = getFirebaseApp();
  if (!app) return null;

  try {
    cachedDb = getFirestore(app);
    return cachedDb;
  } catch (error) {
    initFailure = error instanceof Error ? error.message : String(error);
    console.error("[firebase] getFirestore failed; real-time features disabled.", error);
    return null;
  }
}

/** The Firestore handle, or throw naming the exact missing variable.
 *
 *  Call ONLY from a path that is about to perform a real read or write and
 *  has a caller able to surface the error -- never at module scope, and
 *  never on a render path that the unconfigured state also takes. This is
 *  the direct analogue of `../config.ts`'s `requireContractAddress()`. */
export function requireFirestoreDb(): Firestore {
  const db = getFirestoreDb();
  if (!db) {
    throw new Error(
      firebaseConfigError() ??
        `[firebase] Firestore could not be initialized: ${initFailure ?? "unknown error"}`,
    );
  }
  return db;
}

/* ------------------------------------------------------------------ */
/* Collection paths -- one definition, shared                           */
/* ------------------------------------------------------------------ */
//
// Same rule as `../config.ts` design note #1: a path string duplicated
// across modules is a path string that will eventually drift. These three
// are the ENTIRE Firestore surface this app uses, and `firestore.rules` is
// written against exactly these shapes -- change one here and the rules
// file must change with it, or writes start being denied in production
// while continuing to work in Test Mode.

/** Room discovery / pre-game staging rooms. */
export const ROOMS_COLLECTION = "games";

/** Per-room seat + presence docs, keyed by the player's `juno1...` address:
 *  `games/{roomId}/seats/{address}`. */
export const SEATS_SUBCOLLECTION = "seats";

/** Per-room chat: `games/{roomId}/chat`. Continuous across the staging
 *  room and the live game -- the same collection carries both, so the
 *  transcript does not reset when a room launches on-chain. */
export const CHAT_SUBCOLLECTION = "chat";
