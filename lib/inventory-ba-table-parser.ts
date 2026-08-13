// Rekonstruksi tabel Berita Acara Stock Opname SECARA SPASIAL dari text item
// pdf.js (str + posisi X/Y asli dari `transform`), menggantikan pendekatan
// text-stream/baris (lihat AYOSERA-HANDOFF-LATEST.md dan komentar di
// lib/inventory-ba-parser.ts untuk pembuktian root cause: YONEX AC102 yang
// seharusnya Sistem 10/Fisik 9/Selisih -1 terbaca sebagai 201/350/+349 —
// angka milik baris NESTLE PURE LIFE 1500ML — akibat parsing baris teks
// sequential yang salah menafsirkan wrap/urutan token).
//
// STRATEGI (generik, TIDAK hardcode nama produk atau konstanta piksel):
// 1. Cari item header "No." -> X kolom No. dan Y baseline header.
// 2. Anchor baris data = item numerik murni (mis. "1", "2", ...) yang X-nya
//    berada dalam rentang kolom No. (dari X header "No." sampai X header
//    kolom berikutnya) DAN berada di bawah Y header "No.". Y setiap anchor
//    menandai baris ke-N.
// 3. Batas HEADER vs BODY: semua item dengan Y > Y anchor baris pertama
//    (dengan toleransi kecil) adalah bagian header (termasuk label kolom
//    yang wrap ke 2 baris cetak, mis. "Stock Sistem" / "Olsera"), sisanya
//    body.
// 4. Batas kolom diturunkan dari X setiap label header (dicari dengan
//    regex generik per nama kolom, BUKAN posisi piksel hardcode): kolom
//    berjalan dari X label-nya sendiri sampai (tidak termasuk) X label
//    kolom berikutnya, diurutkan menaik.
// 5. Baris data dikelompokkan berdasarkan Y anchor No. (baris N mencakup Y
//    dari anchor N turun sampai SEBELUM anchor N+1) — bukan urutan
//    ekstraksi. Setiap item body ditempatkan ke kolom berdasarkan X-nya
//    sendiri terhadap batas kolom hasil langkah 4.
// 6. Sel multi-baris (mis. deskripsi yang wrap "NESTLE PURE LIFE" lalu
//    "1500ML" sebagai item terpisah) otomatis tergabung karena kedua item
//    berada di kolom X yang sama dan Y-band baris yang sama — digabung
//    urut atas ke bawah (Y menurun -> lebih besar dulu, karena pdf.js: Y
//    besar = lebih ke atas halaman).
import { extractInventoryBaPeriod, inventoryBaParseFailure, numberValue, type InventoryBaItem, type InventoryBaParseResult } from "./inventory-ba-parser.ts";

export type PositionedTextItem = { str: string; x: number; y: number };

type ColumnKey = "no" | "kelompok" | "deskripsi" | "satuan" | "sistem" | "fisik" | "selisih" | "keterangan";

// Regex generik per label kolom — dicocokkan langsung terhadap str satu
// text item header (label kolom bisa satu item "Kelompok Barang" ATAU
// tersebar; kita hanya butuh SATU item yang cocok untuk menetapkan X awal
// kolom, item kelanjutan header seperti "Olsera"/"Aktual" tidak perlu cocok
// apa pun karena tidak dipakai untuk batas kolom).
const COLUMN_LABELS: Record<ColumnKey, RegExp> = {
  no: /^no\.?$/i,
  kelompok: /kelompok/i,
  deskripsi: /deskripsi/i,
  satuan: /^satuan$/i,
  sistem: /sistem/i,
  fisik: /fisik/i,
  selisih: /^selisih$/i,
  keterangan: /keterangan/i,
};

// Kolom wajib untuk tabel BA dianggap valid; "kelompok" dan "keterangan"
// generik tapi opsional (tidak semua varian BA menyertakannya) — bila
// hilang, tetap parse kolom lain (kolom itu bernilai null untuk seluruh baris).
const REQUIRED_COLUMNS: ColumnKey[] = ["no", "deskripsi", "sistem", "fisik", "selisih"];

const LINE_Y_TOLERANCE = 2.5;

type Column = { key: ColumnKey; xStart: number };

function findHeaderColumns(headerItems: PositionedTextItem[]): Column[] {
  const found = new Map<ColumnKey, number>();
  for (const key of Object.keys(COLUMN_LABELS) as ColumnKey[]) {
    const regex = COLUMN_LABELS[key];
    const matches = headerItems.filter((item) => regex.test(item.str.trim()));
    if (matches.length === 0) continue;
    const minX = Math.min(...matches.map((m) => m.x));
    found.set(key, minX);
  }
  return [...found.entries()].map(([key, xStart]) => ({ key, xStart })).sort((a, b) => a.xStart - b.xStart);
}

function assignColumn(x: number, columns: Column[]): ColumnKey {
  let assigned: Column = columns[0];
  for (const col of columns) {
    if (x >= col.xStart - LINE_Y_TOLERANCE) assigned = col;
  }
  return assigned.key;
}

function cellText(items: PositionedTextItem[]): string {
  return [...items]
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((i) => i.str.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse tabel BA Stock Opname langsung dari text item pdf.js (dengan posisi
 * X/Y). `items` HARUS berasal dari halaman dengan text-layer valid (setiap
 * item punya koordinat asli) — pemanggil bertanggung jawab memastikan ini
 * (lihat lib/reconciliation-berita-acara-client-ocr.ts, extractInventoryBaPdfItems).
 * Bila header tabel tidak ditemukan atau tidak ada anchor baris sama
 * sekali, mengembalikan `inventoryBaParseFailure` (0 baris, PERLU_DICEK) —
 * TIDAK PERNAH menebak struktur tabel dari urutan token.
 */
export function parseInventoryBaTable(items: readonly PositionedTextItem[]): InventoryBaParseResult {
  const rawText = items.map((i) => i.str).join(" ");
  if (items.length === 0) return inventoryBaParseFailure(rawText);

  const noHeaderCandidates = items.filter((item) => COLUMN_LABELS.no.test(item.str.trim()));
  if (noHeaderCandidates.length === 0) return inventoryBaParseFailure(rawText);
  const noHeaderY = Math.max(...noHeaderCandidates.map((i) => i.y));
  const noHeaderX = noHeaderCandidates.find((i) => i.y === noHeaderY)!.x;

  // Batas kanan kolom "No." dipakai untuk membatasi pencarian anchor angka
  // baris supaya tidak salah menangkap angka kolom lain yang kebetulan
  // berada di baris yang sama. Perkiraan awal: gunakan X kolom kedua
  // (kelompok/deskripsi) sebagai batas atas sementara — dihitung ulang di
  // bawah setelah header final ditemukan, tapi untuk anchor baris kita
  // hanya perlu rentang kasar di sekitar X kolom No.
  const roughColumns = findHeaderColumns(items.filter((item) => item.y >= noHeaderY - LINE_Y_TOLERANCE));
  const noColIndex = roughColumns.findIndex((c) => c.key === "no");
  const noColXEnd = noColIndex >= 0 && roughColumns[noColIndex + 1] ? roughColumns[noColIndex + 1].xStart : noHeaderX + 60;

  const rowAnchors = items
    .filter((item) => item.y < noHeaderY && item.x >= noHeaderX - LINE_Y_TOLERANCE && item.x < noColXEnd && /^\d+\.?$/.test(item.str.trim()))
    .sort((a, b) => b.y - a.y);

  if (rowAnchors.length === 0) return inventoryBaParseFailure(rawText);

  const rowYs = rowAnchors.map((a) => a.y);
  const headerCutoffY = rowYs[0] + LINE_Y_TOLERANCE;

  const headerItems = items.filter((item) => item.y > headerCutoffY);
  const columns = findHeaderColumns(headerItems);
  const foundKeys = new Set(columns.map((c) => c.key));
  const missingRequired = REQUIRED_COLUMNS.some((key) => !foundKeys.has(key));
  if (missingRequired) return inventoryBaParseFailure(rawText);

  const bodyItems = items.filter((item) => item.y <= headerCutoffY);

  // Baris N mencakup Y dari rowYs[N] (inklusif) turun sampai SEBELUM rowYs[N+1].
  function rowIndexForY(y: number): number {
    for (let i = 0; i < rowYs.length; i++) {
      const upper = rowYs[i] + LINE_Y_TOLERANCE;
      const lower = i + 1 < rowYs.length ? rowYs[i + 1] + LINE_Y_TOLERANCE : -Infinity;
      if (y <= upper && y > lower) return i;
    }
    return -1;
  }

  const rowsBuckets: Map<ColumnKey, PositionedTextItem[]>[] = rowYs.map(() => new Map());
  for (const item of bodyItems) {
    const rowIndex = rowIndexForY(item.y);
    if (rowIndex === -1) continue;
    const col = assignColumn(item.x, columns);
    if (col === "no") continue; // kolom "No." hanya penanda urutan baris, bukan data.
    const bucket = rowsBuckets[rowIndex];
    const list = bucket.get(col) ?? [];
    list.push(item);
    bucket.set(col, list);
  }

  const { periodStart, cutoffDate } = extractInventoryBaPeriod(rawText);

  const rowItems: InventoryBaItem[] = rowsBuckets.map((bucket) => {
    const description = cellText(bucket.get("deskripsi") ?? []);
    const kelompokText = cellText(bucket.get("kelompok") ?? []);
    const keteranganText = cellText(bucket.get("keterangan") ?? []);
    const satuanText = cellText(bucket.get("satuan") ?? []);
    const sistemText = cellText(bucket.get("sistem") ?? []);
    const fisikText = cellText(bucket.get("fisik") ?? []);
    const selisihText = cellText(bucket.get("selisih") ?? []);

    const satuan = satuanText ? numberValue(satuanText) : null;
    const systemQty = sistemText ? numberValue(sistemText) : null;
    const physicalQty = fisikText ? numberValue(fisikText) : null;
    const differenceQty = selisihText ? numberValue(selisihText) : null;

    const hasRequiredCells = description.length >= 1 && systemQty !== null && physicalQty !== null && differenceQty !== null;
    const arithmeticOk = hasRequiredCells && differenceQty === physicalQty! - systemQty!;
    const ok = hasRequiredCells && arithmeticOk;

    return {
      description,
      kelompok: kelompokText || null,
      satuan,
      systemQty,
      physicalQty,
      differenceQty,
      keterangan: keteranganText || null,
      confidence: ok ? 1 : 0,
      status: ok ? "OK" : "PERLU_DICEK",
    };
  });

  const status = periodStart && cutoffDate && rowItems.length > 0 ? (rowItems.every((item) => item.status === "OK") ? "OK" : "PERLU_DICEK") : "PERLU_DICEK";

  return { periodStart, cutoffDate, items: rowItems, status, rawText };
}
