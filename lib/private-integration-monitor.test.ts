import assert from "node:assert/strict";
import test from "node:test";
import { classifyTokenHealth, isPrivateToolsUser, privateToolsAllowlist, classifyAyoMobileToken, AYO_TOKEN_EXPIRING_SOON_DAYS, OLSERA_TOKEN_EXPIRING_SOON_DAYS } from "./private-integration-monitor.ts";

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.x`;
test("private tools fail closed and allow only listed user ids", () => { assert.equal(isPrivateToolsUser({ id: "a" } as never, privateToolsAllowlist("")), false); assert.equal(isPrivateToolsUser({ id: "a" } as never, privateToolsAllowlist("a,b")), true); assert.equal(isPrivateToolsUser({ id: "c" } as never, privateToolsAllowlist("a,b")), false); });
test("token health classifies active, near expiry, expired, unauthorized, and does not return token", () => { const now = new Date("2026-08-06T00:00:00Z"); const base = now.getTime() / 1000; assert.equal(classifyTokenHealth("ayo-mobile", jwt(base + 10 * 86400), now).status, "AKTIF"); assert.equal(classifyTokenHealth("ayo-mobile", jwt(base + 2 * 86400), now).status, "AKAN_KEDALUWARSA"); assert.equal(classifyTokenHealth("ayo-mobile", jwt(1), now).status, "KEDALUWARSA"); const unauthorized = classifyTokenHealth("olsera-bearer", "secret-value", now, null, "401 Unauthorized"); assert.equal(unauthorized.status, "UNAUTHORIZED"); assert.equal(JSON.stringify(unauthorized).includes("secret-value"), false); });

test(`classifyTokenHealth: threshold AKAN_KEDALUWARSA terpusat di OLSERA_TOKEN_EXPIRING_SOON_DAYS (${OLSERA_TOKEN_EXPIRING_SOON_DAYS} hari), bukan hardcode`, () => {
  const now = new Date("2026-09-02T00:00:00Z");
  const base = now.getTime() / 1000;
  assert.equal(classifyTokenHealth("olsera-bearer", jwt(base + 30 * 86400), now).status, "AKTIF");
  assert.equal(classifyTokenHealth("olsera-bearer", jwt(base + (OLSERA_TOKEN_EXPIRING_SOON_DAYS - 2) * 86400), now).status, "AKAN_KEDALUWARSA");
  assert.equal(classifyTokenHealth("olsera-bearer", jwt(base - 1 * 86400), now).status, "KEDALUWARSA");
});

// --- classifyAyoMobileToken: AYO_MOBILE_TOKEN bukan JWT di production (token opaque,
// tidak ada exp/refresh resmi) — model ini TIDAK PERNAH menebak expiry. ----------------
const NOW = new Date("2026-08-06T00:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;

test("classifyAyoMobileToken: JWT exp jauh di masa depan -> ACTIVE, sumber jwt", () => {
  const result = classifyAyoMobileToken({ token: jwt(NOW_SEC + 30 * 86400), now: NOW });
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.label, "Aktif");
  assert.equal(result.expirySource, "jwt");
});

test(`classifyAyoMobileToken: JWT exp dalam ${AYO_TOKEN_EXPIRING_SOON_DAYS} hari -> EXPIRING_SOON (threshold terpusat, tidak hardcode di banyak tempat)`, () => {
  const result = classifyAyoMobileToken({ token: jwt(NOW_SEC + (AYO_TOKEN_EXPIRING_SOON_DAYS - 1) * 86400), now: NOW });
  assert.equal(result.status, "EXPIRING_SOON");
});

test("classifyAyoMobileToken: JWT exp sudah lewat -> EXPIRED, bukti kalender menang walau ada lastError jaringan", () => {
  const result = classifyAyoMobileToken({ token: jwt(NOW_SEC - 86400), now: NOW, lastError: "network timeout" });
  assert.equal(result.status, "EXPIRED");
});

test("classifyAyoMobileToken: token opaque (bukan JWT) tanpa bukti negatif -> EXPIRY_UNKNOWN, tidak menebak expiresAt", () => {
  const result = classifyAyoMobileToken({ token: "mrHOWa5qvSml4U391kOJ6ypCHcmJl4oKJoCCK4rvyr3XOrz3EKFdRSHB3RgwVC2", now: NOW });
  assert.equal(result.status, "EXPIRY_UNKNOWN");
  assert.equal(result.expiresAt, null);
  assert.equal(result.expirySource, "unknown");
});

test("classifyAyoMobileToken: token kosong/tidak dikonfigurasi -> MANUAL_IMPORT_REQUIRED", () => {
  assert.equal(classifyAyoMobileToken({ token: undefined, now: NOW }).status, "MANUAL_IMPORT_REQUIRED");
  assert.equal(classifyAyoMobileToken({ token: "   ", now: NOW }).status, "MANUAL_IMPORT_REQUIRED");
});

test("classifyAyoMobileToken: berbentuk JWT (3 segmen) tapi payload tidak terbaca -> INVALID, bukan ditebak EXPIRED/ACTIVE", () => {
  const result = classifyAyoMobileToken({ token: "abc.not-valid-base64json.xyz", now: NOW });
  assert.equal(result.status, "INVALID");
});

test("classifyAyoMobileToken: token opaque + checkpoint terakhir gagal karena jaringan -> UNAVAILABLE, bukan Kedaluwarsa", () => {
  const result = classifyAyoMobileToken({ token: "opaque-token-value", now: NOW, lastError: "fetch failed: network timeout" });
  assert.equal(result.status, "UNAVAILABLE");
});

test("classifyAyoMobileToken: token opaque + checkpoint terakhir 401 Unauthorized -> INVALID (bukti operasional nyata, bukan tebakan)", () => {
  const result = classifyAyoMobileToken({ token: "opaque-token-value", now: NOW, lastError: "401 Unauthorized" });
  assert.equal(result.status, "INVALID");
});

test("classifyAyoMobileToken: raw token tidak pernah muncul di objek hasil", () => {
  const result = classifyAyoMobileToken({ token: "super-secret-opaque-token", now: NOW });
  assert.equal(JSON.stringify(result).includes("super-secret-opaque-token"), false);
});

test("classifyAyoMobileToken: importedAt selalu null — tidak ada sumber pelacakan, tidak pernah ditebak", () => {
  assert.equal(classifyAyoMobileToken({ token: jwt(NOW_SEC + 86400), now: NOW }).importedAt, null);
  assert.equal(classifyAyoMobileToken({ token: "opaque", now: NOW }).importedAt, null);
});

test("classifyAyoMobileToken: checkpoint existing (bukan panggilan API baru) diteruskan apa adanya untuk ditampilkan", () => {
  const lastSuccessfulSyncAt = new Date("2026-08-01T00:00:00Z");
  const lastAttemptAt = new Date("2026-08-05T00:00:00Z");
  const result = classifyAyoMobileToken({ token: "opaque", now: NOW, lastSuccessfulSyncAt, lastAttemptAt });
  assert.equal(result.lastSuccessfulCheck, lastSuccessfulSyncAt.toISOString());
  assert.equal(result.lastAttemptAt, lastAttemptAt.toISOString());
});
