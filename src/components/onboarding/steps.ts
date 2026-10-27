/** The sign-up wizard's numbered steps (P4.4). Steps 1–2 are /signup/garage; 3–6 are /app/onboarding/*. */
export const ONBOARDING_STEPS = ["Your garage", "Booking link", "Security", "Services & MOT", "Agreement", "Your team"] as const;

export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_PATHS = {
  security: "/app/onboarding/security",
  services: "/app/onboarding/services",
  agreement: "/app/onboarding/agreement",
  team: "/app/onboarding/team",
  done: "/app/onboarding/done",
} as const;
