// frontend/src/utils/ludumReturn.test.ts
//
// LUDUM (Lane A): `?ludum=signin&return=<path>` -- the account dialog, then back to the Ludum build constant + path; at
// once when already signed in; nothing for any other path (§2.1: not an open redirect).

import { accountPromptState, accountSignedIn, closeAccountDialog, requireAccount, resetAccountPromptForTests } from "./accountPrompt";
import { handleLudumSignIn, LUDUM_ORIGIN, ludumReturnTarget } from "./ludumReturn";
import { readySessionPort } from "./sessionBootstrap";

afterEach(() => resetAccountPromptForTests());

describe("LUDUM: the return-to target", () => {
  it("is the Ludum build constant plus a path matching ^/[a-z0-9/_-]{0,128}$", () => {
    expect(LUDUM_ORIGIN).toBe("https://ludum.netadao.org");
    expect(ludumReturnTarget("?ludum=signin&return=/")).toBe("https://ludum.netadao.org/");
    expect(ludumReturnTarget("?ludum=signin&return=%2Fme%2F")).toBe("https://ludum.netadao.org/me/");
    expect(ludumReturnTarget("?return=/disputes/case/&ludum=signin")).toBe("https://ludum.netadao.org/disputes/case/");
    expect(ludumReturnTarget(`?ludum=signin&return=/${"a".repeat(128)}`)).toBe(`https://ludum.netadao.org/${"a".repeat(128)}`);
  });

  it("refuses everything else (the visitor stays on Play)", () => {
    for (const search of [
      "",
      "?ludum=signin",
      "?return=/me/",
      "?ludum=signout&return=/me/",
      "?ludum=SIGNIN&return=/me/",
      "?ludum=signin&ludum=signin&return=/me/",
      "?ludum=signin&return=/me/&return=/x/",
      "?ludum=signin&return=me/",
      "?ludum=signin&return=https://evil.example/",
      "?ludum=signin&return=//evil.example/",
      "?ludum=signin&return=/%2F/evil.example",
      "?ludum=signin&return=/me/?x=1",
      "?ludum=signin&return=/me/%23x",
      "?ludum=signin&return=/Me/",
      "?ludum=signin&return=/me/../x",
      "?ludum=signin&return=/me\\x",
      "?ludum=signin&return=/me:x",
      "?ludum=signin&return=/ me",
      `?ludum=signin&return=/${"a".repeat(129)}`,
    ]) {
      expect([search, ludumReturnTarget(search)]).toEqual([search, null]);
    }
  });
});

describe("LUDUM: handleLudumSignIn", () => {
  it("already signed in: goes to Ludum at once, no dialog", () => {
    const went: string[] = [];
    const port = readySessionPort();
    const handled = handleLudumSignIn({ search: "?ludum=signin&return=/me/", navigate: (url) => went.push(url), requireAccount: (run, reason) => requireAccount(run, reason, { port }) });
    expect(handled).toBe(true);
    expect(went).toEqual(["https://ludum.netadao.org/me/"]);
    expect(accountPromptState().open).toBe(false);
  });

  it("signed out: opens the existing sign-in dialog; a successful sign-in goes to Ludum once; closing it stays on Play", () => {
    const went: string[] = [];
    const visitor = { state: "unprofiled", account: null } as never;
    const ask = (run: () => void, reason: string) => requireAccount(run, reason, { port: visitor });
    expect(handleLudumSignIn({ search: "?ludum=signin&return=/governance/", navigate: (url) => went.push(url), requireAccount: ask })).toBe(true);
    expect(accountPromptState()).toEqual({ open: true, mode: "login", reason: "Log in to continue to Ludum." });
    expect(went).toEqual([]);
    accountSignedIn({ renew: () => undefined });
    expect(went).toEqual(["https://ludum.netadao.org/governance/"]);

    went.length = 0;
    handleLudumSignIn({ search: "?ludum=signin&return=/me/", navigate: (url) => went.push(url), requireAccount: ask });
    closeAccountDialog();
    accountSignedIn({ renew: () => undefined });
    expect(went).toEqual([]);
  });

  it("an unsafe or absent request does nothing at all", () => {
    const went: string[] = [];
    let asked = 0;
    const ask = () => {
      asked += 1;
      return true;
    };
    expect(handleLudumSignIn({ search: "?ludum=signin&return=//evil.example", navigate: (url) => went.push(url), requireAccount: ask })).toBe(false);
    expect(handleLudumSignIn({ search: "?table=ABCD", navigate: (url) => went.push(url), requireAccount: ask })).toBe(false);
    expect([went, asked]).toEqual([[], 0]);
  });
});
