import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildOlseraItemWorkbook } from "./olsera-item-export.ts";
import { buildLabersSharingWorkbook } from "./olsera-labers-export.ts";

test("Rincian Penjualan keeps historical returns as negative rows", async () => {
  const buffer = await buildOlseraItemWorkbook({ start: "2026-02-01", end: "2026-02-28", rows: [
    { date: "2026-02-05", orderNo: "DF0226020500000033", orderDate: "2026-02-05 12:00:00", customerId: null, customerName: null, tableNo: null, salesByName: "AMEL", itemName: "ICED LEMON TEA", qty: 1, amount: 21250, costAmount: 0, discount: 0, addonPrice: 0 },
    { date: "2026-02-05", orderNo: "DF0226020500000033", orderDate: "2026-02-05 12:00:00", customerId: null, customerName: null, tableNo: null, salesByName: "Historical correction", itemName: "ICED LEMON TEA", qty: -1, amount: -21250, costAmount: 0, discount: 0, addonPrice: 0 },
  ] });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  const totalRow = ws.rowCount;
  const value = (cell: unknown) => typeof cell === "object" && cell ? Number((cell as { result?: number }).result ?? 0) : Number(cell ?? 0);
  assert.equal(value(ws.getCell(totalRow, 8).value), 0);
  assert.equal(value(ws.getCell(totalRow, 9).value), 0);
});

test("Pembagian Hasil LABERS applies the return before percentage split", async () => {
  const days = Array.from({ length: 28 }, (_, i) => ({ date: `2026-02-${String(i + 1).padStart(2, "0")}`, penjualanLabers: 0, addOn: 0 }));
  days[4].penjualanLabers = 14512450 - 21250;
  const buffer = await buildLabersSharingWorkbook({ month: "2026-02", days, empty: false });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0]; const row = ws.rowCount;
  const value = (cell: unknown) => typeof cell === "object" && cell ? Number((cell as { result?: number }).result ?? 0) : Number(cell ?? 0);
  assert.equal(value(ws.getCell(`D${row}`).value), 14491200);
  assert.equal(value(ws.getCell(`E${row}`).value), 2535960);
  assert.equal(value(ws.getCell(`F${row}`).value), 11955240);
});
