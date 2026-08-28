// Dumps one sandbox room's action log to JSON. Run from `frontend/` so the firebase dep and .env resolve:
//   node --env-file=.env dump-sandbox-log.mjs JUNO-Y8V
// Writes `sandbox-log-<CODE>.json` beside this file. Read-only — it never writes to Firestore.
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, orderBy } from "firebase/firestore";
import { writeFileSync } from "node:fs";

const code = process.argv[2];
if (!code) throw new Error("usage: node --env-file=.env dump-sandbox-log.mjs <ROOM-CODE>");

const app = initializeApp({
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
});

// `sandbox_rooms/{code}/actions`, ordered by `index` — the same path and order `readSandboxLog` uses.
const snap = await getDocs(
  query(collection(getFirestore(app), "sandbox_rooms", code, "actions"), orderBy("index")),
);

// `payload` is a JSON string of the ExecuteMsg; parsed here so the file is the messages, not strings of them.
const actions = snap.docs.map((d) => {
  const raw = d.data();
  let msg = null;
  try {
    msg = JSON.parse(raw.payload);
  } catch {
    msg = { UNPARSEABLE: raw.payload ?? null };
  }
  return { index: raw.index, actor: raw.actor ?? null, derived: raw.derived === true, msg };
});

const out = `sandbox-log-${code}.json`;
writeFileSync(out, JSON.stringify({ roomCode: code, count: actions.length, actions }, null, 2));
console.log(`wrote ${out} — ${actions.length} actions`);
console.log(
  `LayTile entries: ${actions.filter((a) => a.msg && "LayTile" in a.msg).length}` +
    ` (these are the ones carrying the orientations)`,
);
