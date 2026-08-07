// Regression test generator XML Coretax — Fase 1. Golden XML per modul
// membuktikan root/wrapper/row/TIN/urutan elemen persis Template XML resmi
// DJP (lihat docs/coretax.md "Sumber Template Resmi").
// Jalankan: node --no-warnings --experimental-strip-types --test lib/coretax/xml-generator.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { CORETAX_MODULES, emptyCoretaxRowValues } from "./modules.ts";
import { coretaxFileName, escapeXml, generateCoretaxXml, sanitizeFileNamePart } from "./xml-generator.ts";
import type { CoretaxRow } from "./types.ts";

function rowFor(moduleId: keyof typeof CORETAX_MODULES, values: Record<string, string>): CoretaxRow {
  const config = CORETAX_MODULES[moduleId];
  return { rowId: "r1", values: { ...emptyCoretaxRowValues(config), ...values }, status: "benar", errors: [] };
}

// ---- 6. XML escaping ----

test("6. escapeXml meng-escape & < > \" ' — & lebih dulu supaya tidak escape ganda", () => {
  assert.equal(escapeXml(`Tan & Co <PT> "Test" 'X'`), "Tan &amp; Co &lt;PT&gt; &quot;Test&quot; &apos;X&apos;");
  assert.equal(escapeXml("A & B"), "A &amp; B");
  assert.equal(escapeXml("&amp;"), "&amp;amp;", "& mentah tetap di-escape walau kebetulan mirip entity lain");
});

// ---- 7-10. Urutan field per modul PERSIS Template XML resmi ----

test("7. urutan field BPU persis Template XML resmi (15 field)", () => {
  assert.deepEqual(CORETAX_MODULES.bpu.fields.map((f) => f.key), [
    "TaxPeriodMonth", "TaxPeriodYear", "CounterpartTin", "IDPlaceOfBusinessActivityOfIncomeRecipient", "TaxCertificate",
    "TaxObjectCode", "TaxBase", "Rate", "Document", "DocumentNumber", "DocumentDate", "IDPlaceOfBusinessActivity",
    "GovTreasurerOpt", "SP2DNumber", "WithholdingDate",
  ]);
});

test("8. urutan field BPMP persis Template XML resmi (13 field)", () => {
  assert.deepEqual(CORETAX_MODULES.bpmp.fields.map((f) => f.key), [
    "TaxPeriodMonth", "TaxPeriodYear", "CounterpartOpt", "CounterpartPassport", "CounterpartTin", "StatusTaxExemption",
    "Position", "TaxCertificate", "TaxObjectCode", "Gross", "Rate", "IDPlaceOfBusinessActivity", "WithholdingDate",
  ]);
});

test("9. urutan field BP21 persis Template XML resmi (15 field)", () => {
  assert.deepEqual(CORETAX_MODULES.bp21.fields.map((f) => f.key), [
    "TaxPeriodMonth", "TaxPeriodYear", "CounterpartTin", "IDPlaceOfBusinessActivityOfIncomeRecipient", "StatusTaxExemption",
    "TaxCertificate", "TaxObjectCode", "Gross", "Deemed", "Rate", "Document", "DocumentNumber", "DocumentDate",
    "IDPlaceOfBusinessActivity", "WithholdingDate",
  ]);
});

test("10. urutan field BPA1 persis Template XML resmi (27 field)", () => {
  assert.deepEqual(CORETAX_MODULES.bpa1.fields.map((f) => f.key), [
    "WorkForSecondEmployer", "TaxPeriodMonthStart", "TaxPeriodMonthEnd", "TaxPeriodYear", "CounterpartOpt", "CounterpartPassport",
    "CounterpartTin", "TaxExemptOpt", "StatusOfWithholding", "CounterpartPosition", "TaxObjectCode", "NumberOfMonths",
    "SalaryPensionJhtTht", "GrossUpOpt", "IncomeTaxBenefit", "OtherBenefit", "Honorarium", "InsurancePaidByEmployer",
    "Natura", "TantiemBonusThr", "PensionContributionJhtThtFee", "Zakat", "PrevWhTaxSlip", "TaxCertificate",
    "Article21IncomeTax", "IDPlaceOfBusinessActivity", "WithholdingDate",
  ]);
});

// ---- 11. Optional empty element ----

test("11. field kosong (optional) ditulis self-closing <Tag /> — pola sama seperti <SP2DNumber /> pada BPU_Template.xml resmi", () => {
  const row = rowFor("bpu", { SP2DNumber: "" });
  const xml = generateCoretaxXml(CORETAX_MODULES.bpu, "1234567890123456", [row]);
  assert.match(xml, /<SP2DNumber \/>/);
  assert.equal(xml.includes("<SP2DNumber></SP2DNumber>"), false);
});

// ---- 20. Status Data / rowId tidak masuk XML ----

test("20. field UI (rowId, status, errors/Keterangan Kesalahan) TIDAK PERNAH ditulis ke XML", () => {
  const row: CoretaxRow = { rowId: "internal-only", values: emptyCoretaxRowValues(CORETAX_MODULES.bpu), status: "perlu-diperbaiki", errors: [{ field: "Rate", message: "salah" }] };
  const xml = generateCoretaxXml(CORETAX_MODULES.bpu, "1234567890123456", [row]);
  for (const forbidden of ["internal-only", "perlu-diperbaiki", "rowId", "<status>", "Keterangan Kesalahan", "salah"]) {
    assert.equal(xml.includes(forbidden), false, `XML tidak boleh memuat "${forbidden}"`);
  }
});

// ---- Nama file & sanitasi ----

test("nama file mengikuti pola resmi: KODE_YYYY-MM_NamaDraft.xml untuk modul bulanan", () => {
  const name = coretaxFileName(CORETAX_MODULES.bpu, { year: "2026", month: "8" }, "NamaDraft");
  assert.equal(name, "BPPU_2026-08_NamaDraft.xml");
});

test("nama file BPA1 hanya Tahun Pajak (tidak ada Masa Pajak tunggal)", () => {
  const name = coretaxFileName(CORETAX_MODULES.bpa1, { year: "2026" }, "NamaDraft");
  assert.equal(name, "BPA1_2026_NamaDraft.xml");
});

test("sanitizeFileNamePart membuang karakter tidak aman untuk nama file", () => {
  assert.equal(sanitizeFileNamePart('A/B\\C:D*E?F"G<H>I|J'), "ABCDEFGHIJ");
  assert.equal(sanitizeFileNamePart("   "), "Draft");
});

// ---- Golden XML per modul — struktural: root, wrapper, row, TIN, jumlah row, urutan elemen, tidak ada field tambahan ----

function extractTags(xml: string): string[] {
  return [...xml.matchAll(/<([A-Za-z0-9]+)(?:\s[^>]*)?\/?>/g)].map((m) => m[1]).filter((tag) => tag !== "TIN");
}

test("Golden XML BPU: root BpuBulk, TIN tepat setelah root, ListOfBpu > Bpu, urutan elemen persis konfigurasi", () => {
  const row = rowFor("bpu", {
    TaxPeriodMonth: "6", TaxPeriodYear: "2026", CounterpartTin: "3172024806201234",
    IDPlaceOfBusinessActivityOfIncomeRecipient: "3172024806201234000000", TaxCertificate: "N/A",
    TaxObjectCode: "24-104-06", TaxBase: "10000000", Rate: "20", Document: "StatementLetter",
    DocumentNumber: "string", DocumentDate: "2026-01-28", IDPlaceOfBusinessActivity: "000000",
    GovTreasurerOpt: "N/A", SP2DNumber: "", WithholdingDate: "2026-03-18",
  });
  const xml = generateCoretaxXml(CORETAX_MODULES.bpu, "1234567890123456", [row]);

  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/);
  assert.match(xml, /<BpuBulk xsi:noNamespaceSchemaLocation="schema\.xsd" xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance">\n {2}<TIN>1234567890123456<\/TIN>/);
  assert.equal((xml.match(/<Bpu>/g) ?? []).length, 1, "jumlah row harus sesuai jumlah baris input");
  assert.match(xml, /<\/BpuBulk>\s*$/);

  const bodyStart = xml.indexOf("<Bpu>");
  const bodyEnd = xml.indexOf("</Bpu>");
  const rowXml = xml.slice(bodyStart, bodyEnd);
  const fieldTags = [...rowXml.matchAll(/<([A-Za-z0-9]+)[^>]*>/g)].map((m) => m[1]).filter((t) => t !== "Bpu");
  assert.deepEqual(fieldTags, CORETAX_MODULES.bpu.fields.map((f) => f.key), "urutan elemen dalam <Bpu> harus persis urutan konfigurasi");
  assert.equal(fieldTags.length, 15, "tidak boleh ada field tambahan di luar 15 field resmi");
});

test("Golden XML BPMP: root MmPayrollBulk, ListOfMmPayroll > MmPayroll, 2 baris tidak tertukar urutannya", () => {
  const row1 = rowFor("bpmp", { TaxPeriodMonth: "3", TaxPeriodYear: "2026", CounterpartOpt: "Resident", CounterpartTin: "1111111111111111", StatusTaxExemption: "K/0", Position: "CEO", TaxCertificate: "N/A", TaxObjectCode: "21-100-01", Gross: "40000000", Rate: "16", IDPlaceOfBusinessActivity: "000000", WithholdingDate: "2026-03-18" });
  const row2 = rowFor("bpmp", { TaxPeriodMonth: "3", TaxPeriodYear: "2026", CounterpartOpt: "Foreign", CounterpartPassport: "ABC-123", CounterpartTin: "2222222222222222", StatusTaxExemption: "K/0", Position: "staff", TaxCertificate: "N/A", TaxObjectCode: "21-100-32", Gross: "100000000", Rate: "24", IDPlaceOfBusinessActivity: "000000", WithholdingDate: "2026-03-18" });
  const xml = generateCoretaxXml(CORETAX_MODULES.bpmp, "9999999999999999", [row1, row2]);

  assert.match(xml, /<MmPayrollBulk /);
  assert.match(xml, /<ListOfMmPayroll>/);
  assert.equal((xml.match(/<MmPayroll>/g) ?? []).length, 2);
  const firstTinIndex = xml.indexOf("<CounterpartTin>1111111111111111</CounterpartTin>");
  const secondTinIndex = xml.indexOf("<CounterpartTin>2222222222222222</CounterpartTin>");
  assert.ok(firstTinIndex > 0 && secondTinIndex > firstTinIndex, "baris kedua harus muncul setelah baris pertama, tidak tertukar");
});

test("Golden XML BP21: root Bp21Bulk, ListOfBp21 > Bp21, tidak ada field tambahan", () => {
  const row = rowFor("bp21", { TaxPeriodMonth: "3", TaxPeriodYear: "2026", CounterpartTin: "1234567890123456", IDPlaceOfBusinessActivityOfIncomeRecipient: "000000", StatusTaxExemption: "TK/1", TaxCertificate: "N/A", TaxObjectCode: "21-100-14", Gross: "1000000", Deemed: "50", Rate: "12.5", Document: "Contract", DocumentNumber: "Test", DocumentDate: "2026-11-16", IDPlaceOfBusinessActivity: "000000", WithholdingDate: "2026-08-14" });
  const xml = generateCoretaxXml(CORETAX_MODULES.bp21, "1234567890123456", [row]);
  assert.match(xml, /<Bp21Bulk /);
  assert.match(xml, /<ListOfBp21>[\s\S]*<Bp21>[\s\S]*<\/Bp21>[\s\S]*<\/ListOfBp21>/);
  const tags = extractTags(xml.slice(xml.indexOf("<Bp21>"), xml.indexOf("</Bp21>"))).filter((t) => t !== "Bp21");
  assert.deepEqual(tags, CORETAX_MODULES.bp21.fields.map((f) => f.key));
});

test("Golden XML BPA1: root A1Bulk, ListOfA1 > A1, 27 field lengkap tanpa tambahan", () => {
  const row = rowFor("bpa1", {
    WorkForSecondEmployer: "No", TaxPeriodMonthStart: "1", TaxPeriodMonthEnd: "10", TaxPeriodYear: "2026",
    CounterpartOpt: "Foreign", CounterpartPassport: "", CounterpartTin: "1234567890123456", TaxExemptOpt: "TK/0",
    StatusOfWithholding: "PartialYear", CounterpartPosition: "staff", TaxObjectCode: "21-100-01", NumberOfMonths: "0",
    SalaryPensionJhtTht: "10000000", GrossUpOpt: "Yes", IncomeTaxBenefit: "5000000", OtherBenefit: "7000000",
    Honorarium: "3000000", InsurancePaidByEmployer: "2000000", Natura: "5000000", TantiemBonusThr: "5000000",
    PensionContributionJhtThtFee: "5000000", Zakat: "6400000", PrevWhTaxSlip: "", TaxCertificate: "N/A",
    Article21IncomeTax: "64000000", IDPlaceOfBusinessActivity: "000000", WithholdingDate: "2026-12-21",
  });
  const xml = generateCoretaxXml(CORETAX_MODULES.bpa1, "0029482015507000", [row]);
  assert.match(xml, /<A1Bulk /);
  assert.match(xml, /<ListOfA1>[\s\S]*<A1>[\s\S]*<\/A1>[\s\S]*<\/ListOfA1>/);
  assert.match(xml, /<CounterpartPassport \/>/);
  assert.match(xml, /<PrevWhTaxSlip \/>/);
  const tags = extractTags(xml.slice(xml.indexOf("<A1>"), xml.indexOf("</A1>"))).filter((t) => t !== "A1");
  assert.deepEqual(tags, CORETAX_MODULES.bpa1.fields.map((f) => f.key));
  assert.equal(tags.length, 27);
});
