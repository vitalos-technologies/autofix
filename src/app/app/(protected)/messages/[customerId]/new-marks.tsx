"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Badge } from "@/components/admin-ui";

const NewMarksContext = createContext<ReadonlySet<string>>(new Set());

/**
 * The thread's "New" marks for this visit. MarkThreadRead marks the messages read as soon as the thread is on
 * screen, and its revalidatePath re-renders this page with them read; the marks are kept here (client state
 * survives that refresh), so the messages that were new when the thread opened stay marked until the next
 * visit. Messages that arrive unread later in the visit join them.
 */
export function ThreadNewMarks({ unreadKeys, children }: { unreadKeys: readonly string[]; children: ReactNode }) {
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => new Set(unreadKeys));
  // Adjusted during render (not in an effect) so a newly unread message is marked in the same paint.
  if (unreadKeys.some((key) => !marks.has(key))) setMarks(new Set([...marks, ...unreadKeys]));
  return <NewMarksContext.Provider value={marks}>{children}</NewMarksContext.Provider>;
}

export function NewMark({ itemKey }: { itemKey: string }) {
  const marks = useContext(NewMarksContext);
  return marks.has(itemKey) ? (
    <Badge tone="accent" size="xs" className="font-bold">
      New
    </Badge>
  ) : null;
}
