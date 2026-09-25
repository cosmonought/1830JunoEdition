/** @jest-environment node */
// frontend/src/utils/liveHygiene.test.ts -- LIVE-0, hosted-playtest hygiene.
//
// FOUR SMALL GUARDS ON THE PATH A TUNNELLED PLAYTEST EXPOSES, each pinned where a regression would reopen it:
//   - the playtest proxy: a malformed `%` escape, the build-directory check, the exact `/gs` route. Tested by
//     requiring the proxy itself -- it listens only when run (`node playtest-proxy.js`), so this opens no port.
//   - the game server's bind host and the parked staging lobby: source scans, the way the other server pins in
//     this directory work. `npm run smoke` (server/src/smokeTest.ts) checks both over a real socket.
//   - no credential-shaped literal in any tracked file (LIVE-0E). The ngrok authtoken that LIVE-1 found in
//     PLAYTEST_NGROK.md was rotated; this is the tripwire so the next one never reaches a commit. It reports
//     file and line only, never the value.

import { readStripped, sliceBetween } from "./sourceScan";

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { execFileSync } = require("child_process") as typeof import("child_process");

const REPO = path.join(__dirname, "..", "..", "..");

/* ------------------------------------------------------------------ */
/*  LIVE-0D: the playtest proxy                                         */
/* ------------------------------------------------------------------ */

interface FakeResponse {
  status: number;
  body: string;
  writeHead(code: number): void;
  end(text?: string): void;
}
const response = (): FakeResponse => {
  const res: FakeResponse = {
    status: 0,
    body: "",
    writeHead(code) {
      res.status = code;
    },
    end(text) {
      res.body += text ?? "";
    },
  };
  return res;
};

interface PlaytestProxy {
  isGame(url: string | undefined): boolean;
  decodeRequestPath(url: string | undefined): string | null;
  isInsideBuild(file: string): boolean;
  serveStatic(req: { url?: string; headers: Record<string, string> }, res: FakeResponse): void;
  BUILD_DIR: string;
}
const proxy = require("../../../server/playtest-proxy.js") as PlaytestProxy;

describe("the playtest proxy survives a malformed path (LIVE-0)", () => {
  const MALFORMED = ["/%", "/%zz", "/%E0%A4%A", "/static/%C0", "/index.html%"];

  it("is the escape that used to throw out of the request handler", () => {
    // The negative control: this is what `serveStatic` called unguarded, inside the request handler.
    for (const url of MALFORMED) expect(() => decodeURIComponent(url)).toThrow(URIError);
  });

  it("answers it with 400 instead of throwing", () => {
    for (const url of MALFORMED) {
      expect(proxy.decodeRequestPath(url)).toBeNull();
      const res = response();
      expect(() => proxy.serveStatic({ url, headers: {} }, res)).not.toThrow();
      expect(res.status).toBe(400);
    }
  });

  it("still decodes an ordinary path, and ignores the query string", () => {
    expect(proxy.decodeRequestPath("/static/js/main.abc123.js?v=1")).toBe("/static/js/main.abc123.js");
    expect(proxy.decodeRequestPath("/a%20b")).toBe("/a b");
    expect(proxy.decodeRequestPath(undefined)).toBe("/");
  });
});

describe("the playtest proxy serves the build directory and nothing beside it (LIVE-0)", () => {
  const { BUILD_DIR } = proxy;
  const sibling = path.resolve(BUILD_DIR, "./../build-x/secret.txt");

  it("counts the directory itself and anything below a separator in it", () => {
    expect(proxy.isInsideBuild(BUILD_DIR)).toBe(true);
    expect(proxy.isInsideBuild(path.join(BUILD_DIR, "index.html"))).toBe(true);
    expect(proxy.isInsideBuild(path.join(BUILD_DIR, "static", "js", "main.js"))).toBe(true);
  });

  it("refuses a sibling that merely shares the prefix -- which the bare startsWith admitted", () => {
    expect(sibling.startsWith(BUILD_DIR)).toBe(true); // the old check, passing
    expect(proxy.isInsideBuild(sibling)).toBe(false);
    expect(proxy.isInsideBuild(BUILD_DIR + "-x")).toBe(false);
    expect(proxy.isInsideBuild(path.dirname(BUILD_DIR))).toBe(false);
  });

  it("answers a request that climbs out of the build with 403, escaped or not", () => {
    for (const url of ["/../build-x/secret.txt", "/..%2Fbuild-x%2Fsecret.txt", "/../../package.json"]) {
      const res = response();
      proxy.serveStatic({ url, headers: {} }, res);
      expect(res.status).toBe(403);
    }
  });
});

describe("the playtest proxy routes exactly /gs to the game server (LIVE-0)", () => {
  it("takes /gs, with or without a query string", () => {
    for (const url of ["/gs", "/gs?", "/gs?room=JUNO-4T2"]) expect(proxy.isGame(url)).toBe(true);
  });

  it("leaves everything else to the app -- including what used to ride along under /gs/", () => {
    for (const url of ["/gs/", "/gs/anything", "/gs/../static/js/main.js", "/gsx", "/GS", "//gs", "/static/gs", "/", ""]) {
      expect(proxy.isGame(url)).toBe(false);
    }
    expect(proxy.isGame(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  LIVE-0B / 0C: the game server                                      */
/* ------------------------------------------------------------------ */

describe("the game server binds loopback and parks the staging lobby (LIVE-0)", () => {
  const SERVER = readStripped("../../server/src/gameServer.ts");
  const START = readStripped("../../server/src/start.ts");

  it("listens on 127.0.0.1, and the banner prints the host it bound", () => {
    expect(SERVER).toContain('export const GAME_SERVER_BIND_HOST = "127.0.0.1";');
    expect(SERVER).toContain("http.listen(options.port, GAME_SERVER_BIND_HOST);");
    expect(SERVER).not.toMatch(/\.listen\(\s*options\.port\s*\)/);
    expect(START).toContain("listening on ws://${GAME_SERVER_BIND_HOST}:${port}");
    expect(START).not.toContain("ws://127.0.0.1:${port}");
  });

  it("parks the staging lobby behind one constant", () => {
    expect(SERVER).toContain("const STAGING_LOBBY_ENABLED: boolean = false;");
  });

  it("keeps lobby-hello for the public sandbox list and answers the staging list empty", () => {
    const hello = sliceBetween(SERVER, 'if (frame.kind === "lobby-hello") {', "return;");
    expect(hello).toContain('{ kind: "lobby", rooms: STAGING_LOBBY_ENABLED ? lobbyRooms() : [] }');
    expect(hello).toContain('{ kind: "rooms", rooms: await sandboxRooms() }');
  });

  it("refuses lobby-watch and lobby-write before any lobby state is touched, in their own reply frames", () => {
    const watch = sliceBetween(SERVER, 'if (frame.kind === "lobby-watch") {', "await lobbyReady;");
    expect(watch).toContain("if (!STAGING_LOBBY_ENABLED) {");
    expect(watch).toContain("room: null, seats: []");
    expect(watch).not.toContain("lobbyWatch.set");
    const write = sliceBetween(SERVER, 'if (frame.kind === "lobby-write") {', "await lobbyReady;");
    expect(write).toContain("if (!STAGING_LOBBY_ENABLED) {");
    expect(write).toContain('kind: "lobby-ack"');
    expect(write).toContain("ok: false");
    expect(write).not.toContain("applyLobbyWrite");
    expect(write).not.toContain("saveLobbyQuietly");
    // Not `error`: the client fans that out to every error listener on the socket, the live lobby's too.
    expect(watch).not.toContain('kind: "error"');
    expect(write).not.toContain('kind: "error"');
  });
});

/* ------------------------------------------------------------------ */
/*  LIVE-0E: no committed credential                                   */
/* ------------------------------------------------------------------ */

/** An ngrok authtoken or API key: one word of two base62 runs joined by `_`, the first 20+ characters.
 *  Filtered to words with lower case, upper case AND digits, which a random token all but always has and an
 *  identifier such as `REACT_APP_GAME_SERVER_URL` never does. Whole words (`WORD`), so a long identifier is
 *  judged entire rather than by a slice of it. */
const WORD = /[A-Za-z0-9_]{36,}/g;
const TOKEN_SHAPE = /^[A-Za-z0-9]{20,}_[A-Za-z0-9]{15,}$/;
const looksRandom = (word: string) => /[a-z]/.test(word) && /[A-Z]/.test(word) && /[0-9]/.test(word);
/** Anything pasted where the placeholder belongs: `add-authtoken <YOUR_NGROK_AUTHTOKEN>` is the only safe form. */
const PASTED_TOKEN = /\b(?:add-authtoken\s+|authtoken:\s*)(?!<)[A-Za-z0-9_-]{20,}/g;

/** Where, and what kind -- NEVER the matched text. */
function credentialFindings(text: string, file = "<text>"): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    (line.match(WORD) ?? []).forEach((word) => {
      if (TOKEN_SHAPE.test(word) && looksRandom(word)) found.push(`${file}:${i + 1} (token-shaped literal, ${word.length} chars)`);
    });
    (line.match(PASTED_TOKEN) ?? []).forEach(() => found.push(`${file}:${i + 1} (authtoken argument is not a placeholder)`));
  });
  return found;
}

describe("no credential is committed (LIVE-0E)", () => {
  it("recognises a token-shaped value and a pasted authtoken, and not the placeholder or an identifier", () => {
    // Synthetic, assembled at run time so no token-shaped literal sits in this file.
    const fake = ["Ab1".repeat(9), "Cd2".repeat(7)].join("_");
    expect(credentialFindings(`authtoken ${fake} here`)).toHaveLength(1);
    expect(credentialFindings("ngrok config add-authtoken " + "Zz9".repeat(8)).length).toBeGreaterThan(0);
    expect(credentialFindings("ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>")).toEqual([]);
    expect(credentialFindings("REACT_APP_GAME_SERVER_URL=wss://host/gs --insecure-local-identity")).toEqual([]);
    expect(credentialFindings(["Ab1".repeat(9), "Cd2".repeat(7)].join(""))).toEqual([]);
  });

  it("finds none in any tracked file", () => {
    let listed: string;
    try {
      listed = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    } catch (error) {
      throw new Error(`LIVE-0E needs \`git ls-files\` to know what is tracked, and it failed: ${String(error)}`);
    }
    const files = listed.split("\0").filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(path.join(REPO, file));
      } catch {
        continue; // tracked but deleted in this working tree
      }
      if (bytes.subarray(0, 8000).includes(0)) continue; // binary
      found.push(...credentialFindings(bytes.toString("utf8"), file));
    }
    expect(found).toEqual([]);
  }, 60_000);
});
