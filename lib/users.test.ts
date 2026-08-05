// Fitur Username (Bagian A): auto-generate dari email saat username kosong,
// dan format yang boleh disimpan (dipakai bersama oleh POST/PATCH /api/users).
import assert from "node:assert/strict";
import test from "node:test";
import { USERNAME_REGEX, usernameFromEmail } from "./username.ts";

test("usernameFromEmail: mengambil local-part email dan melowercase-kannya", () => {
  assert.equal(usernameFromEmail("Budi.Santoso@ayo.local"), "budi.santoso");
});

test("usernameFromEmail: membuang karakter yang tidak diizinkan (mis. '+' pada alias email)", () => {
  assert.equal(usernameFromEmail("budi+tag@ayo.local"), "buditag");
});

test("usernameFromEmail: null bila hasil setelah dibersihkan terlalu pendek (username tetap opsional, tidak memblokir pembuatan user)", () => {
  assert.equal(usernameFromEmail("ab@ayo.local"), null);
  assert.equal(usernameFromEmail("+++@ayo.local"), null);
});

test("USERNAME_REGEX: menerima huruf/angka/titik/underscore/strip, 3-32 karakter", () => {
  assert.ok(USERNAME_REGEX.test("budi.santoso"));
  assert.ok(USERNAME_REGEX.test("budi_123"));
  assert.ok(USERNAME_REGEX.test("abc"));
  assert.ok(USERNAME_REGEX.test("a".repeat(32)));
});

test("USERNAME_REGEX: menolak terlalu pendek, terlalu panjang, atau karakter di luar charset (mis. '@', spasi)", () => {
  assert.ok(!USERNAME_REGEX.test("ab"));
  assert.ok(!USERNAME_REGEX.test("a".repeat(33)));
  assert.ok(!USERNAME_REGEX.test("budi@ayo"));
  assert.ok(!USERNAME_REGEX.test("budi santoso"));
});
