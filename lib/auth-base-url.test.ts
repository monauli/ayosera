// Regression test untuk root cause bug logout 403 (Task 2): BETTER_AUTH_URL
// production ternyata tanpa skema ("ayosera.vercel.app" bukan
// "https://ayosera.vercel.app"), sehingga Better Auth membangun trustedOrigins
// yang salah dan menolak origin production sendiri (403 INVALID_ORIGIN) —
// dibuktikan lewat request nyata (lihat tmp/ai-handoff.md untuk bukti
// request/response). describeAuthBaseURLIssue mendeteksi kelas kesalahan ini
// SAAT startup (log jelas) alih-alih membiarkannya gagal senyap di endpoint
// lain. Jalankan: npm run test:auth-base-url
import assert from "node:assert/strict";
import test from "node:test";
import { describeAuthBaseURLIssue } from "./auth-base-url.ts";

test("URL production yang benar (dengan skema https) -> tidak ada masalah", () => {
  assert.equal(describeAuthBaseURLIssue("https://ayosera.vercel.app"), null);
});

test("URL http (dev lokal) -> tidak ada masalah", () => {
  assert.equal(describeAuthBaseURLIssue("http://localhost:3000"), null);
});

test("nilai kosong/tidak diset -> tidak ada masalah (perilaku fallback existing tidak berubah)", () => {
  assert.equal(describeAuthBaseURLIssue(undefined), null);
  assert.equal(describeAuthBaseURLIssue(""), null);
});

test("PENYEBAB NYATA bug: domain tanpa skema -> terdeteksi sebagai masalah", () => {
  const issue = describeAuthBaseURLIssue("ayosera.vercel.app");
  assert.ok(issue, "domain tanpa skema harus terdeteksi, ini persis penyebab 403 di production");
  assert.match(issue!, /skema/);
});

test("skema selain http/https (mis. salah ketik) -> terdeteksi sebagai masalah", () => {
  const issue = describeAuthBaseURLIssue("ftp://ayosera.vercel.app");
  assert.ok(issue);
  assert.match(issue!, /http\/https/);
});

test("URL dengan trailing slash tetap valid (tidak dianggap masalah berbeda)", () => {
  assert.equal(describeAuthBaseURLIssue("https://ayosera.vercel.app/"), null);
});
