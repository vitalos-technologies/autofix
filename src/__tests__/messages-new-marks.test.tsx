// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NewMark, ThreadNewMarks } from "@/app/app/(protected)/messages/[customerId]/new-marks";

function Thread({ unreadKeys }: { unreadKeys: string[] }) {
  return (
    <ThreadNewMarks unreadKeys={unreadKeys}>
      <ol>
        {["m1", "m2", "m3"].map((key) => (
          <li key={key} data-testid={key}>
            {key}
            <NewMark itemKey={key} />
          </li>
        ))}
      </ol>
    </ThreadNewMarks>
  );
}

const marked = () => ["m1", "m2", "m3"].filter((key) => within(screen.getByTestId(key)).queryByText("New"));

describe("thread New marks", () => {
  it("marks the messages that were unread when the thread opened", () => {
    render(<Thread unreadKeys={["m2"]} />);
    expect(marked()).toEqual(["m2"]);
  });

  it("keeps them through the refresh that marking the thread read causes (admin.spec.ts:485 race)", () => {
    const { rerender } = render(<Thread unreadKeys={["m2"]} />);
    // markThreadReadAction's revalidatePath re-renders the page: the same message now comes back read.
    rerender(<Thread unreadKeys={[]} />);
    expect(marked()).toEqual(["m2"]);
  });

  it("adds a message that arrives unread later in the visit", () => {
    const { rerender } = render(<Thread unreadKeys={["m1"]} />);
    rerender(<Thread unreadKeys={[]} />);
    rerender(<Thread unreadKeys={["m3"]} />);
    expect(marked()).toEqual(["m1", "m3"]);
  });

  it("starts again on the next visit", () => {
    const { unmount } = render(<Thread unreadKeys={["m1"]} />);
    unmount();
    render(<Thread unreadKeys={[]} />);
    expect(marked()).toEqual([]);
  });
});
