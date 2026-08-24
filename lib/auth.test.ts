// Regression test untuk fix normalizeModules(): role "user" sebelumnya otomatis
// dapat SEMUA modul (bug), sekarang harus mengikuti allowedModules tersimpan.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModules, APP_MODULES } from "./app-modules.ts";

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
