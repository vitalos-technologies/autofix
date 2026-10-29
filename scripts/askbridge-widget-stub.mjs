#!/usr/bin/env node
// Local stand-in for Askbridge (P4.6), for Playwright and the Lighthouse check. Serves on
// 127.0.0.1:${ASKBRIDGE_STUB_PORT:-4100}, with the same shape as the real thing (docs/autofix/askbridge.md):
//   GET /widget/v1/askbridge.js        the loader: reads data-site from its <script> tag, fetches the config
//                                      from its own origin and draws a fixed-position launcher in a shadow root
//   GET /api/v1/visitor/config?site=   the public widget config (any well-formed pk_ key)
// Build with NEXT_PUBLIC_ASKBRIDGE_WIDGET_URL=http://127.0.0.1:4100/widget/v1/askbridge.js. No other network
// calls. Never deploy it.
import { createServer } from "node:http";

const port = Number(process.env.ASKBRIDGE_STUB_PORT || 4100);
const SITE_KEY = /^pk_[0-9a-f]{32}$/;

const loader = String.raw`(() => {
  if (window.Askbridge) return;
  const script = document.currentScript || document.querySelector('script[data-site][src*="askbridge"]');
  const site = script && script.getAttribute("data-site");
  if (!script || !site) return console.warn("Askbridge: the script tag needs a data-site attribute.");
  const api = (script.getAttribute("data-api") || new URL(script.src, location.href).origin).replace(/\/+$/, "");
  window.Askbridge = { open() {}, close() {}, toggle() {}, identify() {} };
  fetch(api + "/api/v1/visitor/config?site=" + encodeURIComponent(site), { headers: { "x-askbridge-site": site }, credentials: "omit", cache: "no-store" })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("config " + res.status))))
    .then((config) => {
      const host = document.createElement("div");
      host.setAttribute("data-askbridge", "");
      host.style.cssText = "all:initial;display:block;position:static;width:0;height:0";
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ".l{position:fixed;right:20px;bottom:20px;z-index:2147483000;min-height:56px;padding:0 20px;border:0;border-radius:999px;background:#071127;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer}" +
        ".p{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:min(320px,calc(100vw - 40px));background:#fff;color:#202a36;border:1px solid #e4eaf0;border-radius:16px;padding:16px;font:14px/20px system-ui,sans-serif}";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = config.theme.launcherLabel;
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", "askbridge-panel");
      button.setAttribute("aria-expanded", "false");
      const panel = document.createElement("div");
      panel.className = "p";
      panel.id = "askbridge-panel";
      panel.hidden = true;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", config.name);
      panel.textContent = config.greeting + " (Askbridge stub)";
      button.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
      });
      root.append(style, panel, button);
      document.body.appendChild(host);
    })
    .catch((error) => console.warn("Askbridge: the widget is unavailable (" + error.message + ")."));
})();`;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-askbridge-site",
  "access-control-allow-methods": "GET, POST, DELETE",
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors);
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/widget/v1/askbridge.js") {
    response.writeHead(200, { ...cors, "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" });
    response.end(loader);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/visitor/config") {
    const site = url.searchParams.get("site") ?? "";
    if (!SITE_KEY.test(site)) {
      response.writeHead(404, { ...cors, "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "site_not_found" } }));
      return;
    }
    response.writeHead(200, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ name: "Garage chat", greeting: "Hi. Ask about services, prices or opening hours.", theme: { launcherLabel: "Ask a question" } }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
});

server.listen(port, "127.0.0.1", () => console.log(`Askbridge stub on http://127.0.0.1:${port}/widget/v1/askbridge.js`));
