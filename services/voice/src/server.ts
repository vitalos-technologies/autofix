import { createAutofixClient } from "./autofix.js";
import { createVoiceApp } from "./app.js";
import { loadConfig, ready } from "./config.js";
import { createAnthropicEngine, type Engine } from "./llm.js";
import { log } from "./log.js";

// autofix-voice entry point (Azure Container App, scale to zero; services/voice/README.md).

const config = loadConfig();

const missingKey: Engine = {
  step: async () => {
    throw new Error("ANTHROPIC_API_KEY is not set");
  },
  summarise: async () => null,
};

const app = createVoiceApp(config, {
  autofix: createAutofixClient({ baseUrl: config.autofixBaseUrl, serviceKey: config.relaySecret ?? "" }),
  engine: config.anthropicApiKey ? createAnthropicEngine({ apiKey: config.anthropicApiKey, model: config.model }) : missingKey,
  log,
});

app.server.listen(config.port, () => {
  log.info("listening", { port: config.port, ready: ready(config), model: config.model, twilio_signature_check: Boolean(config.twilioAuthToken) });
});

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  log.info("stopping", { active_calls: app.activeCalls() });
  app.server.close();
  // Let live calls finish (Container Apps waits up to the termination grace period), then wrap up the rest.
  void app.drain(25_000).finally(() => process.exit(0));
});
