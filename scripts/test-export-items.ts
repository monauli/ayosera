// Test end-to-end Export Rincian Penjualan (satu sheet per tanggal).
// Menarik item dari MongoDB, membangun workbook via builder yang sama dengan
// endpoint /api/olsera/export-items, menyimpan file, lalu membuka ulang dengan
// ExcelJS dan memvalidasi per sheet terhadap data DB (bukan angka hardcode).
//
// Pakai: node --experimental-strip-types scripts/test-export-items.ts [START] [END]
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import ExcelJS from "exceljs";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const { collections, withMongo } = await import("../lib/mongodb.ts");
const { buildOlseraItemWorkbook } = await import("../lib/olsera-item-export.ts");

const START = process.argv[2] ?? "2026-05-01";
const END = process.argv[3] ?? "2026-05-09";
const OUT_FILE = `Rincian Penjualan-${START}__${END}.xlsx`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function near(a: number, b: number, eps = 1) {
  return Math.abs(a - b) <= eps;
}
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in value) return value.richText.map((t) => t.text).join("");
  if (typeof value === "object" && "formula" in value) return String(value.result ?? "");
  return String(value);
}
function cellNumber(value: ExcelJS.CellValue): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "formula" in value) return Number((value as { result?: number }).result ?? 0);
  return NaN;
}

const MONTH_ID = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function sheetNameFor(date: string) {
  return `${date.slice(8, 10)} ${MONTH_ID[Number(date.slice(5, 7)) - 1]}`;
}
function prettyDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${d} ${MONTH_EN[Number(m) - 1]} ${y}`;
}

async function main() {
  const items = await withMongo(async () => {
    const { olseraOrderItems } = await collections();
    return olseraOrderItems.find({ date: { $gte: START, $lte: END } }).sort({ orderDate: 1, orderNo: 1 }).toArray();
  });
  if (!items.length) throw new Error(`Tidak ada item pada ${START}..${END} — jalankan sync dulu.`);

  const buffer = await buildOlseraItemWorkbook({ start: START, end: END, rows: items });
  writeFileSync(OUT_FILE, buffer);
  console.log(`Workbook ditulis: ${OUT_FILE} (${buffer.length} bytes)\n`);

  // Acuan dari DATABASE: per tanggal — total order (pengunjung), qty, amount, cost, diskon.
  type Agg = { orders: Set<string>; qty: number; amount: number; cost: number; discount: number };
  const perDate = new Map<string, Agg>();
  for (const item of items) {
    const entry = perDate.get(item.date) ?? { orders: new Set<string>(), qty: 0, amount: 0, cost: 0, discount: 0 };
    entry.orders.add(item.orderNo);
    entry.qty += item.qty;
    entry.amount += item.amount;
    entry.cost += item.costAmount;
    entry.discount += item.discount;
    perDate.set(item.date, entry);
  }
  const expectedDates = [...perDate.keys()].sort();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  check(
    "satu sheet per tanggal bertransaksi (tanpa sheet tanggal kosong)",
    wb.worksheets.length === expectedDates.length,
    `${wb.worksheets.length} sheet vs ${expectedDates.length} tanggal`,
  );
  check(
    "urutan & nama sheet benar (paling awal → akhir)",
    wb.worksheets.every((ws, i) => ws.name === sheetNameFor(expectedDates[i])),
    wb.worksheets.map((ws) => ws.name).join(", "),
  );
  check(
    "nama sheet aman Excel (≤31 char, tanpa karakter terlarang, unik)",
    new Set(wb.worksheets.map((ws) => ws.name)).size === wb.worksheets.length &&
      wb.worksheets.every((ws) => ws.name.length <= 31 && !/[\\/?*[\]:]/.test(ws.name)),
  );

  let grandQty = 0;
  let grandAmount = 0;
  let grandVisitors = 0;
  wb.worksheets.forEach((ws, sheetIndex) => {
    const date = expectedDates[sheetIndex];
    const exp = perDate.get(date)!;
    const label = `sheet "${ws.name}"`;

    // Judul: Rincian Penjualan, BC PADEL CLUB, periode khusus tanggal sheet.
    const title = cellText(ws.getCell("A1").value);
    check(`${label} judul + outlet + periode satu tanggal`,
      title.includes("Rincian Penjualan") && title.includes("BC PADEL CLUB") &&
      title.includes(`Periode ${prettyDate(date)} - ${prettyDate(date)}`),
      title.split("\n")[1] ?? "");

    // Ringkasan dua baris — dihitung dari transaksi tanggal ini saja.
    const summary = (address: string) => cellText(ws.getCell(address).value);
    const summaryNumber = (address: string) => Number(summary(address).split("\n")[1]?.replace(/[^\d-]/g, "") ?? NaN);
    check(`${label} ringkasan Total Penjualan = DB`, near(summaryNumber("A2"), Math.round(exp.amount)), summary("A2").replace("\n", " "));
    check(`${label} ringkasan Total Modal = DB`, near(summaryNumber("F2"), Math.round(exp.cost)));
    check(`${label} ringkasan Total Laba = DB`, near(summaryNumber("J2"), Math.round(exp.amount - exp.cost)));
    check(`${label} ringkasan Diskon = DB`, near(summaryNumber("A3"), Math.round(exp.discount)));
    check(`${label} ringkasan Total Pengunjung = jumlah order tanggal ini`, summaryNumber("F3") === exp.orders.size);
    check(`${label} ringkasan Pajak/Biaya Layanan/Tambahan/Tebus/Pembulatan = 0`,
      [summaryNumber("C2"), summaryNumber("M2"), summaryNumber("Q2"), summaryNumber("C3"), summaryNumber("J3")].every((n) => n === 0));

    // Header tabel.
    check(`${label} header tabel benar`,
      cellText(ws.getCell("A4").value) === "No. Pesanan" && cellText(ws.getCell("S4").value) === "Jumlah Ditebus");

    // Baris data: cari baris total.
    const firstDataRow = 5;
    let totalRow = 0;
    for (let r = firstDataRow; r <= ws.rowCount; r++) {
      if (cellText(ws.getCell(`A${r}`).value).startsWith("Total")) { totalRow = r; break; }
    }
    check(`${label} punya baris total`, totalRow > 0);
    if (!totalRow) return;

    check(`${label} satu baris per nomor pesanan (${exp.orders.size})`, totalRow - firstDataRow === exp.orders.size, `${totalRow - firstDataRow} baris`);

    let clockOk = true;
    let salesByOk = true;
    let dateOk = true;
    let moneyIsNumber = true;
    let foreignOk = true;
    let manualQty = 0;
    let manualAmount = 0;
    const expectedDatePrefix = `${date.slice(8, 10)}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(date.slice(5,7)) - 1]}-${date.slice(0, 4)}`;
    for (let r = firstDataRow; r < totalRow; r++) {
      const row = ws.getRow(r);
      const dateText = cellText(row.getCell(2).value);
      if (!dateText.startsWith(expectedDatePrefix)) dateOk = false; // tidak ada tanggal campur
      if (/00:00:00/.test(dateText) || !/\d{2}:\d{2}:\d{2}/.test(dateText)) clockOk = false;
      if (!/^[^()]+\(.+\)$/.test(cellText(row.getCell(4).value))) salesByOk = false;
      if (typeof row.getCell(8).value !== "number" || typeof row.getCell(9).value !== "number") moneyIsNumber = false;
      // F (Pelanggan), G (Nomor Meja): tanpa ID numerik asing / undefined / null.
      for (const c of [6, 7]) {
        const t = cellText(row.getCell(c).value).trim();
        if (/^\d+([.,]\d+)?$/.test(t) || ["undefined", "null", "[object Object]"].includes(t)) foreignOk = false;
      }
      manualQty += cellNumber(row.getCell(8).value) || 0;
      manualAmount += cellNumber(row.getCell(9).value) || 0;
      // Laba per baris: formula tanpa error.
      const profit = row.getCell(14).value;
      if (!(profit && typeof profit === "object" && "formula" in profit)) foreignOk = foreignOk && typeof profit === "number";
    }
    check(`${label} semua baris bertanggal ${date} (tidak ada tanggal campur)`, dateOk);
    check(`${label} jam transaksi asli (bukan 00:00:00)`, clockOk);
    check(`${label} Penjualan Oleh format "NAMA (TIPE)"`, salesByOk);
    check(`${label} uang & qty berupa angka Excel`, moneyIsNumber);
    check(`${label} tanpa angka asing/undefined di Pelanggan & Nomor Meja`, foreignOk);

    // Total bawah tabel = data tanggal ini.
    const qty = cellNumber(ws.getCell(`H${totalRow}`).value);
    const amount = cellNumber(ws.getCell(`I${totalRow}`).value);
    const cost = cellNumber(ws.getCell(`L${totalRow}`).value);
    const profit = cellNumber(ws.getCell(`N${totalRow}`).value);
    const discount = cellNumber(ws.getCell(`R${totalRow}`).value);
    check(`${label} total bawah = DB (qty ${exp.qty}, IDR ${Math.round(exp.amount).toLocaleString("id-ID")})`,
      near(qty, exp.qty, 0) && near(amount, exp.amount) && near(cost, exp.cost) && near(profit, exp.amount - exp.cost) && near(discount, exp.discount),
      `qty ${qty}, IDR ${Math.round(amount).toLocaleString("id-ID")}`);
    check(`${label} total bawah = jumlah baris item`, near(manualQty, qty, 0) && near(manualAmount, amount));
    const formulaOk = ["H", "I", "L", "N", "R"].every((col) => {
      const v = ws.getCell(`${col}${totalRow}`).value;
      return v && typeof v === "object" && "formula" in v && /^SUM\(/.test(String((v as { formula: string }).formula));
    });
    check(`${label} formula total SUM tanpa error`, formulaOk);

    // Kolom uang cukup lebar — tidak "#######".
    let widthOk = true;
    for (let r = firstDataRow; r <= totalRow; r++) {
      for (const col of [9, 12, 14, 18]) {
        const n = cellNumber(ws.getRow(r).getCell(col).value);
        if (Number.isNaN(n)) continue;
        const digits = String(Math.round(Math.abs(n))).length;
        const needed = 4 + digits + Math.floor((digits - 1) / 3);
        // I & L & P merge dua kolom — lebar gabungan.
        const spans: Record<number, number[]> = { 9: [9, 10], 12: [12, 13], 14: [14], 18: [18] };
        const width = spans[col].reduce((x, c) => x + (ws.getColumn(c).width ?? 8.43), 0);
        if (width < needed) widthOk = false;
      }
    }
    check(`${label} kolom uang cukup lebar (tanpa #######)`, widthOk);

    grandQty += qty;
    grandAmount += amount;
    grandVisitors += exp.orders.size;
  });

  // Total gabungan seluruh sheet = total seluruh rentang.
  const expQty = items.reduce((x, item) => x + item.qty, 0);
  const expAmount = items.reduce((x, item) => x + item.amount, 0);
  check(`total gabungan seluruh sheet = total rentang (qty ${expQty}, IDR ${Math.round(expAmount).toLocaleString("id-ID")})`,
    near(grandQty, expQty, 0) && near(grandAmount, expAmount),
    `qty ${grandQty}, IDR ${Math.round(grandAmount).toLocaleString("id-ID")}`);

  console.log(`\nRingkasan: ${failures === 0 ? "SEMUA VALIDASI LULUS" : `${failures} validasi GAGAL`}`);
  console.log(`Sheets (${wb.worksheets.length}): ${wb.worksheets.map((ws) => ws.name).join(", ")}`);
  console.log(`Total gabungan: Qty ${grandQty}, Penjualan IDR ${Math.round(grandAmount).toLocaleString("id-ID")}, Pengunjung ${grandVisitors}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
