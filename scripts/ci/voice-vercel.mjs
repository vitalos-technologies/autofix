// Connects the Pitline app to the deployed voice service (services/voice, the AI front desk on calls):
// sets VOICE_RELAY_URL (encrypted) and VOICE_RELAY_SECRET (sensitive) for Production only, then redeploys
// the current production deployment so the voice webhook picks them up, and waits for it to be ready.
// Run by .github/workflows/voice-deploy.yml once the service has a Claude key. Prints names and states,
// never a value.
//
// Environment: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID, VOICE_RELAY_URL, VOICE_RELAY_SECRET.

const clean = (value) => (value ?? "").replace(/^﻿/, "").trim();

function required(name) {
  const value = clean(process.env[name]);
  if (!value) {
    console.error(`voice-vercel: ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const token = required("VERCEL_API_TOKEN");
const projectId = required("VERCEL_PROJECT_ID");
const teamId = required("VERCEL_TEAM_ID");
const relayUrl = required("VOICE_RELAY_URL");
const relaySecret = required("VOICE_RELAY_SECRET");
if (!/^wss:\/\/[a-z0-9.-]+\/relay$/.test(relayUrl)) {
  console.error("voice-vercel: VOICE_RELAY_URL must be wss://<host>/relay.");
  process.exit(1);
}
if (relaySecret.length < 32) {
  console.error("voice-vercel: VOICE_RELAY_SECRET must be at least 32 characters.");
  process.exit(1);
}

const team = `teamId=${encodeURIComponent(teamId)}`;
async function vercel(path, init = {}) {
  const response = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}${team}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`voice-vercel: ${init.method ?? "GET"} ${path.split("?")[0]}: HTTP ${response.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""}`.trim());
    process.exit(1);
  }
  return body;
}

const project = encodeURIComponent(projectId);
for (const [key, value, type] of [
  ["VOICE_RELAY_URL", relayUrl, "encrypted"],
  ["VOICE_RELAY_SECRET", relaySecret, "sensitive"],
]) {
  await vercel(`/v10/projects/${project}/env?upsert=true`, {
    method: "POST",
    body: JSON.stringify({ key, value, type, target: ["production"] }),
  });
  console.log(`set ${key} (${type}) for production`);
}

const { deployments = [] } = await vercel(`/v6/deployments?projectId=${project}&target=production&state=READY&limit=1`);
const current = deployments[0];
if (!current) {
  console.error("voice-vercel: no ready production deployment to redeploy.");
  process.exit(1);
}
const redeploy = await vercel(`/v13/deployments`, {
  method: "POST",
  body: JSON.stringify({ name: current.name, deploymentId: current.uid, target: "production" }),
});
console.log(`redeploying production (${current.uid} -> ${redeploy.id})`);

const deadline = Date.now() + 25 * 60 * 1000;
for (;;) {
  const state = (await vercel(`/v13/deployments/${encodeURIComponent(redeploy.id)}`)).readyState;
  if (state === "READY") break;
  if (state === "ERROR" || state === "CANCELED") {
    console.error(`voice-vercel: the redeploy ended ${state}.`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error("voice-vercel: the redeploy was not ready within 25 minutes.");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
console.log("production redeployed with the voice service settings");
