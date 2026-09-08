// frontend/src/utils/introPreference.ts
//
// Whether THIS browser plays the opening titles when a game is dealt.
//
// ==================================================================
//  DESIGN NOTE 1239: A PLAYTESTER'S THIRTEEN SECONDS
// ==================================================================
//
// ASKED: "can you add a 'disable intro video' toggle to the waiting room for the host? that's 13 seconds every
// time I have to do this."
//
// PER BROWSER, NOT PER ROOM, AND THE DIFFERENCE IS WHAT KIND OF FACT IT IS. The titles are presentation: they
// change what a screen shows and nothing about the game. A room-document field would make one player's
// preference everybody's, would need a server write, and would put a viewing choice beside the roster and
// the house rules, which are terms the table agreed to (#910). A viewer's own setting belongs to the viewer.
// The request said "for the host", and in a two-tab playtest the host's browser IS every player's browser --
// `localStorage` is shared across a browser's tabs -- so one tick covers the table this was asked for.
//
// SHOWN TO EVERYONE IN THE WAITING ROOM, because everyone has a browser. A player at a real table who wants
// the titles keeps them; one who has seen them a hundred times does not have to.
//
// `localStorage`, NOT `sessionStorage`. The seat lives in `sessionStorage` so two tabs are two players (#528);
// this is the opposite requirement -- a preference that outlives the tab and applies to the next game too.
// Guarded, because private browsing throws, and a thrown preference read would be the one thing capable of
// breaking a waiting room that otherwise needs nothing from the browser.

const KEY = "18cosmos.skipIntro.v1";

export function skipIntroPreferred(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setSkipIntroPreferred(skip: boolean): void {
  try {
    if (skip) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    /* A browser that refuses storage refuses the preference; the titles simply play. */
  }
}
