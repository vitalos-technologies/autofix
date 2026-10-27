// The consent declaration a garage ticks before importing customers
// (docs/autofix/legal/consent-and-messaging-wording.md, draft v0.1). The exact
// text, with the garage's name, is stored on the import and as each consenting
// customer's consent_text.

export const IMPORT_DECLARATION_VERSION = "v0.1";

export function importDeclaration(garageName: string) {
  const name = garageName.trim() || "the garage";
  return `I confirm these customers gave their details to ${name} when buying or booking a service, were told they could opt out of reminders, and have not opted out, or have given consent to receive reminders.`;
}
