"use client";

import { useEffect, useRef } from "react";
import { markThreadReadAction } from "../actions";

/**
 * Marks the conversation's unread messages read once the thread is actually on screen (never on
 * a prefetch). The "New" marks stay until the next visit (ThreadNewMarks keeps them through the refresh this
 * action's revalidatePath causes), so staff can see what was new.
 */
export function MarkThreadRead({ customerId, unread }: { customerId: string; unread: number }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || unread === 0) return;
    done.current = true;
    void markThreadReadAction(customerId);
  }, [customerId, unread]);
  return null;
}
