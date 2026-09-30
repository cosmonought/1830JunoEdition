// server/src/aws/runtime/storageMode.ts
//
// LIVE-5 L5-7: which storage this process runs on -- `file` (PROCESS mode: the data directory and its lock, exactly as
// before) or `aws` (DynamoDB, KMS and SSM: `awsMain.ts`). `GS_STORAGE` or `--storage`; ABSENT means `file`, so every
// existing start command runs as it always did; any other value, or an environment and a flag that disagree, refuses
// the start (exit 2). This module imports nothing: `start.ts` reads it on every start, and PROCESS mode never loads any
// AWS code (`awsMain.ts` is imported only when the answer is `aws`).

export type StorageKind = "file" | "aws";

export const STORAGE_ENV = "GS_STORAGE";
export const STORAGE_FLAG = "--storage";

export type Env = Readonly<Record<string, string | undefined>>;

/** `--name value` or `--name=value`, every occurrence. */
export function flagValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((arg, at) => {
    if (arg === name) values.push(argv[at + 1] ?? "");
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  });
  return values;
}

/** One setting from the environment and/or its flag: they must agree (identity/mode.ts's rule). */
export function single(argv: readonly string[], env: Env, envName: string, flagName: string): { readonly value?: string; readonly conflict?: string } {
  const values = [...(env[envName] !== undefined ? [env[envName] as string] : []), ...flagValues(argv, flagName)];
  const distinct = [...new Set(values)];
  if (distinct.length > 1) return { conflict: `${envName} and ${flagName} disagree (${distinct.map((value) => JSON.stringify(value)).join(" vs ")})` };
  return distinct.length === 0 ? {} : { value: distinct[0] };
}

/** Which storage this process runs on. Absent: `file` (PROCESS mode, unchanged). */
export function storageKindOf(argv: readonly string[], env: Env): { readonly ok: true; readonly kind: StorageKind } | { readonly ok: false; readonly reason: string } {
  const given = single(argv, env, STORAGE_ENV, STORAGE_FLAG);
  if (given.conflict !== undefined) return { ok: false, reason: given.conflict };
  if (given.value === undefined) return { ok: true, kind: "file" };
  if (given.value === "file" || given.value === "aws") return { ok: true, kind: given.value };
  return { ok: false, reason: `${STORAGE_ENV} must be "file" (the data directory; the default) or "aws" (DynamoDB, KMS and SSM), not ${JSON.stringify(given.value)}` };
}
