// server/src/tools/readOnlyFs.ts
//
// ==================================================================
//  LIVE-4 (L4-6): THE INSPECTION COMMANDS' FILE SYSTEM -- READS PASS, EVERY WRITE IS REFUSED
// ==================================================================
//
// `gamesDoctor inspect`, `continuation`, `money` and `compat` read the same files the server reads, with the same store
// code -- and must never change one byte: no repair, no rewrite, no truncation, no hold, no migration, not even a
// directory a store would make before its first write. Rather than trust every store's read path to stay write-free as
// it evolves, the inspection commands hand those stores this adapter (`StoreFs`, which every file store accepts):
//
//   open(file, "r"), readFile, readdir     passed through
//   mkdir                                  NOT performed: resolved without creating anything (a store "prepares" its
//                                          directory before reading; a directory that does not exist then reads as
//                                          empty, which is what it is)
//   open(file, "r+" | "wx"), rename,       refused: `ReadOnlyInspectionError`, before the operating system is asked
//   unlink, appendFile
//
// The byte-level tests (`tools/l4_6Tooling.test.ts`) hash every file and directory under a data directory before and
// after each command; this adapter is why that holds by construction rather than by care.

import type { StoreFileHandle, StoreFs } from "../fileLogStore";
import { nodeStoreFs } from "../fileLogStore";

export class ReadOnlyInspectionError extends Error {
  constructor(operation: string, target: string) {
    super(`gamesDoctor inspection is read-only: refused ${operation} ${target}`);
    this.name = "ReadOnlyInspectionError";
  }
}

/** `base` with every write refused and `mkdir` a no-op (see the header). */
export function readOnlyStoreFs(base: StoreFs = nodeStoreFs): StoreFs {
  return Object.freeze({
    open: (file: string, flags: "r" | "r+" | "wx"): Promise<StoreFileHandle> => {
      if (flags !== "r") return Promise.reject(new ReadOnlyInspectionError(`open(${flags})`, file));
      return base.open(file, "r");
    },
    readFile: (file: string) => base.readFile(file),
    readdir: (directory: string) => base.readdir(directory),
    mkdir: async () => undefined,
    rename: (from: string, to: string) => Promise.reject(new ReadOnlyInspectionError("rename", `${from} -> ${to}`)),
    unlink: (file: string) => Promise.reject(new ReadOnlyInspectionError("unlink", file)),
    appendFile: (file: string) => Promise.reject(new ReadOnlyInspectionError("appendFile", file)),
  });
}

/** `readdir` that reads a missing directory as empty (what a store's `mkdir` used to guarantee before its list). */
export async function listOrEmpty(list: () => Promise<string[]>): Promise<string[]> {
  try {
    return await list();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}
