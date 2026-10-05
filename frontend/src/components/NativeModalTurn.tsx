// frontend/src/components/NativeModalTurn.tsx
//
/* ==================================================================
    W3-A (AUD-13.07, OD-5(c)): A DIALOG THAT OPENS ITSELF WAITS FOR THE SCREEN
   ==================================================================
   RULED (OD-5(c)): "Do not let two native dialogs/modal notices appear simultaneously." The forced notices take
   turns through the notice chain (`useNoticeChain`). This is the same rule for the other dialogs that open
   THEMSELVES rather than from the player's click -- Game Over when the game ends, the B&O par prompt for its
   actor, a private power's standing-obligation flow -- which could otherwise arrive over a dialog the player had
   already opened (the market peek, Auto-Pass, a licence).

   WAIT, THEN CLAIM, THEN KEEP. While any native dialog is open this renders nothing. The first moment none is,
   it CLAIMS the screen in the registry, in a layout effect -- so a second waiter, or a notice deciding in the same
   commit, sees the claim and yields -- and renders its dialog. Once granted it stays granted until it unmounts:
   a dialog on screen is never withdrawn from under the player, which is also what makes two waiters unable to
   oscillate.

   A DIALOG OPENED BY A CLICK NEEDS NONE OF THIS: every background control is inert under an open dialog, so
   nothing can be clicked open over one. */

import React, { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { openNativeModalCount, registerNativeModal, subscribeNativeModals } from "../utils/nativeModalRegistry";

export function NativeModalTurn({ children }: { children: React.ReactNode }) {
  const [granted, setGranted] = useState(false);
  const releaseRef = useRef<(() => void) | null>(null);
  const openCount = useSyncExternalStore(subscribeNativeModals, openNativeModalCount, () => 0);

  useLayoutEffect(() => {
    if (granted) return;
    if (openNativeModalCount() > 0) return;
    releaseRef.current = registerNativeModal(false);
    setGranted(true);
  }, [granted, openCount]);

  useLayoutEffect(
    () => () => {
      releaseRef.current?.();
      releaseRef.current = null;
    },
    [],
  );

  return granted ? <>{children}</> : null;
}

export default NativeModalTurn;
