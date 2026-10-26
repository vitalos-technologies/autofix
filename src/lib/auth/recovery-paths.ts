// Where a password-recovery link lands after /auth/confirm verifies it.
export const RECOVERY_DESTINATION = "/app/reset-password";

// The Supabase recovery email template (supabase/templates/recovery.html)
// still sends `next=/admin/reset-password` from before the garage admin moved
// to /app (decision A7). Accept that exact value so recovery keeps working,
// and always land on RECOVERY_DESTINATION. Remove once the template is updated.
const LEGACY_RECOVERY_NEXT_PATHS: readonly string[] = ["/admin/reset-password"];

export function isRecoveryNextPath(value: unknown): value is string {
  return typeof value === "string" && (value === RECOVERY_DESTINATION || LEGACY_RECOVERY_NEXT_PATHS.includes(value));
}
