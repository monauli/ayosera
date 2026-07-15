// Test end-to-end Export "Pembagian Hasil LABERS" (rekap harian + pembagian
// Padel/Labers, referensi "Pembagian hasil labers.xlsx"). Membangun workbook
// untuk 2026-05 (31 hari) dan 2026-06 (30 hari) dari data MongoDB nyata,
// membukanya kembali dengan ExcelJS, dan memvalidasi struktur + formula +
// styling terhadap file referensi. Juga menguji Februari (28 & 29 hari),
// bulan 30/31 hari generik, dan bulan tanpa transaksi LABERS sama sekali.
//
// Pakai: node --no-warnings --experimental-strip-types scripts/test-export-labers-sharing.ts
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

const { buildLabersSharingWorkbook, loadLabersSharingRows, daysInMonth } = await import(
  "../lib/olsera-labers-export.ts"
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

const MONTHS_ID_UPPER = [
  "JANUARI", "FEBRUARI", "MARET", "APRIL", "MEI", "JUNI",
  "JULI", "AGUSTUS", "SEPTEMBER", "OKTOBER", "NOVEMBER", "DESEMBER",
];

async function validateMonth(month: string, opts: { compareReference?: string } = {}) {
  console.log(`\n=== Bulan ${month} ===`);
  const dayCount = daysInMonth(month);
  const [year, mon] = month.split("-").map(Number);
  const monthLabel = `${MONTHS_ID_UPPER[mon - 1]}'${String(year).slice(2)}`;
  const sheetName = `Pembagian Hasil - ${monthLabel}`;

  const input = await loadLabersSharingRows(month);
  check(`${month}: jumlah baris tanggal = ${dayCount} hari`, input.days.length === dayCount);
  if (input.empty) console.log(`(bulan ${month} tanpa transaksi LABERS — workbook tetap dibuat, bukan 404)`);

  const buffer = await buildLabersSharingWorkbook(input);
  const outFile = `Pembagian Hasil LABERS-${month}.xlsx`;
  writeFileSync(outFile, buffer);
  console.log(`Workbook ditulis: ${outFile} (${buffer.length} bytes)`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  check(`${month}: hanya 1 sheet`, wb.worksheets.length === 1, `${wb.worksheets.length} sheet`);
  const ws = wb.worksheets[0];
  check(`${month}: nama sheet "${sheetName}"`, ws.name === sheetName, ws.name);

  // Merge A1:F1 / A2:F2
  const merges = ws.model.merges ?? [];
  check(`${month}: A1:F1 merged`, merges.includes("A1:F1"));
  check(`${month}: A2:F2 merged`, merges.includes("A2:F2"));

  // Judul & periode
  check(
    `${month}: judul benar`,
    ws.getCell("A1").value === "Rekap Penjualan Labers & Pembagian Persentase",
    String(ws.getCell("A1").value),
  );
  check(`${month}: periode benar`, ws.getCell("A2").value === `Periode: ${monthLabel}`, String(ws.getCell("A2").value));

  // Header baris 4
  const expectedHeaders = ["Tanggal", "Penjualan Labers", "Add On", "Total Penjualan Labers", "Padel (17,5%)", "Labers (82,5%)"];
  let headerOk = true;
  expectedHeaders.forEach((text, i) => {
    if (ws.getCell(4, i + 1).value !== text) headerOk = false;
  });
  check(`${month}: header baris 4 benar`, headerOk, expectedHeaders.join(" | "));

  const firstDataRow = 5;
  const lastDataRow = firstDataRow + dayCount - 1;
  const totalRow = lastDataRow + 1;

  // Baris TOTAL tepat setelah tanggal terakhir
  check(`${month}: baris TOTAL di row ${totalRow}`, ws.getCell(totalRow, 1).value === "TOTAL");
  check(`${month}: tidak ada baris tambahan setelah TOTAL`, ws.getCell(totalRow + 1, 1).value === null);

  // B & C numerik; D/E/F formula benar dengan cached result benar
  let numericOk = true;
  let formulaOk = true;
  let cachedOk = true;
  let noError = true;
  let sumInvariantOk = true;
  for (let i = 0; i < dayCount; i++) {
    const r = firstDataRow + i;
    const b = ws.getCell(r, 2).value;
    const c = ws.getCell(r, 3).value;
    if (typeof b !== "number" || typeof c !== "number") numericOk = false;
    const bNum = Number(b) || 0;
    const cNum = Number(c) || 0;

    const dCell = ws.getCell(r, 4).value as { formula?: string; result?: number } | null;
    const eCell = ws.getCell(r, 5).value as { formula?: string; result?: number } | null;
    const fCell = ws.getCell(r, 6).value as { formula?: string; result?: number } | null;
    if (!dCell || dCell.formula !== `B${r}+C${r}`) formulaOk = false;
    if (!eCell || eCell.formula !== `D${r}*17.5%`) formulaOk = false;
    if (!fCell || fCell.formula !== `D${r}*82.5%`) formulaOk = false;

    const expectedD = bNum + cNum;
    const expectedE = expectedD * 0.175;
    const expectedF = expectedD * 0.825;
    if (Math.abs((dCell?.result ?? NaN) - expectedD) > 0.01) cachedOk = false;
    if (Math.abs((eCell?.result ?? NaN) - expectedE) > 0.01) cachedOk = false;
    if (Math.abs((fCell?.result ?? NaN) - expectedF) > 0.01) cachedOk = false;

    if (Math.abs((eCell?.result ?? 0) + (fCell?.result ?? 0) - expectedD) > 0.01) sumInvariantOk = false;

    for (let col = 1; col <= 6; col++) {
      const v = ws.getCell(r, col).value;
      if (v && typeof v === "object" && "error" in (v as object)) noError = false;
    }
  }
  check(`${month}: kolom B & C numerik untuk semua tanggal`, numericOk);
  check(`${month}: formula D/E/F sesuai spesifikasi`, formulaOk);
  check(`${month}: cached result formula D/E/F benar`, cachedOk);
  check(`${month}: Padel + Labers = Total Penjualan Labers (per tanggal)`, sumInvariantOk);
  check(`${month}: tidak ada formula error`, noError);

  // Baris TOTAL: formula SUM benar
  let totalFormulaOk = true;
  let totalCachedOk = true;
  const cols = ["B", "C", "D", "E", "F"];
  const expectedTotals: Record<string, number> = {};
  for (const col of cols) {
    let sum = 0;
    for (let r = firstDataRow; r <= lastDataRow; r++) sum += cellNumber(ws.getCell(`${col}${r}`).value);
    expectedTotals[col] = sum;
    const totalCell = ws.getCell(`${col}${totalRow}`).value as { formula?: string; result?: number } | null;
    if (!totalCell || totalCell.formula !== `SUM(${col}${firstDataRow}:${col}${lastDataRow})`) totalFormulaOk = false;
    if (Math.abs((totalCell?.result ?? NaN) - sum) > 0.5) totalCachedOk = false;
  }
  check(`${month}: baris TOTAL — formula SUM benar`, totalFormulaOk);
  check(`${month}: baris TOTAL — cached result benar`, totalCachedOk);
  check(
    `${month}: TOTAL Padel + TOTAL Labers = TOTAL Penjualan Labers`,
    Math.abs(expectedTotals.E + expectedTotals.F - expectedTotals.D) < 0.5,
  );

  // Lebar kolom & tinggi baris sama dengan referensi (nilai tetap, bukan template runtime)
  const expectedWidths = [11.53125, 22.9296875, 12.53125, 18.19921875, 16.06640625, 17.265625];
  let widthOk = true;
  expectedWidths.forEach((w, i) => {
    if (Math.abs((ws.getColumn(i + 1).width ?? 0) - w) > 0.01) widthOk = false;
  });
  check(`${month}: lebar kolom A-F sama dengan template`, widthOk);
  check(`${month}: tinggi baris judul/periode = 18`, ws.getRow(1).height === 18 && ws.getRow(2).height === 18);
  check(`${month}: tinggi baris header = 30`, ws.getRow(4).height === 30);

  // Font & number format
  check(
    `${month}: font judul Calibri 14 bold`,
    ws.getCell("A1").font?.name === "Calibri" && ws.getCell("A1").font?.size === 14 && ws.getCell("A1").font?.bold === true,
  );
  check(`${month}: format tanggal kolom A`, ws.getCell(firstDataRow, 1).numFmt === "mm-dd-yy");
  const moneyFmt = '_-"Rp"* #,##0_-;-"Rp"* #,##0_-;_-"Rp"* "-"_-;_-@_-';
  check(`${month}: format accounting Rupiah kolom B-F`, ws.getCell(firstDataRow, 2).numFmt === moneyFmt);

  // Tidak ada "#######" — lebar kolom cukup untuk nilai terbesar (heuristik: no #### string in any cell text)
  let noHash = true;
  ws.eachRow((row) => row.eachCell((cell) => {
    if (typeof cell.value === "string" && cell.value.includes("#")) noHash = false;
  }));
  check(`${month}: tidak ada "#######"`, noHash);

  if (opts.compareReference) {
    const refWb = new ExcelJS.Workbook();
    await refWb.xlsx.readFile(path.join(process.cwd(), "Pembagian hasil labers.xlsx"));
    const refWs = refWb.getWorksheet(opts.compareReference);
    if (!refWs) {
      check(`ref: sheet "${opts.compareReference}" ditemukan`, false);
      return;
    }
    // Total B/C/D/E/F harus sama persis dengan referensi
    for (const col of cols) {
      const refTotal = cellNumber(refWs.getCell(`${col}${totalRow}`).value);
      check(`ref ${month}: TOTAL kolom ${col}`, Math.abs(expectedTotals[col] - refTotal) < 0.5, `export=${expectedTotals[col]} ref=${refTotal}`);
    }
    // Nilai harian B & C harus sama persis dengan referensi. Mismatch di sini
    // biasanya berarti data addonPrice di MongoDB untuk tanggal tsb berubah
    // sejak file referensi dibuat (mis. hasil backfill yang belum membawa
    // addonPrice) — bukan bug rumus (lihat check TOTAL D/E/F di atas, yang
    // tidak bergantung pada split B/C dan tetap harus sama persis).
    let dailyMatch = true;
    for (let r = firstDataRow; r <= lastDataRow; r++) {
      const refB = cellNumber(refWs.getCell(`B${r}`).value);
      const refC = cellNumber(refWs.getCell(`C${r}`).value);
      const ourB = cellNumber(ws.getCell(`B${r}`).value);
      const ourC = cellNumber(ws.getCell(`C${r}`).value);
      if (Math.abs(refB - ourB) > 0.5 || Math.abs(refC - ourC) > 0.5) {
        dailyMatch = false;
        console.log(
          `       ${input.days[r - firstDataRow].date}: ref B=${refB} C=${refC} | export B=${ourB} C=${ourC}`,
        );
      }
    }
    check(`ref ${month}: nilai harian B & C sama persis dengan referensi`, dailyMatch);
    // Lebar kolom & border sama dengan referensi
    let refWidthOk = true;
    for (let c = 1; c <= 6; c++) {
      if (Math.abs((ws.getColumn(c).width ?? 0) - (refWs.getColumn(c).width ?? 0)) > 0.01) refWidthOk = false;
    }
    check(`ref ${month}: lebar kolom identik dengan file referensi`, refWidthOk);
  }
}

// Referensi PRD (hanya untuk log manual — perbandingan aktual dilakukan terhadap
// file "Pembagian hasil labers.xlsx", bukan hardcode di sini):
// Mei 2026  -> Penjualan Labers 29.520.000 | Add On 200.000 | Total 29.720.000 | Padel 5.201.000 | Labers 24.519.000
// Juni 2026 -> Penjualan Labers 26.664.000 | Add On 340.000 | Total 27.004.000 | Padel 4.725.700 | Labers 22.278.300

await validateMonth("2026-05", { compareReference: "Pembagian Hasil - MEI'26" }); // 31 hari
await validateMonth("2026-06", { compareReference: "Pembagian Hasil - JUNI'26" }); // 30 hari
await validateMonth("2026-02"); // Februari 28 hari
await validateMonth("2028-02"); // Februari kabisat 29 hari
await validateMonth("2026-04"); // bulan 30 hari generik
await validateMonth("2026-07"); // bulan 31 hari generik
await validateMonth("2020-01"); // bulan tanpa transaksi LABERS sama sekali (harus tetap 200 OK, bukan 404)

console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan PASS");
process.exit(failures ? 1 : 0);
