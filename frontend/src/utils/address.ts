// `truncateAddress`, moved out of `App.tsx` unchanged.
//
// It has two callers -- `TopBar` and `AppShell` -- which is precisely why it
// could not travel with either: a helper shared by two components that is
// declared inside one of them makes the other import from a sibling.
//
// NOTE THE NAME COLLISION, pre-existing and deliberate: `utils/lobby.ts` exports
// its own `truncateAddress`, and this local version takes configurable
// lead/trail lengths. Two truncators is still one too many; unifying them is a
// separate tidy-up.

export function truncateAddress(address: string | null, lead = 10, trail = 6): string {
  if (!address) return "--";
  if (address.length <= lead + trail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-trail)}`;
}

