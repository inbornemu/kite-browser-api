import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { resolve } from "node:path";
export function fault(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
export const hash = (value) =>
  createHash("sha256")
    .update(
      Buffer.isBuffer(value)
        ? value
        : typeof value === "string"
          ? value
          : canonical(value),
    )
    .digest("hex");
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export function equal(a, b) {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
}
export function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/(?:token|secret|private.?key|signature|authorization|cookie|passport_operation_key|session_id)/i.test(
              k,
            ),
        )
        .map(([k, v]) => [k, clean(v)]),
    );
  if (typeof value === "string")
    return value
      .replace(/gh[pousr]_[a-zA-Z0-9]{20,}/g, "[redacted]")
      .replace(/Bearer\s+\S+/gi, "[redacted]");
  return value;
}
export class Vault {
  constructor(directory, key) {
    if (!/^[a-f0-9]{64}$/i.test(key || ""))
      throw fault("DATA_KEY_must_be_32_byte_hex", 503);
    this.directory = resolve(directory);
    this.key = Buffer.from(key, "hex");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.path = resolve(this.directory, "state.enc");
    this.lock = resolve(this.directory, "writer.lock");
    this.tail = Promise.resolve();
  }
  read() {
    if (!existsSync(this.path))
      return { schema_version: 1, records: {}, audit: [] };
    const b = readFileSync(this.path);
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
    );
  }
  save(data) {
    const nonce = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, nonce);
    const text = Buffer.concat([c.update(JSON.stringify(data)), c.final()]);
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, Buffer.concat([nonce, c.getAuthTag(), text]), {
      mode: 0o600,
    });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    const dir = openSync(this.directory, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  transaction(fn) {
    const work = async () => {
      try {
        mkdirSync(this.lock, { mode: 0o700 });
      } catch {
        throw fault("writer_locked_manual_recovery_required", 503);
      }
      try {
        const state = this.read();
        return await fn(state, () => this.save(state));
      } finally {
        rmSync(this.lock, { recursive: true });
      }
    };
    const p = this.tail.then(work, work);
    this.tail = p.catch(() => {});
    return p;
  }
}
export function audit(state, type, details = {}) {
  state.audit.push({
    event_id: randomBytes(12).toString("hex"),
    occurred_at: new Date().toISOString(),
    type,
    ...clean(details),
  });
}
