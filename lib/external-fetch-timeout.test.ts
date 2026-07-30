// Regression test untuk Task 4 (security hardening): panggilan API eksternal
// (AYO, Olsera) sebelumnya tidak punya timeout sendiri — hanya bergantung
// pada maxDuration function Vercel, yang menghabiskan seluruh budget durasi
// pada satu request yang macet. Perilaku timeout AbortSignal/setTimeout tidak
// praktis diuji murni tanpa mock jaringan nyata (di luar proporsi task ini),
// jadi diverifikasi lewat pemeriksaan sumber bahwa signal/timeout benar-benar
// disertakan di setiap pemanggilan fetch/http eksternal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("lib/ayo.ts: fetch() POST memakai AbortSignal.timeout", () => {
  const source = read("./ayo.ts");
  assert.ok(source.includes("const AYO_REQUEST_TIMEOUT_MS = 20_000;"));
  assert.match(source, /signal: AbortSignal\.timeout\(AYO_REQUEST_TIMEOUT_MS\)/);
});

test("lib/ayo.ts: request http/https (jalur GET) memakai request.setTimeout dan men-destroy request saat timeout", () => {
  const source = read("./ayo.ts");
  assert.match(source, /request\.setTimeout\(AYO_REQUEST_TIMEOUT_MS,/);
  assert.match(source, /request\.destroy\(new Error\("AYO API request timed out"\)\)/);
});

test("lib/olsera.ts: kedua fetch (token & report) memakai AbortSignal.timeout", () => {
  const source = read("./olsera.ts");
  assert.ok(source.includes("const OLSERA_REQUEST_TIMEOUT_MS = 20_000;"));
  const occurrences = source.match(/signal: AbortSignal\.timeout\(OLSERA_REQUEST_TIMEOUT_MS\)/g) ?? [];
  assert.equal(occurrences.length, 2, "kedua fetch (getAccessToken & getSalesItemsPerGroup) harus punya timeout");
});

test("lib/olsera-financial-client.ts: sudah punya timeout sebelumnya (AbortController 10s) — dipastikan tidak ikut berubah/rusak", () => {
  const source = read("./olsera-financial-client.ts");
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), 10000\)/);
});

test("app/api/webhooks/ayo/route.ts: rate limit + batas ukuran body diterapkan sebelum memproses payload", () => {
  const source = read("../app/api/webhooks/ayo/route.ts");
  assert.ok(source.includes('import { checkRateLimitSafe, clientIp } from "@/lib/rate-limit";'));
  assert.match(source, /checkRateLimitSafe\(`webhook-ayo:\$\{clientIp\(request\)\}`, WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_SECONDS\)/);
  assert.ok(source.includes("status: 429"));
  assert.ok(source.includes("status: 413"));
  assert.ok(source.includes("MAX_BODY_BYTES = 256_000"));
});

test("app/api/webhooks/ayo-sandbox/route.ts: rate limit + batas ukuran body diterapkan juga (konsisten dengan endpoint produksi)", () => {
  const source = read("../app/api/webhooks/ayo-sandbox/route.ts");
  assert.match(source, /checkRateLimitSafe\(`webhook-ayo-sandbox:\$\{clientIp\(request\)\}`, WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_SECONDS\)/);
  assert.ok(source.includes("status: 429"));
  assert.ok(source.includes("status: 413"));
});

test("app/api/auth/login/route.ts: rate limit diterapkan sebelum memproses kredensial", () => {
  const source = read("../app/api/auth/login/route.ts");
  assert.ok(source.includes('import { checkRateLimitSafe, clientIp } from "@/lib/rate-limit";'));
  assert.match(source, /checkRateLimitSafe\(`login:\$\{clientIp\(request\)\}`, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS\)/);
  assert.ok(source.includes("status: 429"));
  assert.ok(source.includes("Retry-After"));
});
