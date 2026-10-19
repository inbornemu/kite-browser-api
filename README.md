# Browser API

Bounded rendering, screenshots and extraction for paid Agent requests.

Version 0.1.0 is an AI-assisted engineering evaluation release, developed under one operator and assigned to this GitHub account. It is not evidence of independent human adoption, official Kite approval, Electric Capital inclusion or successful live payment.

## Run and verify

Node.js 20.11+ is required.

```sh
npm ci
npx playwright install chromium
BROWSER_CHANNEL=chromium npm test
# Configure the environment described below, then:
BROWSER_CHANNEL=chromium npm start
```

POST /v1/browser/run accepts action render|screenshot|extract, one allowlisted HTTPS URL, a bounded viewport and up to 20 CSS selectors. The browser executes JavaScript and returns actual observations, Chromium version, UTC environment, network decisions and PNG bytes with SHA-256.

All page requests are fulfilled through DNS-validated, address-pinned Node transport; private/reserved addresses, userinfo, unexpected ports, redirects, WebSockets, POST and extra main-frame navigation fail closed. Allowlist page and asset hosts explicitly through BROWSER_ALLOWED_HOSTS. Browser environments omit application secrets and use a fresh profile. Runs are limited to 20 seconds, 64 requests, 10 MB network and 4 MB screenshot output.

Production deployment should additionally run the worker inside a non-root container with memory/CPU limits and egress policy. This release's tested isolation is a Chromium sandbox plus fresh context; it is not a formally verified untrusted-browser hosting boundary. A target requiring login/CAPTCHA is blocked. Results are encrypted, returned only after confirmed settlement and recoverable through the buyer-authenticated /operations/{id} endpoint.

## Configuration and recovery

Use .env.example as a list of required environment variables; the service does not automatically load it. Generate a fresh 32-byte hex DATA_KEY locally, keep it outside the repository and retain it across restarts. Supply strong operator/application bearer tokens and a real receiver and asset before enabling a service. Values are intentionally blank so example configuration cannot silently charge a wrong wallet. The stored payment state UNKNOWN never means unpaid. Inspect the original receipt/activity and restricted journal; do not change an operation key to buy again. Where a writer lock survives a crash, stop all writer processes and review the journal before removing only the stale lock directory.

## Integration evidence

Read [compatibility.json](compatibility.json) and [the protocol boundary](docs/PROTOCOL.md). Local tests are E1; read-only public capability/RPC observations prove only the facts observed. Real Passport approval, funded purchase, SIWX interoperability, public deployment and catalog/EC review are not completed by this release. The service manifest stays draft and uses placeholder pay_to until a genuine receiver and deployment are configured.

## Scope and evidence

[Original PRD](docs/PRD.md) describes the full target, not a claim that every external acceptance gate has passed. [Event contract](docs/EVENTS.md) defines the application records. The standalone repositories share protocol/storage support code, with distinct business implementations and tests. The license is MIT; third-party dependencies keep their upstream licenses. Reproduce failures without publishing payment signatures, account credentials or private files.
