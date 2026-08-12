import assert from "node:assert/strict";
import test from "node:test";
import { financialSourceWarningText, visibleFinancialSourceDiagnostics, type FinancialSourceDiagnostic } from "./olsera-financial-diagnostics-ui.ts";

function diagnostic(overrides: Partial<FinancialSourceDiagnostic> = {}): FinancialSourceDiagnostic {
  return {
    accountCode: "40001",
    accountName: "Court Fees",
    status: "Selisih sumber",
    summaryDebit: 0,
    summaryCredit: 0,
    detailDebit: 0,
    detailCredit: 0,
    ...overrides,
  };
}

test("diagnostic sumber 0/0 seluruhnya tidak ditampilkan", () => {
  assert.deepEqual(visibleFinancialSourceDiagnostics([diagnostic()]), []);
});

test("diagnostic sumber dengan nominal non-zero tetap ditampilkan", () => {
  const row = diagnostic({ detailCredit: 125_000 });
  assert.deepEqual(visibleFinancialSourceDiagnostics([diagnostic(), row]), [row]);
});

test("bulan berjalan memakai pesan ringan, historis tetap memakai judul diagnostic", () => {
  assert.equal(financialSourceWarningText(true), "Data bulan berjalan belum lengkap.");
  assert.equal(financialSourceWarningText(false), "Perlu Dicek — diagnostic sumber");
});
