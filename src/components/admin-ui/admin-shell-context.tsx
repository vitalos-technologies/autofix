"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AdminLink, AdminUser, FormAction } from "./types";

/** What the shell shares with `PageHeader`, which shows search and the account menu on phones. */
export type AdminShellChrome = {
  user: AdminUser;
  signOutAction?: FormAction;
  accountLinks?: AdminLink[];
  notificationsHref?: string;
  unreadCount?: number;
  bookingPageUrl?: string | null;
  searchAction?: FormAction;
  searchPlaceholder?: string;
};

const AdminShellContext = createContext<AdminShellChrome | null>(null);

export function AdminShellProvider({ value, children }: { value: AdminShellChrome; children: ReactNode }) {
  return <AdminShellContext value={value}>{children}</AdminShellContext>;
}

/** The surrounding shell's chrome, or `null` outside `AdminShell`. */
export function useAdminShell(): AdminShellChrome | null {
  return useContext(AdminShellContext);
}
