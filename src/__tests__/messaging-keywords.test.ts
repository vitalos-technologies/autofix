import { describe, expect, it } from "vitest";
import { classifyInbound, HELP_KEYWORDS, OPT_IN_KEYWORDS, OPT_OUT_KEYWORDS } from "@/lib/messaging/keywords";

describe("classifyInbound", () => {
  it.each(OPT_OUT_KEYWORDS.flatMap((keyword) => [keyword, keyword.toLowerCase(), `  ${keyword[0]}${keyword.slice(1).toLowerCase()}  \n`]))(
    "treats %j as an opt-out",
    (body) => {
      expect(classifyInbound(body)).toBe("stop");
    },
  );

  it.each(["Stop.", "STOP!", "stop all", "Opt out", "opt-out", "S T O P", "Stop sending me these", "unsubscribe me please", "ＳＴＯＰ", "STOP 🛑"])(
    "treats %j as an opt-out",
    (body) => {
      expect(classifyInbound(body)).toBe("stop");
    },
  );

  it.each(["Cancel my booking please", "End of the week works", "Quit asking, I'll call", "Can't stop by today", "Nonstop"])(
    "does not treat the ordinary reply %j as an opt-out",
    (body) => {
      expect(classifyInbound(body)).toBe("other");
    },
  );

  it.each([...OPT_IN_KEYWORDS, "start", " Yes ", "yes!", "Unstop"])("treats %j as an opt-in", (body) => {
    expect(classifyInbound(body)).toBe("start");
  });

  it.each([...HELP_KEYWORDS, "help", "Info?"])("treats %j as a help request", (body) => {
    expect(classifyInbound(body)).toBe("help");
  });

  it.each(["", "   ", "Yes please book me in", "Thanks!", "What time is it ready?", null, undefined])("treats %j as other", (body) => {
    expect(classifyInbound(body)).toBe("other");
  });

  it("lets Twilio's OptOutType win over the body", () => {
    expect(classifyInbound("Thanks", { optOutType: "STOP" })).toBe("stop");
    expect(classifyInbound("STOP", { optOutType: "start" })).toBe("start");
    expect(classifyInbound("hello", { optOutType: "HELP" })).toBe("help");
    expect(classifyInbound("STOP", { optOutType: "" })).toBe("stop");
  });
});
