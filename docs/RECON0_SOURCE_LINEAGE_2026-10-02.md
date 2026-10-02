# RECON-0 — Source-lineage and semantic reconciliation audit, LIVE-6 L6-6 forward (2026-10-02)

**Type:** audit / inventory only. No deploy, no AWS, no Terraform, no DNS, no Juno / JUNOX / Keplr, no merge to `main`,
no branch deleted or rewritten, no production / test / IaC source edited. This branch adds only this file and its
machine-readable companion `docs/RECON0_SOURCE_LINEAGE_2026-10-02.json`.

**Repository:** `cosmonought/1830JunoEdition`, full (unshallow) clone of every remote branch, audited 2026-10-02 ~17:10 CDT.
**Audit branch base:** `1d8fd7aee312ad239d1d7aa1f31a4f42519d4946` (`live6/l6-12d-relayer-capital-fix`) — the last commit
of the linear LIVE-6 line and the merge base of every COST and Phase-5 candidate, so this record merges cleanly into
whichever candidate RECON-1 builds.

**Addendum (17:20 CDT, folded in throughout):** the newest Phase-5 descendant `phase5/jx-4c-operator-evidence-iam`
`ee14050f18ba4a51b5af73a5ea9a9a6e89674073` (parent `9e45ded`) is in scope and classified (§G.2, §J `X-10`, §K).

**Testing policy applied to RECON-0:** no test of any kind was run — not `npm test`, not any owner certification
suite, not a targeted suite (this record adds documentation only, so there is nothing of its own to validate beyond the
git evidence quoted here). Every "run X" below is a RECON-1 instruction; the full-suite certification is
**PENDING OWNER GATE**.

**Method (semantic, not SHA ancestry).** For every commit reachable from any remote branch but not from the current
candidate heads (`phase5/jx-4c-operator-evidence-iam` `ee14050` ⊃ `phase5/cost1-integration` `9e45ded`,
`cost/cost-2a-host-verifier` `ce77f47`, `cost/cost-2b-migration-guards` `161c737`):

1. `git patch-id --stable` against every commit of the candidate lines (exact equivalence under another SHA);
2. a diff-of-diffs against the candidate cherry-pick named by the graph (which +/- lines differ, and why);
3. a line-presence check of every added / removed line of the side commit in the later tree, with every miss traced to
   a named later commit that deliberately changed that line (supersession), never assumed from a commit message;
4. `git apply --check` of still-unique patches onto each candidate head;
5. in-memory trial merges (`git merge-tree --write-tree`, no ref moved) of the candidate heads against one another.

---

## Verdict

**RECON-0 COMPLETE** — every unique source change from LIVE-6 L6-6 through the current COST and Phase-5 branches is
classified, and RECON-1 has an explicit take / already-present / superseded / retired manifest (§J). Two items are
`PENDING ACTIVE LANE` by the brief's own rule (COST-2C has no branch; P5-INT-1 has no final report, though JX-4C
contains it by ancestry), four are `OWNER DECISION REQUIRED` with a recommendation, and the full-suite certification
is `PENDING OWNER GATE`. No item is UNKNOWN; no BLOCKER.

The headline findings:

- **Nothing from the LIVE-6 side branches is missing** from the candidate trees except **one** test-only portability fix,
  `04138ea` (L6-14W1 CRLF), which RECON-1 must take.
- **The Phase-5 slices JX-1K / JX-2A / JX-2B / JX-3B / JX-4B / JX-5B / JX-6B are all already present** in
  `phase5/cost1-integration` (code files byte-identical; only `package.json`, README and header text adapted).
- **JX-4C (`ee14050`) is a clean one-commit descendant of P5-INT-1** and is the recommended RECON-1 base (§K). Its IAM
  is additive and textually merges with COST-2A / 2B, but it **inherits the same frozen-stack conflict as D0**: its
  operator-policy half needs an app-stack apply, and its ledger half (`OperatorJournalQuery`) would make COST-2B's
  `ledger-host-authorize` refuse step 8 if still pending (§F.1, §G.2).
- **COST-2A ↔ COST-2B is a real semantic conflict** (D0's ordinary app-stack apply vs the frozen app stack) that the
  existing tests will **not** catch; RECON-1 must replace D0 with a targeted, guarded step (§F) — one that also carries
  JX-4C's operator grants, plus a guarded ledger step for JX-4C's ledger half before step 8.
- **New portability hazard on the COST-1 base** (shared by every candidate): the single host's bash scripts, systemd
  units and templates are embedded verbatim into EC2 user data and are not pinned `eol=lf`. On the owner's Windows
  (`core.autocrlf=true`) checkout they render CRLF, and `user_data_replace_on_change = true` means a Windows-originated
  plan differs from a Linux one and would replace the host. Owner decision, strongly recommended for RECON-1 (§D).
- **No branch in the set changes any version axis** relative to `1d8fd7a` (§I).

---

## A. Graph inventory

### A.1 The authoritative LIVE-6 line

The LIVE-6 line is **linear** (first-parent chain, no merge commits) from `live5/l5-8-aws-infrastructure` `aa2c64c` to
`1d8fd7a`. Every LIVE-6 "slice branch" is either an ancestor of it or a side copy whose change reached the line by a
(conflict-resolved) cherry-pick.

```
1d8fd7a 10-02 03:49 Correct relayer reserve and harden rotation proof                      (live6/l6-12d-relayer-capital-fix)
c14186d 10-02 07:05 LIVE-6 owner Windows gate: restoreAlarmDrill r3 SIGTERM is POSIX-only  (live6/windows-restore-signal-test)
130395b 10-02 00:09 post-flip drills integration (cherry-pick of 38e9f3f onto 7b1a956)    (live6/postflip-drills-converged)
7b1a956 10-01 23:57 flip-alarm 'after' reads absent ActionsSuppressedBy as not suppressed  (live6/live-closure-candidate-w1)
8fed34f 10-01 21:47 a supported producer for probe-flip-alarms.json
d32533e 10-01 19:02 drain-pool.ps1 keeps a single stopped task ARN an array (PS 5.1)
3a2f0bf 10-01 18:29 the edge probe's idle socket stands the lobby subscription
a4895cd 10-01 15:27 drop the apostrophe from the task SG ingress rule description
be281eb 09-30 14:49 R12-W1 Windows frontend owner gate                                    (= c785247 exactly)
f4a3dda 09-30 15:03 LIVE-6 W1 Windows owner-gate server fixes                             (= f90de1d exactly)
6ebd900 09-30 13:26 final convergence: the seam review's Lows                              (live6/live-closure-candidate)
649292b 09-30 13:02 final convergence: bind L6-4 readers, TASK#, L6-5B, L6-2 drills into stage-cert
e4305a5 / 784fc0a / 8e8d339  ROUTE v12 R12-4 / R12-3 / R12-2 (cherry-picks of 54d8898 / 0fcefa4 / 7b24a60)
80c333e 09-30 06:33 L6-6P  (converged copy of b7caddc)
df6e85a 09-30 05:47 L6-6R  (copy of 0c20222)
fc6af5c 09-30 04:48 L6-6   (converged copy of 8a2dc2b)
17d350b L6-5B · bc6d1c1 L6-7 (copy of c4f4c91) · 35d2a7c L6-5A · e67281c/34de826 L6-2 · 0e55722 · 78bb14a L6-4 · 2f41be2 L6-3 · 9f3fb59 L6-1
aa2c64c live5/l5-8-aws-infrastructure
```

### A.2 Candidate lines after `1d8fd7a`

```
* ce77f47 COST-2A: single-host verifier and evidence tooling              (cost/cost-2a-host-verifier)
| * 161c737 COST-2B: post-abandonment migration runbook and plan guards    (cost/cost-2b-migration-guards)
|/
| * ee14050 JX-4C: least-privilege operator reads for the JX-3B/JX-4B evidence (phase5/jx-4c-operator-evidence-iam)
| * 9e45ded P5-INT-1: review follow-ups; cross-slice test under aws/runtime (phase5/cost1-integration)
| * 6679d61 P5-INT-1: cross-slice tests
| * 3fa10e6 P5-INT-1: pin COST-1's host role against JX-1K's financial key sets
| * 74eeb4b JX-6B · e1521fa JX-5B · 32204a6 JX-4B · 785779c JX-3B · 0d8e6a8 JX-2B · aff17f3 JX-2A · 99eb537 JX-1K
|/
* 7d140b4 COST-1: correct the single-host alarm count                       (cost/cost-1-single-ec2)
* b6858cc COST-1: add low-cost single-host AWS deployment
| * 04138ea Make relayer reserve guard CRLF-portable                         (live6/l6-14w-crlf-test-fix)   <- UNIQUE
| | * bdaad17 JX-2B (on 7d7b7e5 JX-2A)                                      (phase5/jx-2b-relayer-submission-hardening)
| |/
| * 7d7b7e5 JX-2A
|/   (and 04cf14f JX-1K, 4c786ae JX-3B, d752117 JX-4B on JX-3B, 9b10012 JX-5B, 3b8d59f JX-6B -- each directly on 1d8fd7a)
* 1d8fd7a
```

No `cost/cost-2c*` branch exists on the remote (no other `cost/*`, no tags, no `recon/*` before this one).
`main` is `e1f1280` (= `live5/l5-6-relayer-takeover`), an ancestor of `1d8fd7a`: every candidate is a fast-forward of
`main`; nothing in this audit touches it.

### A.3 Per-branch record

"Line" = the authoritative LIVE-6 line ending `1d8fd7a`. Ahead / behind are `git rev-list --left-right --count
<branch>...1d8fd7a`. "Unique" = commits not reachable from `9e45ded`, `ce77f47` or `161c737`.

| Branch | Head | Merge base with line | Ahead / behind | Shape | Unique commits (SHA) → where the change lives |
|---|---|---|---|---|---|
| live6/l6-6-staging-cert-harness | 8a2dc2b | aa2c64c | 1 / 27 | divergent side, cherry-picked (converged) | 8a2dc2b → fc6af5c (+ later evolution) |
| live6/l6-6p-prerequisite-task-enumeration | b7caddc | aa2c64c | 3 / 27 | stacked on L6-6R side | b7caddc → 80c333e; 0c20222 → df6e85a; 8a2dc2b → fc6af5c |
| live6/l6-6r-recovery-cert-review | 0c20222 | aa2c64c | 2 / 27 | stacked on L6-6 side | 0c20222 → df6e85a; 8a2dc2b → fc6af5c |
| live6/l6-7-relayer-durability-scale | c4f4c91 | da317f0 | 1 / 28 | divergent side, cherry-picked | c4f4c91 → bc6d1c1 |
| live6/w1-windows-server-gate | f90de1d | 6ebd900 | 1 / 10 | side, exact cherry-pick | f90de1d ≡ f4a3dda (patch-id) |
| live6/live-closure-candidate | 6ebd900 | 6ebd900 | 0 / 10 | ancestor (linear) | — |
| live6/live-closure-candidate-w1 | 7b1a956 | 7b1a956 | 0 / 3 | ancestor (linear) | — |
| live6/restore-drill-tooling | 429e992 | 8fed34f | 1 / 4 | side, folded by integration | 429e992 → 130395b (via 38e9f3f), then c14186d |
| live6/relayer-rotation-prep | e59e9fe | 8fed34f | 1 / 4 | side, folded by integration | e59e9fe → 130395b, then superseded in part by 1d8fd7a |
| live6/postflip-drills-integration | 38e9f3f | 8fed34f | 1 / 4 | side, exact cherry-pick | 38e9f3f ≡ 130395b (patch-id) |
| live6/postflip-drills-converged | 130395b | 130395b | 0 / 2 | ancestor (linear) | — |
| live6/windows-restore-signal-test | c14186d | c14186d | 0 / 1 | ancestor (linear) | — |
| live6/l6-12d-relayer-capital-fix | 1d8fd7a | 1d8fd7a | 0 / 0 | line tip | — |
| live6/l6-14w-crlf-test-fix | 04138ea | 1d8fd7a | 1 / 0 | linear child of line tip, not in any candidate | **04138ea UNIQUE** |
| live6/l6-1 / l6-3 / l6-4 / l6-5a (pre-L6-6) | f0c9840 / 8e10d74 / 088abbd / 49c7b71 | da317f0 | 1 / 28 each | divergent sides, cherry-picked (converged) | → 9f3fb59 / 2f41be2 / 78bb14a / 35d2a7c |
| live6/l6-2, l6-5b | e67281c, 17d350b | self | 0 / 21, 0 / 18 | ancestors | — |
| route-v12/r12-2, r12-3, r12-4 | 7b24a60, 0fcefa4, 54d8898 | 0269b33 | 1–3 / 33 | side, cherry-picked | → 8e8d339, 784fc0a, e4305a5 (header text only differs) |
| route-v12/r12-w1-windows-frontend-gate | c785247 | 6ebd900 | 1 / 10 | side, exact | c785247 ≡ be281eb |
| route-v12/r12-1-oracle-mainbase | da78949 | self | 0 / 40 | ancestor | — |
| live5/l5-2, l5-4, l5-5 (pre-L6-6) | cfee004, d064f49, 0b3eaf8 | a62373a | 1–2 / 44 | side, cherry-picked | cfee004 ≡ f17c661; d064f49 ≡ fe00475; 0b3eaf8 ≡ 09d2308; f7609cf → c74e555; 0fa34ae → 3c96382 |
| live5/l5-3, l5-6, l5-7, l5-8 | — | self | 0 / n | ancestors | — |
| cost/cost-1-single-ec2 | 7d140b4 | 1d8fd7a | 2 / 0 | linear on line | b6858cc, 7d140b4 — in all three candidates by ancestry |
| cost/cost-2a-host-verifier | ce77f47 | 1d8fd7a | 3 / 0 | sibling of 2B and P5 on 7d140b4 | **ce77f47** (candidate) |
| cost/cost-2b-migration-guards | 161c737 | 1d8fd7a | 3 / 0 | sibling of 2A and P5 on 7d140b4 | **161c737** (candidate) |
| phase5/cost1-integration | 9e45ded | 1d8fd7a | 12 / 0 | on 7d140b4; 7 cherry-picks + 3 integration commits | 99eb537 aff17f3 0d8e6a8 785779c 32204a6 e1521fa 74eeb4b 3fa10e6 6679d61 9e45ded (candidate) |
| phase5/jx-4c-operator-evidence-iam | ee14050 | 1d8fd7a | 13 / 0 | linear child of 9e45ded (1 ahead of it) | **ee14050** (candidate; contains all of P5-INT-1) |
| phase5/jx-1k-financial-key-sets | 04cf14f | 1d8fd7a | 1 / 0 | side | 04cf14f → 99eb537 |
| phase5/jx-2b-relayer-submission-hardening | bdaad17 | 1d8fd7a | 2 / 0 | side (on JX-2A) | 7d7b7e5 → aff17f3; bdaad17 → 0d8e6a8 |
| phase5/jx-3b-wallet-hardening | 4c786ae | 1d8fd7a | 1 / 0 | side | 4c786ae → 785779c |
| phase5/jx-4b-money-evidence-reader | d752117 | 1d8fd7a | 2 / 0 | side (on JX-3B) | d752117 → 32204a6 |
| phase5/jx-5b-settle-sweep-retry | 9b10012 | 1d8fd7a | 1 / 0 | side | 9b10012 → e1521fa |
| phase5/jx-6b-dispute-server-hardening | 3b8d59f | 1d8fd7a | 1 / 0 | side | 3b8d59f → 74eeb4b |

Thirty side commits in total are unreachable from the candidates; §B classifies every one.

---

## B. Patch-equivalence audit

`≡` = identical stable patch-id. "Line check" = every added/removed line of the side commit looked up in the later
tree; misses listed with the later commit that changed them.

| Side commit | Files | Equivalent | Evidence | Class | RECON-1 |
|---|---|---|---|---|---|
| 8a2dc2b L6-6 harness | 42 (20 A) | fc6af5c | Diff-of-diffs (73 lines) is only the convergence: the side's separate `StagingCertListTasks` / `StagingCertDescribeTasks` IAM statements became the existing statement (1d8fd7a `iam.tf` l.330 `ecs:ListTasks, ecs:DescribeTasks`; l.366-367 `ListTaskDefinitions`, `DescribeTargetHealth`); `gs-<env>-primary` target group → `gs-<env>-<pool>` (L6-2's per-pool groups); `verify` options carried as typed fields, the L5-1 import guard widened for L6-4. Every remaining miss is shared with fc6af5c and was changed later on the line (649292b, 6ebd900, 130395b, 1d8fd7a). All 20 added files exist in 1d8fd7a, 9e45ded, ce77f47, 161c737. | 2 SEMANTICALLY PRESENT | none |
| 0c20222 L6-6R | 8 | df6e85a | Identical +/- lines (diff-of-diffs 0); patch-id differs only by context. | 1 EXACTLY PRESENT | none |
| b7caddc L6-6P | 7 | 80c333e | 20-line delta = the per-pool target group convergence only. | 2 SEMANTICALLY PRESENT | none |
| c4f4c91 L6-7 | 16 | bc6d1c1 | bc6d1c1 additionally registers into `l6_5aObservability.test.ts` and `taskStatus.dynamoLocal.test.ts`; side and line show the same residual misses (later line edits). | 2 SEMANTICALLY PRESENT | none |
| f90de1d LIVE-6 W1 | — | ≡ f4a3dda | patch-id | 1 EXACTLY PRESENT | none |
| c785247 R12-W1 | — | ≡ be281eb | patch-id | 1 EXACTLY PRESENT | none |
| 38e9f3f post-flip integration | — | ≡ 130395b | patch-id; 130395b's message records the clean convergence onto 7b1a956 | 1 EXACTLY PRESENT | none |
| 429e992 restore-drill tooling | 30 (17 A) | 130395b | Line check against 130395b: no added line missing (3 removed test-object lines survive elsewhere in the file). Against 1d8fd7a: the only 2 misses are c14186d's POSIX-only SIGTERM change to `restoreAlarmDrill.test.ts`. | 1 EXACTLY PRESENT (source) / 7 HISTORICAL (procedure) | none |
| e59e9fe relayer-rotation prep | 19 (4 A) | 130395b | Against 130395b: misses are 130395b's own integration edits (admin-known wording). Against 1d8fd7a: 85 missed lines, **every one** removed or rewritten by 130395b's integration or by 1d8fd7a (L6-12D: planning reserve = 73 × per-tx cap, an unread balance is never enough, proof `v2`). | 1 PRESENT, then 5 SUPERSEDED in part by 1d8fd7a | none |
| 04138ea L6-14W1 CRLF | 1 (`rotationProof.test.ts`) | **none** | `rotationProof.test.ts` is byte-identical to 1d8fd7a in 7d140b4, 9e45ded, ce77f47 and 161c737 (no `readCheckoutText`). `git apply --check` of 04138ea succeeds on all three heads; `testSupport/portability.ts` `readCheckoutText` exists on all. | 4 UNIQUE — TEST-ONLY MUST INTEGRATE | **TAKE** |
| 7d7b7e5 JX-2A | 4 | aff17f3 | Diff-of-diffs: `package.json` test-list context only. Added test lines of 7d7b7e5 absent in 9e45ded are exactly those JX-2B `bdaad17` rewrote (the D-1 budget follow-up). | 2 SEMANTICALLY PRESENT | none |
| 04cf14f JX-1K | 9 | 99eb537 | Only delta: README test count (23 → 30, then 32 by P5-INT-1); tfvars comment widened to name `stacks/single-host` (3fa10e6). | 2 SEMANTICALLY PRESENT | none |
| bdaad17 JX-2B | 6 | 0d8e6a8 | Identical +/- lines. | 1 EXACTLY PRESENT | none |
| 4c786ae JX-3B | 16 | 785779c | 12 code files byte-identical at 9e45ded; `operatorMain.ts` command list extended by JX-4B (`money`); header text. | 2 SEMANTICALLY PRESENT | none |
| d752117 JX-4B | 16 | 32204a6 | 13 files byte-identical at 9e45ded; header and `package.json` text only. | 2 SEMANTICALLY PRESENT | none |
| 9b10012 JX-5B | 4 | e1521fa | `package.json` `_comment_test`/`test` context only; test file identical. | 2 SEMANTICALLY PRESENT | none |
| 3b8d59f JX-6B | 7 | 74eeb4b | `package.json` context only; test file identical. | 2 SEMANTICALLY PRESENT | none |
| f0c9840 / 8e10d74 / 088abbd / 49c7b71 (pre-L6-6) | — | 9f3fb59 / 2f41be2 / 78bb14a / 35d2a7c | Line copies are the converged versions (e.g. L6-5A's `standby` role replaced by L6-1's non-primary router); residual misses are header text and the convergence. | 2 SEMANTICALLY PRESENT | none |
| 7b24a60 / 0fcefa4 / 54d8898 (R12) | — | 8e8d339 / 784fc0a / e4305a5 | Diff-of-diffs = 4 lines each, the canonical header only. | 1 EXACTLY PRESENT (code) | none |
| cfee004, d064f49, 0b3eaf8, f7609cf, 0fa34ae (LIVE-5) | — | f17c661, fe00475, 09d2308 (≡); c74e555, 3c96382 | header text only | 1 EXACTLY PRESENT | none |

Classes 3 (UNIQUE source), 6 and 8 have no side commit: COST-1 deleted **no file** (`git diff --name-status 1d8fd7a`
over every candidate shows only A/M), so every topology-specific item lives on in every candidate tree and its
disposition is about **use**, not about source (§E).

---

## C. LIVE-6 L6-6 → 1d8fd7a

- **Present in 1d8fd7a:** the whole L6-6 harness — `stage-cert prerequisite | certify`, `stage-probe task-role | edge |
  collect`, L6-4's recovery contract (`staging/recovery.ts`), `capture-evidence.{sh,ps1}`, `capture-restore-stop.{sh,ps1}`,
  `drain.ts`, `edgeProbe.ts`, `evidence.ts`, `prerequisite.ts`, `certify.ts`, `l6_6StagingCert.test.ts`, the staging
  certification IAM reads, and L6-6P's complete cluster listing (every page, RUNNING and STOPPED, every batch).
- **How it arrived:** by cherry-pick with convergence (fc6af5c, 80c333e, df6e85a), not by ancestry. The convergence
  changed exactly: IAM statement layout (same actions, merged into the existing statement), per-pool target-group names,
  and `verify`'s options type. L6-6R arrived line-for-line.
- **Then evolved on the line:** 649292b bound L6-4's readers, TASK# heartbeats, L6-5B alarms and L6-2 drills into the
  certification — which is why the side's README paragraph ending "those gates FAIL 'not integrated'" is absent: it is
  superseded, not lost. 6ebd900, 8fed34f, 7b1a956, 130395b, 1d8fd7a extended it further.
- **Missing from 1d8fd7a:** nothing.
- **L6-6 test / certification support still to carry:** none beyond what every candidate already holds (the files are
  unchanged in all three heads except where COST / P5 deliberately edited them).

## D. Windows / portability line

| Item | Where | In COST / P5 trees? | Disposition |
|---|---|---|---|
| LIVE-6 W1 server fixes (portable paths / EOL, case-distinct manifest, cmd.exe-safe batches) | f4a3dda (≡ f90de1d) | yes, by ancestry | ALREADY PRESENT |
| R12-W1 frontend gate (CRLF source tests, test-summary exit) | be281eb (≡ c785247) | yes | ALREADY PRESENT |
| drain-pool.ps1 PS 5.1 array | d32533e | yes | ALREADY PRESENT (ECS tool: RETIRED in use) |
| restoreAlarmDrill r3 SIGTERM POSIX-only | c14186d | yes | ALREADY PRESENT |
| **rotationProof.test CRLF-portable reserve guard** | **04138ea** | **no** (blob = 1d8fd7a's in every head) | **TAKE** |
| `.gitattributes` | identical in every head: `* text=auto` + escrow testdata/schema/scripts and settlement fixtures pinned LF | — | see W-04 |

**New hazards on the COST-1 base** (shared by all candidates; not regressions of any older fix — new files):

- **W-02** `server/src/aws/deploy/cost2aHostVerifier.test.ts` (ce77f47) l.969: `block.indexOf("\n}\n")` over raw
  `observability.tf` — the exact pattern 04138ea fixed. On CRLF it returns −1 and the slice widens to the rest of the
  file (fails open: a later alarm's attributes can satisfy an earlier alarm's assertions).
- **W-03** `server/src/aws/deploy/cost1SingleHost.test.ts` (7d140b4, all candidates) l.222-223 / 226-227:
  `/^GS_STORAGE=aws$/m` over raw `server.env.tftpl` — fails on a CRLF checkout (`$` does not match before `\r`).
- **W-04** `infra/aws/modules/single-host/files/**` (bash `gs-*`, systemd units), `templates/**` and
  `infra/aws/single-host/*.sh` resolve to `text=auto` (`git check-attr`), so a `core.autocrlf=true` checkout writes them
  CRLF. `modules/single-host/locals.tf` reads them with `file()` **verbatim** into cloud-init `write_files`, and
  `host.tf` sets `user_data_replace_on_change = true`. Consequences from a Windows checkout: `#!/usr/bin/env bash\r`
  shebangs and CRLF unit files on the host, and a user-data hash different from a Linux checkout's — a plan that
  **replaces the host**. The owner's checkout is CRLF by 04138ea's own record (it failed there).
  Recommended: pin `eol=lf` for those paths (the INTEGRATION-1 precedent in `.gitattributes`), plus a test that the
  rendered files contain no `\r`; then W-02 / W-03 read through `readCheckoutText`.

These three are **OWNER DECISION REQUIRED** (they are new work, not carried patches), recommended **TAKE in RECON-1,
before any `host-create` plan is captured from a Windows checkout**.

## E. Post-flip drill tooling

Source is present in every candidate (§B). Separation by use:

| Group | Contents | Single-host status | Disposition |
|---|---|---|---|
| Topology-independent safety, KEEP | APPGEN / SYSTEM/GENERATION adoption and the generation fence (L6-4, `restoreFence.ts` judgment), the production EMF metric builders extracted from `awsRuntime` (429e992; reused by COST-1's `GS_METRICS_PROFILE`), the identity restore's journal replay, `gamesDoctor aws` data-plane reads, RELAYQ / relayer fence checks | used unchanged by the host (same image, same tables) | ALREADY PRESENT |
| Relayer rotation source, KEEP | ledger `relayer_key_count` / `relayer-r<N>` keys, app `relayer_rotation_key_arns`, `set-operator-plan`, `relayer-rotation-gate` (v2), `rotationProof` v2, L6-12D reserve | **not** superseded by JX-1K (JX-1K adds settlement/admission financial key sets; P5-INT's ledger tests carry both: "relayer rotation +6; JX-1K +11") | ALREADY PRESENT |
| Relayer rotation **procedure** | the gate's "every pool drained" proof reads ECS `capture-evidence`; L6-13P's runbook is ECS / p1-p2 shaped; `l613-admin.cjs` is owner-local (Project file, not in any branch) | a future single-host rotation needs the gate's drain evidence adapted to `gs-stop` / host evidence | OWNER DECISION REQUIRED (future slice; not RECON-1) |
| ECS / ALB / p1-p2 machinery | flip, `flip-alarms`, `flip-drill`, `drain-pool`, `capture-restore-stop`, ALB/listener checks, L6-5B multi-pool alarms and suppressors, `suppression-overlap`, `run-restore-alarm-probe`, `run-restore-fence-probe` (`ecs run-task`) | COST-1's certification matrix: RETIRE | RETIRED (kept as source; never operated; do not delete in RECON-1) |
| Restore drill (L6-10 / L6-11, GO-C) | `--scenario restore-drill`, appgen-adopt of g2 | abandoned; GO-C never authorized; COST-2B §0 records the accepted post-GO-B state and its test pins every GO-C line as a negation | RETIRED / HISTORICAL — RECON-1 must not reintroduce any step that adopts g2 |

## F. COST parallel branches

### F.1 The D0 conflict (real; tests will not catch it)

- **COST-2A** `ce77f47` adds four `HostVerifier*` read statements to `data.aws_iam_policy_document.bootstrap`
  (`infra/aws/modules/app/iam.tf`), pinned by `app.tftest.hcl`, and tells the operator to apply them with an
  **ordinary app-stack apply**: `SINGLE_HOST_MIGRATION.md` step **D0** ("`stacks/app` at this commit with unchanged
  inputs. The plan shows only the bootstrap role's policy …") and `infra/aws/README.md` ("Apply it before the host
  verification is first needed (… step D0): the app plan then shows only the bootstrap role's policy").
- **COST-2B** `161c737` establishes (§0.2) that in the accepted staging state the app stack carries the **legacy
  desired-count drift** (state/config expect p1 desired 1; live is 0/0/0): an ordinary apply restarts p1 (or destroys
  the services). The app stack is frozen; the only applies are the targeted cutover (14), `ecs-rollback` and
  `compute-none`, each from a judged saved plan.
- **Why the merge is unsafe as text:** D0's premise ("the plan shows only the bootstrap policy") is false in 2B's world
  (it also shows the drift), and applying it restarts ECS. COST-2B's runbook test forbids `` `terraform apply` the `` but
  D0's wording does not match it — a mechanical merge passes the tests.
- **Knock-on (verified in `planGuards.ts`):** if the HostVerifier delta is never applied, every later untargeted
  app-stack plan carries it; `ecs-rollback` is a strict allowlist (only `aws_ecs_service.pool["p1"]` 0 → 1) and
  `compute-none`'s `retiredPoolNarrowingProblem` refuses "statements added". Both fail closed — safe, but the **rollback
  path would be blocked**. §A step 2 ("the plan shows only the drift; anything else is a STOP") would also stop.

**The same conflict, a second time — JX-4C (`ee14050`).** JX-4C adds `IdentityEvidenceRead` and `LedgerJournalQuery`
to the **operator** policy (`aws_iam_role_policy.operator[0]`, app stack) and `OperatorJournalQuery` to the **ledger
resource policy** (ledger stack). Verified in `planGuards.ts`:
- app half: pending in a later untargeted plan → `ecs-rollback` (strict allowlist) and `compute-none`
  (`retiredPoolNarrowingProblem`: "statements added") refuse — exactly as for D0; it needs the same targeted, guarded
  path, never an ordinary app apply;
- ledger half: pending when step 8's plan is captured → `ledger-host-authorize`'s `runtimePrincipalDelta` refuses
  ("statements added or removed"), and likewise `ledger-task-deauthorize` at step 22. The ledger stack is not drift-
  frozen, but the grant must be applied **before step 8** from its own judged saved plan.

**Required behaviour for RECON-1 (not implemented here):**

1. Delete D0's ordinary-apply text (runbook and README); never an untargeted app apply before compute-none.
2. Add a dedicated app gate, e.g. `migration-guard app-read-authorize` (stacks/app, **targeted**
   `-target=module.app.aws_iam_role_policy.bootstrap -target=module.app.aws_iam_role_policy.operator[0]`, captured with
   `plan-evidence -KeepPlan`): only in-place updates of those two policies, attribute `policy` only; bootstrap after =
   before + exactly the four `HostVerifier*` SIDs (2A); operator after = before + exactly `IdentityEvidenceRead`
   (GetItem, identity table, LeadingKeys PRIN#/PROF#/FAM# + Null false) and `LedgerJournalQuery` (Query, ledger table,
   ATTI# + Null false) (JX-4C); each statement's action / resource / condition set pinned to `modules/app/iam.tf` by a
   module-parity test; no other statement altered; every ECS / service / task-definition / document / table / KMS change
   refused; clean committed checkout. (Two separate gates are equally acceptable; one targeted capture is fewer steps.)
3. Add a ledger gate, e.g. `migration-guard ledger-operator-journal` (stacks/ledger, saved plan): exactly an in-place
   update of `aws_dynamodb_resource_policy.ledger` adding exactly `OperatorJournalQuery` (Query; principal the app
   account root with `ArnEquals aws:PrincipalArn` = the operator role; ATTI# + Null false); no key, table, backup or
   other statement change.
4. Place both after §A and **before step 8** (before any host exists), so that from then on `ledger-host-authorize`,
   `ecs-rollback`, `compute-none` and `ledger-task-deauthorize` see no foreign delta. Amend §A step 2's expected plan:
   "the drift, plus — until the app-read-authorize step — the bootstrap and operator read additions".
5. Tests: synthetic fixtures for the new gate(s) (+ ideally `terraform-real` plans), mutations (extra action, wildcard
   resource, a dropped LeadingKeys condition, `SESS#`/`LINK#` in the identity set, `ssm:SendCommand`, a desired_count
   change, an untargeted plan), add the gates to `GATE_NAMES` / the runbook assertions, keep 2A's `app.tftest.hcl`
   pins and JX-4C's `operator_evidence_policy.tftest.hcl` + `jx4cOperatorEvidenceIam.test.ts` unchanged.

Affected files: `infra/aws/SINGLE_HOST_MIGRATION.md`, `infra/aws/README.md`, `server/src/aws/deploy/migration/planGuards.ts`,
`migrationCommands.ts`, `planFixtures.ts`, `cost2bMigrationGuards.test.ts`, `infra/aws/fixtures/migration-plans/`,
`server/src/aws/deploy/commands.ts` (USAGE), `PROJECT_CANONICAL_CONTEXT.md`.

### F.2 Every other COST-2A ↔ COST-2B overlap (trial merge `ce77f47` + `161c737`)

| File | Textual | Semantic union RECON-1 must produce |
|---|---|---|
| `infra/aws/SINGLE_HOST_MIGRATION.md` | CONFLICT | 2B's text as the frame (post-abandonment §0, guards, targeted 14, guarded rollback, compute-none at 20). Re-insert 2A's **F0** (coexist verify; `--generation 1` already matches 2B), **15b** (re-verify after `Deployed`), **J24** judged inventory (`verify --topology single-host`). Replace D0 per F.1. Final paragraph: 2A's "The host's control plane is verified (COST-2A)" replaces "Not yet automated on the host", keeping 2B's "(and the COST-2B guard records)". |
| `infra/aws/README.md` | auto-merged | Keep both sections; rewrite 2A's "Apply it before … step D0" sentence per F.1. |
| `infra/aws/fixtures/README.md` | CONFLICT | Both paragraphs: 2A's host-role policy fixtures and 2B's `migration-plans/`. |
| `server/package.json` | CONFLICT | Token union (§H). |
| `server/src/aws/deploy/commands.ts` | auto-merged | Verified correct: `verify --topology` (2A) and `migration-guard` dispatch + USAGE (2B) both present. |
| `server/src/aws/deploy/deployVerify.ts` (2A only) | — | `Check.status` gains `not-evaluated`; 2B's `migration-guard` verdict is `every(pass)` (fail closed) but prints non-pass/fail as `SKIP` — print it as `NOT EVALUATED` (cosmetic). Type-check after the merge. |
| `PROJECT_CANONICAL_CONTEXT.md` | CONFLICT | One header rewritten last (§H). |
| App IAM / Terraform tests | — | 2A's `HostVerifier*` + `app.tftest.hcl` asserts; 2B adds no IAM. Doc test counts: app 68 runs (45 + 16 + 7) on 2A alone — 69 once JX-4C's `operator_evidence_policy` run joins (§H); single-host 20 (+1 by 2A). |

### F.3 COST-2C

No branch exists (`git ls-remote`: no `cost/*2c*`). **PENDING ACTIVE LANE.** When it lands, RECON-1 must re-check: its
merge base (expected 7d140b4 or a 2A/2B head), overlap with `SINGLE_HOST_MIGRATION.md`, `planGuards.ts` gate list,
`app` IAM, `server/package.json`, `infra/aws/README.md`, the canonical header, and whether it already resolves F.1 (do
not duplicate).

## G. Phase-5 line (`phase5/cost1-integration` `9e45ded`)

Treated as **in progress**: no P5-INT-1 final report is in the Project in this session. Audited at `9e45ded` only.

| Slice | Source | In P5-INT | Evidence |
|---|---|---|---|
| JX-1K | 04cf14f | 99eb537 | ledger module/stack files carry `financial_key_sets` beside COST-1's `app_runtime_role_arns` / `ecs_task_role_authorized`; test count 32 at 9e45ded (34 with JX-4C) |
| JX-2A | 7d7b7e5 | aff17f3 | frontend `jx2VerifyTx.js`, `jx2aKmsSigningParity.test.ts` identical; signer-pipeline test = JX-2B's version |
| JX-2B | bdaad17 | 0d8e6a8 | identical +/- lines |
| JX-3B | 4c786ae | 785779c | 12 files byte-identical |
| JX-4B | d752117 | 32204a6 | 13 files byte-identical; `test:dynamodb-local` registers `jx4bMoneyEvidence.dynamoLocal.test.js` |
| JX-5B | 9b10012 | e1521fa | test file identical; registered |
| JX-6B | 3b8d59f | 74eeb4b | test file identical; registered |

Overlaps with the COST siblings (trial merges): **P5 + 2B** → CONFLICT only in `PROJECT_CANONICAL_CONTEXT.md`,
`server/package.json` (README auto-merges). **P5 + 2A** → CONFLICT in `PROJECT_CANONICAL_CONTEXT.md`,
`infra/aws/README.md` (test-count lines), `server/package.json`, `server/src/aws/operator/operatorMain.ts`.

Semantic re-checks (no conflict marker, must still be run in RECON-1):
- COST-2B's `ledger-host-authorize` / `ledger-task-deauthorize` iterate every `aws_kms_key.signing[*]` of the prior
  state, so JX-1K's `settlement-<l>` / `admission-<l>` and rotation `relayer-r<N>` keys are covered by construction; add
  one guard fixture with those keys present (2B's fixtures predate JX-1K).
- COST-2B's `host-create` requires exactly three `--signing-keys`; consistent with P5's pin (the host role signs with
  exactly the three configured keys, financial or not).
- COST-2A's verifier ("host role KMS keys exactly the Juno configuration's") with a JX-1K configuration: run
  `cost2aHostVerifier.test` after the union.

### G.2 JX-4C — `phase5/jx-4c-operator-evidence-iam` `ee14050` (addendum)

- **Shape:** one commit, parent `9e45ded` (P5-INT-1's head): a linear descendant, so it contains every JX slice and
  P5-INT-1 by ancestry. No other branch carries any part of it (new patch; `git rev-list ee14050 ^9e45ded` = 1).
- **Content, verified in the diff (9 files):** app `iam.tf` operator policy + `IdentityEvidenceRead` (GetItem, identity
  table, `dynamodb:LeadingKeys` ForAllValues:StringLike `PRIN#*`/`PROF#*`/`FAM#*` + Null false) and
  `LedgerJournalQuery` (Query, ledger table, `ATTI#*` + Null false); ledger `main.tf` resource policy +
  `OperatorJournalQuery` (Query, app-account root principal, `ArnEquals aws:PrincipalArn` = the operator role, `ATTI#*`
  + Null false); `app.tftest.hcl` (+asserts, still 45 runs), new `app/tests/operator_evidence_policy.tftest.hcl` (1 run),
  `ledger.tftest.hcl` (33 runs), new `ledger/tests/operator_evidence_policy.tftest.hcl` (1 run); new
  `server/src/aws/operator/jx4cOperatorEvidenceIam.test.ts` registered in `npm test`; README rows for the ledger and
  operator roles. **No** `server/src` runtime file, no `frontend/`, no `contracts/`, no Dockerfile, no evidence code, no
  KMS / signing / session / write grant.
- **Classification:** 3 UNIQUE — MUST INTEGRATE → **TAKE** (as the base, §K).
- **Trial merges:** `ee14050 + 161c737` → CONFLICT only `PROJECT_CANONICAL_CONTEXT.md`, `server/package.json`.
  `ee14050 + ce77f47` → CONFLICT `PROJECT_CANONICAL_CONTEXT.md`, `infra/aws/README.md` (test-count lines),
  `server/package.json`, `operatorMain.ts` (all inherited from P5-INT-1, none from JX-4C's own lines); `iam.tf` and
  `app.tftest.hcl` auto-merge and the merged `iam.tf` holds all six new SIDs (four HostVerifier*, IdentityEvidenceRead,
  LedgerJournalQuery). Semantic union: neither side replaces the other — the bootstrap document gains 2A's statements,
  the operator document JX-4C's, the ledger resource policy JX-4C's.
- **Semantic conflict:** §F.1 (frozen app stack; ledger delta before step 8).
- **Re-checks for RECON-1:** `jx4cOperatorEvidenceIam.test.ts` parses `modules/app/iam.tf` and `modules/ledger/main.tf`
  by document name — run it after 2A's bootstrap statements land; COST-2B's guard fixtures model operator/bootstrap
  policies without JX-4C's statements — add the post-JX-4C policy text to the `compute-none` fixture so the narrowing
  check is exercised with them present. JX-4C's own README test-count lines were not updated (ledger still says 32,
  app 61): the union counts are in §H. Its Terraform source parser trims captured values and does not split on
  `"\n}\n"`, so it looks EOL-tolerant; not Windows-certified — PENDING OWNER GATE.
- **Version axes:** none touched (§I).

## H. Package / registration unions

| Surface | Union RECON-1 must preserve |
|---|---|
| `server/package.json` `test` | base 1d8fd7a list **+** COST-1 `aws/deploy/cost1SingleHost.test.js`, `aws/runtime/singleHostMetrics.test.js` **+** 2A `aws/deploy/cost2aHostVerifier.test.js`, `aws/operator/cost2aHostSnapshot.test.js` **+** 2B `aws/deploy/migration/cost2bMigrationGuards.test.js` **+** P5 `aws/deploy/jx2aSignerPipeline.test.js`, `aws/operator/jx3bWalletGrants.test.js`, `aws/operator/jx4bMoneyEvidence.test.js`, `aws/runtime/p5IntCrossSlice.test.js`, `escrow/jx3bMultiDevice.test.js`, `escrow/jx5bSettleSweepRetry.test.js`, `escrow/jx6bDisputeServer.test.js`, `tools/jx3bEvidence.test.js` **+** JX-4C `aws/operator/jx4cOperatorEvidenceIam.test.js` — each once (all under `dist/server/src/`). Nothing removed by any branch. |
| `server/package.json` `test:dynamodb-local` | base + `persistence/conformance/jx4bMoneyEvidence.dynamoLocal.test.js` (P5) |
| `server/package.json` other scripts | P5's new `jx3VerifyLink`; `_comment_test` text of 2B and P5 both kept. No other top-level key differs. |
| awsDeploy CLI (`commands.ts`) | `verify --topology ecs\|coexist\|single-host` + host flags (2A); `migration-guard <gate>` + `nat` (2B); RECON-1's new gate; USAGE lines for all. |
| gamesDoctor aws (`operatorMain.ts`) | `known` = status, game, games, wallet-grants, money, host-snapshot, set-primary, claim, take, release, flip, flip-observe, recover, retire-check, orphans, suppression-overlap; `noSubject` += host-snapshot; read-only apply refusal includes wallet-grants, money, host-snapshot; `VALUE_FLAGS` += `--tx-bytes --attempt --tx-hash` (P5) and `--out` (2A); `BOOLEAN_FLAGS` += `--chain` (P5); `mutation` list = P5's (host-snapshot returns earlier). Header comment and help lines of both. |
| Terraform tests (docs) | ledger 34 runs (`ledger.tftest.hcl` 33 + JX-4C `operator_evidence_policy` 1); app 69 (app 45 + alarms 16 + compute_none 7 + JX-4C `operator_evidence_policy` 1); single-host 20 + `bash tests/host-scripts.test.sh` (2A). COST-1's stale "12 runs" and JX-4C's unchanged "32" / "61" lines must not survive. |
| Module variables / outputs | Only P5 (ledger: `financial_key_sets` + COST-1's runtime-role variables, already unioned in 99eb537/3fa10e6). 2A / 2B / JX-4C change none. |
| IAM statements | 2A bootstrap `HostVerifierDescribeUnscopable`, `HostVerifierEcsEra`, `HostVerifierHostRole`, `HostVerifierBudgets`; JX-4C operator `IdentityEvidenceRead`, `LedgerJournalQuery` and ledger resource policy `OperatorJournalQuery`; COST-1 host role; P5 ledger key policies (no single-host IAM change). All additive, in different documents. |
| Docker / build | COST-1 only (multi-arch Dockerfile, `check-arch-neutral.cjs`, `build-image.{sh,ps1}`); no other branch touches them. |
| Windows scripts | 2A `capture-host-evidence.ps1`; 2B `capture-nat-evidence.ps1`, `plan-evidence.ps1` (`-KeepPlan`, single-host stack); COST-1 `build-image.ps1`, `gs-host.ps1`. Disjoint. |
| Fixtures | 2A `fixtures/host-*-policy-staging.json`; 2B `fixtures/migration-plans/**`; `fixtures/README.md` both. |
| Migration runbook | §F.2 first row. |
| `PROJECT_CANONICAL_CONTEXT.md` | One "Last updated" for RECON-1; "Before that" entries for COST-2B, COST-2A, JX-4C (it adds no header of its own: RECON-1 writes one), P5-INT-1 (with its JX-3B / JX-4B entries), COST-1, post-flip; §A bullets COST-1, COST-2A, COST-2B, JX-3B, JX-4B, JX-4C and P5-INT-1 all kept. |
| AWS operator / evidence registration | `gamesDoctor aws` command set is §H row 4 (JX-4C does not touch `operatorMain.ts`); the evidence paths JX-4C authorises (`wallet-grants`, `money`) need its IAM, `host-snapshot` (2A) adds no operator IAM (it reads status, route pools and open money games through the existing grants). |

## I. Version / protocol audit

No branch in the reconciliation set changes a version axis relative to `1d8fd7a`:

- `frontend/src/gameEngine/rulesVersion.ts` (`RULES_ENGINE_VERSION = 12`), `protocolVersions.ts`
  (`HOSTED_PROTOCOL_VERSION 1`, `FINANCIAL_PROTOCOL_VERSION 3`, `CLIENT_PROTOCOL_VERSION 1`),
  `contracts/escrow/Cargo.toml` (`2.0.0`), `contracts/escrow/src/contract.rs` and
  `frontend/src/gameEngine/settlementAppraisal.ts` have the **same blob** in 1d8fd7a, 7d140b4, 9e45ded, ee14050 (JX-4C),
  ce77f47, 161c737 and 04138ea.
- No `contracts/` or `frontend/src/gameEngine/` change in any candidate diff; settlement certification
  (`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS = [10, 11, 12]`) untouched.
- DynamoDB identity: `CHAIN_INTENT_FORMAT` and `chainIntents.ts` untouched; JX-4B moves the `INTENT#` parser into an
  exported function (same checks); JX-3B re-homes a grant with "same storage format". New constants are evidence /
  record formats only (`18COSMOS/HOST-EVIDENCE/v1`, `HOST-RUNTIME-SNAPSHOT/v1`, `HOST-VERIFY-REPORT/v1`,
  `COST-2B-MIGRATION-GUARD/v1`, `COST-2B-NAT-EVIDENCE/v1`, `JX3B/VERIFY-LINK/v1`, `JX3B/WALLET-GRANTS/v1`,
  `JX4B/MONEY-EVIDENCE/v1`, `JX4B/TX-BYTES/v1`).
- The rules-v12 change (R12-2/3/4) is **on the shared line before 1d8fd7a**, identical in every candidate; it is not a
  reconciliation item. No route / rules-engine work outside this set is folded in.

## J. Final reconciliation manifest

Dispositions: TAKE · ALREADY PRESENT · SUPERSEDED · RETIRED · PENDING ACTIVE LANE · OWNER DECISION REQUIRED.

| ID | Source | Classification | Final disposition | Dependencies | Conflict surface | RECON-1 action |
|---|---|---|---|---|---|---|
| P-01 | LIVE-5 side commits cfee004 d064f49 0b3eaf8 f7609cf 0fa34ae | 1 EXACTLY PRESENT | ALREADY PRESENT | — | — | none |
| P-02 | L6-1/3/4/5A sides f0c9840 8e10d74 088abbd 49c7b71 | 2 SEMANTICALLY PRESENT (converged) | ALREADY PRESENT | — | — | none |
| P-03 | R12-2/3/4 sides 7b24a60 0fcefa4 54d8898; R12-W1 c785247 | 1 EXACTLY PRESENT | ALREADY PRESENT | — | — | none |
| L-01 | L6-6 8a2dc2b | 2 SEMANTICALLY PRESENT | ALREADY PRESENT | — | — | none |
| L-02 | L6-6R 0c20222 | 1 EXACTLY PRESENT | ALREADY PRESENT | L-01 | — | none |
| L-03 | L6-6P b7caddc | 2 SEMANTICALLY PRESENT | ALREADY PRESENT | L-02 | — | none |
| L-04 | L6-7 c4f4c91 | 2 SEMANTICALLY PRESENT | ALREADY PRESENT | — | — | none |
| L-05 | LIVE-6 W1 f90de1d | 1 EXACTLY PRESENT (f4a3dda) | ALREADY PRESENT | — | — | none |
| L-06 | restore-drill tooling 429e992 (source) | 1 PRESENT via 130395b + c14186d | ALREADY PRESENT | — | — | none; do not delete |
| L-07 | relayer-rotation prep e59e9fe | 1 PRESENT via 130395b; 5 SUPERSEDED in part by 1d8fd7a | SUPERSEDED | — | — | none |
| L-08 | post-flip integration 38e9f3f | 1 EXACTLY PRESENT (130395b) | ALREADY PRESENT | L-06, L-07 | — | none |
| L-09 | L6-14W1 CRLF fix 04138ea | 4 UNIQUE TEST-ONLY | **TAKE** | `readCheckoutText` (present) | none (applies cleanly to all heads) | merge `live6/l6-14w-crlf-test-fix` (parent is 1d8fd7a) |
| T-01 | ECS flip / drain / ALB / L6-5B multi-pool alarm machinery (all trees) | 6 TOPOLOGY-OBSOLETE | RETIRED | — | — | keep source; never operate; no deletion in RECON-1 |
| T-02 | restore drill procedure, GO-C, restore-alarm / restore-fence probes | 7 HISTORICAL TOOLING | RETIRED | — | 2B runbook test pins GO-C negations | keep source; never resurrect the procedure |
| T-03 | generation fence, APPGEN, metric builders, data-plane reads | topology-independent | ALREADY PRESENT | — | — | none |
| T-04 | relayer rotation source (keys, gate v2, proof v2, set-operator-plan) | topology-independent source | ALREADY PRESENT | — | — | none |
| T-05 | relayer rotation procedure on the single host (gate's ECS drain evidence; owner-local `l613-admin.cjs`) | needs adaptation | OWNER DECISION REQUIRED | COST-2A host evidence | — | none in RECON-1; schedule a later slice if a rotation is wanted |
| C-01 | COST-1 b6858cc 7d140b4 | base of all candidates | ALREADY PRESENT | — | — | none |
| C-02 | COST-2B 161c737 | 3 UNIQUE MUST INTEGRATE | **TAKE** | C-01 | canonical, package.json (vs P5) | merge 1st after base |
| C-03 | COST-2A ce77f47 | 3 UNIQUE MUST INTEGRATE | **TAKE** | C-01, C-02 | runbook, fixtures README, README, package.json, operatorMain, canonical | merge 2nd; unions per §F.2 / §H |
| C-04 | D0 vs frozen app stack (2A bootstrap) + JX-4C operator / ledger grants | cross-branch semantic conflict | **TAKE** (new RECON-1 work) | C-02, C-03, X-10 | runbook, README, planGuards & tests | replace D0 by the targeted `app-read-authorize` gate and add the `ledger-operator-journal` gate, both before step 8 (§F.1) |
| C-05 | `Check` `not-evaluated` vs migration-guard print | union detail | **TAKE** | C-02, C-03 | `migrationCommands.ts` | print NOT EVALUATED; verdict stays every(pass) |
| C-06 | COST-2C | — | PENDING ACTIVE LANE | C-01.. | unknown | re-run §F against its final head |
| X-01 | JX-1K 04cf14f | 2 SEMANTICALLY PRESENT (99eb537) | ALREADY PRESENT | — | — | none |
| X-02 | JX-2A 7d7b7e5 | 2 SEMANTICALLY PRESENT (aff17f3) | ALREADY PRESENT | — | — | none |
| X-03 | JX-2B bdaad17 | 1 EXACTLY PRESENT (0d8e6a8) | ALREADY PRESENT | X-02 | — | none |
| X-04 | JX-3B 4c786ae | 2 SEMANTICALLY PRESENT (785779c) | ALREADY PRESENT | — | — | none |
| X-05 | JX-4B d752117 | 2 SEMANTICALLY PRESENT (32204a6) | ALREADY PRESENT | X-04 | — | none |
| X-06 | JX-5B 9b10012 | 2 SEMANTICALLY PRESENT (e1521fa) | ALREADY PRESENT | — | — | none |
| X-07 | JX-6B 3b8d59f | 2 SEMANTICALLY PRESENT (74eeb4b) | ALREADY PRESENT | — | — | none |
| X-08 | P5-INT-1 3fa10e6 6679d61 9e45ded | integration lane | PENDING ACTIVE LANE (final report) — contained by ancestry in X-10 | X-01..X-07, C-01 | — | no separate action; if P5-INT-1's head moves past 9e45ded, merge that too and re-audit |
| X-10 | JX-4C ee14050 (`phase5/jx-4c-operator-evidence-iam`) | 3 UNIQUE MUST INTEGRATE (additive operator read IAM, tests) | **TAKE** — as the RECON-1 base | X-08 | `iam.tf` / `app.tftest.hcl` (auto-merge with 2A), ledger `main.tf`, `package.json`, README counts, canonical; semantic: C-04 | base; union per §G.2 / §H; its grants applied only via the C-04 gates |
| X-09 | 2B guards × JX-1K / rotation keys / JX-4C policies; 2A verifier × JX-1K config | semantic re-check | **TAKE** (validation) | C-02, C-03, X-01, X-10 | tests | add a ledger guard fixture with financial + r2 keys and a compute-none fixture with JX-4C's operator statements; run cost2a / cost2b / jx4c suites |
| H-01 | `server/package.json` | registration union | **TAKE** | all | conflict | §H token union |
| H-02 | `operatorMain.ts` | CLI union | **TAKE** | X-04, X-05, C-03 | conflict | §H list union |
| H-03 | Terraform test-count docs, fixtures README, infra README | doc union | **TAKE** | — | conflict | §H |
| H-04 | `PROJECT_CANONICAL_CONTEXT.md` | header union | **TAKE** | all | conflict in every pair | rewrite last |
| W-02 | `cost2aHostVerifier.test.ts` l.969 `"\n}\n"` | new portability gap | OWNER DECISION REQUIRED (recommend TAKE) | L-09 pattern | — | `readCheckoutText` + delimiter assertion |
| W-03 | `cost1SingleHost.test.ts` `$/m` on raw template | new portability gap | OWNER DECISION REQUIRED (recommend TAKE) | — | — | `readCheckoutText` |
| W-04 | single-host host files not `eol=lf`; verbatim user data; `user_data_replace_on_change` | new portability / safety gap | OWNER DECISION REQUIRED (recommend TAKE before any host-create plan) | — | `.gitattributes` | pin LF + a no-`\r` render test |
| V-01 | version / protocol axes | none changed | ALREADY PRESENT (unchanged) | — | — | none |
| G-01 | full owner certification of the RECON-1 candidate | — | PENDING OWNER GATE | RECON-1 | — | owner runs the broad suites; RECON-0 ran none |

## K. Proposed RECON-1 base and order

**Base: `phase5/jx-4c-operator-evidence-iam` `ee14050`** (updated by the addendum; previously P5-INT-1 `9e45ded`).
Reasons from the graph: JX-4C is a linear one-commit child of P5-INT-1, so it already contains COST-1 by ancestry, all
seven JX slices and P5-INT-1's ten commits of finished conflict work (which must not be redone), plus JX-4C itself;
COST-2A and COST-2B are each a single commit on COST-1 `7d140b4`, an ancestor of the base, so each arrives as a
one-commit merge with original SHAs kept reachable (future lineage audits then work by ancestry, not patch-id);
04138ea's parent is 1d8fd7a, also an ancestor. Starting from 2A or 2B would mean re-cherry-picking eleven Phase-5
commits. If P5-INT-1's lane later moves its own head past `9e45ded`, merge that head too (step 1b) — never rebase JX-4C.

**Order** (use `git merge --no-ff`, never rebase / rewrite):

1. Start a `recon/recon-1-*` branch at `ee14050` (verify the remote head is still `ee14050`; if not, re-run §G.2).
   1b. Only if P5-INT-1 has moved past `9e45ded`: merge its final head and re-run §G.
2. Merge `live6/l6-14w-crlf-test-fix` (04138ea) — zero conflicts.
3. Merge `cost/cost-2b-migration-guards` (161c737) — conflicts: canonical header, `package.json`.
4. Merge `cost/cost-2a-host-verifier` (ce77f47) — conflicts: runbook, fixtures README, infra README (test counts),
   `package.json`, `operatorMain.ts`, canonical header; `iam.tf` / `app.tftest.hcl` auto-merge (check all six new SIDs
   remain). Resolve with 2B's runbook as the frame (§F.2) and the §H unions.
5. RECON-1 commit: the `app-read-authorize` and `ledger-operator-journal` gates and the runbook / README rewrite
   (C-04), the NOT EVALUATED print (C-05), the X-09 fixtures.
6. If the owner approves: W-04, then W-02 / W-03.
7. COST-2C when final (re-check §F.3; it may land earlier in the order if it is based on 2A or 2B).
8. Canonical header rewritten last.

Narrow validation for RECON-1 (targeted only; the full server `npm test` corpus and every owner certification suite
are **PENDING OWNER GATE**): server `tsc` build; the `cost1SingleHost`, `cost2aHostVerifier`, `cost2aHostSnapshot`,
`cost2bMigrationGuards`, `jx4cOperatorEvidenceIam`, `p5IntCrossSlice`, `rotationProof` and `awsClients` suites;
`terraform test` in `modules/app`, `modules/ledger`, `modules/single-host`; `bash tests/host-scripts.test.sh`.

## L. Record

Branch `recon/recon-0-lineage-audit` from `1d8fd7a`, adding only this file and
`docs/RECON0_SOURCE_LINEAGE_2026-10-02.json`. Not merged. Nothing saved to the Claude Project. No test was run by
RECON-0 (testing policy of the addendum).
