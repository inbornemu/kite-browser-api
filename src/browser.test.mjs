import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runBrowser, publicAddress, destination } from "./browser.mjs";
test("IPv4, IPv6, mapped private and metadata addresses are refused", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("1.1.1.1"), true);
  await assert.rejects(
    destination("https://allowed.example", {
      allowedHosts: ["allowed.example"],
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    { code: "blocked_private_destination" },
  );
  await assert.rejects(
    destination("http://allowed.example", {
      allowedHosts: ["allowed.example"],
    }),
    { code: "target_not_allowlisted" },
  );
});
test("real Chromium observes dynamic content and produces a PNG", async (t) => {
  const s = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      '<title>Price fixture</title><h1>Browser test</h1><p id="price">Loading</p><script>setTimeout(()=>document.querySelector("#price").textContent="$19.25",70)</script>',
    );
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  const origin = "http://127.0.0.1:" + s.address().port;
  const options = { fixtureOrigins: [origin] };
  const result = await runBrowser(
    {
      operation_id: "browser-test",
      url: origin,
      action: "extract",
      selectors: { price: "#price" },
    },
    options,
  );
  assert.equal(result.fields.price, "$19.25");
  assert(result.environment.browser);
  const screenshot = await runBrowser(
    { operation_id: "screen-test", url: origin, action: "screenshot" },
    options,
  );
  assert.equal(
    Buffer.from(screenshot.artifacts[0].data, "base64")
      .subarray(1, 4)
      .toString(),
    "PNG",
  );
  await assert.rejects(
    runBrowser(
      { url: origin, action: "extract", selectors: { missing: "#none" } },
      options,
    ),
    { code: "selector_not_found" },
  );
});
test("redirect and private subrequest escape are rejected", async (t) => {
  const s = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/metadata" });
      res.end();
    } else {
      res.setHeader("content-type", "text/html");
      res.end('<h1>Fixture</h1><img src="http://10.0.0.1/private">');
    }
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  const origin = "http://127.0.0.1:" + s.address().port;
  for (const suffix of ["/redirect", "/"])
    await assert.rejects(
      runBrowser(
        { url: origin + suffix, action: "render" },
        { fixtureOrigins: [origin] },
      ),
      (error) =>
        [
          "redirect_or_second_navigation_blocked",
          "target_not_allowlisted",
          "blocked_private_destination",
        ].includes(error.code),
    );
});
