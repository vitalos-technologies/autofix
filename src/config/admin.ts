// The garage admin lives at /app on the admin host (decision A7). /admin is
// reserved for the Vitalos super admin (P4.5) and must not match here.
// Access is garage membership (`garage_members`), not an email allowlist.
export const GARAGE_ADMIN_BASE_PATH = "/app";

export function isGarageAdminPath(pathname: string) {
  return pathname === GARAGE_ADMIN_BASE_PATH || pathname.startsWith(`${GARAGE_ADMIN_BASE_PATH}/`);
}
