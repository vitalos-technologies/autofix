"use client";

import { useEffect, type RefObject } from "react";

/**
 * Menus built on `<details>` open and close without JavaScript. Once it loads, this closes the menu
 * on Escape (focus goes back to the `<summary>`) and on a press outside it.
 */
export function useDetailsDismiss(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const details = ref.current;
    if (!details) return;

    function close(returnFocus: boolean) {
      if (!details?.open) return;
      details.open = false;
      if (returnFocus) details.querySelector("summary")?.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && details?.open) {
        event.stopPropagation();
        close(true);
      }
    }

    function onPointerDown(event: PointerEvent) {
      if (details && event.target instanceof Node && !details.contains(event.target)) close(false);
    }

    details.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      details.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [ref]);
}
