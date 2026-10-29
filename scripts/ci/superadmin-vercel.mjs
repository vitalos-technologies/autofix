// Points the Pitline app's /superadmin proxy at the deployed super admin (DECISIONS D18; src/proxy.ts):
// sets SUPERADMIN_ORIGIN (encrypted) and SUPERADMIN_PROXY_SECRET (sensitive) for Production only, then
// redeploys the current production deployment so it picks them up, and waits for it to be ready.
// Run by .github/workflows/superadmin-deploy.yml. Prints names and states, never a value.
//
// Environment: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID, SUPERADMIN_ORIGIN, SUPERADMIN_PROXY_SECRET.

const clean = (value) => (value ?? "").replace(/^﻿/, "").trim();

function required(name) {
  const value = clean(process.env[name]);
  if (!value) {
    console.error(`superadmin-vercel: ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const token = required("VERCEL_API_TOKEN");
const projectId = required("VERCEL_PROJECT_ID");
const teamId = required("VERCEL_TEAM_ID");
const origin = required("SUPERADMIN_ORIGIN");
const proxySecret = required("SUPERADMIN_PROXY_SECRET");
if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) {
  console.error("superadmin-vercel: SUPERADMIN_ORIGIN must be https://<host> with no path.");
  process.exit(1);
}
if (proxySecret.length < 32) {
  console.error("superadmin-vercel: SUPERADMIN_PROXY_SECRET must be at least 32 characters.");
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
    console.error(`superadmin-vercel: ${init.method ?? "GET"} ${path.split("?")[0]}: HTTP ${response.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""}`.trim());
    process.exit(1);
  }
  return body;
}

const project = encodeURIComponent(projectId);
for (const [key, value, type] of [
  ["SUPERADMIN_ORIGIN", origin, "encrypted"],
  ["SUPERADMIN_PROXY_SECRET", proxySecret, "sensitive"],
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
  console.error("superadmin-vercel: no ready production deployment to redeploy.");
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
    console.error(`superadmin-vercel: the redeploy ended ${state}.`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error("superadmin-vercel: the redeploy was not ready within 25 minutes.");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
console.log("production redeployed with the super admin proxy settings");
