// Regression test untuk Task 4 (security hardening): batas rentang tanggal
// export — mencegah permintaan tak terbatas (mis. satu dekade) yang berisiko
// memory/timeout pada export baris-per-transaksi.
import assert from "node:assert/strict";
import test from "node:test";
import { validateDateRangeQuery } from "./date-range-validation.ts";

test("format tanggal valid & rentang wajar -> ok", () => {
  assert.equal(validateDateRangeQuery("2026-07-01", "2026-07-31", 366).ok, true);
});

test("format tidak sesuai YYYY-MM-DD -> ditolak", () => {
  const r = validateDateRangeQuery("07/01/2026", "2026-07-31", 366);
  assert.equal(r.ok, false);
});

test("start setelah end -> ditolak", () => {
  const r = validateDateRangeQuery("2026-08-01", "2026-07-01", 366);
  assert.equal(r.ok, false);
});

test("start sama dengan end (satu hari) -> ok", () => {
  assert.equal(validateDateRangeQuery("2026-07-01", "2026-07-01", 366).ok, true);
});

test("PENYEBAB NYATA temuan: rentang melebihi batas maksimum -> ditolak dengan pesan jelas, bukan diam-diam dipotong", () => {
  const r = validateDateRangeQuery("2020-01-01", "2026-07-30", 366);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /maksimum 366 hari/);
    assert.match(r.error, /\d+ hari/); // menyebutkan jumlah hari yang diminta
  }
});

test("rentang tepat di batas maksimum (366 hari inklusif) -> masih ok, bukan off-by-one", () => {
  // 2025-01-01..2026-01-01 inklusif = 366 hari (2025 bukan tahun kabisat: 365 + 1).
  const r = validateDateRangeQuery("2025-01-01", "2026-01-01", 366);
  assert.equal(r.ok, true);
});

test("rentang satu hari melebihi batas maksimum -> ditolak", () => {
  // 2025-01-01..2026-01-02 inklusif = 367 hari (2025 bukan tahun kabisat) -> 1 hari di atas batas 366.
  const r = validateDateRangeQuery("2025-01-01", "2026-01-02", 366);
  assert.equal(r.ok, false);
});
