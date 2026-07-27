// Test SEC-01: spreadsheet formula injection (CWE-1236) pada export "Rincian
// Penjualan" — nilai teks eksternal (No. Pesanan, Pelanggan ID, Pelanggan,
// Nomor Meja, Penjualan Oleh) yang diawali karakter pemicu formula Excel
// (=, +, -, @) harus disimpan sebagai teks aman, TANPA mengubah angka/Date/
// formula internal (SUM, Laba).
import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildOlseraItemWorkbook, type OlseraItemExportInput } from "./olsera-item-export.ts";

function row(overrides: Partial<OlseraItemExportInput["rows"][number]> = {}): OlseraItemExportInput["rows"][number] {
  return {
    date: "2026-05-01",
    orderNo: "DF0226050100004062",
    orderDate: "2026-05-01 10:00:00",
    customerId: "CUST-1",
    customerName: "Budi",
    tableNo: "1",
    salesByName: "Kasir A",
    itemName: "Kopi Susu",
    qty: 1,
    amount: 15000,
    costAmount: 5000,
    discount: 0,
    addonPrice: 0,
    ...overrides,
  };
}

async function readSheet(rows: OlseraItemExportInput["rows"]) {
  const buffer = await buildOlseraItemWorkbook({ start: "2026-05-01", end: "2026-05-01", rows });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb.worksheets[0];
}

test("export Rincian Penjualan: No. Pesanan/Pelanggan ID/Pelanggan/Nomor Meja/Penjualan Oleh berbahaya disimpan sebagai teks aman", async () => {
  const ws = await readSheet([
    row({
      orderNo: "=SUM(A1:A2)",
      customerId: "+CMD",
      customerName: "-10+20",
      tableNo: "@HYPERLINK",
      salesByName: "'=SAFE",
    }),
  ]);
  const dataRow = ws.getRow(5); // title(1) + summary(2,3) + header(4) + data(5)
  assert.equal(dataRow.getCell("A").value, "'=SUM(A1:A2)"); // No. Pesanan
  assert.equal(dataRow.getCell("E").value, "'+CMD"); // Pelanggan ID
  assert.equal(dataRow.getCell("F").value, "'-10+20"); // Pelanggan
  assert.equal(dataRow.getCell("G").value, "'@HYPERLINK"); // Nomor Meja
  assert.equal(dataRow.getCell("D").value, "'=SAFE"); // Penjualan Oleh — TIDAK diberi apostrof kedua
});

test("export Rincian Penjualan: teks normal tetap sama, angka/Date/formula tidak berubah", async () => {
  const ws = await readSheet([row({ orderNo: "DF0226050100004062", qty: 3, amount: 45000, costAmount: 15000 })]);
  const dataRow = ws.getRow(5);
  assert.equal(dataRow.getCell("A").value, "DF0226050100004062");
  assert.equal(dataRow.getCell("H").value, 3); // Qty tetap number
  assert.equal(typeof dataRow.getCell("H").value, "number");
  assert.equal(dataRow.getCell("I").value, 45000); // Total Penjualan tetap number
  assert.equal(typeof dataRow.getCell("I").value, "number");
  // Tanggal Jual (B) tetap teks tanggal terformat (bukan formula), dibangun
  // dari Date internal — tidak melalui sanitasi formula sama sekali.
  assert.equal(typeof dataRow.getCell("B").value, "string");
  assert.match(String(dataRow.getCell("B").value), /^\d{2}-[A-Za-z]{3}-\d{4}/);
  // Laba (O) adalah formula internal aplikasi — harus tetap formula.
  const profitCell = dataRow.getCell("O").value as { formula?: string; result?: number };
  assert.equal(typeof profitCell, "object");
  assert.equal(profitCell.formula, "I5-M5");
  assert.equal(profitCell.result, 30000);
});

test("export Rincian Penjualan: baris total tetap formula SUM, bukan teks", async () => {
  const ws = await readSheet([
    row({ orderNo: "A1", qty: 2, amount: 20000, costAmount: 8000 }),
    row({ orderNo: "A2", qty: 1, amount: 10000, costAmount: 4000 }),
  ]);
  const totalRow = ws.getRow(7); // title(1)+summary(2,3)+header(4)+data(5,6)+total(7)
  assert.equal(totalRow.getCell("A").value, "Total - IDR");
  const qtyFormula = totalRow.getCell("H").value as { formula?: string; result?: number };
  assert.equal(qtyFormula.formula, "SUM(H5:H6)");
  assert.equal(qtyFormula.result, 3);
  const amountFormula = totalRow.getCell("I").value as { formula?: string; result?: number };
  assert.equal(amountFormula.formula, "SUM(I5:I6)");
  assert.equal(amountFormula.result, 30000);
});

test("export Rincian Penjualan: negative number (Laba rugi) tetap number, bukan teks", async () => {
  const ws = await readSheet([row({ orderNo: "A1", amount: 5000, costAmount: 12000 })]);
  const dataRow = ws.getRow(5);
  const profitCell = dataRow.getCell("O").value as { formula?: string; result?: number };
  assert.equal(profitCell.result, -7000);
  assert.equal(typeof profitCell.result, "number");
});

test("export Rincian Penjualan: customerId kosong tidak menghasilkan teks aneh", async () => {
  const ws = await readSheet([row({ customerId: null })]);
  const dataRow = ws.getRow(5);
  assert.equal(dataRow.getCell("E").value, "");
});
