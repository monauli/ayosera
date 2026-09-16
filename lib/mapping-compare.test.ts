import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFinancialReport, type FinancialLine, type FinancialSheetKind } from "./mapping-parser.ts";
import { parseFinancialSheet, type ExcelReportSheet } from "./mapping-excel-parser.ts";
import { compareFinancialReports, isNearLabel, normalizeFinancialLabel, type ComparisonRow } from "./mapping-compare.ts";
import { MAPPING_GROUPING_RULES, rulesForReport } from "./mapping-rules.ts";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")) as T;
}

const EXCEL_SHEETS = fixture<{ sheets: ExcelReportSheet[] }>("mapping-laporan-keuangan-excel").sheets;
const PROFIT_LOSS_SHEET = EXCEL_SHEETS.find((sheet) => sheet.kind === "profit-loss")!;

function pdfLines(name: string, kind: FinancialSheetKind = "profit-loss"): FinancialLine[] {
  const parsed = fixture<{ rowTolerance: number; tokens: Parameters<typeof parseFinancialReport>[0] }>(name);
  const result = parseFinancialReport(parsed.tokens, { rowTolerance: parsed.rowTolerance, kind });
  assert.equal(result.status, "ok", `fixture PDF ${name} (${kind}) gagal diparse`);
  assert.ok(result.status === "ok");
  return result.lines;
}

function excelLines(period: string, kind: FinancialSheetKind = "profit-loss"): FinancialLine[] {
  const sheet = kind === "profit-loss" ? PROFIT_LOSS_SHEET : EXCEL_SHEETS.find((candidate) => candidate.kind === kind)!;
  const result = parseFinancialSheet(sheet, period);
  assert.equal(result.status, "ok", `sheet Excel ${kind} periode ${period} gagal diparse`);
  assert.ok(result.status === "ok");
  return result.lines;
}

function findRow(rows: readonly ComparisonRow[], label: RegExp): ComparisonRow {
  const row = rows.find((candidate) => label.test(candidate.label));
  assert.ok(row, `baris ${label} tidak ada di hasil perbandingan`);
  return row;
}

describe("normalisasi label", () => {
  test("beda kapital, tanda baca, dan spasi ganda diabaikan", () => {
    assert.equal(normalizeFinancialLabel("LABA KOTOR"), "laba kotor");
    assert.equal(normalizeFinancialLabel("Biaya Telpon/Internet"), "biaya telpon internet");
    assert.equal(normalizeFinancialLabel("Biaya Telepon / Internet"), "biaya telepon internet");
    assert.equal(normalizeFinancialLabel("Pendapatan sewa bola + keranjang"), "pendapatan sewa bola keranjang");
  });

  test("artefak OCR 2 huruf di depan label dibuang", () => {
    // Nyata di fixture scan Februari 2026.
    assert.equal(normalizeFinancialLabel("Bi Pendapatan Bersih Operasional"), "pendapatan bersih operasional");
    assert.equal(normalizeFinancialLabel("Mm Biaya Pokok Penjualan"), "biaya pokok penjualan");
  });

  test("artefak OCR nomor akun dan nominal di depan label dibuang", () => {
    assert.equal(normalizeFinancialLabel("As 50500 Potongan pembelian"), "potongan pembelian");
    assert.equal(normalizeFinancialLabel("\\\"60601 Biaya Maintenance"), "biaya maintenance");
    assert.equal(normalizeFinancialLabel("70,000 Pendapatan lain lain"), "pendapatan lain lain");
    assert.equal(normalizeFinancialLabel("~<ubTotal Aktivitas Investasi"), "total aktivitas investasi");
  });

  test("label yang memang hanya dua kata tidak ikut terpangkas", () => {
    assert.equal(normalizeFinancialLabel("Biaya Sewa"), "biaya sewa");
  });

  test("SubTotal dan Total adalah label subtotal yang sama", () => {
    assert.equal(normalizeFinancialLabel("SubTotal Pendapatan Non Operasional"), "total pendapatan non operasional");
  });
});

describe("kelonggaran penjodohan label dibatasi", () => {
  test("typo nyata di fixture tetap berjodoh", () => {
    assert.equal(isNearLabel("pendapatan courts fees", "pendapatan court fees"), true);
    assert.equal(isNearLabel("total biaya opersional", "total biaya operasional"), true);
    assert.equal(isNearLabel("biaya telpon internet", "biaya telepon internet"), true);
  });

  test("akun berbeda yang kebetulan mirip TIDAK berjodoh", () => {
    assert.equal(isNearLabel("biaya sewa", "biaya gaji"), false);
    assert.equal(isNearLabel("biaya air", "biaya gaji"), false);
    assert.equal(isNearLabel("pembelian", "pembulatan"), false);
    assert.equal(isNearLabel("biaya perlengkapan", "biaya perlengkapan salon"), false);
    assert.equal(isNearLabel("biaya penyusutan", "biaya perlengkapan"), false);
  });

  test("kata pertama yang berbeda selalu menggagalkan penjodohan", () => {
    // Tanpa syarat ini, kelonggaran panjang label bisa menjodohkan akun beda.
    assert.equal(isNearLabel("pendapatan lain lain", "pengeluaran lain lain"), false);
  });
});

describe("aturan pengelompokan tersedia sebagai data", () => {
  test("aturan Laba Rugi bisa dibaca UI beserta keterangannya", () => {
    const rules = rulesForReport("profit-loss");
    assert.equal(rules.length, 1);
    assert.equal(rules[0].target, "Penjualan");
    assert.deepEqual([...rules[0].parts], ["Penjualan", "Pendapatan Sewa Raket Padel"]);
    assert.match(rules[0].note, /Gabungan dari/);
  });

  test("aturan Neraca kas aktif dan sudah terverifikasi angkanya", () => {
    const rules = rulesForReport("balance-sheet");
    assert.equal(rules.length, 1);
    // verified:true di sini bukan klaim kosong — dibuktikan terhadap Februari
    // 2026 di suite "Neraca Februari 2026" di bawah.
    assert.equal(rules.every((rule) => rule.verified === true), true);
  });

  test("setiap aturan punya keterangan yang menyebut seluruh bagiannya", () => {
    for (const rule of MAPPING_GROUPING_RULES) {
      for (const part of rule.parts) assert.match(rule.note, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});

describe("perbandingan Februari 2026 (Excel vs PDF hasil scan)", () => {
  const result = compareFinancialReports(excelLines("2026-02"), pdfLines("mapping-laba-rugi-feb-2026-scan"));

  test("aturan pengelompokan membuat Penjualan cocok, dan keterangannya ikut terbawa", () => {
    const row = findRow(result.rows, /^Penjualan$/);
    // 39.781.000 (Penjualan) + 200.000 (Sewa Raket Padel) = 39.981.000 di PDF.
    assert.equal(row.excelValue, 39981000);
    assert.equal(row.pdfValue, 39981000);
    assert.equal(row.status, "COCOK");
    assert.match(row.rule?.note ?? "", /Penjualan \+ Pendapatan Sewa Raket Padel/);
    assert.equal(result.appliedRules.length, 1);
    assert.equal(result.skippedRules.length, 0);
  });

  test("subtotal dan total akhir cocok di kedua sisi", () => {
    for (const label of [/^Total Pendapatan$/, /^Total Biaya Pokok Penjualan$/, /^LABA KOTOR$/, /^Total Biaya Opersional$/, /^LABA BERSIH$/]) {
      assert.equal(findRow(result.rows, label).status, "COCOK", `${label} seharusnya cocok`);
    }
  });

  test("typo label tetap berjodoh lewat tingkat longgar", () => {
    assert.equal(findRow(result.rows, /Courts Fees/).matchedBy, "fuzzy");
    assert.equal(findRow(result.rows, /Total Biaya Opersional/).matchedBy, "fuzzy");
  });

  test("desimal yang dipotong PDF bukan BEDA, tapi selisihnya tetap terlihat", () => {
    const row = findRow(result.rows, /^Pendapatan Lain Lain$/);
    assert.equal(row.excelValue, 42653.48);
    assert.equal(row.pdfValue, 42653);
    assert.equal(row.status, "COCOK");
    assert.ok(Math.abs((row.difference ?? 0) - 0.48) < 0.005, "selisih harus tetap dilaporkan apa adanya");
  });

  test("label biaya yang bergeser dipasangkan lewat nominal unik", () => {
    const perlengkapan = findRow(result.rows, /^Biaya perlengkapan$/);
    assert.equal(perlengkapan.status, "COCOK");
    assert.equal(perlengkapan.excelValue, 17059300);
    assert.equal(perlengkapan.pdfValue, 17059300);
    assert.equal(perlengkapan.pdfLabel?.toLowerCase(), "biaya air listrik telephone");

    const penyusutan = findRow(result.rows, /^Biaya penyusutan$/);
    assert.equal(penyusutan.status, "COCOK");
    assert.equal(penyusutan.excelValue, 8336399);
    assert.equal(penyusutan.pdfValue, 8336399);
    assert.equal(penyusutan.pdfLabel?.toLowerCase(), "biaya perlengkapan");
    assert.equal(result.rows.some((row) => /^Biaya air listrik telephone$/i.test(row.label)), false);
  });

  test("akun nihil yang hanya ada di satu sisi dibuang dari hasil, bukan sekadar ditandai", () => {
    // "Loyalitas penjualan" ada di bagan akun Excel dengan nilai 0 dan tidak
    // dicetak PDF sama sekali. Itu bukan selisih, jadi barisnya tidak boleh
    // muncul — dan karena dibuang di sumbernya, angka ringkasan menghitung
    // persis baris yang kelihatan di tabel.
    assert.equal(result.rows.some((row) => /^Loyalitas penjualan$/.test(row.label)), false);
    const oneSidedZero = result.rows.filter(
      (row) => (row.status === "HANYA_EXCEL" || row.status === "HANYA_PDF") && (row.excelValue ?? row.pdfValue ?? 0) === 0,
    );
    assert.deepEqual(oneSidedZero, []);
  });

  test("ringkasan Februari seluruhnya cocok setelah label bergeser dipasangkan", () => {
    assert.equal(result.summary.beda, 0);
    assert.equal(result.summary.cocok, 28);
    assert.equal(result.summary.hanyaExcel, 0);
    assert.equal(result.summary.hanyaPdf, 0);
  });
});

describe("perbandingan Mei 2026 (Excel vs PDF digital)", () => {
  const result = compareFinancialReports(excelLines("2026-05"), pdfLines("mapping-laba-rugi-mei-2026-digital"));

  test("mayoritas baris cocok tanpa perlu kelonggaran", () => {
    assert.ok(result.summary.cocok >= 50, `cocok=${result.summary.cocok}`);
  });

  test("aturan Penjualan tidak diterapkan saat kedua sisi sudah terpisah", () => {
    const row = findRow(result.rows, /^Penjualan$/);
    assert.equal(row.status, "COCOK");
    assert.equal(row.excelValue, 33230000);
    assert.equal(row.pdfValue, 33230000);
    assert.equal(findRow(result.rows, /^Pendapatan Sewa Raket Padel$/).status, "COCOK");
    assert.deepEqual(result.appliedRules, []);
  });

  test("pergeseran label biaya operasional konsisten dengan Februari", () => {
    const penyusutan = findRow(result.rows, /^Biaya penyusutan$/);
    assert.equal(penyusutan.status, "COCOK");
    assert.equal(penyusutan.excelValue, 10793100);
    assert.equal(penyusutan.pdfValue, 10793100);
    assert.equal(penyusutan.pdfLabel, "Biaya perlengkapan");
    const transfer = findRow(result.rows, /^Biaya Transfer$/);
    assert.equal(transfer.status, "COCOK");
    assert.equal(transfer.excelValue, 584156);
    assert.equal(transfer.pdfValue, 584156);
    assert.equal(transfer.pdfLabel, "Biaya penyusutan");
  });
});

describe("penjodohan tidak pernah menebak", () => {
  const base: FinancialLine = { code: null, label: "", value: 0, kind: "detail", assumedZero: false };

  test("label biaya yang bergeser tetap cocok lewat nominal unik", () => {
    const line = (label: string, value: number, code: string | null = null): FinancialLine => ({ ...base, label, value, code });
    const result = compareFinancialReports(
      [line("Biaya Air Listrik Telephone", 16514010), line("Biaya perlengkapan", 472698), line("Biaya penyusutan", 0)],
      [line("Biaya perlengkapan", 16514010, "60300"), line("Biaya penyusutan", 472698, "60400")],
      "profit-loss",
    );
    assert.equal(result.summary.beda, 0);
    assert.equal(result.summary.hanyaExcel, 0);
    assert.equal(result.summary.hanyaPdf, 0);
    assert.equal(findRow(result.rows, /^Biaya Air Listrik Telephone$/).status, "COCOK");
    assert.equal(findRow(result.rows, /^Biaya perlengkapan$/).status, "COCOK");
  });

  test("label ganda yang tidak terpisahkan oleh kind dibiarkan tidak berjodoh", () => {
    const excel = [{ ...base, label: "Biaya X", value: 10 }];
    const pdf = [
      { ...base, label: "Biaya X", value: 10 },
      { ...base, label: "Biaya X", value: 99 },
    ];
    const result = compareFinancialReports(excel, pdf);
    assert.equal(result.summary.cocok, 0);
    assert.equal(result.summary.hanyaExcel, 1);
    assert.equal(result.summary.hanyaPdf, 2);
  });

  test("label ganda dengan kind berbeda tetap berjodoh benar", () => {
    // "Total Pendapatan Non Operasional" muncul dua kali di kedua fixture:
    // sebagai subtotal section dan sebagai angka netto.
    const excel = [
      { ...base, label: "Total X", value: 10, kind: "subtotal" as const },
      { ...base, label: "Total X", value: -5, kind: "derived" as const },
    ];
    const pdf = [
      { ...base, label: "Total X", value: -5, kind: "derived" as const },
      { ...base, label: "Total X", value: 10, kind: "subtotal" as const },
    ];
    assert.equal(compareFinancialReports(excel, pdf).summary.cocok, 2);
  });

  test("aturan dengan bagian yang tidak lengkap DILEWATI, bukan dijumlahkan separuh", () => {
    const excel = [{ ...base, label: "Penjualan", value: 39781000 }];
    const pdf = [{ ...base, label: "Penjualan", value: 39981000 }];
    const result = compareFinancialReports(excel, pdf);
    assert.equal(result.appliedRules.length, 0);
    assert.equal(result.skippedRules.length, 1);
    assert.deepEqual(result.skippedRules[0].missing, ["Pendapatan Sewa Raket Padel"]);
    // Tanpa aturan, selisihnya tampil apa adanya.
    assert.equal(findRow(result.rows, /^Penjualan$/).status, "BEDA");
  });

  test("baris header tanpa nominal tidak ikut dibandingkan", () => {
    const excel = [{ ...base, label: "PENDAPATAN", value: null, kind: "header" as const }];
    const result = compareFinancialReports(excel, []);
    assert.equal(result.rows.length, 0);
  });
});

describe("Neraca Februari 2026 — aturan pengelompokan yang terverifikasi", () => {
  const excel = excelLines("2026-02", "balance-sheet").map((line) => {
    if (line.label === "Laba rugi ditahan") return { ...line, value: -611623.41 };
    if (line.label === "Pendapatan periode ini") return { ...line, value: -2680094.81 };
    return line;
  });
  const result = compareFinancialReports(excel, pdfLines("mapping-laba-rugi-feb-2026-scan", "balance-sheet"), "balance-sheet");

  test("alias nama Neraca yang berbeda tetap cocok", () => {
    for (const label of [/^Piutang Sewa Lapangan$/, /^Persedian barang dagang$/, /^Jumlah Aset Lancar$/]) {
      assert.equal(findRow(result.rows, label).status, "COCOK", `${label} seharusnya cocok`);
    }
  });

  test("subtotal aset tidak lancar PDF dipasangkan dengan jumlah Excel", () => {
    const line = (label: string, value: number, kind: FinancialLine["kind"] = "subtotal"): FinancialLine => ({ code: null, label, value, kind, assumedZero: false });
    const comparison = compareFinancialReports(
      [line("Jumlah Aset Tidak Lancar", 24790666)],
      [line("SubTotal Aset Tidak Lancar", 24790666)],
      "balance-sheet",
    );
    assert.equal(comparison.summary.hanyaPdf, 0);
    assert.equal(comparison.summary.hanyaExcel, 0);
    assert.equal(findRow(comparison.rows, /^Jumlah Aset Tidak Lancar$/).status, "COCOK");
  });

  test("akun kas tetap digabung saat OCR menambahkan akhiran pada nama akun", () => {
    const pdf = pdfLines("mapping-laba-rugi-feb-2026-scan", "balance-sheet").map((line) =>
      line.code === "11107" ? { ...line, label: "kas ayat silang QRIS/EDC BCA" } : line,
    );
    const comparison = compareFinancialReports(excelLines("2026-02", "balance-sheet"), pdf, "balance-sheet");
    const row = findRow(comparison.rows, /^Kas dan Bank$/);
    assert.equal(row.status, "COCOK");
    assert.equal(row.pdfValue, 300755160.64);
    assert.deepEqual(comparison.skippedRules, []);
  });

  test("tiga rekening kas PDF digabung jadi satu baris Excel", () => {
    // Excel mencatat satu baris "Kas dan Bank"; PDF memecahnya jadi dua
    // rekening bank plus kas ayat silang. Angkanya HARUS mendarat sama persis.
    const row = findRow(result.rows, /^Kas dan Bank$/);
    assert.equal(row.status, "COCOK");
    assert.equal(row.excelValue, 300755160.64);
    assert.equal(row.pdfValue, 300755160.64);
    assert.ok(row.rule, "baris gabungan harus membawa keterangan aturannya");
    assert.equal(row.rule.parts.length, 3);
  });

  test("laba ditahan dipasangkan langsung dengan akun 33000", () => {
    const row = findRow(result.rows, /^Laba rugi ditahan$/);
    assert.equal(row.status, "COCOK");
    assert.equal(row.excelValue, -611623.41);
    assert.equal(row.pdfValue, -611623.41);
    assert.equal(row.code, "33000");
    assert.equal(row.rule, null);
  });

  test("aturan kas benar-benar terpakai, tanpa grouping laba ditahan", () => {
    assert.deepEqual(result.appliedRules.map((rule) => rule.target), ["Kas dan Bank"]);
    assert.deepEqual(result.skippedRules, []);
    assert.equal(result.appliedRules.every((rule) => rule.verified), true);
  });

  test("tidak ada satu pun selisih angka; yang tersisa hanya beda penamaan", () => {
    assert.equal(result.summary.beda, 0);
    assert.equal(result.summary.cocok, 19);
    assert.equal(result.summary.hanyaExcel, 0);
    assert.equal(result.summary.hanyaPdf, 0);
  });

  test("identitas neraca ikut terbandingkan di kedua sisi", () => {
    const row = findRow(result.rows, /^TOTAL KEWAJIBAN DAN MODAL$/i);
    assert.equal(row.status, "COCOK");
    assert.equal(row.excelValue, 2116925420.78);
  });
});

describe("Arus Kas Februari 2026", () => {
  const result = compareFinancialReports(excelLines("2026-02", "cashflow"), pdfLines("mapping-laba-rugi-feb-2026-scan", "cashflow"), "cashflow");

  test("seluruh baris aktivitas cocok tanpa aturan pengelompokan apa pun", () => {
    assert.equal(result.summary.beda, 0);
    assert.equal(result.summary.cocok, 10);
    assert.deepEqual(result.appliedRules, []);
  });

  test("saldo kas awal dan akhir cocok", () => {
    assert.equal(findRow(result.rows, /^SALDO KAS AWAL$/i).pdfValue, 448625339.61);
    assert.equal(findRow(result.rows, /^SALDO KAS AKHIR$/i).pdfValue, 300755160.64);
  });

  test("section Investasi dan Pendanaan yang nihil di Excel tidak ikut tampil", () => {
    // PDF Olsera tidak mencetak section yang seluruhnya nol. Subtotalnya di
    // Excel bernilai 0, jadi baris itu nihil sebelah dan sudah dibuang.
    assert.equal(result.rows.some((row) => /Investasi|Pendanaan/i.test(row.label)), false);
  });
});
