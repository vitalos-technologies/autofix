"use client";

import type { ReactNode } from "react";

/** Opens the browser's print dialog: the statement page prints without the admin chrome (print:hidden). */
export function PrintButton({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <button type="button" className={className} onClick={() => window.print()}>
      {children}
    </button>
  );
}
