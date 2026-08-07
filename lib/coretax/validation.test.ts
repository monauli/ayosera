// Regression test validasi Coretax — Fase 1.
// Jalankan: node --no-warnings --experimental-strip-types --test lib/coretax/validation.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { CORETAX_MODULES, emptyCoretaxRowValues } from "./modules.ts";
import { canExportCoretaxRows, validateCoretaxRow } from "./validation.ts";
import type { CoretaxRowValues } from "./types.ts";

function values(moduleId: keyof typeof CORETAX_MODULES, overrides: CoretaxRowValues): CoretaxRowValues {
  return { ...emptyCoretaxRowValues(CORETAX_MODULES[moduleId]), ...overrides };
}
function fieldErrors(errors: { field: string; message: string }[], field: string) {
  return errors.filter((e) => e.field === field);
}

const VALID_BPU: CoretaxRowValues = {
  TaxPeriodMonth: "6", TaxPeriodYear: "2026", CounterpartTin: "3172024806201234",
  IDPlaceOfBusinessActivityOfIncomeRecipient: "3172024806201234000000", TaxCertificate: "N/A",
  TaxObjectCode: "24-104-06", TaxBase: "10000000", Rate: "2", Document: "StatementLetter",
  DocumentNumber: "string", DocumentDate: "2026-01-28", IDPlaceOfBusinessActivity: "000000",
  GovTreasurerOpt: "N/A", SP2DNumber: "", WithholdingDate: "2026-06-18",
};

test("12. SP2DNumber wajib saat GovTreasurerOpt = Direct", () => {
  const withDirect = values("bpu", { ...VALID_BPU, GovTreasurerOpt: "Direct", SP2DNumber: "" });
  const errors = validateCoretaxRow(CORETAX_MODULES.bpu, withDirect);
  assert.ok(fieldErrors(errors, "SP2DNumber").some((e) => e.message === "Nomor SP2D wajib diisi karena cara pembayaran Direct."));

  const filled = values("bpu", { ...VALID_BPU, GovTreasurerOpt: "Direct", SP2DNumber: "SP001" });
  assert.equal(fieldErrors(validateCoretaxRow(CORETAX_MODULES.bpu, filled), "SP2DNumber").length, 0);
});

const VALID_BPMP: CoretaxRowValues = {
  TaxPeriodMonth: "3", TaxPeriodYear: "2026", CounterpartOpt: "Resident", CounterpartPassport: "",
  CounterpartTin: "1111111111111111", StatusTaxExemption: "K/0", Position: "CEO", TaxCertificate: "N/A",
  TaxObjectCode: "21-100-01", Gross: "40000000", Rate: "16", IDPlaceOfBusinessActivity: "000000", WithholdingDate: "2026-03-18",
};

test("13. CounterpartPassport wajib untuk penerima berstatus Foreign", () => {
  const foreignNoPassport = values("bpmp", { ...VALID_BPMP, CounterpartOpt: "Foreign", CounterpartPassport: "" });
  const errors = validateCoretaxRow(CORETAX_MODULES.bpmp, foreignNoPassport);
  assert.ok(fieldErrors(errors, "CounterpartPassport").some((e) => e.message === "Nomor paspor wajib diisi untuk penerima berstatus Foreign."));

  const residentNoPassport = values("bpmp", VALID_BPMP);
  assert.equal(fieldErrors(validateCoretaxRow(CORETAX_MODULES.bpmp, residentNoPassport), "CounterpartPassport").length, 0);

  const foreignWithPassport = values("bpmp", { ...VALID_BPMP, CounterpartOpt: "Foreign", CounterpartPassport: "ABC-123" });
  assert.equal(fieldErrors(validateCoretaxRow(CORETAX_MODULES.bpmp, foreignWithPassport), "CounterpartPassport").length, 0);
});

test("14. DocumentNumber dan DocumentDate wajib bila Document diisi (BPU & BP21)", () => {
  const missingBoth = values("bpu", { ...VALID_BPU, DocumentNumber: "", DocumentDate: "" });
  const errors = validateCoretaxRow(CORETAX_MODULES.bpu, missingBoth);
  assert.ok(fieldErrors(errors, "DocumentNumber").some((e) => e.message === "Nomor dokumen wajib diisi."));
  assert.ok(fieldErrors(errors, "DocumentDate").some((e) => e.message === "Tanggal dokumen wajib diisi untuk jenis dokumen ini."));
});

test("15. WithholdingDate tidak boleh lebih rendah dari masa pajak (bulan/tahun baris)", () => {
  const before = values("bpu", { ...VALID_BPU, TaxPeriodMonth: "6", TaxPeriodYear: "2026", WithholdingDate: "2026-05-31" });
  const errors = validateCoretaxRow(CORETAX_MODULES.bpu, before);
  assert.ok(fieldErrors(errors, "WithholdingDate").some((e) => e.message === "Tanggal pemotongan tidak boleh sebelum masa pajak."));

  const sameMonth = values("bpu", { ...VALID_BPU, TaxPeriodMonth: "6", TaxPeriodYear: "2026", WithholdingDate: "2026-06-01" });
  assert.equal(fieldErrors(validateCoretaxRow(CORETAX_MODULES.bpu, sameMonth), "WithholdingDate").length, 0);
});

test("16. Tarif harus sesuai referensi Kode Objek Pajak (BPU, tabel tunggal)", () => {
  const wrongRate = values("bpu", { ...VALID_BPU, TaxObjectCode: "24-101-01", Rate: "99" }); // REF: Dividen = 15%
  const errors = validateCoretaxRow(CORETAX_MODULES.bpu, wrongRate);
  assert.ok(fieldErrors(errors, "Rate").some((e) => e.message.includes("referensi: 15%")));

  const correctRate = values("bpu", { ...VALID_BPU, TaxObjectCode: "24-101-01", Rate: "15" });
  assert.equal(fieldErrors(validateCoretaxRow(CORETAX_MODULES.bpu, correctRate), "Rate").length, 0);
});

test("Deemed harus sesuai referensi Kode Objek Pajak (BP21)", () => {
  const base: CoretaxRowValues = {
    TaxPeriodMonth: "3", TaxPeriodYear: "2026", CounterpartTin: "1111111111111111",
    IDPlaceOfBusinessActivityOfIncomeRecipient: "000000", StatusTaxExemption: "TK/0", TaxCertificate: "N/A",
    TaxObjectCode: "21-100-07", Gross: "1000000", Deemed: "99", Rate: "6", Document: "Contract",
    DocumentNumber: "X", DocumentDate: "2026-03-01", IDPlaceOfBusinessActivity: "000000", WithholdingDate: "2026-03-15",
  };
  const errors = validateCoretaxRow(CORETAX_MODULES.bp21, values("bp21", base)); // REF: 21-100-07 Deemed=50
  assert.ok(fieldErrors(errors, "Deemed").some((e) => e.message.includes("referensi: 50%")));
});

test("Field wajib kosong menghasilkan pesan yang jelas (bukan 'Invalid' generik)", () => {
  const empty = values("bpu", { TaxPeriodMonth: "", CounterpartTin: "", DocumentNumber: "0100012292489165" });
  const errors = validateCoretaxRow(CORETAX_MODULES.bpu, empty);
  assert.ok(errors.some((e) => e.message === "Masa Pajak wajib diisi."));
  assert.ok(errors.some((e) => e.message === "NPWP/NIK Penerima wajib diisi."));
  assert.ok(errors.every((e) => e.message !== "Invalid"));
});

test("Angka negatif ditolak untuk field number", () => {
  const negative = values("bpu", { ...VALID_BPU, TaxBase: "-100" });
  const errors = validateCoretaxRow(CORETAX_MODULES.bpu, negative);
  assert.ok(fieldErrors(errors, "TaxBase").some((e) => e.message === "Dasar Pengenaan Pajak tidak boleh negatif."));
});

test("Format bulan/tahun/tanggal ditolak bila tidak valid", () => {
  const bad = values("bpu", { ...VALID_BPU, TaxPeriodMonth: "13", TaxPeriodYear: "26", WithholdingDate: "2026-99-99" });
  const errors = validateCoretaxRow(CORETAX_MODULES.bpu, bad);
  assert.ok(fieldErrors(errors, "TaxPeriodMonth").length > 0);
  assert.ok(fieldErrors(errors, "TaxPeriodYear").length > 0);
  assert.ok(fieldErrors(errors, "WithholdingDate").length > 0);
});

test("baris valid lengkap TIDAK menghasilkan error sama sekali", () => {
  assert.deepEqual(validateCoretaxRow(CORETAX_MODULES.bpu, values("bpu", VALID_BPU)), []);
});

// ---- 17/18. Preview & Export ditolak saat masih ada error (helper murni dipakai UI) ----

test("17/18. canExportCoretaxRows menolak bila belum diperiksa, tidak ada baris, atau ada baris bermasalah", () => {
  assert.equal(canExportCoretaxRows(false, [{ status: "benar" }]), false, "belum diperiksa -> ditolak");
  assert.equal(canExportCoretaxRows(true, []), false, "tidak ada baris -> ditolak");
  assert.equal(canExportCoretaxRows(true, [{ status: "benar" }, { status: "perlu-diperbaiki" }]), false);
  assert.equal(canExportCoretaxRows(true, [{ status: "benar" }, { status: "belum-diperiksa" }]), false, "baris belum-diperiksa juga menolak export");
  assert.equal(canExportCoretaxRows(true, [{ status: "benar" }, { status: "benar" }]), true);
});
