// Regenerasi + validasi file testing "Rincian Penjualan-YYYY-MM-DD__YYYY-MM-DD.xlsx"
// dari data nyata MongoDB (olsera_order_items), lewat generator yang sama dengan
// endpoint /api/olsera/export-items. Jalankan: npx tsx scripts/generate-olsera-export-test.ts
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";

async function main() {
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const START = process.argv[2] ?? "2026-05-01";
const END = process.argv[3] ?? START;

const { buildOlseraItemWorkbook } = await import("../lib/olsera-item-export.ts");
const { MongoClient } = await import("mongodb");

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();
const rows = await client
  .db(process.env.MONGODB_DB)
  .collection("olsera_order_items")
  .find({ date: { $gte: START, $lte: END } })
  .sort({ orderDate: 1, orderNo: 1 })
  .project({ _id: 0, date: 1, orderNo: 1, orderDate: 1, customerId: 1, customerName: 1, tableNo: 1, salesByName: 1, itemName: 1, qty: 1, amount: 1, costAmount: 1, discount: 1 })
  .toArray();
await client.close();

const filename = `Rincian Penjualan-${START}__${END}.xlsx`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buffer = await buildOlseraItemWorkbook({ start: START, end: END, rows: rows as any });
await writeFile(filename, buffer);
console.log(`Ditulis: ${filename} (${rows.length} baris item)`);

// ---- Validasi: buka kembali workbook dan periksa isi sel secara nyata ----
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(filename);
const ws = wb.worksheets[0];

const text = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  if (typeof v === "object" && "formula" in v) return String(v.result ?? "");
  return String(v);
};
const num = (v: ExcelJS.CellValue): number => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "formula" in v) return Number(v.result ?? 0);
  return Number(v) || 0;
};

const firstDataRow = 5;
let totalRow = 0;
for (let r = firstDataRow; r <= ws.rowCount; r++) {
  if (text(ws.getCell(`A${r}`).value).startsWith("Total")) { totalRow = r; break; }
}
const orderCount = totalRow - firstDataRow;

const checks: [string, boolean, string][] = [];
const push = (label: string, ok: boolean, actual: string) => checks.push([label, ok, actual]);

push("Jumlah transaksi = 74", orderCount === 74, String(orderCount));
push("Total Qty = 140", num(ws.getCell(`H${totalRow}`).value) === 140, text(ws.getCell(`H${totalRow}`).value));
push("Total Penjualan = 6.734.000", num(ws.getCell(`I${totalRow}`).value) === 6_734_000, String(num(ws.getCell(`I${totalRow}`).value)));
push("Total Modal = 907.223", Math.round(num(ws.getCell(`L${totalRow}`).value)) === 907_223, String(num(ws.getCell(`L${totalRow}`).value)));
push("Total Laba = 5.826.777", Math.round(num(ws.getCell(`N${totalRow}`).value)) === 5_826_777, String(num(ws.getCell(`N${totalRow}`).value)));

let hasAmel = false, hasNisa = false, hasMidnight = false, badCustomer = 0, badTable = 0;
for (let r = firstDataRow; r < totalRow; r++) {
  const seller = text(ws.getCell(`D${r}`).value);
  if (seller === "AMEL (DINE IN)") hasAmel = true;
  if (seller === "NISA (DINE IN)") hasNisa = true;
  if (text(ws.getCell(`B${r}`).value).includes("00:00:00")) hasMidnight = true;
  for (const col of ["E", "F"]) {
    const v = text(ws.getCell(`${col}${r}`).value).trim();
    if (/^\d+$/.test(v)) badCustomer++;
  }
  const meja = text(ws.getCell(`G${r}`).value).trim();
  if (meja === "11" || meja === "26") badTable++;
}
push("Ada AMEL (DINE IN)", hasAmel, String(hasAmel));
push("Ada NISA (DINE IN)", hasNisa, String(hasNisa));
push("Tidak ada 00:00:00", !hasMidnight, String(!hasMidnight));
push("Kolom Pelanggan ID/Pelanggan bebas angka", badCustomer === 0, `${badCustomer} sel angka`);
push("Nomor Meja bebas 11/26 palsu", badTable === 0, `${badTable} sel`);
push("Jam pertama 06:57:24", text(ws.getCell(`B${firstDataRow}`).value).includes("06:57:24"), text(ws.getCell(`B${firstDataRow}`).value).replace(/\n/g, " "));
push("Jam terakhir 21:31:17", text(ws.getCell(`B${totalRow - 1}`).value).includes("21:31:17"), text(ws.getCell(`B${totalRow - 1}`).value).replace(/\n/g, " "));

// Ringkasan (baris 2-3): tidak boleh ada angka asing berdiri sendiri.
let strayNumber = "";
for (const addr of ["A2", "C2", "F2", "J2", "M2", "Q2", "A3", "C3", "F3", "J3", "M3"]) {
  const v = text(ws.getCell(addr).value).trim();
  if (v && !/^(Total|Pengiriman|Biaya|Tambahan|Diskon)/.test(v)) strayNumber = `${addr}=${JSON.stringify(v)}`;
}
push("Ringkasan tanpa angka asing", strayNumber === "", strayNumber || "bersih");
push("Total Pengunjung = 74", text(ws.getCell("F3").value).includes("74"), text(ws.getCell("F3").value).replace(/\n/g, " "));

let failed = 0;
for (const [label, ok, actual] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  →  ${actual}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`\n${failed} validasi GAGAL`);
  process.exit(1);
}
console.log("\nSemua validasi lulus.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
