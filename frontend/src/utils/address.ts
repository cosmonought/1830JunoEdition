// frontend/src/utils/address.ts
//
// `truncateAddress`, moved out of `App.tsx` unchanged.
//
// It has two callers -- `TopBar` and `AppShell` -- which is precisely why it
// could not travel with either. A helper shared by two components that is
// declared inside one of them makes the other import from a sibling for a
// four-line string function.
//
// NOTE THE NAME COLLISION, which is pre-existing and deliberate:
// `utils/lobby.ts` exports its own `truncateAddress`, and `App.tsx` carried a
// comment explaining that it was NOT importing that one because this local
// version takes configurable lead/trail lengths. That comment travelled to
// the import site in `AppShell`. Two truncators is still one too many, and
// unifying them is still a separate tidy-up rather than this pass's business
// -- but at least the second one now has an address of its own.

export function truncateAddress(address: string | null, lead = 10, trail = 6): string {
  if (!address) return "--";
  if (address.length <= lead + trail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-trail)}`;
}

