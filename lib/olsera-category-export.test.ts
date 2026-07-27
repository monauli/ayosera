// Test SEC-01: spreadsheet formula injection (CWE-1236) pada export "Kategori
// Penjualan" — nilai teks eksternal (nama produk/pelanggan/no. pesanan) yang
// diawali karakter pemicu formula Excel (=, +, -, @) harus disimpan sebagai
// teks aman (diawali apostrof), TANPA mengubah angka/Date/formula internal.
import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildOlseraCategoryWorkbook, escapeExcelFormulaPrefix, type OlseraCategoryExportInput } from "./olsera-category-export.ts";

test("escapeExcelFormulaPrefix: mengawali apostrof untuk =, +, -, @", () => {
  assert.equal(escapeExcelFormulaPrefix("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(escapeExcelFormulaPrefix("+CMD"), "'+CMD");
  assert.equal(escapeExcelFormulaPrefix("-10+20"), "'-10+20");
  assert.equal(escapeExcelFormulaPrefix("@HYPERLINK"), "'@HYPERLINK");
});

test("escapeExcelFormulaPrefix: tidak menambah apostrof kedua bila sudah ada", () => {
  assert.equal(escapeExcelFormulaPrefix("'=SAFE"), "'=SAFE");
  assert.equal(escapeExcelFormulaPrefix("'+SAFE"), "'+SAFE");
});

test("escapeExcelFormulaPrefix: teks normal tidak berubah", () => {
  assert.equal(escapeExcelFormulaPrefix("Produk Normal"), "Produk Normal");
  assert.equal(escapeExcelFormulaPrefix(""), "");
  assert.equal(escapeExcelFormulaPrefix("Kopi Susu - Large"), "Kopi Susu - Large");
});

function row(overrides: Partial<OlseraCategoryExportInput["rows"][number]> = {}): OlseraCategoryExportInput["rows"][number] {
  return {
    date: "2026-05-01",
    orderNo: "DF0226050100004062",
    orderDate: "2026-05-01 10:00:00",
    customerName: "Budi",
    tableNo: "1",
    salesByName: "Kasir A",
    itemName: "Kopi Susu",
    qty: 1,
    amount: 15000,
    costAmount: 5000,
    discount: 0,
    addonPrice: 0,
    category: "Minuman",
    ...overrides,
  };
}

async function readCategorySheet(rows: OlseraCategoryExportInput["rows"]) {
  const buffer = await buildOlseraCategoryWorkbook({ start: "2026-05-01", end: "2026-05-01", rows });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb.worksheets[0];
}

test("export Kategori: itemName/orderNo/customerName berbahaya disimpan sebagai teks aman", async () => {
  const ws = await readCategorySheet([
    row({ orderNo: "=SUM(A1:A2)", itemName: "+CMD", customerName: "-10+20", tableNo: "@HYPERLINK", salesByName: "'=SAFE" }),
  ]);
  // Baris data ada di row 3 (1 judul blok + 1 header + 1 data).
  const dataRow = ws.getRow(3);
  assert.equal(dataRow.getCell(1).value, "'=SUM(A1:A2)"); // No. Pesanan
  assert.equal(dataRow.getCell(3).value, "'-10+20"); // Pelanggan
  assert.equal(dataRow.getCell(4).value, "'@HYPERLINK"); // Nomor Meja
  assert.equal(dataRow.getCell(5).value, "'=SAFE"); // Penjualan Oleh — TIDAK diberi apostrof kedua
  assert.equal(dataRow.getCell(7).value, "'+CMD"); // Item
});

test("export Kategori: teks normal tetap sama, angka & formula tidak berubah", async () => {
  const ws = await readCategorySheet([row({ orderNo: "DF0226050100004062", itemName: "Kopi Susu", qty: 3, amount: 45000, costAmount: 15000 })]);
  const dataRow = ws.getRow(3);
  assert.equal(dataRow.getCell(1).value, "DF0226050100004062");
  assert.equal(dataRow.getCell(7).value, "Kopi Susu");
  assert.equal(dataRow.getCell(8).value, 3); // Qty tetap number
  assert.equal(typeof dataRow.getCell(8).value, "number");
  assert.equal(dataRow.getCell(10).value, 45000); // Total Pesanan tetap number
  assert.equal(typeof dataRow.getCell(10).value, "number");
  // Kolom Laba (Q) adalah formula internal aplikasi — harus tetap formula, bukan teks.
  const profitCell = dataRow.getCell(17).value as { formula?: string; result?: number };
  assert.equal(typeof profitCell, "object");
  assert.equal(profitCell.formula, "J3-M3");
  assert.equal(profitCell.result, 30000);
});

test("export Kategori: baris total tetap formula SUM, bukan teks", async () => {
  const ws = await readCategorySheet([
    row({ orderNo: "A1", itemName: "Kopi Susu", qty: 2, amount: 20000, costAmount: 8000 }),
    row({ orderNo: "A2", itemName: "Kopi Susu", qty: 1, amount: 10000, costAmount: 4000 }),
  ]);
  const totalRow = ws.getRow(5); // judul(1) + header(2) + 2 data(3,4) + total(5)
  assert.equal(totalRow.getCell(1).value, "Total - IDR");
  const qtyFormula = totalRow.getCell(8).value as { formula?: string; result?: number };
  assert.equal(qtyFormula.formula, "SUM(H3:H4)");
  assert.equal(qtyFormula.result, 3);
  const amountFormula = totalRow.getCell(10).value as { formula?: string; result?: number };
  assert.equal(amountFormula.formula, "SUM(J3:J4)");
  assert.equal(amountFormula.result, 30000);
});

test("export Kategori: negative number tetap number, bukan teks", async () => {
  // Diskon lebih besar dari amount menghasilkan Laba negatif — pastikan tetap
  // number/formula, bukan berubah jadi string ter-escape.
  const ws = await readCategorySheet([row({ orderNo: "A1", itemName: "Kopi Susu", amount: 5000, costAmount: 12000 })]);
  const dataRow = ws.getRow(3);
  const profitCell = dataRow.getCell(17).value as { formula?: string; result?: number };
  assert.equal(profitCell.result, -7000);
  assert.equal(typeof profitCell.result, "number");
});
