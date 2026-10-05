// server/src/threadPool.ts
//
// PHASE 3 (P3-ACCT, review M1): LIBUV'S THREAD POOL IS WIDER THAN THE PASSWORD KDF'S GATE.
//
// Node runs `crypto.scrypt` -- the password KDF (`identity/accountCredentials.ts`) -- on libuv's thread pool, the same
// pool that serves asynchronous file-system work (the room logs, the record store), DNS lookups and other async crypto.
// Its default is FOUR threads, which is exactly the KDF gate's width: a burst of sign-ins would occupy every thread and
// queue the game's own disk writes behind scrypt. The pool's size is read ONCE, when it is first used, from
// `UV_THREADPOOL_SIZE` -- so this module is imported FIRST by the process entry (`start.ts`), before anything can touch
// the pool, and widens it to 16 unless the operator has set the variable (an explicit setting always wins).
//
// Memory: the gate still bounds concurrent KDFs (4 x 32 MiB); extra threads cost only their stacks.

const DEFAULT_POOL = "16";

if (process.env.UV_THREADPOOL_SIZE === undefined || process.env.UV_THREADPOOL_SIZE.trim() === "") {
  process.env.UV_THREADPOOL_SIZE = DEFAULT_POOL;
}

export const THREAD_POOL_SIZE = process.env.UV_THREADPOOL_SIZE;
