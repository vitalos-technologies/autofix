import "server-only";

import { platformEmailBrand, PLATFORM_NAME } from "@/lib/email/brand";
import { emailLayout, notice, plainTextFooter, plainTextHeader, type RenderedEmail } from "./components";

// Account mail is platform mail: garage staff sign in to Autofix, not to a garage.

export function renderPasswordReset(input: { actionUrl: string }): RenderedEmail {
  const brand = platformEmailBrand();
  return {
    html: emailLayout({
      brand,
      preheader: `Use this secure link to reset your ${PLATFORM_NAME} password.`,
      status: "PASSWORD RESET",
      tone: "warning",
      title: `Reset your ${PLATFORM_NAME} password`,
      intro: `We received a request to reset the password for your ${PLATFORM_NAME} account.`,
      contentHtml: notice("Only you should use this link", "This secure link is intended only for the account holder. If you did not request this reset, you can ignore this email.", brand),
      cta: { label: "Reset password", url: input.actionUrl },
    }),
    text: [plainTextHeader(brand), "", "PASSWORD RESET", "", `Reset your ${PLATFORM_NAME} password`, "", `We received a request to reset the password for your ${PLATFORM_NAME} account.`, "", `Reset password: ${input.actionUrl}`, "", "This link is intended only for the account holder. If you did not request this reset, you can ignore this email.", plainTextFooter(brand)].join("\n"),
  };
}

export function renderPasswordChanged(): RenderedEmail {
  const brand = platformEmailBrand();
  return {
    html: emailLayout({
      brand,
      preheader: `Your ${PLATFORM_NAME} password was changed successfully.`,
      status: "SECURITY NOTICE",
      tone: "success",
      title: "Password updated",
      intro: `Your ${PLATFORM_NAME} password was changed successfully.`,
      contentHtml: notice("No action is needed if this was you", "If you did not make this change, contact your garage owner or Autofix support immediately.", brand),
    }),
    text: [plainTextHeader(brand), "", "PASSWORD UPDATED", "", `Your ${PLATFORM_NAME} password was changed successfully.`, "", "If you made this change, no further action is required.", "If you did not make this change, contact your garage owner or Autofix support immediately.", plainTextFooter(brand)].join("\n"),
  };
}
