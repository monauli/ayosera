// Reset Password (Bagian B): password baru harus SELALU acak — ini menjaga
// generatePassword() tidak diam-diam berubah jadi lemah/pendek/predictable.
import assert from "node:assert/strict";
import test from "node:test";
import { generatePassword, PASSWORD_CHARSET } from "./password-generator.ts";

test("generatePassword: panjang default 14 dan hanya memakai karakter dari charset", () => {
  const password = generatePassword();
  assert.equal(password.length, 14);
  for (const char of password) {
    assert.ok(PASSWORD_CHARSET.includes(char), `karakter '${char}' di luar charset`);
  }
});

test("generatePassword: menghormati panjang custom", () => {
  assert.equal(generatePassword(20).length, 20);
  assert.equal(generatePassword(8).length, 8);
});

test("generatePassword: charset tidak memuat karakter ambigu (0/O, 1/l/I)", () => {
  for (const ambiguous of ["0", "O", "1", "l", "I"]) {
    assert.ok(!PASSWORD_CHARSET.includes(ambiguous), `charset seharusnya tidak memuat '${ambiguous}'`);
  }
});

test("generatePassword: dua panggilan berturut-turut menghasilkan nilai berbeda (acak, bukan statis)", () => {
  const samples = new Set(Array.from({ length: 20 }, () => generatePassword()));
  assert.equal(samples.size, 20, "generatePassword harus menghasilkan nilai unik tiap kali dipanggil");
});
