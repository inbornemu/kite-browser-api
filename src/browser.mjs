import { chromium } from "playwright";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import ipaddr from "ipaddr.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fault, hash } from "./store.mjs";
export function publicAddress(address) {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export async function destination(
  raw,
  { allowedHosts = [], fixtureOrigins = [], resolver = lookup } = {},
) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw fault("invalid_target");
  }
  if (
    u.username ||
    u.password ||
    u.hash ||
    !["https:", "http:"].includes(u.protocol)
  )
    throw fault("blocked_target");
  if (fixtureOrigins.includes(u.origin))
    return { url: u, address: "127.0.0.1", family: 4 };
  if (
    u.protocol !== "https:" ||
    (u.port && u.port !== "443") ||
    !allowedHosts.includes(u.hostname)
  )
    throw fault("target_not_allowlisted", 403);
  const addresses = await resolver(u.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw fault("blocked_private_destination", 403);
  return { url: u, ...addresses[0] };
}
export function checkBrowser(input) {
  if (!["render", "screenshot", "extract"].includes(input.action))
    throw fault("invalid_action");
  if (typeof input.url !== "string" || input.url.length > 2000)
    throw fault("invalid_url");
  const v = input.viewport || { width: 1280, height: 720 };
  if (
    !Number.isInteger(v.width) ||
    !Number.isInteger(v.height) ||
    v.width < 320 ||
    v.width > 1920 ||
    v.height < 240 ||
    v.height > 1080
  )
    throw fault("invalid_viewport");
  if (
    input.action === "extract" &&
    (!input.selectors ||
      Array.isArray(input.selectors) ||
      Object.keys(input.selectors).length > 20 ||
      Object.values(input.selectors).some(
        (s) => typeof s !== "string" || s.length > 200,
      ))
  )
    throw fault("invalid_selectors");
  return input;
}
function pinnedFetch(target, headers, { maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const client =
      target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = client(
      target.url,
      {
        method: "GET",
        headers,
        lookup: (host, options, callback) =>
          callback(null, target.address, target.family),
        timeout: 10000,
      },
      (res) => {
        const data = [];
        let n = 0;
        res.on("data", (b) => {
          n += b.length;
          if (n > maxBytes) req.destroy(fault("resource_limit", 422));
          else data.push(b);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(data),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(fault("navigation_timeout", 422)));
    req.on("error", reject);
    req.end();
  });
}
export async function runBrowser(input, options = {}) {
  checkBrowser(input);
  const policy = {
    allowedHosts: options.allowedHosts || [],
    fixtureOrigins: options.fixtureOrigins || [],
  };
  await destination(input.url, policy);
  const home = mkdtempSync(join(tmpdir(), "kite-browser-home-"));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        "--js-flags=--max-old-space-size=128",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
      ...(options.executablePath
        ? { executablePath: options.executablePath }
        : {
            channel: options.channel || process.env.BROWSER_CHANNEL || "chrome",
          }),
    });
  } catch (e) {
    rmSync(home, { recursive: true, force: true });
    throw e;
  }
  const started = Date.now(),
    decisions = [];
  let requests = 0,
    bytes = 0,
    navigations = 0,
    violation = null;
  const timeout = setTimeout(() => browser.close().catch(() => {}), 20000);
  try {
    const context = await browser.newContext({
      viewport: input.viewport || { width: 1280, height: 720 },
      timezoneId: "UTC",
      locale: "en-US",
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
      ignoreHTTPSErrors: false,
    });
    await context.routeWebSocket("**/*", (ws) => {
      violation = "websocket_not_allowed";
      ws.close();
    });
    await context.addInitScript(() => {
      for (const name of [
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
        "WebTransport",
      ])
        Object.defineProperty(globalThis, name, {
          value: undefined,
          configurable: false,
        });
    });
    await context.route("**/*", async (route) => {
      const r = route.request();
      try {
        if (
          ++requests > 64 ||
          r.method() !== "GET" ||
          Date.now() - started > 15000
        )
          throw fault("resource_limit");
        if (
          r.isNavigationRequest() &&
          r.frame() === r.frame().page().mainFrame() &&
          ++navigations > 1
        )
          throw fault("redirect_or_second_navigation_blocked");
        const target = await destination(r.url(), policy);
        decisions.push({
          host: target.url.host,
          decision: "allowed",
          address_family: target.family,
        });
        const upstream = await pinnedFetch(target, {
          "user-agent": "KiteBrowserEvaluation/0.1",
          accept: r.headers().accept || "*/*",
          "accept-encoding": "identity",
        });
        // Reject before handing a Location header to Chromium. Browser-level
        // private-network prompts can otherwise hide the redirected request
        // from route interception and turn a policy rejection into a timeout.
        if (upstream.status >= 300 && upstream.status < 400)
          throw fault("redirect_or_second_navigation_blocked");
        bytes += upstream.body.length;
        if (bytes > 10 * 1024 * 1024) throw fault("resource_limit");
        const safe = Object.fromEntries(
          Object.entries(upstream.headers).filter(
            ([k, v]) =>
              ![
                "set-cookie",
                "connection",
                "transfer-encoding",
                "content-length",
                "content-encoding",
              ].includes(k) && typeof v === "string",
          ),
        );
        await route.fulfill({
          status: upstream.status,
          headers: safe,
          body: upstream.body,
        });
      } catch (e) {
        violation = e.code || "network_request_failed";
        decisions.push({ decision: "blocked", reason: violation });
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.on("dialog", (d) => d.dismiss());
    let navigation;
    try {
      navigation = await page.goto(input.url, {
        waitUntil: "networkidle",
        timeout: 15000,
      });
    } catch {
      throw fault(violation || "navigation_error", 422);
    }
    if (!navigation || !navigation.ok() || violation)
      throw fault(violation || "target_http_error", 422);
    const text = (await page.locator("body").innerText()).slice(0, 50000);
    if (
      /verify you are human|captcha|access denied|sign in to continue/i.test(
        text,
      )
    )
      throw fault("target_requires_interaction", 422);
    const fields = {};
    if (input.action === "extract")
      for (const [name, selector] of Object.entries(input.selectors)) {
        const loc = page.locator(selector);
        if (!(await loc.count())) throw fault("selector_not_found", 422);
        fields[name] = (await loc.first().innerText()).slice(0, 10000);
      }
    const artifacts = [];
    if (["screenshot", "render"].includes(input.action)) {
      const b = await page.screenshot({ type: "png", fullPage: false });
      if (b.length > 4 * 1024 * 1024) throw fault("screenshot_over_limit", 422);
      artifacts.push({
        kind: "screenshot",
        mime_type: "image/png",
        sha256: hash(b),
        encoding: "base64",
        data: b.toString("base64"),
      });
    }
    return {
      run_id: input.operation_id,
      status: "completed",
      final_url: page.url(),
      environment: {
        browser: browser.version(),
        viewport: input.viewport || { width: 1280, height: 720 },
        timezone: "UTC",
        locale: "en-US",
      },
      fields,
      text: input.action === "render" ? text : undefined,
      artifacts,
      observed_at: new Date().toISOString(),
      resources: { requests, bytes },
      network_decisions: decisions,
    };
  } finally {
    clearTimeout(timeout);
    await browser.close();
    rmSync(home, { recursive: true, force: true });
  }
}
