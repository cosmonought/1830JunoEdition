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

import { expectOrder, readStripped, sliceBetween } from "./sourceScan";

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

describe("the playtest proxy routes exactly /gs to the game server (LIVE-0), and /gs/api/ + /gs/healthz (LIVE-2B)", () => {
  it("takes /gs, with or without a query string", () => {
    for (const url of ["/gs", "/gs?", "/gs?room=JUNO-4T2"]) expect(proxy.isGame(url)).toBe(true);
  });

  it("takes the identity API and the health check (LIVE-2 §4.1), and nothing else under /gs/", () => {
    for (const url of ["/gs/api/session", "/gs/api/session/revoke", "/gs/api/me/games", "/gs/healthz", "/gs/healthz?x=1"]) {
      expect(proxy.isGame(url)).toBe(true);
    }
    for (const url of ["/gs/api", "/gs/apix/session", "/gs/api/../../static/js/main.js", "/gs/api/%2e%2e/x", "/gs/healthz/x"]) {
      expect(proxy.isGame(url)).toBe(false);
    }
  });

  it("leaves everything else to the app -- including what used to ride along under /gs/", () => {
    for (const url of ["/gs/", "/gs/anything", "/gs/../static/js/main.js", "/gsx", "/GS", "//gs", "/static/gs", "/", "", "/GS/api/session"]) {
      expect(proxy.isGame(url)).toBe(false);
    }
    expect(proxy.isGame(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  LIVE-0B / 0C: the game server                                      */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  R12-W1: the two bind paths, as checks that return what failed       */
/* ------------------------------------------------------------------ */

/** PROCESS (file) mode: loopback by construction. An empty list is a pass. */
function processBindFailures(server: string, start: string): string[] {
  const failures: string[] = [];
  const need = (text: string, needle: string, what: string) => {
    if (!text.includes(needle)) failures.push(what);
  };
  need(server, 'export const GAME_SERVER_BIND_HOST = "127.0.0.1";', "gameServer: the loopback constant");
  /* The one listen, defaulting to loopback when no host is handed in. */
  need(server, "http.listen(options.port, options.bindHost ?? GAME_SERVER_BIND_HOST);", "gameServer: listen defaults to loopback");
  if ((server.match(/\.listen\(/g) ?? []).length !== 1) failures.push("gameServer: exactly one listen");
  if (/\.listen\(\s*options\.port\s*\)/.test(server)) failures.push("gameServer: a hostless listen");
  /* File mode never hands a host in, so it takes the default. */
  if (start.includes("bindHost")) failures.push("start: file mode passes a bindHost");
  need(start, "const server = createGameServer({", "start: the file-mode createGameServer call");
  /* AWS code is reached only through the storage-mode switch, by a dynamic import. */
  need(start, 'if (storage.ok && storage.kind === "aws") {', "start: the aws storage switch");
  need(start, 'const { runAwsStorageMode } = await import("./aws/runtime/awsMain");', "start: awsMain loaded dynamically");
  /* (`./aws/runtime/storageMode` -- the parser of `GS_STORAGE` itself -- is static by design and binds nothing.) */
  if (/(from\s*|require\(\s*)["']\.\/(aws\/runtime\/(awsMain|awsRuntime)|routerServer)["']/.test(start)) failures.push("start: a binding AWS module loaded statically");
  try {
    expectOrder(start, 'if (storage.ok && storage.kind === "aws") {', 'await import("./aws/runtime/awsMain")', "const server = createGameServer({");
  } catch (error) {
    failures.push(`start: order -- ${(error as Error).message}`);
  }
  need(start, "listening on ws://${GAME_SERVER_BIND_HOST}:${port}", "start: the banner prints the constant");
  if (start.includes("ws://127.0.0.1:${port}")) failures.push("start: the banner hard-codes the host");
  return failures;
}

/** AWS storage mode: the task's own interface, handed down explicitly to both servers the runtime can build. */
function awsBindFailures(awsMain: string, awsRuntime: string, router: string): string[] {
  const failures: string[] = [];
  const need = (text: string, needle: string, what: string) => {
    if (!text.includes(needle)) failures.push(what);
  };
  need(awsMain, 'export const AWS_BIND_HOST = "0.0.0.0";', "awsMain: the task-interface constant");
  if (awsMain.split("bindHost: AWS_BIND_HOST,").length - 1 !== 1) failures.push("awsMain: hands AWS_BIND_HOST to the runtime once");
  need(awsMain, "listening on ws://${AWS_BIND_HOST}:${input.port}", "awsMain: the banner prints the constant");
  /* Both servers the runtime builds (the pool's game server; the non-primary router) take the host they were given. */
  if (awsRuntime.split("bindHost: input.bindHost,").length - 1 !== 2) failures.push("awsRuntime: passes its bindHost to both servers");
  if (/"(0\.0\.0\.0|127\.0\.0\.1)"/.test(awsRuntime)) failures.push("awsRuntime: a literal host");
  need(router, "readonly bindHost: string;", "router: bindHost is required");
  need(router, "http.listen(options.port, options.bindHost);", "router: listens on the host it was given");
  if ((router.match(/\.listen\(/g) ?? []).length !== 1) failures.push("router: exactly one listen");
  return failures;
}

/** The server's non-test modules, comment-stripped, `server/src`-relative with forward slashes. */
function serverSources(): Array<{ rel: string; code: string }> {
  const root = path.join(REPO, "server", "src");
  const out: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        out.push({ rel, code: readStripped(`../../server/src/${rel}`) });
      }
    }
  };
  walk(root);
  return out;
}

/** Where an all-interfaces address appears in server code: IPv4 `0.0.0.0` anywhere, and IPv6 `"::"` where it is a
 *  bind -- a `listen(` argument or a host assignment. (`"::"` also appears as address-parsing text, in
 *  `identity/clientIp.ts`, which binds nothing.) */
const IPV6_ANY_BIND = /(\.listen\([^)]*|[Hh]ost\w*\s*[:=]\s*)["'`]::["'`]/;

function allInterfaceSites(sources: ReadonlyArray<{ rel: string; code: string }>): string[] {
  return sources
    .filter((source) => source.code.includes("0.0.0.0") || IPV6_ANY_BIND.test(source.code))
    .map((source) => source.rel)
    .sort();
}

/** The server modules that handle a bind host: the two servers that listen, and the AWS runtime that builds them. */
const BIND_HOST_SITES = ["aws/runtime/awsMain.ts", "aws/runtime/awsRuntime.ts", "gameServer.ts", "routerServer.ts"];

function bindHostSites(sources: ReadonlyArray<{ rel: string; code: string }>): string[] {
  return sources.filter((source) => /\bbindHost\b/.test(source.code)).map((source) => source.rel).sort();
}

describe("the game server binds loopback and parks the staging lobby (LIVE-0)", () => {
  const SERVER = readStripped("../../server/src/gameServer.ts");
  const START = readStripped("../../server/src/start.ts");

  /* ==================================================================
      R12-W1: TWO BIND PATHS, BOTH PINNED -- LOOPBACK FOR PROCESS MODE, THE TASK'S INTERFACE FOR AWS ONLY
     ==================================================================
     LIVE-0 bound loopback unconditionally and said "where a deployment binds is LIVE-5's question". LIVE-5 L5-7
     answered it (`48ffaf6`): `createGameServer` takes an optional `bindHost` whose ABSENCE is loopback, PROCESS
     (file) mode never passes one, and only the AWS storage mode -- loaded by a dynamic import behind
     `GS_STORAGE=aws` -- passes `AWS_BIND_HOST` ("0.0.0.0", the awsvpc task's own interface, reached only through the
     load balancer's security group). This test predated that accepted distinction and still asked for the
     one-argument `http.listen(options.port, GAME_SERVER_BIND_HOST)`. It pins both halves now; forcing AWS back to
     loopback would fail it as surely as opening PROCESS mode would. */
  const AWS_MAIN = readStripped("../../server/src/aws/runtime/awsMain.ts");
  const AWS_RUNTIME = readStripped("../../server/src/aws/runtime/awsRuntime.ts");
  const ROUTER = readStripped("../../server/src/routerServer.ts");

  it("listens on 127.0.0.1 in PROCESS (file) mode, and the banner prints the host it bound", () => {
    expect(processBindFailures(SERVER, START)).toEqual([]);
  });

  it("binds the task's own interface in the AWS storage mode alone (LIVE-5 L5-7)", () => {
    expect(awsBindFailures(AWS_MAIN, AWS_RUNTIME, ROUTER)).toEqual([]);
    /* ONE SITE: no other server module names an all-interfaces address in code, and only the two servers and the AWS
       runtime that builds them handle a bind host at all -- a new entry point handing one in is a new bind path. */
    const sources = serverSources();
    expect(allInterfaceSites(sources)).toEqual(["aws/runtime/awsMain.ts"]);
    expect(bindHostSites(sources)).toEqual(BIND_HOST_SITES);
  });

  it("fails on every way to get the bind wrong (R12-W1 negative controls)", () => {
    const processMutations: Array<[string, string, string]> = [
      ["open default", SERVER.replace('GAME_SERVER_BIND_HOST = "127.0.0.1";', 'GAME_SERVER_BIND_HOST = "0.0.0.0";'), START],
      ["hostless listen", SERVER.replace("http.listen(options.port, options.bindHost ?? GAME_SERVER_BIND_HOST);", "http.listen(options.port);"), START],
      ["no default", SERVER.replace("options.bindHost ?? GAME_SERVER_BIND_HOST", "options.bindHost"), START],
      ["file mode passes a host", SERVER, START.replace("const server = createGameServer({", 'const server = createGameServer({\n    bindHost: "0.0.0.0",')],
      ["AWS code loaded statically", SERVER, START.replace("const { runAwsStorageMode } = await import(\"./aws/runtime/awsMain\");", 'const { runAwsStorageMode } = require("./aws/runtime/awsMain");')],
      ["banner hard-codes the host", SERVER, START.replace("listening on ws://${GAME_SERVER_BIND_HOST}:${port}", "listening on ws://127.0.0.1:${port}")],
    ];
    for (const [name, server, start] of processMutations) {
      expect([name, server === SERVER && start === START]).toEqual([name, false]);
      expect([name, processBindFailures(server, start).length > 0]).toEqual([name, true]);
    }
    const awsMutations: Array<[string, string, string, string]> = [
      ["AWS forced to loopback", AWS_MAIN.replace('AWS_BIND_HOST = "0.0.0.0";', 'AWS_BIND_HOST = "127.0.0.1";'), AWS_RUNTIME, ROUTER],
      ["AWS host not handed to the runtime", AWS_MAIN.replace("bindHost: AWS_BIND_HOST,", ""), AWS_RUNTIME, ROUTER],
      ["router listens everywhere", AWS_MAIN, AWS_RUNTIME, ROUTER.replace("http.listen(options.port, options.bindHost);", "http.listen(options.port);")],
      ["runtime drops the host for its game server", AWS_MAIN, AWS_RUNTIME.replace("bindHost: input.bindHost,", ""), ROUTER],
    ];
    for (const [name, main, runtime, router] of awsMutations) {
      expect([name, main === AWS_MAIN && runtime === AWS_RUNTIME && router === ROUTER]).toEqual([name, false]);
      expect([name, awsBindFailures(main, runtime, router).length > 0]).toEqual([name, true]);
    }
    /* A second all-interfaces site is seen. */
    const extra = [...serverSources(), { rel: "rooms/somewhereElse.ts", code: 'server.listen(port, "0.0.0.0");' }];
    expect(allInterfaceSites(extra)).toEqual(["aws/runtime/awsMain.ts", "rooms/somewhereElse.ts"]);
    /* The IPv6 spelling of every interface is seen too. */
    expect(allInterfaceSites([{ rel: "rooms/v6.ts", code: "http.listen(port, '::');" }])).toEqual(["rooms/v6.ts"]);
    expect(allInterfaceSites([{ rel: "rooms/v6b.ts", code: 'const bindHost = "::";' }])).toEqual(["rooms/v6b.ts"]);
    expect(allInterfaceSites([{ rel: "identity/parse.ts", code: 'const parts = inner.split("::");' }])).toEqual([]);
    /* A new module handing a host in -- from the environment, say -- is seen. */
    const handed = [...serverSources(), { rel: "rooms/entry.ts", code: "createGameServer({ port, bindHost: process.env.HOST });" }];
    expect(bindHostSites(handed)).toEqual([...BIND_HOST_SITES, "rooms/entry.ts"].sort());
  });

  /* LIVE-2D (RUST-RETIRE-1 2B.3): THE STAGING LOBBY IS DELETED, NOT PARKED. LIVE-0 parked it behind
     `STAGING_LOBBY_ENABLED = false` and answered its three frames with empty or refused replies; LIVE-2D removes the
     frames themselves. `lobby-hello`, `lobby-watch` and `lobby-write` are not kinds this server knows -- a client
     that sends one is answered `bad-frame`, like any other unknown kind, and no lobby state exists to touch. */
  it("has no staging lobby left to park: no flag, no handler, no state", () => {
    expect(SERVER).not.toContain("STAGING_LOBBY_ENABLED");
    for (const kind of ["lobby-hello", "lobby-watch", "lobby-write"]) {
      expect([kind, SERVER.includes(`frame.kind === "${kind}"`)]).toEqual([kind, false]);
    }
    expect(SERVER).not.toContain("applyLobbyWrite");
    expect(SERVER).not.toContain("lobbyWatch.set");
  });

  it("refuses every retired frame kind as unknown, before any state is touched", () => {
    const schema = require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
    for (const kind of ["lobby-hello", "lobby-watch", "lobby-write", "room-write", "seat-pin", "claim-seat", "find-seats"]) {
      expect([kind, schema.RETIRED_CLIENT_FRAME_KINDS.includes(kind)]).toEqual([kind, true]);
      expect([kind, schema.CLIENT_FRAME_KINDS.includes(kind)]).toEqual([kind, false]);
      expect([kind, schema.parseClientFrame({ kind })]).toEqual([kind, { ok: false, reason: schema.BAD_FRAME_REASONS.unknownKind, kind: null }]);
    }
    /* The public list is `rooms-watch` now, on the server-owned room protocol. */
    expect(schema.CLIENT_FRAME_KINDS).toContain("rooms-watch");
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
