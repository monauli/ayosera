// Test end-to-end Export Omset Kategori (matriks bulanan, referensi
// "Total keselurhan omset.xlsx"). Membangun workbook untuk 2026-05 (plus
// 2026-02, 2026-04, dan bulan kosong), membukanya kembali dengan ExcelJS, dan
// memvalidasi struktur + seluruh angka. Untuk 2026-05 hasil dibandingkan 1:1
// dengan file referensi (label, urutan, total per kategori, total per tanggal,
// grand total 370.807.500) — angka acuan dibaca dari file, bukan hardcode.
//
// Pakai: node --no-warnings --experimental-strip-types scripts/test-export-omset-kategori.ts
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

const { buildOmsetKategoriWorkbook, loadOmsetKategoriRows, daysInMonth } = await import(
  "../lib/omset-kategori-export.ts"
);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function cellNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "object" && ("formula" in (value as object) || "sharedFormula" in (value as object))) {
    return Number((value as { result?: number }).result ?? 0);
  }
  return NaN;
}

type SheetMatrix = {
  labels: { no: string; label: string; row: number }[];
  rowTotals: Map<string, number>; // label (leaf) -> TOTAL kolom
  cells: Map<string, number[]>; // label (leaf) -> nilai per hari
  columnTotals: number[]; // baris TOTAL bawah per hari
  grandTotal: number;
  totalRow: number;
  dayCount: number;
};

/** Baca sheet matriks (hasil export ATAU referensi) menjadi struktur seragam. */
function readMatrix(ws: ExcelJS.Worksheet, dayCount: number): SheetMatrix {
  const totalCol = 3 + dayCount;
  // cari baris TOTAL bawah
  let totalRow = 0;
  for (let r = 6; r <= ws.rowCount; r++) {
    if (String(ws.getRow(r).getCell(1).value ?? "") === "TOTAL") {
      totalRow = r;
      break;
    }
  }
  const labels: SheetMatrix["labels"] = [];
  const rowTotals = new Map<string, number>();
  const cells = new Map<string, number[]>();
  for (let r = 6; r < totalRow; r++) {
    const label = String(ws.getRow(r).getCell(2).value ?? "").trim();
    if (!label) continue;
    labels.push({ no: String(ws.getRow(r).getCell(1).value ?? ""), label, row: r });
    const days: number[] = [];
    for (let d = 1; d <= dayCount; d++) days.push(cellNumber(ws.getRow(r).getCell(2 + d).value) || 0);
    const hasDayValues = days.some((v) => v !== 0);
    const totalValue = cellNumber(ws.getRow(r).getCell(totalCol).value) || 0;
    // baris induk (grup) pada referensi tidak berisi angka — hanya leaf yang dibandingkan
    if (hasDayValues || totalValue !== 0 || ws.getRow(r).getCell(2 + 1).value !== null) {
      cells.set(label, days);
      rowTotals.set(label, totalValue);
    }
  }
  const columnTotals: number[] = [];
  for (let d = 1; d <= dayCount; d++) columnTotals.push(cellNumber(ws.getRow(totalRow).getCell(2 + d).value) || 0);
  const grandTotal = cellNumber(ws.getRow(totalRow).getCell(totalCol).value) || 0;
  return { labels, rowTotals, cells, columnTotals, grandTotal, totalRow, dayCount };
}

async function validateMonth(month: string, opts: { compareReference?: boolean } = {}) {
  console.log(`\n=== Bulan ${month} ===`);
  const dayCount = daysInMonth(month);
  const input = await loadOmsetKategoriRows(month);
  if (input.empty) {
    console.log(`(bulan ${month} tanpa transaksi — endpoint mengembalikan 404, tidak menghasilkan workbook)`);
    check(`${month}: bulan kosong terdeteksi konsisten`, true);
    return;
  }
  const buffer = await buildOmsetKategoriWorkbook(input);
  const outFile = `Omset Kategori-${month}.xlsx`;
  writeFileSync(outFile, buffer);
  console.log(`Workbook ditulis: ${outFile} (${buffer.length} bytes)`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  check(`${month}: hanya 1 sheet`, wb.worksheets.length === 1, `${wb.worksheets.length} sheet`);
  const ws = wb.worksheets[0];
  check(`${month}: nama sheet`, ws.name === "Total Keseluruhan Omset", ws.name);

  // header tanggal 1..N, tidak ada tanggal hilang/berlebih
  let headerOk = true;
  for (let d = 1; d <= dayCount; d++) if (cellNumber(ws.getCell(5, 2 + d).value) !== d) headerOk = false;
  check(`${month}: kolom tanggal 1..${dayCount}`, headerOk);
  check(
    `${month}: tidak ada kolom tanggal berlebih`,
    ws.getCell(5, 2 + dayCount + 1).value === "TOTAL" || String(ws.getCell(4, 3 + dayCount).value) === "TOTAL",
  );
  check(`${month}: kolom TOTAL`, String(ws.getCell(4, 3 + dayCount).value) === "TOTAL");

  const matrix = readMatrix(ws, dayCount);

  // tidak ada duplikasi label kategori
  const labelSet = new Set(matrix.labels.map((l) => l.label));
  check(`${month}: tidak ada duplikasi kategori`, labelSet.size === matrix.labels.length);

  // semua nilai uang berupa angka (bukan string) & tidak ada formula error
  let numericOk = true;
  let noError = true;
  for (let r = 6; r <= matrix.totalRow; r++) {
    for (let c = 3; c <= 3 + dayCount; c++) {
      const v = ws.getRow(r).getCell(c).value;
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v !== "") numericOk = false;
      if (v && typeof v === "object" && "error" in (v as object)) noError = false;
    }
  }
  check(`${month}: semua nilai uang angka Excel`, numericOk);
  check(`${month}: tidak ada formula error`, noError);

  // lebar kolom cukup (tidak "#######"): panjang tampilan nilai terbesar <= lebar
  let widthOk = true;
  for (let d = 1; d <= dayCount; d++) {
    const needed = String(Math.round(matrix.columnTotals[d - 1])).replace(/\B(?=(\d{3})+(?!\d))/g, ".").length;
    if ((ws.getColumn(2 + d).width ?? 0) < needed) widthOk = false;
  }
  const grandLen = String(Math.round(matrix.grandTotal)).replace(/\B(?=(\d{3})+(?!\d))/g, ".").length;
  if ((ws.getColumn(3 + dayCount).width ?? 0) < grandLen) widthOk = false;
  check(`${month}: lebar kolom cukup (tanpa #######)`, widthOk);

  // konsistensi internal: total baris, total kolom, grand total
  let rowTotalsOk = true;
  let sumRowTotals = 0;
  for (const [label, days] of matrix.cells) {
    const expected = days.reduce((x, v) => x + v, 0);
    if (Math.abs((matrix.rowTotals.get(label) ?? 0) - expected) > 0.5) rowTotalsOk = false;
    sumRowTotals += expected;
  }
  check(`${month}: TOTAL per baris = jumlah tanggal`, rowTotalsOk);
  let colTotalsOk = true;
  for (let d = 0; d < dayCount; d++) {
    let expected = 0;
    for (const days of matrix.cells.values()) expected += days[d];
    if (Math.abs(matrix.columnTotals[d] - expected) > 0.5) colTotalsOk = false;
  }
  check(`${month}: TOTAL per tanggal = jumlah kategori`, colTotalsOk);
  const sumColTotals = matrix.columnTotals.reduce((x, v) => x + v, 0);
  check(
    `${month}: total kategori = total harian = grand total`,
    Math.abs(sumRowTotals - matrix.grandTotal) < 0.5 && Math.abs(sumColTotals - matrix.grandTotal) < 0.5,
    `kategori=${sumRowTotals} harian=${sumColTotals} grand=${matrix.grandTotal}`,
  );

  if (opts.compareReference) {
    const refWb = new ExcelJS.Workbook();
    await refWb.xlsx.readFile(path.join(process.cwd(), "Total keselurhan omset.xlsx"));
    const ref = readMatrix(refWb.worksheets[0], dayCount);

    check(
      "ref: jumlah & urutan label kategori sama",
      matrix.labels.map((l) => l.label).join("|") === ref.labels.map((l) => l.label).join("|"),
      `export=[${matrix.labels.map((l) => l.label).join(", ")}] ref=[${ref.labels.map((l) => l.label).join(", ")}]`,
    );

    for (const { label } of ref.labels) {
      const refDays = ref.cells.get(label);
      if (!refDays) continue; // baris induk grup
      const ourDays = matrix.cells.get(label);
      if (!ourDays) {
        check(`ref: baris "${label}" ada di export`, false);
        continue;
      }
      const refTotal = refDays.reduce((x, v) => x + v, 0);
      const ourTotal = ourDays.reduce((x, v) => x + v, 0);
      check(`ref: total kategori "${label}"`, Math.abs(refTotal - ourTotal) < 0.5, `ref=${refTotal} export=${ourTotal}`);
      const daysMatch = refDays.every((v, i) => Math.abs(v - ourDays[i]) < 0.5);
      check(`ref: nilai harian "${label}"`, daysMatch);
    }
    let colMatch = true;
    for (let d = 0; d < dayCount; d++) {
      if (Math.abs(matrix.columnTotals[d] - ref.columnTotals[d]) > 0.5) colMatch = false;
    }
    check("ref: total per tanggal sama", colMatch);
    check(
      "ref: grand total IDR 370.807.500",
      Math.abs(matrix.grandTotal - ref.grandTotal) < 0.5 && Math.abs(ref.grandTotal - 370807500) < 0.5,
      `export=${matrix.grandTotal} ref=${ref.grandTotal}`,
    );
  }
}

await validateMonth("2026-05", { compareReference: true });
await validateMonth("2026-02"); // 28 hari, kemungkinan tanpa transaksi
await validateMonth("2026-04"); // 30 hari
await validateMonth("2025-01"); // bulan tanpa transaksi

console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan PASS");
process.exit(failures ? 1 : 0);
