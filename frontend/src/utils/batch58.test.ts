/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1087 (harness): FOUR NEW SCENES, AND THE ORDER THAT MAKES THEM WORK
// ==================================================================
//
// 456 OF THE 595 LINES TOOK THEIR BUCKET'S FALLBACK, which #1040 records as the intended shape. Four coherent
// scenes were hiding in that remainder, each with one unmistakable noise and no neighbour in the pack:
//
//   ledger.mp3   20 lines   a ledger closing -- the most repeated scene in the whole payload
//   trestle.mp3  10 lines   timber giving way, then a splash: the only water in the set
//   shovel.mp3    9 lines   a shovel into a firebox
//   pickaxe.mp3   7 lines   a pickaxe on rock
//
// Plus four widened patterns claiming 18 more lines with no new audio.
//
// THE RISK IN THIS KIND OF CHANGE IS NOT THE NEW LINES, IT IS THE OLD ONES. `SFX_KEYWORDS` is an ORDERING --
// first match wins -- so a new entry can silently take a line that already had a better sound, and nothing in
// the diff shows it. The change was made by computing every line's cue before and after and reading the
// eleven that moved: five were improvements and six were regressions, and the regressions all had the same
// shape -- a common noun in the new pattern beating the actual event.
//
// SO MOST OF THIS FILE PINS THE ORDERING, not the additions. The additions are one assertion each; the
// placement is what took the work and what a later "tidy the table" edit would undo without noticing.

export {};

const { variantCueFor, everySfxFile, SFX_KEYWORDS, BUCKET_FALLBACK } =
  require("./variantSfx") as typeof import("./variantSfx");
const { UNPREDICTABLE_REVENUE_FLAVOR } =
  require("../constants/flavorText") as typeof import("../constants/flavorText");

type Bucket = keyof typeof UNPREDICTABLE_REVENUE_FLAVOR;
const BUCKETS = Object.keys(UNPREDICTABLE_REVENUE_FLAVOR) as Bucket[];
const cue = (line: string, bucket: Bucket) => variantCueFor({ line, bucket }).audio;

/** Every line in the payload, with the clip it selects. */
function everyLine(): { bucket: Bucket; line: string; audio: string | null }[] {
  const out: { bucket: Bucket; line: string; audio: string | null }[] = [];
  for (const bucket of BUCKETS) {
    for (const line of UNPREDICTABLE_REVENUE_FLAVOR[bucket]) {
      out.push({ bucket, line, audio: cue(line, bucket) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The four new scenes                                                */
/* ------------------------------------------------------------------ */

describe("four scenes that had nothing but their bucket's fallback", () => {
  it("gives the bookkeeping lines a ledger", () => {
    /* THE BIGGEST COHERENT SCENE IN THE PAYLOAD, and spread across all five buckets -- which is the sign it
       is an EVENT rather than a mood, and therefore the right kind of thing for this table. */
    expect(cue("The accountants found the books pleasantly boring.", "unchanged")).toBe("ledger.mp3");
    expect(cue("A minor accounting error shorted the quarterly ledger.", "minorMalus")).toBe("ledger.mp3");
    expect(cue("Revenue arrived in such quantities that the accountants required a larger ledger.", "criticalBonus"))
      .toBe("ledger.mp3");
  });

  it("gives the coal lines a shovel", () => {
    expect(cue("Coal deliveries proceeded at the usual pace.", "unchanged")).toBe("shovel.mp3");
    expect(cue("A brief coal shortage forced reduced service for two days.", "minorMalus")).toBe("shovel.mp3");
    expect(cue("A locomotive’s firebox failed and left the express stranded in the countryside.", "criticalMalus"))
      .toBe("shovel.mp3");
  });

  it("gives the bridges a trestle", () => {
    expect(cue("A trestle gave way beneath an empty freight car, closing the line for repairs.", "criticalMalus"))
      .toBe("trestle.mp3");
    expect(cue("The company completed a daring new bridge, opening a lucrative shortcut.", "criticalBonus"))
      .toBe("trestle.mp3");
  });

  it("gives the strikes a pickaxe", () => {
    /* A "STRIKE" IN THIS PAYLOAD IS ALMOST ALWAYS GOLD, not labour -- three of the four lines using the word.
       The pattern says `gold|silver` explicitly rather than matching `strike` alone, so the one labour strike
       keeps the crowd it should have. */
    expect(cue("A modest gold strike nearby brought a wave of prospectors.", "minorBonus")).toBe("pickaxe.mp3");
    expect(cue("Word of a silver strike triggered a stampede of paying passengers.", "criticalBonus"))
      .toBe("pickaxe.mp3");
    expect(cue("A strike brought the railway to an expensive standstill.", "criticalMalus"))
      .not.toBe("pickaxe.mp3");
  });
});

/* ------------------------------------------------------------------ */
/* The ordering, which is the actual design                           */
/* ------------------------------------------------------------------ */

describe("the broad words lose to the specific events", () => {
  /* ==================================================================
      DESIGN NOTE 1087: SIX REGRESSIONS THAT A DRY RUN CAUGHT AND PLACEMENT FIXED
     ==================================================================
     EACH OF THESE FAILED IN THE FIRST DRAFT, where `shovel` and `ledger` sat at the head of the table. Every
     one has the same shape: the new pattern matched a common noun that happened to appear in a line about
     something else entirely. They are asserted as a group because the group is the rule -- "a noun in the
     furniture must not beat the event" -- and any future entry matching a single common word will break
     exactly these. */

  it("leaves a fire that destroys records to the fire", () => {
    expect(cue("A mysterious fire destroyed the company’s records before the accountants could finish their work.", "criticalMalus"))
      .toBe("fire-alarm.mp3");
  });

  it("leaves a burning coal tender to the fire", () => {
    expect(cue("The coal tender caught fire, but only a little bit.", "minorMalus")).toBe("fire-alarm.mp3");
  });

  it("leaves a circus elephant to the elephant, nervous accountant notwithstanding", () => {
    expect(cue("A circus troupe paid handsomely to transport an elephant, three lions, and one very nervous accountant.", "criticalBonus"))
      .toBe("elephant.mp3");
  });

  it("leaves dynamite beside the coal to the dynamite", () => {
    expect(cue("A shipment of dynamite was discovered to have been loaded beside the coal.", "criticalMalus"))
      .toBe("dynamite-fuse.mp3");
  });

  it("leaves striking miners to the crowd", () => {
    expect(cue("Striking coal miners cut off fuel supply to the yard.", "criticalMalus")).toBe("angry-crowd.mp3");
  });

  it("leaves a collapsing spur to the crash, not to the livestock aboard it", () => {
    /* THE REASON `livestock` IS A SEPARATE ENTRY AT THE TAIL rather than being added to the `cattle|cows`
       entry at the head. Up there it would have won this line, where the event is the collapse. */
    expect(cue("A rail spur collapsed under an overloaded livestock car.", "criticalMalus")).toBe("crash.mp3");
  });

  it("puts the two broad entries below every specific one", () => {
    /* THE STRUCTURAL FORM OF THE SAME CLAIM, so it survives the day somebody adds a seventh line to the
       group above and forgets to add a case for it. */
    const order = SFX_KEYWORDS.map((entry) => entry.file);
    for (const broad of ["shovel.mp3", "ledger.mp3"]) {
      for (const specific of ["fire-alarm.mp3", "elephant.mp3", "dynamite-fuse.mp3", "angry-crowd.mp3"]) {
        expect(order.indexOf(broad)).toBeGreaterThan(order.indexOf(specific));
      }
    }
    // And the livestock entry is the LAST `COW_CONTEXT`, not the first.
    const cows = order.reduce<number[]>((at, file, i) => (file === "COW_CONTEXT" ? [...at, i] : at), []);
    expect(cows.length).toBe(2);
    expect(cows[1]).toBeGreaterThan(order.indexOf("crash.mp3"));
  });
});

describe("the specific compounds beat the metaphors", () => {
  /* THE OTHER HALF OF THE PLACEMENT, and the five reassignments that were kept. In every one the old clip
     was matching a figure of speech rather than an event. */

  it("stops a flood of prospectors sounding like weather", () => {
    expect(cue("A distant gold discovery sent a flood of prospectors westward aboard the company’s trains.", "criticalBonus"))
      .toBe("pickaxe.mp3");
    expect(cue("A gold rush along the route sent prospectors flooding to the depot.", "criticalBonus"))
      .toBe("pickaxe.mp3");
  });

  it("stops prospectors rushing sounding like applause", () => {
    expect(cue("A newly struck gold vein sent prospectors rushing toward the company’s western terminus.", "criticalBonus"))
      .toBe("pickaxe.mp3");
  });

  it("gives a collapsing bridge the bridge sound rather than a generic crash", () => {
    expect(cue("A bridge collapsed just before the train reached it.", "criticalMalus")).toBe("trestle.mp3");
    expect(cue("A competitor's bridge collapsed, giving the company a total monopoly for the week.", "criticalBonus"))
      .toBe("trestle.mp3");
  });

  it("keeps them above the clips they took those lines from", () => {
    const order = SFX_KEYWORDS.map((entry) => entry.file);
    for (const specific of ["pickaxe.mp3", "trestle.mp3"]) {
      for (const generic of ["crash.mp3", "thunder.mp3", "applause.mp3"]) {
        expect(order.indexOf(specific)).toBeLessThan(order.indexOf(generic));
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* The widenings                                                      */
/* ------------------------------------------------------------------ */

describe("four patterns that were narrower than their subject", () => {
  it("lets the newsboy cry any newspaper, not just a vendor", () => {
    /* IT MATCHED THE LITERAL PHRASE "newspaper vendor" while eight lines about newspapers went unclaimed.
       A newsboy crying headlines is how news travelled in 1830, so it serves both. */
    expect(cue("A newspaper printed an unfavorable rumor about the company.", "minorMalus")).toBe("newsboy.mp3");
    expect(cue("The company survived another day without making the newspapers.", "unchanged")).toBe("newsboy.mp3");
  });

  it("counts an industrial plant as the factory it is", () => {
    expect(cue("A major industrial plant signed an exclusive shipping agreement.", "criticalBonus"))
      .toBe("machinery.mp3");
  });

  it("counts a convention and a grand opening as the parade they sound like", () => {
    expect(cue("A celebrated political convention brought thousands of visitors to the railway’s stations.", "criticalBonus"))
      .toBe("marching-band.mp3");
    expect(cue("A dazzling grand-opening celebration drew travelers from three states.", "criticalBonus"))
      .toBe("marching-band.mp3");
  });

  it("counts livestock as cattle, with the mood the bucket carries", () => {
    /* STILL VALENCE-SENSITIVE, because it routes through `COW_CONTEXT` like the other two -- which is the
       one thing that would have been lost by giving livestock its own flat clip. */
    expect(cue("Local livestock wandered onto the tracks, causing repeated delays.", "minorMalus"))
      .toBe("cow-sad.mp3");
    expect(cue("Livestock shipments matched seasonal averages.", "unchanged")).toBe("cow-sad.mp3");
  });
});

/* ------------------------------------------------------------------ */
/* The whole table, still coherent                                    */
/* ------------------------------------------------------------------ */

describe("the table as a whole survived the additions", () => {
  it("claims more lines without becoming a third fallback", () => {
    /* THE NUMBER THAT MOVES WHEN A PATTERN STARTS STEALING (#1040's tripwire), re-based from 139 to 195.
       AND THE SECOND HALF IS THE POINT: the fallbacks must still carry the bulk. A keyword clip firing on
       sixty lines would stop being a signal and start being a third default, which is the failure this whole
       table exists to avoid. Asserted as a share rather than a count so it reads as the rule it is. */
    const lines = everyLine();
    const matched = lines.filter((row) => row.audio !== BUCKET_FALLBACK[row.bucket]);
    expect(lines.length).toBe(595);
    /* Design note #1103: 195 -> 197. `blizzard.mp3` claims "a blizzard buried the mountain pass" and "a
       winter freeze burst several miles of track", both previously on their bucket's fallback -- verified by
       a dry run over all 601 lines showing those two and nothing else moved.
       RE-BASED, NOT LOOSENED. It is still an exact count, which is the whole value of the tripwire: a pattern
       that started stealing lines shows up HERE rather than in a playtest. */
    /* Design note #1105: 197 -> 199. `rain.mp3` claims three lines and one of them came off `thunder`, so the
       matched total rises by the two that were on their bucket's fallback. Dry run over all 601 lines
       confirms those three and nothing else moved -- the count rises by two because the rainstorm was already
       counted as matched. */
    expect(matched.length).toBe(199);

    const per = new Map<string, number>();
    for (const row of matched) if (row.audio) per.set(row.audio, (per.get(row.audio) ?? 0) + 1);
    const busiest = Math.max(...Array.from(per.values()));
    expect(busiest).toBeLessThan(40);
  });

  it("leaves no sound unreachable", () => {
    /* A FILE NO LINE CAN TRIGGER is a file nobody will ever hear, and the likeliest cause is a pattern above
       it swallowing its lines -- which is exactly the risk four new entries introduce. */
    const heard = new Set(everyLine().map((row) => row.audio).filter((file): file is string => file !== null));
    const unreachable = everySfxFile().filter(
      (file) => !file.endsWith(".mp4") && !heard.has(file) && !/yellow_sign|carcosa/.test(file),
    );
    expect(unreachable).toEqual([]);
  });

  it("names four files that are actually on disk", () => {
    /* #1040's LESSON: a missing audio file is the quietest failure in this codebase, because `playQuietly`
       swallows the error by design and a 404 is indistinguishable from a clip that is simply not very loud. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    for (const file of ["pickaxe.mp3", "ledger.mp3", "trestle.mp3", "shovel.mp3"]) {
      expect(everySfxFile()).toContain(file);
      expect(fs.existsSync(path.join(__dirname, "..", "..", "public", "audio", file))).toBe(true);
    }
  });

  it("keeps the unchanged bucket silent where no keyword claims it", () => {
    /* #1081 IS NOT UNDONE BY THIS. Twelve of the twenty ledger lines and one coal line are `unchanged`, so
       this batch gives that bucket back some texture -- but only through keyword matches, which is exactly
       the narrowing that was ruled ("some of the Unchanged events have more 'unique' flavor text with sound
       effects that can still play"). The default is still silence. */
    expect(BUCKET_FALLBACK.unchanged).toBeNull();
    expect(cue("The day passed without financial incident.", "unchanged")).toBeNull();
    const silent = everyLine().filter((row) => row.audio === null);
    expect(silent.length).toBeGreaterThan(50);
    expect(silent.every((row) => row.bucket === "unchanged")).toBe(true);
  });
});
