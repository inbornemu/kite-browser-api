import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createSIWxPayload,
  encodeSIWxHeader,
} from "@x402/extensions/sign-in-with-x";
import { Seller, amountUnits, encode } from "./seller.mjs";
import { Vault } from "./store.mjs";
function setup(t, mode = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "seller-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32).toString("hex"),
    vault = new Vault(dir, key),
    events = [],
    account = privateKeyToAccount(generatePrivateKey());
  const seller = new Seller({
    vault,
    origin: "https://seller.example",
    network: "eip155:2368",
    asset: "0x" + "b".repeat(40),
    payTo: "0x" + "c".repeat(40),
    facilitator: "https://f.example/v2",
    fetcher: async (url) => {
      events.push(url.split("/").at(-1));
      if (url.endsWith("verify"))
        return {
          ok: true,
          json: async () => ({
            isValid: mode !== "invalid",
            payer: account.address,
          }),
        };
      if (mode === "unknown") throw Error("reset");
      return {
        ok: true,
        json: async () => ({
          success: true,
          network: "eip155:2368",
          transaction: "mock-settlement",
        }),
      };
    },
  });
  const input = { operation_id: "purchase-1", n: 1 },
    payment = {
      x402Version: 2,
      resource: { url: "https://seller.example/v1/run" },
      accepted: seller.terms,
      payload: { signature: "synthetic-test-proof" },
    };
  const buy = (
    i = input,
    h = encode(payment),
    fn = async () => {
      events.push("business");
      return { answer: 42 };
    },
  ) => seller.purchase({ path: "/v1/run", input: i, header: h, prepare: fn });
  return { dir, key, vault, seller, events, input, payment, buy, account };
}
test("token amounts preserve arbitrary precision and reject precision loss", () => {
  assert.equal(
    amountUnits("9007199254740993.123456", 6),
    "9007199254740993123456",
  );
  assert.throws(() => amountUnits("0.0000001", 6));
  assert.throws(() => amountUnits("1e2", 6));
});
test("402 has version, resource and exact accepted terms; no remote call", async (t) => {
  const c = setup(t);
  const r = await c.buy(c.input, null);
  assert.equal(r.status, 402);
  assert.equal(r.body.accepts[0].network, "eip155:2368");
  assert.deepEqual(c.events, []);
});
test("business precedes settle; original operation cannot execute twice", async (t) => {
  const c = setup(t);
  assert.equal((await c.buy()).status, 200);
  assert.deepEqual(c.events, ["verify", "business", "settle"]);
  assert.equal((await c.buy()).status, 409);
  assert.deepEqual(c.events, ["verify", "business", "settle"]);
  assert.equal(
    c.vault.read().payments["purchase-1"].payment_state,
    "CONFIRMED",
  );
  assert(
    !readFileSync(join(c.dir, "state.enc")).includes(Buffer.from("answer")),
  );
});
test("wrong amount and unsupported version rejected before verify", async (t) => {
  const c = setup(t);
  await assert.rejects(
    c.buy(
      c.input,
      encode({
        ...c.payment,
        accepted: { ...c.payment.accepted, amount: "1" },
      }),
    ),
    { code: "payment_terms_mismatch" },
  );
  await assert.rejects(
    c.buy(c.input, encode({ ...c.payment, x402Version: 1 })),
    { code: "payment_terms_mismatch" },
  );
  assert.equal(c.events.length, 0);
});
test("invalid signature does not run business", async (t) => {
  const c = setup(t, "invalid");
  await assert.rejects(c.buy(), { code: "payment_verification_rejected" });
  assert.deepEqual(c.events, ["verify"]);
});
test("business error prevents settlement", async (t) => {
  const c = setup(t);
  await assert.rejects(
    c.buy(c.input, encode(c.payment), async () => {
      throw Error("failed");
    }),
  );
  assert.deepEqual(c.events, ["verify"]);
});
test("unknown settle survives restart and never re-settles", async (t) => {
  const c = setup(t, "unknown");
  await assert.rejects(c.buy(), { code: "payment_unknown_do_not_repurchase" });
  const vault2 = new Vault(c.dir, c.key);
  assert.equal(vault2.read().payments["purchase-1"].payment_state, "UNKNOWN");
  assert.equal((await c.buy()).status, 409);
  assert.equal(c.events.filter((x) => x === "settle").length, 1);
});
test("conflicting request and same authorization under new operation are refused", async (t) => {
  const c = setup(t);
  await c.buy();
  await assert.rejects(c.buy({ ...c.input, n: 2 }), {
    code: "operation_conflict",
  });
  await assert.rejects(c.buy({ ...c.input, operation_id: "purchase-2" }), {
    code: "payment_replay",
  });
});
test("SIWX authenticates the verified buyer, binds path and consumes nonce", async (t) => {
  const c = setup(t);
  await c.buy();
  const path = "/operations/purchase-1",
    challenge = await c.seller.identity(path);
  const info = challenge.body.extensions["sign-in-with-x"].info;
  const proof = await createSIWxPayload(
    { ...info, chainId: "eip155:2368", type: "eip191" },
    c.account,
    info.uri,
  );
  const header = encodeSIWxHeader(proof);
  const identity = await c.seller.identity(path, header);
  assert.equal(identity.payer, c.account.address.toLowerCase());
  assert.equal(
    (await c.seller.recover("purchase-1", identity.payer)).result.answer,
    42,
  );
  await assert.rejects(c.seller.identity(path, header), {
    code: "invalid_identity_nonce",
  });
  await assert.rejects(c.seller.recover("purchase-1", "0x" + "e".repeat(40)), {
    code: "purchase_not_found",
  });
});
