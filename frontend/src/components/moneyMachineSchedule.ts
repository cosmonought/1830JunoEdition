// frontend/src/components/moneyMachineSchedule.ts
//
// The five-phase schedule both money machines run on -- #1082's marks, in one module with no imports, so the
// panel that draws the phases (`MoneyMachinePanel`) and the machines that time them (`DividendMoneyMachine`,
// `TreasuryMoneyMachine`) can both read the numbers without importing each other.
//
// Design note #1291: `DividendMoneyMachine` re-exports every one of these under the names the tests and the
// shell have always used; nothing that imported them from there needs to change. The reason they moved is a
// module cycle -- the panel wants the slide and fall durations for its CSS at evaluation time, and the machine
// wants the panel; a constant read across a cycle at evaluation time is `undefined` in whichever file loads
// second. A leaf module ends that.

/** 0.0-0.5s in, 3.0-3.5s out. */
export const MONEY_MACHINE_SLIDE_MS = 500;
/** 0.5-1.5s. The beat #1082 added: both figures perfectly still, so they can be read. */
export const MONEY_MACHINE_HOLD_MS = 1000;
/** 1.5-2.0s. The amount travels into the total; the total becomes the new figure at the end of it. */
export const MONEY_MACHINE_FALL_MS = 500;
/** #1368: how long the mover row takes to fold away once the figure has landed. Inside the linger, so the
 *  panel is closed up around the total before it leaves. */
export const MONEY_MACHINE_FOLD_MS = 260;
/** #1372: how long a treasury movement is held for a second one by the same corporation before it is shown.
 *  Long enough to cover a player buying two trains in two clicks; short enough that a single purchase does
 *  not feel unanswered. */
export const TREASURY_MACHINE_COALESCE_MS = 1500;
/** 2.0-3.0s, on the final total. */
export const MONEY_MACHINE_LINGER_MS = 1000;
/** When the amount starts to move. */
export const MONEY_MACHINE_FALL_AT_MS = MONEY_MACHINE_SLIDE_MS + MONEY_MACHINE_HOLD_MS;
/** When it has landed and the total updates. */
export const MONEY_MACHINE_MERGE_AT_MS = MONEY_MACHINE_FALL_AT_MS + MONEY_MACHINE_FALL_MS;
/** When the panel starts to leave. */
export const MONEY_MACHINE_LEAVE_AT_MS = MONEY_MACHINE_MERGE_AT_MS + MONEY_MACHINE_LINGER_MS;
/** When it has gone. */
export const MONEY_MACHINE_TOTAL_MS = MONEY_MACHINE_LEAVE_AT_MS + MONEY_MACHINE_SLIDE_MS;
