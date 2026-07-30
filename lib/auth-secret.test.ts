// Regression test untuk Task 4 (security hardening): secret penandatanganan
// sesi tidak boleh diam-diam jatuh ke fallback hardcode di production.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthSecret } from "./auth-secret.ts";

test("BETTER_AUTH_SECRET diset -> dipakai apa adanya", () => {
  assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: "real-secret-123", NODE_ENV: "production" }), "real-secret-123");
});

test("hanya JWT_SECRET diset (fallback lama) -> tetap dipakai", () => {
  assert.equal(resolveAuthSecret({ JWT_SECRET: "jwt-secret-456", NODE_ENV: "production" }), "jwt-secret-456");
});

test("BETTER_AUTH_SECRET diprioritaskan di atas JWT_SECRET bila keduanya ada", () => {
  assert.equal(
    resolveAuthSecret({ BETTER_AUTH_SECRET: "primary", JWT_SECRET: "secondary", NODE_ENV: "production" }),
    "primary",
  );
});

test("PENYEBAB NYATA temuan: production TANPA secret apa pun -> gagal keras (throw), bukan diam-diam pakai fallback hardcode", () => {
  assert.throws(() => resolveAuthSecret({ NODE_ENV: "production" }), /wajib diset di production/);
});

test("development TANPA secret -> tetap dapat fallback praktis (tidak throw)", () => {
  const secret = resolveAuthSecret({ NODE_ENV: "development" });
  assert.equal(typeof secret, "string");
  assert.ok(secret.length >= 32, "fallback dev harus tetap string panjang yang wajar untuk secret");
});

test("NODE_ENV tidak diset sama sekali (mis. dijalankan langsung lewat node) -> diperlakukan seperti development, tidak throw", () => {
  assert.doesNotThrow(() => resolveAuthSecret({}));
});
