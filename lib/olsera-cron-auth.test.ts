// Regression test untuk Task 4 (security hardening) dan konsistensi cron:
// verifyCronSecret adalah SATU-SATUNYA tempat perbandingan Bearer CRON_SECRET
// dilakukan (sebelumnya ada 3 salinan logika, 2 di antaranya memakai `!==`
// biasa alih-alih perbandingan waktu-konstan).
import assert from "node:assert/strict";
import test from "node:test";
import { verifyCronSecret } from "./olsera-cron-auth.ts";

const ORIGINAL_SECRET = process.env.CRON_SECRET;

function withCronSecret<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try {
    return fn();
  } finally {
    if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_SECRET;
  }
}

test("CRON_SECRET tidak dikonfigurasi -> gagal aman (500), bukan terbuka tanpa auth", () => {
  const result = withCronSecret(undefined, () => verifyCronSecret("Bearer anything"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 500);
});

test("Bearer token yang benar -> ok", () => {
  const result = withCronSecret("shh-secret-123", () => verifyCronSecret("Bearer shh-secret-123"));
  assert.equal(result.ok, true);
});

test("Bearer token yang salah -> 401 Unauthorized", () => {
  const result = withCronSecret("shh-secret-123", () => verifyCronSecret("Bearer wrong"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 401);
});

test("header Authorization kosong/null -> 401 (tidak crash)", () => {
  const result = withCronSecret("shh-secret-123", () => verifyCronSecret(null));
  assert.equal(result.ok, false);
});

test("token dengan panjang berbeda dari yang diharapkan -> ditolak dengan aman (tidak melempar dari timingSafeEqual)", () => {
  const result = withCronSecret("a-fairly-long-secret-value", () => verifyCronSecret("Bearer short"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 401);
});

test("prefix 'Bearer ' wajib persis (tanpa spasi ganda/beda kapital) -> ditolak", () => {
  const result = withCronSecret("shh-secret-123", () => verifyCronSecret("bearer shh-secret-123"));
  assert.equal(result.ok, false);
});
