import { Vault, fault, hash, audit } from "./store.mjs";
import { Seller } from "./seller.mjs";
import { auth, body, json, serve } from "./http.mjs";
import { readFileSync } from "node:fs";
export function service({
  path,
  precheck,
  execute,
  extraRoute,
  prepare,
  complete,
  afterSettlement,
  port = 4407,
}) {
  const vault = new Vault(
    process.env.DATA_DIR || ".data",
    process.env.DATA_KEY,
  );
  const seller = new Seller({
    vault,
    origin: process.env.PUBLIC_ORIGIN,
    network: process.env.KITE_NETWORK,
    asset: process.env.ASSET,
    payTo: process.env.PAY_TO,
    price: process.env.PRICE_USD || "0.01",
    decimals: Number(process.env.ASSET_DECIMALS || 6),
    facilitator: process.env.FACILITATOR_URL,
    extra: JSON.parse(process.env.ASSET_EXTRA_JSON || "{}"),
    rpc: process.env.KITE_RPC_URL,
  });
  const state = vault.read(),
    initial = {
      price_usd: process.env.PRICE_USD || "0.01",
      paused: false,
      manifest_hash: null,
    };
  const operatorToken = process.env.OPERATOR_TOKEN;
  if (!operatorToken) throw Error("OPERATOR_TOKEN required");
  const context = { vault, seller };
  const handler = async (req, res) => {
    const url = new URL(req.url, process.env.PUBLIC_ORIGIN);
    const pathname = url.pathname;
    if (pathname === "/healthz" && req.method === "GET")
      return json(res, 200, { status: "ok", live_payment_verified: false });
    if (pathname === "/" && req.method === "GET") {
      res.setHeader("content-type", "text/html");
      try {
        return res.end(
          readFileSync(new URL("../public/index.html", import.meta.url)),
        );
      } catch {
        return res.end(
          "<h1>Kite service</h1><p>See repository README for API contract.</p>",
        );
      }
    }
    if (pathname === "/admin/config") {
      auth(req, operatorToken);
      if (req.method === "GET") {
        const c = vault.read().config || { revision: 0, config: initial };
        return json(res, 200, c);
      }
      if (req.method === "POST") {
        const i = await body(req);
        return json(
          res,
          200,
          await vault.transaction((s, save) => {
            const c = s.config || { revision: 0, config: initial };
            if (i.expected_revision !== c.revision)
              throw fault("revision_conflict", 409);
            const allowed = ["price_usd", "paused", "manifest_hash"];
            if (
              !i.config ||
              Object.keys(i.config).some((k) => !allowed.includes(k)) ||
              typeof i.config.paused !== "boolean" ||
              !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(i.config.price_usd)
            )
              throw fault("invalid_config");
            s.config = { revision: c.revision + 1, config: i.config };
            audit(s, "config_applied", { revision: s.config.revision });
            save();
            return s.config;
          }),
        );
      }
    }
    const recovery = pathname.match(/^\/operations\/([A-Za-z0-9_-]+)$/);
    if (recovery && req.method === "GET") {
      const identity = await seller.identity(
        pathname,
        req.headers["sign-in-with-x"],
      );
      if (!identity.payer)
        return json(res, identity.status, identity.body, identity.headers);
      return json(res, 200, await seller.recover(recovery[1], identity.payer));
    }
    if (extraRoute && (await extraRoute(req, res, pathname, context))) return;
    if (pathname === path && req.method === "POST") {
      const input = await body(req, 12 * 1024 * 1024);
      if (precheck) await precheck(input, req, context);
      const config = vault.read().config?.config || initial;
      if (config.paused) throw fault("service_paused", 503);
      const current = new Seller({
        ...seller,
        vault,
        origin: seller.origin,
        network: seller.network,
        asset: seller.terms.asset,
        payTo: seller.terms.payTo,
        price: config.price_usd,
        decimals: Number(process.env.ASSET_DECIMALS || 6),
        facilitator: seller.facilitator,
        extra: seller.terms.extra,
        rpc: seller.rpc,
      });
      const result = await current.purchase({
        path,
        input,
        header: req.headers["payment-signature"],
        prepare: prepare
          ? (args) => prepare({ ...args, req, ...context })
          : async (args) => execute({ ...args, req, ...context }),
        complete,
        afterSettlement,
      });
      return json(res, result.status, result.body, result.headers);
    }
    throw fault("not_found", 404);
  };
  return {
    vault,
    seller,
    handler,
    start: () => serve(handler, Number(process.env.PORT || port)),
  };
}
