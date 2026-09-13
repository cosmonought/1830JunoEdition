/** @jest-environment node */
// frontend/src/utils/ceremonySounds.test.ts -- design note #1419.
import { CEREMONY_SOUNDS, ceremonySoundFor } from "./ceremonySounds";
import { unearned, type Accolade, type AccoladeKey } from "./accolades";
import { ceremonyScript } from "../components/AccoladesCeremony";

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");

const a = (key: AccoladeKey, holder = "p"): Accolade => ({ ...unearned(key), holder, value: 1, detail: "1" });

describe("every clip the mapping names exists in public/audio (design note #1419)", () => {
  it("resolves each file", () => {
    for (const file of Object.values(CEREMONY_SOUNDS)) {
      const full = path.join(__dirname, "../../public/audio", file);
      expect([file, fs.existsSync(full)]).toEqual([file, true]);
    }
  });
});

describe("the moments and their sounds", () => {
  it("title is the drumroll, sweep the twinkle, finale the stinger", () => {
    expect(ceremonySoundFor({ kind: "title" })).toBe(CEREMONY_SOUNDS.drumroll);
    expect(ceremonySoundFor({ kind: "sweep" })).toBe(CEREMONY_SOUNDS.twinkle);
    expect(ceremonySoundFor({ kind: "finale", accolade: a("robber-baron") })).toBe(CEREMONY_SOUNDS.stinger);
  });

  it("corporate cards get the horn, the two train awards the whistle, and land silently", () => {
    expect(ceremonySoundFor({ kind: "present", accolade: a("workhorse"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.horn);
    expect(ceremonySoundFor({ kind: "present", accolade: a("early-adopter"), ordinal: 1 })).toBe(CEREMONY_SOUNDS.whistle);
    expect(ceremonySoundFor({ kind: "present", accolade: a("fleet-admiral"), ordinal: 2 })).toBe(CEREMONY_SOUNDS.whistle);
    expect(ceremonySoundFor({ kind: "land", accolade: a("workhorse"), ordinal: 0 })).toBeNull();
  });

  it("player cards alternate magical and tada-twinkle; the core ones are announced by the clap; nothing lands with a sound", () => {
    expect(ceremonySoundFor({ kind: "present", accolade: a("fundraiser"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.magical);
    expect(ceremonySoundFor({ kind: "present", accolade: a("last-call"), ordinal: 1 })).toBe(CEREMONY_SOUNDS.tadaTwinkle);
    expect(ceremonySoundFor({ kind: "present", accolade: a("mr-monopoly"), ordinal: 2 })).toBe(CEREMONY_SOUNDS.magical);
    // #1426: each core award has its own announcement.
    expect(ceremonySoundFor({ kind: "present", accolade: a("master-of-the-line"), ordinal: 4 })).toBe(CEREMONY_SOUNDS.whistle);
    expect(ceremonySoundFor({ kind: "present", accolade: a("track-boss"), ordinal: 5 })).toBe(CEREMONY_SOUNDS.horn);
    expect(ceremonySoundFor({ kind: "present", accolade: a("market-manipulator"), ordinal: 6 })).toBe(CEREMONY_SOUNDS.clap);
    expect(ceremonySoundFor({ kind: "present", accolade: a("carcosan-railways"), ordinal: 1 })).toBe(CEREMONY_SOUNDS.carcosan);
    expect(ceremonySoundFor({ kind: "present", accolade: a("redeemer"), ordinal: 1 })).toBe(CEREMONY_SOUNDS.redeemer);
    expect(ceremonySoundFor({ kind: "land", accolade: a("fundraiser"), ordinal: 0 })).toBeNull();
    expect(ceremonySoundFor({ kind: "land", accolade: a("track-boss"), ordinal: 5 })).toBeNull(); // #1423
    expect(ceremonySoundFor({ kind: "land", accolade: a("robber-baron"), ordinal: 7 })).toBeNull();
  });

  it("the hostile awards without a clip of their own get the descending twinkle, whatever their scope", () => {
    for (const key of ["gravedigger", "rust-belt"] as const) {
      expect(ceremonySoundFor({ kind: "present", accolade: a(key), ordinal: 0 })).toBe(CEREMONY_SOUNDS.twinkleDown);
    }
    expect(ceremonySoundFor({ kind: "present", accolade: { ...a("shell-corporation"), scope: "corporation" }, ordinal: 0 })).toBe(CEREMONY_SOUNDS.twinkleDown);
    expect(ceremonySoundFor({ kind: "present", accolade: a("fundraiser"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.magical);
  });

  it("an award with its own clip plays it (#1428)", () => {
    expect(ceremonySoundFor({ kind: "present", accolade: a("the-wall"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.theWall);
    expect(ceremonySoundFor({ kind: "present", accolade: a("train-robber"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.trainRobber);
    expect(ceremonySoundFor({ kind: "present", accolade: a("corporate-raider"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.corporateRaider);
    expect(ceremonySoundFor({ kind: "present", accolade: a("capitalist-pig"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.capitalistPig); // #1438: the pig is a player award now
    expect(ceremonySoundFor({ kind: "present", accolade: a("mountain-mover"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.mountainMover);
    expect(ceremonySoundFor({ kind: "present", accolade: a("phase-rusher"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.phaseRusher);
    expect(ceremonySoundFor({ kind: "present", accolade: a("paper-millionaire"), ordinal: 0 })).toBe(CEREMONY_SOUNDS.paperMillionaire);
  });

  it("a twelve-accolade ceremony plays no file more than four times", () => {
    /* The worry that motivated the mapping: "two sounds repeated ~12 times might be grating". The count is
       taken off the same script the ceremony runs, so a change to either side shows up here. */
    const ceremony: Accolade[] = [
      a("early-adopter"), a("salvager"), a("scrooge-company"), a("workhorse"),
      a("fundraiser"), a("last-call"), a("gravedigger"), a("paper-millionaire"),
      a("master-of-the-line"), a("track-boss"), a("market-manipulator"), a("robber-baron"),
    ].map((x) => ({ ...x, scope: ["early-adopter", "salvager", "scrooge-company", "workhorse"].includes(x.key) ? "corporation" : "player" }));
    const counts = new Map<string, number>();
    const script = ceremonyScript(ceremony);
    const lastPresent = script.map((s) => s.kind).lastIndexOf("present");
    script.forEach((step, at) => {
      let file: string | null = null;
      if (step.kind === "title") file = ceremonySoundFor({ kind: "title" });
      else if (step.kind === "sweep") file = ceremonySoundFor({ kind: "sweep" });
      else if (step.kind === "present" || step.kind === "land") {
        const accolade = ceremony.find((x) => x.key === step.key)!;
        const ordinal = ceremony.filter((x) => x.scope === accolade.scope).findIndex((x) => x.key === step.key);
        file = at === lastPresent ? ceremonySoundFor({ kind: "finale", accolade }) : ceremonySoundFor({ kind: step.kind, accolade, ordinal });
      }
      if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
    });
    for (const [file, n] of Array.from(counts.entries())) expect([file, n <= 4]).toEqual([file, true]);
    expect(counts.get(CEREMONY_SOUNDS.stinger)).toBe(1);
    expect(counts.get(CEREMONY_SOUNDS.drumroll)).toBe(1);
  });
});
