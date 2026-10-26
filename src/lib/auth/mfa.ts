import { GARAGE_ADMIN_BASE_PATH, isGarageAdminPath } from "@/config/admin";

export function safeAdminReturnTo(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return GARAGE_ADMIN_BASE_PATH;
  try {
    const parsed = new URL(value, "http://localhost");
    if (parsed.origin !== "http://localhost" || !isGarageAdminPath(parsed.pathname) || parsed.pathname === "/app/mfa") return GARAGE_ADMIN_BASE_PATH;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return GARAGE_ADMIN_BASE_PATH;
  }
}

export function isSixDigitMfaCode(value: string) {
  return /^\d{6}$/.test(value.trim());
}

export function createMfaReplacementFriendlyName(nonce = crypto.randomUUID()) {
  return `SOB Autofix Admin Replacement ${nonce.slice(0, 8)}`;
}

export function requiresMfaChallenge(assurance: { currentLevel: string | null; nextLevel: string | null }) {
  return assurance.currentLevel === "aal1" && assurance.nextLevel === "aal2";
}

export function canChangeAdminPassword(assurance: {
  currentLevel: string | null;
  currentAuthenticationMethods?: Array<string | { method: string }>;
}) {
  return assurance.currentLevel === "aal2"
    || assurance.currentAuthenticationMethods?.some((entry) =>
      (typeof entry === "string" ? entry : entry.method) === "recovery") === true;
}
