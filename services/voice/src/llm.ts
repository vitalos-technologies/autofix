import Anthropic from "@anthropic-ai/sdk";

// The reasoning engine behind the desk: one streamed Messages API step at a time (the desk owns the
// loop, so a caller talking over it can stop a reply mid-sentence), and one short structured call at the
// end of the call for the staff summary. Tests pass a scripted engine instead.

export type EngineStep = {
  content: Anthropic.ContentBlock[];
  stopReason: Anthropic.StopReason | null;
};

export interface Engine {
  step(input: { system: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[]; signal: AbortSignal; onText: (text: string) => void }): Promise<EngineStep>;
  summarise(input: { transcript: string; booked: boolean; signal: AbortSignal }): Promise<CallSummary | null>;
}

export const summaryOutcomes = ["booked", "message", "callback", "answered", "spam", "dropped"] as const;
export type SummaryOutcome = (typeof summaryOutcomes)[number];
export type CallSummary = { summary: string; outcome: SummaryOutcome };

/** Replies are a sentence or three; a step that calls tools needs a little more. */
const STEP_MAX_TOKENS = 1024;

const SUMMARY_PROMPT = `You write a note for staff at a UK car garage about a phone call their automated assistant just took.
Write one to three plain sentences: who called (first name if given), what they wanted, what was agreed, and anything the team must do (for example call back). Never include a vehicle registration or a phone number.
Pick the outcome: booked (a booking request was made), callback (the caller wants a call back), message (the caller left a message or will leave a voicemail), answered (questions answered, nothing to do), spam (sales or abuse), dropped (the caller said nothing useful or hung up straight away).`;

export function createAnthropicEngine(input: { apiKey: string; model: string }): Engine {
  const client = new Anthropic({ apiKey: input.apiKey, maxRetries: 1, timeout: 20_000 });
  return {
    async step({ system, messages, tools, signal, onText }) {
      const stream = client.messages.stream(
        {
          model: input.model,
          max_tokens: STEP_MAX_TOKENS,
          // The instructions and tools are the same for every step of the call: cache them.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
          // Speed over depth on a live call.
          output_config: { effort: "low" },
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") onText(event.delta.text);
      }
      const message = await stream.finalMessage();
      return { content: message.content, stopReason: message.stop_reason };
    },

    async summarise({ transcript, booked, signal }) {
      const response = await client.messages.create(
        {
          model: input.model,
          max_tokens: 1024,
          system: SUMMARY_PROMPT,
          messages: [{ role: "user", content: `${booked ? "A booking request was made on this call.\n\n" : ""}Transcript:\n${transcript}` }],
          output_config: {
            effort: "low",
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { summary: { type: "string" }, outcome: { type: "string", enum: [...summaryOutcomes] } },
                required: ["summary", "outcome"],
              },
            },
          },
        },
        { signal },
      );
      if (response.stop_reason === "refusal") return null;
      const text = response.content.find((block): block is Anthropic.TextBlock => block.type === "text")?.text;
      if (!text) return null;
      try {
        const parsed = JSON.parse(text) as { summary?: unknown; outcome?: unknown };
        if (typeof parsed.summary !== "string" || !summaryOutcomes.includes(parsed.outcome as SummaryOutcome)) return null;
        return { summary: parsed.summary, outcome: parsed.outcome as SummaryOutcome };
      } catch {
        return null;
      }
    },
  };
}
