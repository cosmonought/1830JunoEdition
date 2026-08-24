# Working agreement

Written after a batch of work (items 26–34) produced three regressions in a row, all from one change. This
records what went wrong and what replaces it. It is a process document, not an architecture one: everything
here is about how changes get made and verified, not about how the game works.

---

## What happened

#757 added a legality gate to the tile-lay path — the hottest path in the app, touching three things across
two separate state atoms (the tile grid, the terrain fee, the sub-phase cursor). Three bugs followed:

| Note | Bug | Root cause |
|------|-----|------------|
| #762 | Both clients white-screened on a share purchase | A `useMemo` read a `useRef` declared 487 lines below it — a temporal dead zone |
| #766 | Unlimited tile lays per turn | The gate's predicate read the ref *between* two writes, so it judged the board it had just changed |
| #767 | Every laid tile disappeared | `rebuildSandbox` reset the grid's state and not its ref |

**One change, three failures, one shape.** A ref is a second copy of a value, and every second copy needs
three things: **one writer that wins**, **a reset that covers it**, and **a reader that knows which copy it is
getting**. #757 introduced the mechanism and got all three wrong in turn.

### Why the tooling did not catch any of them

- The verification command was `npx tsc --noEmit 2>&1 | head -8 && echo "TSC CLEAN"`. `head` always exits 0,
  so the `&&` fired regardless of what TypeScript thought. **The check was structurally incapable of
  failing.**
- The production build was never run locally. It first ran on Vercel, and failed there (TS7053).
- Almost every test in this repo is a unit test or a source scan. **None of them exercise the App dispatch**,
  which is exactly where all three bugs lived.
- Items 26–34 shipped as one batch with no playtest between them, so each fix landed on top of unverified
  work and the failures compounded.

---

## The agreement

### 1. `npm run verify` before saying anything is ready

```
npm run verify
```

That is `tsc --noEmit` followed by the production build — the same build Vercel runs. Shell-agnostic, so it
works from PowerShell, cmd or bash.

**It works from the repo root or from `frontend/`.** The root `package.json` exists only to forward
`verify`, `typecheck`, `test`, `build` and `start` into `frontend/` via `npm --prefix`. It was added after a
`cd frontend` went missing between two messages and produced an `ENOENT` on a `package.json` that had never
existed there. An instruction that has to be remembered is one that will eventually be forgotten;
deleting the precondition is better than restating it.

`npm run typecheck` alone is the fast gate (~20s against several minutes) and catches the largest class. The
full build is the belt.

**Who runs which, honestly.** The webpack build takes over twenty-five minutes in the assistant's sandbox and
under two on a developer machine, so promising "the assistant runs the full build every time" would be a
promise it quietly stops keeping — which is the same failure mode as the `| head` check. The division that
actually holds:

| Check | Who | When |
|---|---|---|
| `npm run typecheck`, exit code captured | assistant | every batch, before saying it is ready |
| Targeted Jest suites, exit code captured | assistant | every batch |
| `npm run verify` (typecheck + build) | developer | before deploying |
| Playtest | developer | after any change to the tile-lay dispatch, and between batches |

The assistant states plainly what it ran and what it did not. "I could not run the build here" is a useful
sentence; a silent gap is not.

**Never read a piped command's exit code as the tool's.** Capture it:

```
npm run typecheck > out.log 2>&1; echo "EXIT=$?"
```

### 2. Small batches, playtested between

One or two items, then a playtest, then the next. The compounding is what turned one bad change into three
reports.

### 3. Anything touching the tile-lay dispatch needs a playtest specifically

No automated test in this repo reaches that code. Until that changes, it is verified by playing or not at all.

### 4. New indirections get their invariants written down first

Before adding a ref, a cache, a snapshot or any second copy of a value, write down:

- **who writes it**, and which writer wins when two disagree
- **what resets it**, including every path that resets the thing it mirrors
- **who reads it**, and whether they need the pre-action or post-action value

Then test *those*, not just the feature. `refStatePairs.test.ts` is what that looks like for the third one.

---

## Standing guards this produced

These exist because a class of bug got through more than once. They are cheap to run and worth keeping.

- **`memoDeadZone.test.ts`** — no `useMemo` may read a binding declared below it. TypeScript cannot see this:
  it flags a direct use-before-declaration and says nothing about one inside a closure, because it cannot
  know when the closure runs. Scans memos only; extending it to callbacks would flag dozens of legitimate
  forward references and get switched off.
- **`refStatePairs.test.ts`** — every ref that mirrors a state atom is reset alongside it in
  `rebuildSandbox`. A sweep rather than a case, so the next ref is covered without anybody remembering.
- **`oneLayPerTurn.test.ts`** — the one-lay rule is the sub-phase advance, not a counter, so anything that
  stops the state advancing removes the rule entirely.

---

## A note on notes

The design-note convention in this codebase records superseded reasoning rather than deleting it, and that
paid off repeatedly here — #757's note explained why its ref placement looked safe, which is what identified
#762's cause in one read. Two corollaries learned the hard way:

- **A confident comment is not a citation.** #746c ported a rule out of `market.rs` because the contract said
  it was deliberate. The contract had the same bug. Implementations are not authorities on rules.
- **A test can pin a bug.** #757's harness asserted `mapGrid: mapGridRef.current` — the exact expression that
  caused #766. When a test's only defence of a behaviour is that it resembles a defect, check the rule rather
  than pinning it.
