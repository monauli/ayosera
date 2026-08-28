// Regression test untuk fix normalizeModules(): role "user" sebelumnya otomatis
// dapat SEMUA modul (bug), sekarang harus mengikuti allowedModules tersimpan.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModules, APP_MODULES, resolveAppRole, SUPERVISOR_EMAILS, SUPERVISOR_SEED_EMAIL } from "./app-modules.ts";

test("supervisor -> selalu semua APP_MODULES, apa pun input modules-nya", () => {
  assert.deepEqual(normalizeModules("supervisor", undefined), [...APP_MODULES]);
  assert.deepEqual(normalizeModules("supervisor", []), [...APP_MODULES]);
  assert.deepEqual(normalizeModules("supervisor", ["dasbor"]), [...APP_MODULES]);
});

test("user tanpa field allowedModules (undefined) -> tidak dapat modul apapun", () => {
  assert.deepEqual(normalizeModules("user", undefined), []);
});

test("user dengan allowedModules kosong -> tidak dapat modul apapun", () => {
  assert.deepEqual(normalizeModules("user", []), []);
});

test("user dengan ['olsera'] -> dapat olsera + auto-tambah rekonsiliasi", () => {
  assert.deepEqual(normalizeModules("user", ["olsera"]), ["olsera", "rekonsiliasi"]);
});

test("user dengan modul spesifik (bukan olsera) -> hanya modul itu, tidak semua", () => {
  assert.deepEqual(normalizeModules("user", ["dasbor", "webhook"]), ["dasbor", "webhook"]);
});

test("user dengan modul tidak valid -> difilter habis, hasil kosong", () => {
  assert.deepEqual(normalizeModules("user", ["modul-tidak-valid"]), []);
});

// --- Allowlist supervisor (opsi A): SUPERVISOR_EMAIL tunggal -> SUPERVISOR_EMAILS.
// Gate ini membuka manajemen pengguna dan reset password akun lain, jadi
// dikunci test: satu edit tak sengaja di daftar harus menggagalkan CI.

test("resolveAppRole: keempat email di allowlist jadi supervisor bila role DB admin/supervisor", () => {
  for (const email of SUPERVISOR_EMAILS) {
    assert.equal(resolveAppRole(email, "supervisor"), "supervisor");
    assert.equal(resolveAppRole(email, "admin"), "supervisor");
  }
  assert.equal(SUPERVISOR_EMAILS.size, 4);
  for (const email of ["timunemas@ayo.local", "manageramp@gmail.com", "direksi@gmail.com", "admampbatam222@gmail.com"]) {
    assert.ok(SUPERVISOR_EMAILS.has(email), `${email} hilang dari allowlist`);
  }
});

test("resolveAppRole: syarat AND — ada di allowlist saja TIDAK cukup", () => {
  assert.equal(resolveAppRole("direksi@gmail.com", "user"), "user");
  assert.equal(resolveAppRole("direksi@gmail.com", undefined), "user");
  assert.equal(resolveAppRole("direksi@gmail.com", null), "user");
});

test("resolveAppRole: role DB supervisor saja TIDAK cukup kalau email di luar allowlist", () => {
  assert.equal(resolveAppRole("admin@ayo.local", "supervisor"), "user");
  assert.equal(resolveAppRole("admin@ayo.local", "admin"), "user");
  assert.equal(resolveAppRole("syela@ayo.com", "supervisor"), "user");
  assert.equal(resolveAppRole("ariamp@gmail.com", "supervisor"), "user");
});

test("resolveAppRole: email dinormalisasi (case + spasi), tidak bisa ditembus lewat casing", () => {
  assert.equal(resolveAppRole("  Direksi@Gmail.COM ", "supervisor"), "supervisor");
  assert.equal(resolveAppRole("direksi@gmail.com.evil.test", "supervisor"), "user");
});

test("akun bootstrap seed tetap satu dan ada di dalam allowlist", () => {
  assert.equal(SUPERVISOR_SEED_EMAIL, "timunemas@ayo.local");
  assert.ok(SUPERVISOR_EMAILS.has(SUPERVISOR_SEED_EMAIL));
});
