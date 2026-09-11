import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detectMonthColumns,
  parseFinancialSheet,
  parseFinancialWorkbook,
  sheetKindFromName,
  type ExcelFinancialLine,
  type ExcelReportSheet,
} from "./mapping-excel-parser.ts";

/**
 * JSON tidak punya tipe tanggal, jadi sel tanggal di fixture tersimpan sebagai
 * string ISO dan dihidupkan lagi di sini. Di produksi ExcelJS langsung
 * mengembalikan Date — reviver ini murni artefak round-trip fixture.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function loadSheets(): ExcelReportSheet[] {
  const raw = readFileSync(new URL("./__fixtures__/mapping-laporan-keuangan-excel.json", import.meta.url), "utf8");
  return (JSON.parse(raw, (_key, value) => (typeof value === "string" && ISO_DATE.test(value) ? new Date(value) : value)) as { sheets: ExcelReportSheet[] }).sheets;
}

const SHEETS = loadSheets();

function sheetOf(kind: string): ExcelReportSheet {
  const sheet = SHEETS.find((s) => s.kind === kind);
  assert.ok(sheet, `sheet ${kind} tidak ada di fixture`);
  return sheet;
}

function assertAmount(actual: number | null | undefined, expected: number, message: string): void {
  assert.ok(actual !== null && actual !== undefined, `${message}: nilai tidak ada`);
  assert.ok(Math.abs(actual - expected) < 0.005, `${message}: dapat ${actual}, seharusnya ${expected}`);
}

function findLabel(lines: readonly ExcelFinancialLine[], pattern: RegExp): ExcelFinancialLine {
  const line = lines.find((l) => pattern.test(l.label.trim()));
  assert.ok(line, `baris ${pattern} tidak ditemukan`);
  return line;
}

describe("pengenalan sheet", () => {
  test("tiga laporan dikenali dari nama, kerangka manual diabaikan", () => {
    assert.equal(sheetKindFromName("Profit & Loss fokus laba rugi"), "profit-loss");
    assert.equal(sheetKindFromName("Balance Sheet fokus neraca"), "balance-sheet");
    assert.equal(sheetKindFromName("Cashflow Arus kas"), "cashflow");
    assert.equal(sheetKindFromName("cocokan dengan BA"), null);
  });

  test("fixture hanya memuat tiga sheet laporan", () => {
    assert.deepEqual(SHEETS.map((s) => s.kind).sort(), ["balance-sheet", "cashflow", "profit-loss"]);
  });
});

describe("deteksi kolom bulan", () => {
  const { headerRow, columns } = detectMonthColumns(sheetOf("profit-loss").rows);

  test("baris header ditemukan dari isi, bukan nomor baris yang di-hardcode", () => {
    assert.equal(headerRow, 6);
  });

  test("setiap bulan terpetakan ke kolomnya", () => {
    // Kolom A = 0, jadi B = 1 (Nov 2025) ... E = 4 (Feb 2026).
    assert.equal(columns.get("2026-02"), 4);
    assert.equal(columns.get("2025-11"), 1);
    assert.equal(columns.get("2026-07"), 9);
    assert.equal(columns.size, 9);
  });

  test("baris berisi angka tahun telanjang tidak disalahkira sebagai header", () => {
    // Baris 4 memuat 2025 dan 2026 sebagai angka, bukan tanggal.
    assert.notEqual(headerRow, 4);
  });
});

describe("Profit & Loss Februari 2026 — cocok dengan angka terverifikasi dari Tahap 1", () => {
  const result = parseFinancialSheet(sheetOf("profit-loss"), "2026-02");

  test("diterima", () => {
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.monthColumn, 4);
  });

  test("subtotal dan total akhir sama persis dengan hasil parser PDF", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLabel(result.lines, /^Total Pendapatan$/i).value, 152862900, "Total Pendapatan");
    assertAmount(findLabel(result.lines, /^Total Biaya Pokok Penjualan$/i).value, 32428163.86, "Total BPP");
    assertAmount(findLabel(result.lines, /^LABA KOTOR$/i).value, 120434736.14, "Laba Kotor");
    assertAmount(findLabel(result.lines, /^Total Biaya Opersional$/i).value, 122584699, "Total Biaya Operasional");
    assertAmount(findLabel(result.lines, /^LABA BERSIH$/i).value, -2670588.83, "Laba Bersih");
  });

  test("baris detail keluar apa adanya, TANPA digabung ke bentuk PDF", () => {
    assert.ok(result.status === "ok");
    // Tahap 4 yang akan menyatukan dua baris ini jadi "Penjualan" versi PDF
    // (39.981.000). Tahap 2 tidak boleh menyentuhnya.
    assertAmount(findLabel(result.lines, /^Penjualan$/i).value, 39781000, "Penjualan");
    assertAmount(findLabel(result.lines, /^Pendapatan Sewa Raket Padel$/i).value, 200000, "Sewa Raket Padel");
    assertAmount(findLabel(result.lines, /^Pendapatan Courts Fees$/i).value, 98453500, "Court Fees");
    assertAmount(findLabel(result.lines, /^Penjualan produk LABERS$/i).value, 15033000, "LABERS");
  });

  test("sel kosong jadi 0, dan Excel menyimpan desimal yang dipotong di PDF", () => {
    assert.ok(result.status === "ok");
    assertAmount(findLabel(result.lines, /^Pendapatan Pickleball AMP$/i).value, 0, "Pickleball AMP");
    // PDF mencetak 42.653 (desimal terpotong); Excel menyimpan nilai penuh.
    assertAmount(findLabel(result.lines, /^Pendapatan Lain Lain$/i).value, 42653.48, "Pendapatan Lain Lain");
  });

  test("klasifikasi baris ikut bentuk parser PDF", () => {
    assert.ok(result.status === "ok");
    assert.equal(findLabel(result.lines, /^PENDAPATAN$/).kind, "header");
    assert.equal(findLabel(result.lines, /^Total Pendapatan$/i).kind, "subtotal");
    assert.equal(findLabel(result.lines, /^LABA KOTOR$/i).kind, "derived");
    assert.equal(findLabel(result.lines, /^Penjualan$/i).kind, "detail");
    // Excel tidak punya kode akun sama sekali — pencocokan Tahap 4 lewat label.
    assert.equal(result.lines.every((l) => l.code === null), true);
  });

  test("seluruh cek rekonsiliasi lulus", () => {
    assert.ok(result.status === "ok");
    assert.equal(result.checks.every((c) => c.passed), true);
    assert.equal(result.checks.filter((c) => c.kind === "section").length, 5);
  });
});

describe("Neraca dan Arus Kas Februari 2026", () => {
  test("Neraca seimbang: Total Aset = Total Kewajiban dan Modal", () => {
    const result = parseFinancialSheet(sheetOf("balance-sheet"), "2026-02");
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assertAmount(findLabel(result.lines, /^TOTAL ASET$/i).value, 2116925420.78, "Total Aset");
    assertAmount(findLabel(result.lines, /^TOTAL KEWAJIBAN DAN MODAL$/i).value, 2116925420.78, "Total Kewajiban dan Modal");
    assertAmount(findLabel(result.lines, /^Kas dan Bank$/i).value, 300755160.64, "Kas dan Bank");
    assert.equal(result.checks.every((c) => c.passed), true);
  });

  test("subtotal berlabel 'Jumlah' ikut tertutup, bukan cuma 'Total'", () => {
    const result = parseFinancialSheet(sheetOf("balance-sheet"), "2026-02");
    assert.ok(result.status === "ok");
    assert.equal(findLabel(result.lines, /^Jumlah Aset Lancar$/i).kind, "subtotal");
    // Subtotal bernilai nihil tetap subtotal — kalau tidak, baris detail di
    // atasnya terbawa menjumlah ke section berikutnya.
    assert.equal(findLabel(result.lines, /^Jumlah Aset Tidak Lancar$/i).kind, "subtotal");
    assert.equal(findLabel(result.lines, /^TOTAL ASET$/i).kind, "derived");
  });

  test("Arus Kas: saldo awal + aktivitas = saldo akhir", () => {
    const result = parseFinancialSheet(sheetOf("cashflow"), "2026-02");
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assertAmount(findLabel(result.lines, /^SALDO KAS AKHIR$/i).value, 300755160.64, "Saldo Kas Akhir");
    assertAmount(findLabel(result.lines, /^Total Aktivasi opersional$/i).value, -147870178.97, "Total Aktivitas Operasional");
    assert.equal(result.checks.every((c) => c.passed), true);
  });

  test("subtotal dari sel shared-formula tanpa hasil ter-cache tetap terbaca", () => {
    // Baris 21 dan 26 sheet Arus Kas adalah {sharedFormula} tanpa `result`.
    const result = parseFinancialSheet(sheetOf("cashflow"), "2026-02");
    assert.ok(result.status === "ok");
    assert.equal(findLabel(result.lines, /^Total Aktivitas Investasi$/i).kind, "subtotal");
    assert.equal(findLabel(result.lines, /^Total Aktivitas Pendanaan$/i).kind, "subtotal");
  });

  test("ketiga sheet lolos untuk Februari 2026", () => {
    const results = parseFinancialWorkbook(SHEETS, "2026-02");
    assert.equal(results.length, 3);
    assert.equal(results.every((r) => r.status === "ok"), true);
  });
});

describe("pengaman aritmatika — data yang tidak rekonsiliasi DITOLAK", () => {
  /** Ubah satu sel di kolom Februari (index 4), meniru salah input/salah baca. */
  function withCell(kind: string, rowNumber: number, value: number | null): ExcelReportSheet {
    const sheet = sheetOf(kind);
    return {
      ...sheet,
      rows: sheet.rows.map((row) =>
        row.row === rowNumber ? { ...row, cells: row.cells.map((cell, index) => (index === 4 ? value : cell)) } : row,
      ),
    };
  }

  test("satu baris detail diubah nilainya ditolak", () => {
    // Baris 38 = "Biaya Sewa" 35.000.000 -> 45.000.000.
    const result = parseFinancialSheet(withCell("profit-loss", 38, 45000000), "2026-02");
    assert.equal(result.status, "rejected");
    assert.ok(result.status === "rejected");
    assert.match(result.reason, /tidak rekonsiliasi/);
    assert.ok(result.failedChecks.some((c) => Math.abs(c.difference - 10000000) < 0.005), JSON.stringify(result.failedChecks));
  });

  test("tanda terbalik pada satu baris detail ditolak", () => {
    // Baris 18 = "Potongan penjualan" -584.600 -> +584.600.
    const result = parseFinancialSheet(withCell("profit-loss", 18, 584600), "2026-02");
    assert.equal(result.status, "rejected");
  });

  test("subtotal diubah ditolak, dan gagal DUA kali (section + total akhir)", () => {
    // Baris 21 = "Total Pendapatan".
    const result = parseFinancialSheet(withCell("profit-loss", 21, 152000000), "2026-02");
    assert.ok(result.status === "rejected");
    assert.equal(result.failedChecks.length, 2);
    assert.deepEqual(result.failedChecks.map((c) => c.kind), ["section", "final"]);
  });

  test("neraca yang tidak seimbang ditolak", () => {
    // Baris 43 = "Modal" 2.000.000.000 -> 2.000.000.001.
    const result = parseFinancialSheet(withCell("balance-sheet", 43, 2000000001), "2026-02");
    assert.equal(result.status, "rejected");
  });

  test("bulan yang diminta tidak ada di sheet ditolak dengan daftar yang tersedia", () => {
    const result = parseFinancialSheet(sheetOf("profit-loss"), "2027-03");
    assert.ok(result.status === "rejected");
    assert.match(result.reason, /Kolom bulan 2027-03 tidak ada/);
    assert.match(result.reason, /2026-02/);
  });

  test("kolom bulan yang seluruh detailnya kosong ditolak, bukan diterima sebagai nol", () => {
    const empty: ExcelReportSheet = {
      ...sheetOf("profit-loss"),
      rows: sheetOf("profit-loss").rows.map((row) =>
        row.row > 6 ? { ...row, cells: row.cells.map((cell, index) => (index === 4 ? null : cell)) } : row,
      ),
    };
    const result = parseFinancialSheet(empty, "2026-02");
    assert.ok(result.status === "rejected");
    assert.match(result.reason, /kosong/);
  });

  test("arus kas tanpa saldo awal ditolak — identitasnya tidak bisa diuji", () => {
    // November 2025 adalah bulan pertama; Saldo Kas Awal-nya kosong.
    const result = parseFinancialSheet(sheetOf("cashflow"), "2025-11");
    assert.ok(result.status === "rejected");
    assert.match(result.reason, /Saldo Kas Awal/);
  });
});
