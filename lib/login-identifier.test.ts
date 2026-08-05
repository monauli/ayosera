// Bagian A: login menerima EMAIL atau USERNAME lewat satu kolom input yang
// sama (deteksi otomatis lewat "@"). Logikanya ada di dalam handler POST
// app/api/auth/login/route.ts (butuh koneksi DB nyata) — sama seperti
// lib/login-form-guard.test.ts, diuji struktural di sini untuk menjaga
// kontrak ini tidak terhapus/berubah diam-diam tanpa infra integrasi DB.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "app", "api", "auth", "login", "route.ts"), "utf8");

test("login route mendeteksi username (tanpa '@') dan mencarinya di koleksi user sebelum signInEmail", () => {
  assert.match(source, /!identifier\.includes\("@"\)/, "cabang deteksi username hilang");
  assert.match(source, /users\.findOne\(\{ username: identifier \}\)/, "lookup username hilang");
});

test("login route TIDAK PERNAH memanggil signInEmail dengan input mentah yang bukan email (selalu resolvedEmail)", () => {
  const call = source.match(/auth\.api\.signInEmail\(\{[\s\S]*?\}\);/)?.[0] ?? "";
  assert.ok(call, "pemanggilan signInEmail tidak ditemukan");
  assert.match(call, /email: resolvedEmail/, "signInEmail harus selalu memakai resolvedEmail, bukan body.email mentah");
});

test("username yang tidak ditemukan menghasilkan pesan generik (tidak membocorkan apakah username ada)", () => {
  assert.match(source, /if \(!byUsername\)[\s\S]{0,120}Email atau password tidak valid/, "pesan error untuk username tak ditemukan harus generik");
});

test("identifier dinormalisasi lowercase sebelum dibandingkan (username case-insensitive)", () => {
  assert.match(source, /identifier = body\.email\.trim\(\)\.toLowerCase\(\)/);
});
