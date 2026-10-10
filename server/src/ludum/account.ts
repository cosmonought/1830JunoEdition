// server/src/ludum/account.ts
//
// ==================================================================
//  LUDUM v1.1: `account` AND `display-name` -- THE ACCOUNT'S OWN PAGE (Your account)
// ==================================================================
//
//   POST account {}               (profiled) the display name and its state, the facts tablemates see, the roles.
//   POST display-name { name }    (profiled) the ONE display-name change, before the account's first game.
//
// Only ever the CALLER's own account: no route here takes an account, a username or an id. The facts are the same ones
// `/gs/api/trust/*` shows a tablemate (`rooms/trustFacts.ts`) -- here the account sees its own. The display-name rule
// (unique by `displayNameKey`, one change, never while seated or once a game has started) is the identity service's
// (`IdentityService.changeDisplayName`); this only reshapes its answer.

import type { AccountResponse, DisplayNameResponse, DisplayNameView } from "./contract";
import type { LudumHandler, LudumMemberPorts } from "./ports";

type Answer = { status: number; json: unknown };
const signedOut = (): Answer => ({ status: 401, json: { error: "signed-out" } });
const unavailable = (detail: string): Answer => ({ status: 503, json: { error: "unavailable", detail } });

function viewOf(members: LudumMemberPorts, principalId: string): DisplayNameView | null {
  const current = members.displayName(principalId);
  if (current === null) return null;
  return { name: current.name, state: current.state.kind, changedAt: current.state.kind === "changed" ? new Date(current.state.at).toISOString() : null };
}

export const account: LudumHandler = async (body, caller, ports) => {
  if (caller.principalId === null) return signedOut();
  const members = ports.members;
  if (members === undefined) return unavailable("account pages are not served here");
  if (typeof body !== "object" || body === null || Object.keys(body).length !== 0) return { status: 400, json: { error: "bad-request", detail: "the body is {}" } };
  let displayName: DisplayNameView | null;
  try {
    displayName = viewOf(members, caller.principalId);
  } catch {
    return unavailable("the game records could not be read");
  }
  if (displayName === null) return signedOut();
  let tablemates: AccountResponse["tablemates"];
  try {
    const facts = await members.tablemateFacts(caller.principalId);
    tablemates =
      facts === null
        ? { value: null, provenance: "unavailable", reason: "this account's facts could not be read" }
        : {
            value: {
              memberSince: facts.memberSince,
              accountAgeDays: facts.accountAgeDays,
              completedMoneyGames: facts.completedMoneyGames,
              unresolvedDisputes: facts.unresolvedDisputes,
              disputedGames: facts.disputedGames,
              inactivityExits: facts.inactivityExits,
              authorizationWalletSince: facts.authorizationWalletSince,
              establishedOpponents: facts.establishedOpponents,
            },
            provenance: "server-recorded",
            observedAt: new Date(ports.now()).toISOString(),
          };
  } catch {
    tablemates = { value: null, provenance: "unavailable", reason: "this account's facts could not be read" };
  }
  const answer: AccountResponse = { displayName, tablemates, roles: { reviewer: members.isReviewer(caller.principalId) } };
  return { status: 200, json: answer };
};

export const displayName: LudumHandler = async (body, caller, ports) => {
  if (caller.principalId === null) return signedOut();
  const members = ports.members;
  if (members === undefined) return unavailable("account pages are not served here");
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof body !== "object" || body === null || Object.keys(body).length !== 1 || typeof name !== "string") return { status: 400, json: { error: "bad-request", detail: "the body is { name }" } };
  let outcome;
  try {
    outcome = await members.changeDisplayName(caller.principalId, name);
  } catch {
    return unavailable("the game records could not be read");
  }
  switch (outcome.kind) {
    case "ok": {
      const view = viewOf(members, caller.principalId);
      if (view === null) return signedOut();
      const answer: DisplayNameResponse = { displayName: view };
      return { status: 200, json: answer };
    }
    case "bad-name":
      return { status: 400, json: { error: "bad-request", detail: "bad-name" } };
    case "not-found":
      return signedOut();
    case "unavailable":
      return unavailable("the change could not be saved; nothing changed");
    default:
      return { status: 409, json: { error: "conflict", detail: outcome.kind } };
  }
};
