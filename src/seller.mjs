import { randomBytes } from "node:crypto";
import {
  buildSIWxSchema,
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
} from "@x402/extensions/sign-in-with-x";
import { createPublicClient, http } from "viem";
import { fault, hash, canonical, audit } from "./store.mjs";
export const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
export function amountUnits(price, decimals) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(price)
  )
    throw fault("invalid_price");
  const [i, f = ""] = price.split(".");
  if (f.length > decimals) throw fault("price_precision");
  return (
    BigInt(i) * 10n ** BigInt(decimals) +
    BigInt(f.padEnd(decimals, "0") || "0")
  ).toString();
}
export class Seller {
  constructor({
    vault,
    origin,
    network,
    asset,
    payTo,
    price = "0.01",
    decimals = 6,
    facilitator,
    fetcher = fetch,
    extra = {},
    rpc,
  }) {
    const u = new URL(origin);
    if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
      throw fault("invalid_origin");
    if (
      !["eip155:2366", "eip155:2368"].includes(network) ||
      !/^0x[\da-f]{40}$/i.test(asset) ||
      !/^0x[\da-f]{40}$/i.test(payTo) ||
      /^0x0{40}$/i.test(payTo)
    )
      throw fault("invalid_payment_config", 503);
    if (!/^https:\/\//.test(facilitator))
      throw fault("facilitator_https_required", 503);
    Object.assign(this, {
      vault,
      origin: u.origin,
      network,
      fetcher,
      facilitator: facilitator.replace(/\/$/, ""),
      rpc,
    });
    this.terms = {
      scheme: "exact",
      network,
      asset,
      payTo,
      amount: amountUnits(price, decimals),
      maxTimeoutSeconds: 120,
      extra,
    };
  }
  challenge(path, extensions = {}) {
    return {
      x402Version: 2,
      resource: {
        url: new URL(path, this.origin).href,
        description:
          "Fixed bounded operation; recovery is free and authenticated",
        mimeType: "application/json",
      },
      accepts: [this.terms],
      ...(Object.keys(extensions).length ? { extensions } : {}),
    };
  }
  async remote(kind, payload) {
    const response = await this.fetcher(this.facilitator + "/" + kind, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok) throw fault("facilitator_" + kind + "_http", 502);
    return response.json();
  }
  async purchase({
    path,
    input,
    header,
    prepare,
    complete = async (x) => x,
    afterSettlement = async () => {},
  }) {
    if (!/^[a-zA-Z0-9_-]{4,100}$/.test(input.operation_id || ""))
      throw fault("operation_id_required");
    if (!header)
      return {
        status: 402,
        body: this.challenge(path),
        headers: { "payment-required": encode(this.challenge(path)) },
      };
    let payment;
    try {
      if (header.length > 20000) throw Error();
      payment = JSON.parse(Buffer.from(header, "base64").toString());
    } catch {
      throw fault("invalid_payment_header");
    }
    if (
      payment.x402Version !== 2 ||
      canonical(payment.accepted) !== canonical(this.terms) ||
      payment.resource?.url !== new URL(path, this.origin).href
    )
      throw fault("payment_terms_mismatch", 402);
    const requestHash = hash(input),
      proofHash = hash(payment),
      wire = {
        x402Version: 2,
        paymentPayload: payment,
        paymentRequirements: this.terms,
      };
    return this.vault.transaction(async (state, save) => {
      state.payments ??= {};
      state.proofs ??= {};
      const key = input.operation_id,
        old = state.payments[key];
      if (old) {
        if (old.request_hash !== requestHash)
          throw fault("operation_conflict", 409);
        return {
          status: 409,
          body: {
            error: "recover_original_operation",
            payment_state: old.payment_state,
            recoveryUrl: "/operations/" + encodeURIComponent(key),
          },
        };
      }
      if (state.proofs[proofHash]) throw fault("payment_replay", 409);
      // Persist before external calls: a crash leaves UNKNOWN and cannot cause an automatic second settle.
      const r = (state.payments[key] = {
        operation_id: key,
        request_hash: requestHash,
        spec_version: "1",
        payment_state: "VERIFY_PENDING",
        fulfillment_state: "NOT_STARTED",
        proof_hash: proofHash,
        network: this.network,
        asset: this.terms.asset,
        amount_base_units: this.terms.amount,
        created_at: new Date().toISOString(),
        expires_at: Date.now() + 86400000,
      });
      state.proofs[proofHash] = key;
      save();
      let verified;
      try {
        verified = await this.remote("verify", wire);
      } catch {
        r.payment_state = "UNKNOWN";
        save();
        throw fault("verification_unknown_manual_review", 503);
      }
      if (
        verified.isValid !== true ||
        !/^0x[\da-f]{40}$/i.test(verified.payer || "")
      ) {
        r.payment_state = "FAILED";
        save();
        throw fault("payment_verification_rejected", 402);
      }
      r.payer = verified.payer.toLowerCase();
      r.payment_state = "VERIFIED";
      audit(state, "payment_verified", { operation_id: key });
      save();
      try {
        r.prepared = await prepare({ input, payer: r.payer, state });
        r.result = await complete(r.prepared, { input, payer: r.payer, state });
        if (r.result === undefined || r.result === null)
          throw fault("invalid_business_result", 502);
        r.fulfillment_state = "READY";
        save();
      } catch (e) {
        r.fulfillment_state = "FAILED";
        audit(state, "business_failed", { operation_id: key });
        save();
        throw e;
      }
      r.payment_state = "SETTLEMENT_PENDING";
      save();
      let receipt;
      try {
        receipt = await this.remote("settle", wire);
        if (
          receipt.success !== true ||
          receipt.network !== this.network ||
          !receipt.transaction
        )
          throw Error("settlement_not_confirmed");
      } catch {
        r.payment_state = "UNKNOWN";
        audit(state, "settlement_unknown", { operation_id: key });
        save();
        throw fault("payment_unknown_do_not_repurchase", 503);
      }
      r.payment_state = "CONFIRMED";
      r.receipt = {
        success: true,
        transaction: receipt.transaction,
        network: receipt.network,
      };
      audit(state, "payment_confirmed", {
        operation_id: key,
        transaction_refs: [receipt.transaction],
      });
      save();
      await afterSettlement(r, state);
      save();
      return {
        status: 200,
        body: {
          ...r.result,
          operation_id: key,
          payment_state: r.payment_state,
        },
        headers: { "payment-response": encode(r.receipt) },
      };
    });
  }
  async identity(path, header) {
    if (!header)
      return this.vault.transaction((s, save) => {
        s.nonces ??= {};
        const now = Date.now();
        for (const [k, v] of Object.entries(s.nonces))
          if (v.expiry < now) delete s.nonces[k];
        const nonce = randomBytes(20).toString("hex");
        const uri = new URL(path, this.origin).href;
        const info = {
          domain: new URL(this.origin).host,
          uri,
          version: "1",
          nonce,
          issuedAt: new Date(now).toISOString(),
          expirationTime: new Date(now + 300000).toISOString(),
          statement: "Read an existing purchase; no payment",
        };
        s.nonces[nonce] = { uri, expiry: now + 300000 };
        save();
        const challenge = {
          x402Version: 2,
          accepts: [],
          resource: { url: uri },
          extensions: {
            "sign-in-with-x": {
              info,
              supportedChains: [{ chainId: this.network, type: "eip191" }],
              schema: buildSIWxSchema(),
            },
          },
        };
        return {
          status: 402,
          body: challenge,
          headers: { "payment-required": encode(challenge) },
        };
      });
    let payload;
    try {
      payload = parseSIWxHeader(header);
    } catch {
      throw fault("invalid_identity", 401);
    }
    if (!payload || payload.chainId !== this.network)
      throw fault("invalid_identity_chain", 401);
    return this.vault.transaction(async (s, save) => {
      const nonce = s.nonces?.[payload.nonce];
      if (
        !nonce ||
        nonce.uri !== new URL(path, this.origin).href ||
        nonce.expiry < Date.now()
      )
        throw fault("invalid_identity_nonce", 401);
      const checked = await validateSIWxMessage(payload, new URL(this.origin), {
        checkNonce: (n) => n === payload.nonce,
      });
      if (!checked.isValid || payload.uri !== nonce.uri)
        throw fault("invalid_identity_message", 401);
      const options = this.rpc
        ? {
            evmVerifier: createPublicClient({ transport: http(this.rpc) })
              .verifyMessage,
          }
        : {};
      const verified = await verifySIWxSignature(payload, options);
      if (!verified.isValid) throw fault("invalid_identity_signature", 401);
      delete s.nonces[payload.nonce];
      save();
      return { payer: verified.payer.toLowerCase() };
    });
  }
  async recover(operation, payer) {
    return this.vault.transaction((s, save) => {
      const r = s.payments?.[operation];
      if (!r || r.payer !== payer) throw fault("purchase_not_found", 404);
      if (r.expires_at < Date.now()) {
        delete r.result;
        delete r.prepared;
        save();
        throw fault("artifact_expired", 410);
      }
      if (r.payment_state !== "CONFIRMED")
        return {
          operation_id: operation,
          payment_state: r.payment_state,
          fulfillment_state: r.fulfillment_state,
          result: null,
        };
      return {
        operation_id: operation,
        payment_state: r.payment_state,
        fulfillment_state: r.fulfillment_state,
        result: r.result,
        receipt: r.receipt,
      };
    });
  }
}
