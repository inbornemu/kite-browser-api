import { service } from "./service.mjs";
import { checkBrowser, destination, runBrowser } from "./browser.mjs";
const allowedHosts = (process.env.BROWSER_ALLOWED_HOSTS || "")
  .split(",")
  .filter(Boolean);
if (!allowedHosts.length) throw Error("BROWSER_ALLOWED_HOSTS required");
service({
  path: "/v1/browser/run",
  port: 4408,
  precheck: async (input) => {
    checkBrowser(input);
    await destination(input.url, { allowedHosts });
  },
  execute: ({ input }) => runBrowser(input, { allowedHosts }),
}).start();
