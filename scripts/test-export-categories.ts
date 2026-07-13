// Test end-to-end Export Kategori Penjualan (format blok per tanggal, referensi
// LABERS.xlsx). Menarik item dari MongoDB, me-resolve kategori (katalog produk
// Olsera), membangun workbook, menyimpannya, lalu membuka ulang dengan ExcelJS
// dan memvalidasi struktur blok + angka terhadap agregat
// olsera_sales_by_category di database (bukan angka hardcode).
//
// Pakai: node --experimental-strip-types scripts/test-export-categories.ts [START] [END]
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
const { buildOlseraCategoryWorkbook, categoryForItem, getCategoryByNameMap } = await import(
  "../lib/olsera-category-export.ts"
);

const START = process.argv[2] ?? "2026-05-01";
const END = process.argv[3] ?? "2026-05-02";
const OUT_FILE = `Kategori Penjualan-${START}__${END}.xlsx`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function near(a: number, b: number, eps = 1) {
  return Math.abs(a - b) <= eps;
}
function cellNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "formula" in value) {
    // ExcelJS tidak menulis cached result 0 — formula tanpa result berarti 0
    // (workbook memakai fullCalcOnLoad, Excel menghitung ulang saat dibuka).
    return Number((value as { result?: number }).result ?? 0);
  }
  return NaN;
}

type Block = { titleRow: number; totalRow: number; dataRows: number[]; titleText: string };

/** Pindai satu sheet menjadi blok-blok: judul "Item Penjualan : ..." .. baris "Total - IDR". */
function scanBlocks(ws: ExcelJS.Worksheet): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (let r = 1; r <= ws.rowCount; r++) {
    const a = String(ws.getRow(r).getCell(1).value ?? "");
    if (a.startsWith("Item Penjualan :")) {
      current = { titleRow: r, totalRow: 0, dataRows: [], titleText: a };
    } else if (a === "Total - IDR") {
      if (current) {
        current.totalRow = r;
        blocks.push(current);
        current = null;
      }
    } else if (current && r > current.titleRow + 1 && a) {
      current.dataRows.push(r);
    }
  }
  return blocks;
}

async function main() {
  const { items, agg } = await withMongo(async () => {
    const { olseraOrderItems, olseraSalesByCategory } = await collections();
    return {
      items: await olseraOrderItems.find({ date: { $gte: START, $lte: END } }).sort({ orderDate: 1, orderNo: 1 }).toArray(),
      agg: await olseraSalesByCategory.find({ date: { $gte: START, $lte: END } }).toArray(),
    };
  });
  if (!items.length) throw new Error(`Tidak ada item pada ${START}..${END} — jalankan sync dulu.`);

  const nameMap = await getCategoryByNameMap();
  const rows = items.map((item) => ({ ...item, category: categoryForItem(item.itemName, nameMap) }));

  const buffer = await buildOlseraCategoryWorkbook({ start: START, end: END, rows });
  writeFileSync(OUT_FILE, buffer);
  console.log(`Workbook ditulis: ${OUT_FILE} (${buffer.length} bytes)\n`);

  // Acuan dari DATABASE: agregat per (kategori, tanggal) dan per kategori.
  const perCategoryDate = new Map<string, { qty: number; amount: number; cost: number }>();
  const perCategory = new Map<string, { qty: number; amount: number; cost: number }>();
  for (const doc of agg) {
    const key = `${doc.category}|${doc.date}`;
    perCategoryDate.set(key, { qty: doc.qty, amount: doc.totalAmount, cost: doc.costAmount });
    const entry = perCategory.get(doc.category) ?? { qty: 0, amount: 0, cost: 0 };
    entry.qty += doc.qty;
    entry.amount += doc.totalAmount;
    entry.cost += doc.costAmount;
    perCategory.set(doc.category, entry);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  check(
    "jumlah sheet = jumlah kategori bertransaksi",
    wb.worksheets.length === perCategory.size,
    `${wb.worksheets.length} sheet vs ${perCategory.size} kategori`,
  );

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function prettyDate(date: string) {
    const [year, month, day] = date.split("-");
    return `${monthNames[Number(month) - 1]} ${day}, ${year}`;
  }

  let totalBlocks = 0;
  for (const ws of wb.worksheets) {
    const category = [...perCategory.keys()].find((k) => k.slice(0, 31) === ws.name);
    check(`sheet "${ws.name}" cocok dengan kategori DB`, !!category);
    if (!category) continue;

    const blocks = scanBlocks(ws);
    totalBlocks += blocks.length;
    const expectedDates = [...perCategoryDate.keys()]
      .filter((k) => k.startsWith(`${category}|`))
      .map((k) => k.split("|")[1])
      .sort();

    check(
      `sheet "${ws.name}" jumlah blok = jumlah tanggal bertransaksi (${expectedDates.length})`,
      blocks.length === expectedDates.length,
      `${blocks.length} blok`,
    );

    const seenTitles = new Set(blocks.map((b) => b.titleText));
    check(`sheet "${ws.name}" tidak ada blok tanggal duplikat`, seenTitles.size === blocks.length);

    let sheetQty = 0;
    let sheetAmount = 0;
    blocks.forEach((block, index) => {
      const date = expectedDates[index];
      const expectedTitle = `Item Penjualan : ${prettyDate(date)} - ${prettyDate(date)}`;
      check(`  blok ${index + 1} judul urut & benar`, block.titleText === expectedTitle, block.titleText);

      const headerCell = String(ws.getRow(block.titleRow + 1).getCell(1).value ?? "");
      check(`  blok ${index + 1} header 16 kolom di bawah judul`, headerCell === "No. Pesanan" && String(ws.getRow(block.titleRow + 1).getCell(16).value ?? "") === "Laba");

      const exp = perCategoryDate.get(`${category}|${date}`)!;
      const totalRow = ws.getRow(block.totalRow);
      const qty = cellNumber(totalRow.getCell(8).value);
      const amount = cellNumber(totalRow.getCell(10).value);
      const cost = cellNumber(totalRow.getCell(12).value);
      const profit = cellNumber(totalRow.getCell(16).value);
      check(`  blok ${index + 1} (${date}) total = DB`, near(qty, exp.qty, 0) && near(amount, exp.amount) && near(cost, exp.cost) && near(profit, exp.amount - exp.cost), `qty ${qty}, amount ${Math.round(amount)}`);

      // Baris item: uang numerik, jam asli, kasir "(TIPE)", kolom teks bersih.
      let moneyIsNumber = true;
      let clockOk = true;
      let salesByOk = true;
      let textColsOk = true;
      let manualQty = 0;
      let manualAmount = 0;
      for (const r of block.dataRows) {
        const row = ws.getRow(r);
        // C (Pelanggan), D (Nomor Meja), F (No. Seri), I (Unit Pengukuran),
        // N (Nama Diskon): tidak boleh berisi ID numerik asing (19/11/26/dll),
        // "undefined", "null", atau "[object Object]" — kosong tetap kosong.
        for (const col of [3, 4, 6, 9, 14]) {
          const raw = row.getCell(col).value;
          const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
          if (raw !== null && raw !== undefined && typeof raw !== "string" && typeof raw !== "number") textColsOk = false;
          if (/^\d+([.,]\d+)?$/.test(text) || ["undefined", "null", "[object Object]"].includes(text)) textColsOk = false;
        }
        if (typeof row.getCell(8).value !== "number" || typeof row.getCell(10).value !== "number") moneyIsNumber = false;
        manualQty += Number(row.getCell(8).value) || 0;
        manualAmount += Number(row.getCell(10).value) || 0;
        const dateText = String(row.getCell(2).value ?? "");
        if (/00:00:00/.test(dateText) || !/\d{2}:\d{2}:\d{2}/.test(dateText)) clockOk = false;
        if (!/^[^()]+\(.+\)$/.test(String(row.getCell(5).value ?? ""))) salesByOk = false;
      }
      check(`  blok ${index + 1} uang & qty berupa angka Excel`, moneyIsNumber);
      check(`  blok ${index + 1} jumlah baris item = baris total`, near(manualQty, qty, 0) && near(manualAmount, amount));
      check(`  blok ${index + 1} jam transaksi asli (bukan 00:00:00)`, clockOk);
      check(`  blok ${index + 1} Penjualan Oleh format "NAMA (TIPE)"`, salesByOk);
      check(`  blok ${index + 1} kolom C/D/F/I/N bersih (tanpa ID numerik/undefined/null)`, textColsOk);
      sheetQty += qty;
      sheetAmount += amount;

      // Tiga baris kosong sebelum blok berikutnya.
      const next = blocks[index + 1];
      if (next) {
        const gap = next.titleRow - block.totalRow - 1;
        let gapEmpty = true;
        for (let r = block.totalRow + 1; r < next.titleRow; r++) {
          if (ws.getRow(r).actualCellCount > 0) gapEmpty = false;
        }
        check(`  blok ${index + 1}→${index + 2} dipisah 3 baris kosong`, gap === 3 && gapEmpty, `${gap} baris`);
      }
    });

    const expCat = perCategory.get(category)!;
    check(
      `sheet "${ws.name}" total seluruh blok = total kategori DB (qty ${expCat.qty}, IDR ${Math.round(expCat.amount).toLocaleString("id-ID")})`,
      near(sheetQty, expCat.qty, 0) && near(sheetAmount, expCat.amount),
      `qty ${sheetQty}, IDR ${Math.round(sheetAmount).toLocaleString("id-ID")}`,
    );

    // Lebar kolom: uang tidak boleh "#######" (lebar >= panjang tampilan
    // "IDR #,##0" terpanjang), nama kasir kolom E tampil penuh.
    const MONEY_COLS = [10, 11, 12, 13, 15, 16];
    let widthOk = true;
    let salesWidthOk = true;
    ws.eachRow((row) => {
      for (const col of MONEY_COLS) {
        const n = cellNumber(row.getCell(col).value);
        if (Number.isNaN(n)) continue;
        const digits = String(Math.round(Math.abs(n))).length;
        const needed = 4 + digits + Math.floor((digits - 1) / 3);
        if ((ws.getColumn(col).width ?? 8.43) < needed) widthOk = false;
      }
      const sales = String(row.getCell(5).value ?? "");
      if (/^[^()]+\(.+\)$/.test(sales) && (ws.getColumn(5).width ?? 8.43) < sales.length) salesWidthOk = false;
    });
    check(`sheet "${ws.name}" kolom uang cukup lebar (tanpa #######)`, widthOk);
    check(`sheet "${ws.name}" kolom Penjualan Oleh cukup lebar`, salesWidthOk);

    let hasDibuatPada = false;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        let text = cell.value;
        if (text && typeof text === "object" && "richText" in text) {
          text = (text as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
        }
        if (typeof text === "string" && text.includes("Dibuat pada")) hasDibuatPada = true;
      });
    });
    check(`sheet "${ws.name}" tanpa teks "Dibuat pada"`, !hasDibuatPada);
  }

  const grandExpectedQty = [...perCategory.values()].reduce((x, e) => x + e.qty, 0);
  const grandExpectedAmount = [...perCategory.values()].reduce((x, e) => x + e.amount, 0);
  console.log(`\nRingkasan: ${failures === 0 ? "SEMUA VALIDASI LULUS" : `${failures} validasi GAGAL`}`);
  console.log(`Sheets (${wb.worksheets.length}): ${wb.worksheets.map((ws) => ws.name).join(", ")}`);
  console.log(`Total blok tanggal: ${totalBlocks}`);
  console.log(`Acuan DB: Qty ${grandExpectedQty}, Penjualan IDR ${Math.round(grandExpectedAmount).toLocaleString("id-ID")}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
