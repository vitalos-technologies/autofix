/*
 * Focus rings use Tailwind's important modifier (`!`) on purpose: the SOB base rules at the top of
 * globals.css (`:focus-visible { outline: … }`) are unlayered, so they beat every layered Tailwind
 * utility. Drop the `!` once those rules are gone.
 */

/** Visible keyboard focus for controls on light backgrounds (garage accent ring). */
export const focusRing = "focus-visible:outline-3! focus-visible:outline-offset-2! focus-visible:outline-accent!";

/** Visible keyboard focus for controls on navy backgrounds. */
export const focusRingOnDark = "focus-visible:outline-3! focus-visible:outline-offset-2! focus-visible:outline-white!";

/** Focus ring on a card (label) when the native control inside it has keyboard focus. */
export const focusWithinRing =
  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

/** For a native control whose card shows the focus ring instead. */
export const noOwnFocusRing = "focus-visible:outline-none!";
