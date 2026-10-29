/** Visible keyboard focus on light backgrounds: Pitline orange, the garage accent on booking sites (`--focus-ring`). */
export const focusRing = "focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Visible keyboard focus for controls on navy backgrounds (Signal Orange, 5.6:1 on navy). */
export const focusRingOnDark = "focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-on-dark";

/** Focus ring on a card (label) when the native control inside it has keyboard focus. */
export const focusWithinRing =
  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";

/** For a native control whose card shows the focus ring instead. */
export const noOwnFocusRing = "focus-visible:outline-none";
