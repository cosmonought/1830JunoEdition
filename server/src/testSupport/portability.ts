// server/src/testSupport/portability.ts
//
// ==================================================================
//  LIVE-6 W1: WHAT A SOURCE OR PATH ASSERTION MAY ASSUME, ON EVERY PLATFORM
// ==================================================================
//
// The first Windows owner gate failed tests whose code was right: a Windows checkout (Git's core.autocrlf, `* text=auto`)
// has CRLF sources, `path.relative` answers `modules\app\edge.tf`, and NTFS folds case. A test that inspects the repository
// or names a file normalizes ONCE, where it reads or enumerates, with these helpers -- never by loosening what it asserts.
// Each helper is plain string work, so a test can feed it Windows input on any platform (`path.win32`, `\r\n`).

import * as fs from "fs";
import * as path from "path";

/** A relative path with `/` separators, whatever produced it (`path.relative` on Windows answers with `\`). */
export const toPosixPath = (p: string): string => p.split("\\").join("/");

/** `path.relative(from, to)` as a `/`-separated name. `api` defaults to this platform's `path`; a test passes `path.win32`
 *  to pin Windows input where it does not run. */
export const relativePosix = (from: string, to: string, api: Pick<typeof path, "relative"> = path): string => toPosixPath(api.relative(from, to));

/** Text with every line ending as `\n` (CRLF and a lone CR alike): a source or lock file as the repository commits it. */
export const normalizeEol = (text: string): string => text.replace(/\r\n?/g, "\n");

/** A checked-out text file (source, Terraform, lock, script) read as the repository commits it: LF line endings, no BOM. */
export const readCheckoutText = (file: string): string => normalizeEol(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

/** The names that fold to the same path on a case-insensitive filesystem (NTFS, default APFS) while being spelled
 *  differently: each group is one Windows path that more than one of `names` would claim. `\` and `/` are one separator. */
export function caseFoldCollisions(names: Iterable<string>): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const name of names) {
    const spelled = toPosixPath(name);
    const folded = spelled.toLowerCase();
    const group = groups.get(folded) ?? new Set<string>();
    group.add(spelled);
    groups.set(folded, group);
  }
  return [...groups.values()].filter((g) => g.size > 1).map((g) => [...g].sort());
}

/** Every directory prefix of each name too (`terraform/app/plan.json` -> `terraform`, `terraform/app`): a file and a
 *  directory, or two directories, collide on a case-insensitive filesystem exactly as two files do. */
export function withDirectories(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const parts = toPosixPath(name).split("/");
    for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join("/"));
  }
  return [...out];
}
