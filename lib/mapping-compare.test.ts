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

  test("label yang memang hanya dua kata tidak ikut terpangkas", () => {
    assert.equal(normalizeFinancialLabel("Biaya Sewa"), "biaya sewa");
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

  test("kedua aturan Neraca aktif dan sudah terverifikasi angkanya", () => {
    const rules = rulesForReport("balance-sheet");
    assert.equal(rules.length, 2);
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

  test("label yang bergeser muncul apa adanya, TIDAK diperbaiki sendiri", () => {
    // Keputusan pengguna: biarkan tampil sebagai beda/tidak berjodoh sampai
    // diputuskan apakah ini salah input atau pemetaan yang disengaja.
    const perlengkapan = findRow(result.rows, /^Biaya perlengkapan$/);
    assert.equal(perlengkapan.status, "BEDA");
    assert.equal(perlengkapan.excelValue, 17059300);
    assert.equal(perlengkapan.pdfValue, 8336399);

    const penyusutan = findRow(result.rows, /^Biaya penyusutan$/);
    assert.equal(penyusutan.status, "HANYA_EXCEL");
    assert.equal(penyusutan.excelValue, 8336399);

    const airListrik = findRow(result.rows, /^Biaya air listrik telephone$/);
    assert.equal(airListrik.status, "HANYA_PDF");
    assert.equal(airListrik.pdfValue, 17059300);
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

  test("ringkasan: hanya 1 selisih sungguhan, dan hanya-Excel tinggal baris yang berisi", () => {
    assert.equal(result.summary.beda, 1);
    assert.equal(result.summary.cocok, 26);
    // Dulu 28 hanya-Excel; 27 di antaranya akun nihil yang tidak dicetak PDF
    // dan sekarang tidak ikut keluar sama sekali.
    assert.equal(result.summary.hanyaExcel, 1);
    assert.equal(result.summary.hanyaPdf, 1);
  });
});

describe("perbandingan Mei 2026 (Excel vs PDF digital)", () => {
  const result = compareFinancialReports(excelLines("2026-05"), pdfLines("mapping-laba-rugi-mei-2026-digital"));

  test("mayoritas baris cocok tanpa perlu kelonggaran", () => {
    assert.ok(result.summary.cocok >= 50, `cocok=${result.summary.cocok}`);
  });

  test("aturan Penjualan JUSTRU membuat selisih di periode ini", () => {
    // Bukti bahwa aturan itu terikat periode. Mei 2026 mencetak 40000 dan
    // 40003 sebagai dua baris terpisah di PDF, persis seperti Excel, jadi
    // menjumlahkan keduanya di sisi Excel menghasilkan selisih palsu sebesar
    // nilai Sewa Raket Padel. Ditulis sebagai test supaya perilaku ini
    // tercatat, bukan jadi kejutan saat dipakai lintas bulan.
    const row = findRow(result.rows, /^Penjualan$/);
    assert.equal(row.status, "BEDA");
    assert.equal(row.excelValue, 61700000);
    assert.equal(row.pdfValue, 33230000);
    assert.equal(row.difference, 28470000);
    assert.equal(findRow(result.rows, /^Pendapatan Sewa Raket Padel$/).status, "HANYA_PDF");
  });

  test("pergeseran label biaya operasional konsisten dengan Februari", () => {
    // Excel tidak punya akun "Biaya air listrik telephone" sama sekali,
    // sehingga seluruh akun setelah Biaya Gaji bergeser satu baris: nilai
    // Excel pada baris N adalah nilai PDF pada baris N+1.
    assert.equal(findRow(result.rows, /^Biaya perlengkapan$/).excelValue, 0);
    assert.equal(findRow(result.rows, /^Biaya perlengkapan$/).pdfValue, 10793100);
    assert.equal(findRow(result.rows, /^Biaya penyusutan$/).excelValue, 10793100);
    assert.equal(findRow(result.rows, /^Biaya Transfer$/).excelValue, 584156);
  });
});

describe("penjodohan tidak pernah menebak", () => {
  const base: FinancialLine = { code: null, label: "", value: 0, kind: "detail", assumedZero: false };

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
  const result = compareFinancialReports(excelLines("2026-02", "balance-sheet"), pdfLines("mapping-laba-rugi-feb-2026-scan", "balance-sheet"), "balance-sheet");

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

  test("laba ditahan digabung dengan pendapatan periode berjalan", () => {
    const row = findRow(result.rows, /^Laba rugi ditahan$/);
    assert.equal(row.status, "COCOK");
    assert.equal(row.excelValue, -3291718.22);
    assert.equal(row.pdfValue, -3291718.22);
    assert.ok(row.rule);
  });

  test("kedua aturan benar-benar terpakai, tidak ada yang dilewati", () => {
    assert.deepEqual(result.appliedRules.map((rule) => rule.target).sort(), ["Kas dan Bank", "Laba rugi ditahan"]);
    assert.deepEqual(result.skippedRules, []);
    assert.equal(result.appliedRules.every((rule) => rule.verified), true);
  });

  test("tidak ada satu pun selisih angka; yang tersisa hanya beda penamaan", () => {
    assert.equal(result.summary.beda, 0);
    assert.equal(result.summary.cocok, 15);
    // "Piutang Sewa Lapangan" vs "Piutang Court Fee", "Persedian" vs
    // "Persediaan", "Jumlah Aset Lancar" vs "Total Aset Lancar" — beda label,
    // bukan beda angka. Dibiarkan tampil apa adanya, tidak dijodohkan paksa.
    assert.equal(result.summary.hanyaExcel, 3);
    assert.equal(result.summary.hanyaPdf, 3);
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
    assert.equal(result.summary.cocok, 9);
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
