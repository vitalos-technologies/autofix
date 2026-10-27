#!/usr/bin/env node
// Local stand-in for the Askbridge widget script (P4.6), for Playwright and the Lighthouse check.
// Serves GET /widget.js on 127.0.0.1:${ASKBRIDGE_STUB_PORT:-4100}. The script follows the contract in
// docs/autofix/askbridge.md: it reads its <script id="askbridge-widget"> data attributes and draws a
// fixed-position launcher (no layout shift) that opens a small panel linking to the booking flow.
// It makes no network calls. Never deploy it.
import { createServer } from "node:http";

const port = Number(process.env.ASKBRIDGE_STUB_PORT || 4100);

const widget = String.raw`(() => {
  const tag = document.getElementById("askbridge-widget");
  if (!tag || document.getElementById("askbridge-launcher")) return;
  const data = tag.dataset;
  const accent = /^#[0-9a-f]{6}$/i.test(data.accent || "") ? data.accent : "#155fba";
  const root = document.createElement("div");
  root.setAttribute("data-askbridge-stub", data.widgetId || "");
  root.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:50;font-family:system-ui,sans-serif";
  const button = document.createElement("button");
  button.id = "askbridge-launcher";
  button.type = "button";
  button.textContent = "Ask a question";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "askbridge-panel");
  button.style.cssText = "min-height:48px;padding:0 18px;border:0;border-radius:999px;background:#071127;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 6px 20px rgba(7,17,39,.25);cursor:pointer";
  const panel = document.createElement("div");
  panel.id = "askbridge-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat with " + (data.garageName || "the garage"));
  panel.style.cssText = "position:absolute;right:0;bottom:60px;width:min(320px,calc(100vw - 32px));background:#fff;color:#202a36;border:1px solid #e4eaf0;border-radius:16px;padding:16px;box-shadow:0 12px 32px rgba(7,17,39,.2)";
  const text = document.createElement("p");
  text.style.margin = "0 0 12px";
  text.textContent = "Hi! Ask about services, prices or opening hours. (Askbridge stub)";
  const link = document.createElement("a");
  link.href = data.bookingUrl || "/";
  link.textContent = "Book online";
  link.style.cssText = "display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:12px;background:#071127;color:#fff;font-weight:600;text-decoration:none";
  link.style.background = accent;
  panel.append(text, link);
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  });
  root.append(panel, button);
  document.body.append(root);
})();`;

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url?.split("?")[0] === "/widget.js") {
    response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
    response.end(widget);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
});

server.listen(port, "127.0.0.1", () => console.log(`Askbridge widget stub on http://127.0.0.1:${port}/widget.js`));
