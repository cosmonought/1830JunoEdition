/** @jest-environment jsdom */
//
// LIVE-2E: THE PROFILE GATE. Profiles are mandatory: the app renders only for a PROFILED session; an unprofiled browser
// meets the three ways in (create, recover, link); a created profile's recovery key is revealed once, and the lobby is
// reached only after the player ticks that they saved it. Nothing typed or revealed here is written to storage or the
// console, and no player-visible word here is "guest".

import * as fs from "fs";
import * as path from "path";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProfileGate } from "./ProfileGate";
import { RECOVERY_KEY_FILE } from "./RecoveryKeyReveal";
import { httpSessionPort, type SessionPort } from "../utils/sessionBootstrap";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://play.example/gs/api/session";
const KEY = "rk_0123456789abcdefghjkmnpqr0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEW_KEY = "rk_zyxwvtsrqpnmkjhgfedcba9870.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

type Queued = { status: number; body?: unknown; then?: () => void };

/** The server, played by the test: the bootstrap answers with `profile`, every other path with what was queued. */
function fakeServer(initial: { name: string; otherSessions: number } | null) {
  let profile = initial;
  let bootstrapFails = 0;
  let endedReason: string | null = null;
  const bodies: string[] = [];
  const urls: string[] = [];
  const answers = new Map<string, Queued[]>();
  const port = httpSessionPort({
    endpoint: ENDPOINT,
    fetch: async (input, init) => {
      urls.push(input);
      bodies.push(init.body);
      const where = new URL(input).pathname;
      if (where === "/gs/api/session") {
        if (bootstrapFails > 0) {
          bootstrapFails -= 1;
          throw new TypeError("Failed to fetch");
        }
        if (endedReason !== null) return { status: 401, json: async () => ({ error: "session-ended", reason: endedReason }) };
        return { status: 200, json: async () => ({ ok: true, expiresAt: 1, profile }) };
      }
      const next = answers.get(where)?.shift();
      if (!next) throw new Error(`nothing queued for ${where}`);
      next.then?.();
      return { status: next.status, json: async () => next.body ?? {} };
    },
  });
  return {
    port,
    urls,
    bodies,
    failBootstraps: (count: number) => {
      bootstrapFails = count;
    },
    setProfile: (next: typeof profile) => {
      profile = next;
    },
    endWith: (reason: string) => {
      endedReason = reason;
    },
    queue: (where: string, status: number, body?: unknown, then?: () => void) => answers.set(where, [...(answers.get(where) ?? []), { status, body, then }]),
  };
}

let container: HTMLDivElement;
let root: Root;
let appMounts = 0;

function AppProbe() {
  React.useEffect(() => {
    appMounts += 1;
  }, []);
  return <div data-testid="the-app">the lobby</div>;
}

beforeEach(() => {
  appMounts = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

const flush = async () => {
  for (let n = 0; n < 20; n += 1) await Promise.resolve();
};
const settle = () => act(flush);
const mount = async (port: SessionPort) => {
  act(() => root.render(<ProfileGate port={port}><AppProbe /></ProfileGate>));
  await settle();
};
const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector(`[data-testid="${id}"]`) as T | null;
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  act(() => (element as HTMLElement).click());
  await settle();
};
const type = (input: HTMLInputElement | null, value: string) => {
  expect(input).toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** Every storage write and every console line, for the "nothing kept, nothing said" assertions. */
function watchLeaks() {
  const storage = jest.spyOn(Storage.prototype, "setItem");
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return { storage, lines };
}

describe("the profile gate (LIVE-2E)", () => {
  it("says it is connecting before the first answer, offers Retry after a failed bootstrap, and mounts no app", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 });
    server.failBootstraps(1);
    await mount(server.port);
    expect(container.textContent).toContain("Connecting to the game server…");
    expect(appMounts).toBe(0);
    await click(buttonNamed("Retry"));
    expect(byTestId("the-app")).not.toBeNull();
    expect(appMounts).toBe(1);
  });

  it("an unprofiled browser meets the mandatory choice -- and never the app", async () => {
    const server = fakeServer(null);
    await mount(server.port);
    expect(byTestId("profile-gate")).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("A profile is required to play");
    for (const label of ["Create profile", "Recover existing profile", "Link existing profile"]) {
      expect(Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent)).toContain(label);
    }
    expect(byTestId("the-app")).toBeNull();
    expect(appMounts).toBe(0);
    expect(container.textContent).not.toMatch(/guest/i);
  });

  it("create -> the recovery key, once -> Continue only after the player says it is saved -> the lobby", async () => {
    const leaks = watchLeaks();
    const server = fakeServer(null);
    await mount(server.port);
    type(byTestId<HTMLInputElement>("profile-name"), "Brad");
    expect(byTestId<HTMLInputElement>("profile-name")!.maxLength).toBe(24);
    server.queue("/gs/api/profile", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, recoveryKey: KEY }, () =>
      server.setProfile({ name: "Brad", otherSessions: 0 }),
    );
    await click(byTestId("profile-create"));
    /* The session is profiled by now, and still the app has not mounted under the reveal. */
    expect(server.port.state).toBe("ready");
    expect(appMounts).toBe(0);
    expect(byTestId("recovery-key-value")?.textContent).toBe(KEY);
    expect(container.textContent).toContain("the only way back into your profile if you lose this browser and have no other signed-in device");
    expect(container.textContent).toContain("Anyone with this key can sign in as you");
    expect(buttonNamed("Copy")).toBeTruthy();
    const proceed = byTestId<HTMLButtonElement>("recovery-key-continue")!;
    expect(proceed.textContent).toBe("Continue to the lobby");
    expect(proceed.disabled).toBe(true);
    await click(proceed);
    expect(appMounts).toBe(0);
    await click(byTestId("recovery-key-saved"));
    expect(byTestId<HTMLButtonElement>("recovery-key-continue")!.disabled).toBe(false);
    await click(byTestId("recovery-key-continue"));
    expect(byTestId("the-app")).not.toBeNull();
    expect(appMounts).toBe(1);
    /* Shown once: gone from the page, never stored, never logged, never in a URL. */
    expect(container.innerHTML).not.toContain(KEY);
    expect(leaks.storage).not.toHaveBeenCalled();
    expect(leaks.lines.join("\n")).not.toContain(KEY);
    expect(leaks.lines).toEqual([]);
    expect(server.urls.join(" ")).not.toContain(KEY);
  });

  it("'Save as file' downloads the key as a text file and revokes the object URL at once", async () => {
    const server = fakeServer(null);
    await mount(server.port);
    type(byTestId<HTMLInputElement>("profile-name"), "Brad");
    server.queue("/gs/api/profile", 201, { ok: true, profile: { name: "Brad", otherSessions: 0 }, recoveryKey: KEY }, () =>
      server.setProfile({ name: "Brad", otherSessions: 0 }),
    );
    await click(byTestId("profile-create"));
    const blobs: Blob[] = [];
    const created = jest.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:https://play.example/1";
    });
    const revoked = jest.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    const downloads: Array<{ href: string; download: string }> = [];
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, download: this.download });
    });
    await click(buttonNamed("Save as file"));
    expect(downloads).toEqual([{ href: "blob:https://play.example/1", download: RECOVERY_KEY_FILE }]);
    expect(RECOVERY_KEY_FILE).toBe("18cosmos-recovery-key.txt");
    expect(revoked).toHaveBeenCalledWith("blob:https://play.example/1");
    expect(blobs[0].type).toMatch(/^text\/plain/);
    expect(container.querySelector('a[download]')).toBeNull(); // the link was removed with the URL
  });

  it("a create answering already-profiled lets the player through, says the key did not arrive, and offers a new one", async () => {
    const server = fakeServer(null);
    await mount(server.port);
    type(byTestId<HTMLInputElement>("profile-name"), "Brad");
    server.queue("/gs/api/profile", 409, { error: "already-profiled", profile: { name: "Brad" } }, () =>
      server.setProfile({ name: "Brad", otherSessions: 0 }),
    );
    await click(byTestId("profile-create"));
    expect(byTestId("missed-key-notice")).not.toBeNull();
    expect(container.textContent).toContain("did not arrive here");
    expect(appMounts).toBe(0);
    server.queue("/gs/api/profile/recovery-key", 200, { ok: true, recoveryKey: NEW_KEY });
    await click(buttonNamed("Make a new recovery key"));
    expect(byTestId("recovery-key-value")?.textContent).toBe(NEW_KEY);
    await click(byTestId("recovery-key-saved"));
    await click(byTestId("recovery-key-continue"));
    expect(appMounts).toBe(1);
    expect(container.innerHTML).not.toContain(NEW_KEY);
  });

  it("recover and link: a wrong credential is one plain sentence; the right one opens the app", async () => {
    const leaks = watchLeaks();
    const server = fakeServer(null);
    await mount(server.port);
    await click(byTestId("profile-choice-recover"));
    type(byTestId<HTMLInputElement>("profile-recovery-key"), KEY);
    server.queue("/gs/api/profile/recover", 403, { error: "invalid-credential" });
    await click(buttonNamed("Recover profile"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "That key or code doesn't work. Check it and try again — a device-link code works once, for 10 minutes.",
    );
    await click(byTestId("profile-choice-link"));
    expect(byTestId<HTMLInputElement>("profile-link-code")!.value).toBe(""); // nothing typed is carried across
    expect(container.textContent).toContain("Link another device");
    type(byTestId<HTMLInputElement>("profile-link-code"), "abcd-efgh-jkmn-pqrs-tvwx");
    server.queue("/gs/api/profile/link", 429, { error: "rate-limited", retryAfterMs: 30_000 });
    await click(buttonNamed("Link this device"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Too many attempts. Wait 30 seconds and try again.");
    server.queue("/gs/api/profile/link", 200, { ok: true, profile: { name: "Brad" } }, () => server.setProfile({ name: "Brad", otherSessions: 1 }));
    await click(buttonNamed("Link this device"));
    expect(byTestId("the-app")).not.toBeNull();
    expect(JSON.parse(server.bodies[server.bodies.length - 2])).toEqual({ code: "ABCDEFGHJKMNPQRSTVWX" });
    expect(leaks.storage).not.toHaveBeenCalled();
    expect(leaks.lines).toEqual([]);
    expect(server.urls.join(" ")).not.toMatch(/rk_|ABCD/);
  });

  it("the app stays mounted behind the session-ended notice; a page that loads ended mounts nothing", async () => {
    const server = fakeServer({ name: "Brad", otherSessions: 0 });
    await mount(server.port);
    expect(appMounts).toBe(1);
    server.endWith("signed-out-remotely");
    await act(async () => {
      await server.port.ensure(true);
    });
    expect(server.port.state).toBe("ended");
    expect(byTestId("the-app")).not.toBeNull();
    expect(appMounts).toBe(1);
    const fresh = fakeServer(null);
    fresh.endWith("expired");
    act(() => root.render(<ProfileGate key="reloaded" port={fresh.port}><AppProbe /></ProfileGate>));
    await settle();
    expect(byTestId("the-app")).toBeNull();
    expect(byTestId("profile-gate-ended")).not.toBeNull();
    expect(appMounts).toBe(1);
  });

  it("is mounted around the app in index.tsx, with the session-ended notice beside it", () => {
    const index = fs.readFileSync(path.join(__dirname, "..", "index.tsx"), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(index).toMatch(/<ProfileGate>\s*<App \/>\s*<\/ProfileGate>\s*<SessionEndedNotice \/>/);
    expect(index).toContain("installSessionPort(createAppSessionPort(GAME_SERVER_URL));");
  });
});
