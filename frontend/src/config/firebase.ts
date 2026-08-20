// frontend/src/config/firebase.ts
//
// Firebase App + Firestore init. WEB2 AND OFF-CHAIN ONLY: chat, presence and
// room discovery. The Juno contract stays the single source of truth for all
// game state, and Firestore is in Test Mode -- nothing it returns is authoritative.
//
// RoomDoc.chainGameId is a POINTER, not state: written once from a confirmed tx
// and only ever used as a GetGameState argument. firestore.rules enforces that.
//
// Nothing here is secret -- a Firebase API key is a public project identifier.
// firestore.rules is what protects the data.
//
// Init is lazy, memoised and never throws at import; reading config yields
// undefined ("no real-time backend"), and only requiring a live handle throws.
//
// See docs/ai_architecture/firebase_middleware.md - firebase.ts #0, #1, #2, #3

import { initializeApp, getApps, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

// The reads must be literal process.env.REACT_APP_FOO expressions: react-scripts substitutes them textually, and destructuring or dynamic indexing silently yields undefined in a production bundle.
// See docs/ai_architecture/firebase_middleware.md - firebase.ts #3
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

/** A SHAPE check, not an existence check -- "your-project-id" is well-formed and deliberately passes; this rejects the dotted/underscored/uppercase placeholders people paste.
 *  See docs/ai_architecture/firebase_middleware.md - firebase.ts #3 */
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

/** false means real-time features are off. Use it to LABEL the UI honestly, not to hide the failure: an empty room list misleads, a stated reason informs.
 *  See docs/ai_architecture/firebase_middleware.md - firebase.ts #1 */
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

/** null is a supported, meaningful state -- pass it through and render a "real-time offline" affordance rather than coercing or asserting past it.
 *  See docs/ai_architecture/firebase_middleware.md - firebase.ts #1 */
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

/** Call ONLY from a path about to perform a real read or write with a caller able to surface the error -- never at module scope, never on a render path the unconfigured state also takes.
 *  See docs/ai_architecture/firebase_middleware.md - firebase.ts #1 */
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

// One definition of each collection path: firestore.rules is written against exactly these shapes, so a change here must move with it or writes are denied in production while working in Test Mode.
// See docs/ai_architecture/firebase_middleware.md - firebase.ts #0

/** Room discovery / pre-game staging rooms. */
export const ROOMS_COLLECTION = "games";

/** Per-room seat + presence docs, keyed by the player's `juno1...` address:
 *  `games/{roomId}/seats/{address}`. */
export const SEATS_SUBCOLLECTION = "seats";

/** Per-room chat: `games/{roomId}/chat`. Continuous across the staging
 *  room and the live game -- the same collection carries both, so the
 *  transcript does not reset when a room launches on-chain. */
export const CHAT_SUBCOLLECTION = "chat";
