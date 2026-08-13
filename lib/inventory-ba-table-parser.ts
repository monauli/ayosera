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

// `page` opsional untuk kompatibilitas mundur (test lama tanpa field ini
// diperlakukan seolah semua item berada di halaman yang sama, page 1).
// Dipakai untuk tabel yang bersambung lintas halaman: nomor kolom "No."
// terus lanjut (mis. 1..7 di halaman 1, 8..12 di halaman 2), tetapi
// koordinat Y masing-masing halaman independen (mulai lagi dari atas
// halaman) — tanpa `page`, baris di halaman 2 bisa salah dianggap dekat
// dengan anchor baris halaman 1 yang kebetulan Y-nya mirip.
export type PositionedTextItem = { str: string; x: number; y: number; page?: number };

type ColumnKey = "no" | "kelompok" | "deskripsi" | "satuan" | "sistem" | "fisik" | "selisih" | "keterangan";

// Regex generik per label kolom — dicocokkan langsung terhadap str satu
// text item header (label kolom bisa satu item "Kelompok Barang" ATAU
// tersebar; kita hanya butuh SATU item yang cocok untuk menetapkan X awal
// kolom, item kelanjutan header seperti "Olsera"/"Aktual" tidak perlu cocok
// apa pun karena tidak dipakai untuk batas kolom).
// ROOT CAUSE (BA Juli 2026, real production file — pdf.js raw dump proved
// this, not a guess): header kolom deskripsi PADA FILE PDF ASLI tertulis
// "Deksripsi Barang" (k dan s TERTUKAR — typo asli dokumen sumber, bukan
// artefak ekstraksi), sedangkan regex sebelumnya hanya cocok ejaan baku
// "Deskripsi". Akibatnya findHeaderColumns tidak pernah menemukan kolom
// deskripsi -> missingRequired true -> parser SELALU gagal (0 baris,
// PERLU_DICEK) untuk file real ini walau posisi X/Y tabel sudah benar.
// Fix generik (bukan hardcode nama produk): terima kedua ejaan ("deskripsi"
// dan "deksripsi") via regex yang toleran terhadap transposisi k/s tersebut.
const COLUMN_LABELS: Record<ColumnKey, RegExp> = {
  no: /^no\.?$/i,
  kelompok: /kelompok/i,
  deskripsi: /de[ks]{2}ripsi/i,
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

// ROOT CAUSE (BA Juli 2026, real production file): body cell text is not
// always left-aligned to exactly its header label's X — e.g. "Keterangan"
// header sits at x≈496.8 but the actual "Untuk Raket Sewa"/"Salah Input di
// Kasir" cell text starts at x≈480-482 (visually center-ish within the
// column width), and "Kelompok" header sits at x≈114.0 while "BOLA PADEL"
// cell text starts at x≈109.2. The old walk-and-overwrite assignment
// (`x >= col.xStart - tolerance`) required cell text to start AT OR RIGHT OF
// its own header label, so text starting slightly left of its label's X
// bled into the PREVIOUS column instead (keterangan -> selisih, kelompok ->
// no). Fix (generic, derived purely from header X positions, no hardcoded
// pixel constants): assign each item to the column whose header label is
// CLOSEST on the left, using the MIDPOINT between adjacent header X
// positions as the column boundary rather than each header's own X. This
// tolerates content that starts left/right of its label as long as it is
// still closer to its own column's label than to the neighboring one.
function assignColumn(x: number, columns: Column[]): ColumnKey {
  for (let i = 0; i < columns.length; i++) {
    const nextStart = columns[i + 1]?.xStart;
    const boundary = nextStart !== undefined ? (columns[i].xStart + nextStart) / 2 : Infinity;
    if (x < boundary) return columns[i].key;
  }
  return columns[columns.length - 1].key;
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

  const pageOf = (item: PositionedTextItem): number => item.page ?? 1;

  const noHeaderCandidates = items.filter((item) => COLUMN_LABELS.no.test(item.str.trim()));
  if (noHeaderCandidates.length === 0) return inventoryBaParseFailure(rawText);
  const noHeaderY = Math.max(...noHeaderCandidates.map((i) => i.y));
  const noHeaderItem = noHeaderCandidates.find((i) => i.y === noHeaderY)!;
  const noHeaderX = noHeaderItem.x;
  const headerPage = pageOf(noHeaderItem);

  // Batas kanan kolom "No." dipakai untuk membatasi pencarian anchor angka
  // baris supaya tidak salah menangkap angka kolom lain yang kebetulan
  // berada di baris yang sama. Perkiraan awal: gunakan X kolom kedua
  // (kelompok/deskripsi) sebagai batas atas sementara — dihitung ulang di
  // bawah setelah header final ditemukan, tapi untuk anchor baris kita
  // hanya perlu rentang kasar di sekitar X kolom No.
  const roughColumns = findHeaderColumns(items.filter((item) => pageOf(item) === headerPage && item.y >= noHeaderY - LINE_Y_TOLERANCE));
  const noColIndex = roughColumns.findIndex((c) => c.key === "no");
  const noColXEnd = noColIndex >= 0 && roughColumns[noColIndex + 1] ? roughColumns[noColIndex + 1].xStart : noHeaderX + 60;

  // Anchor baris = item numerik murni dalam rentang X kolom "No.". Untuk
  // tabel yang bersambung lintas halaman (`page` berbeda), setiap halaman
  // punya sistem koordinat Y sendiri (mulai lagi dari atas halaman) —
  // anchor di halaman header dibatasi `y < noHeaderY`, sedangkan anchor di
  // halaman LAIN (lanjutan tabel, tidak ada baris header di sana) tidak
  // dibatasi Y karena tidak ada baris header untuk dibandingkan. Diurutkan
  // per halaman (menaik) lalu Y menurun dalam halaman itu supaya urutan
  // baris hasil akhir tetap urutan baca alami, bukan tercampur.
  const rowAnchors = items
    .filter((item) => {
      if (item.x < noHeaderX - LINE_Y_TOLERANCE || item.x >= noColXEnd) return false;
      if (!/^\d+\.?$/.test(item.str.trim())) return false;
      if (pageOf(item) === headerPage) return item.y < noHeaderY;
      return true;
    })
    .sort((a, b) => pageOf(a) - pageOf(b) || b.y - a.y);

  if (rowAnchors.length === 0) return inventoryBaParseFailure(rawText);

  const headerPageRowYs = rowAnchors.filter((a) => pageOf(a) === headerPage).map((a) => a.y);
  const headerCutoffY = headerPageRowYs.length > 0 ? headerPageRowYs[0] + LINE_Y_TOLERANCE : noHeaderY;

  // ROOT CAUSE (BA Juli 2026, real production file — proved via raw pdf.js
  // dump, not a guess): the OLD `item.y > headerCutoffY` filter had no upper
  // bound, so it also captured body paragraph text sitting ABOVE the table
  // (e.g. the word "fisik" inside "...penghitungan fisik persediaan barang
  // (stock opname)..." at y≈479) — with multiple candidates, `findHeaderColumns`
  // picks the SMALLEST x among matches, so that stray paragraph occurrence
  // (x≈72) beat the real "Fisik" header cell (x≈388) and corrupted the
  // column boundaries downstream, causing Sistem/Fisik to read as null.
  // Fix (generic, no hardcoded pixel/text constants): bound the header
  // region to a contiguous run of Y values directly above the topmost row
  // anchor, stopping at the first large vertical gap — real header label
  // lines (incl. wrapped labels like "Stock"/"Sistem"/"Olsera") sit close
  // together (gap ~ one line height), while paragraph text above the table
  // is always separated by a much larger gap.
  const rowHeight = headerPageRowYs.length >= 2 ? headerPageRowYs[0] - headerPageRowYs[1] : 40;
  const headerGapThreshold = Math.max(rowHeight * 1.5, 20);
  const candidateHeaderYsAsc = [...new Set(items.filter((item) => pageOf(item) === headerPage && item.y > headerCutoffY).map((item) => item.y))].sort((a, b) => a - b);
  let headerTopY = headerCutoffY;
  for (const y of candidateHeaderYsAsc) {
    if (y - headerTopY > headerGapThreshold) break;
    headerTopY = y;
  }

  const headerItems = items.filter((item) => pageOf(item) === headerPage && item.y > headerCutoffY && item.y <= headerTopY + LINE_Y_TOLERANCE);
  const columns = findHeaderColumns(headerItems);
  const foundKeys = new Set(columns.map((c) => c.key));
  const missingRequired = REQUIRED_COLUMNS.some((key) => !foundKeys.has(key));
  if (missingRequired) return inventoryBaParseFailure(rawText);

  // Body = semua item KECUALI header (halaman header, di atas headerCutoffY)
  // dan KECUALI anchor baris "No." sendiri (ditangani terpisah, bukan data
  // kolom). Item di halaman lain (lanjutan tabel) semuanya body — tidak ada
  // wilayah header untuk dikecualikan di sana.
  const bodyItems = items.filter((item) => !(pageOf(item) === headerPage && item.y > headerCutoffY));

  // ROOT CAUSE tambahan (real file): sel deskripsi yang wrap 2 baris cetak
  // (mis. "NESTLE PURE LIFE" lalu "1500ML") memiliki baseline Y yang
  // SIMETRIS di atas & di bawah Y anchor baris tersebut (bukan selalu di
  // BAWAH anchornya) — band tetap lama ("dari anchor N turun sampai sebelum
  // anchor N+1") salah menaruh baris pertama sel wrap tersebut ke baris
  // SEBELUMNYA karena Y-nya lebih besar dari anchor barisnya sendiri. Fix
  // generik: assign tiap item body ke anchor TERDEKAT (jarak |Y| minimum)
  // pada HALAMAN YANG SAMA — ini otomatis menggabungkan sel multi-baris ke
  // baris yang benar tanpa constant piksel apa pun, dan multi-halaman aman
  // karena hanya anchor di halaman yang sama yang dibandingkan.
  function rowIndexForItem(item: PositionedTextItem): number {
    const page = pageOf(item);
    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rowAnchors.length; i++) {
      if (pageOf(rowAnchors[i]) !== page) continue;
      const dist = Math.abs(rowAnchors[i].y - item.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  const rowsBuckets: Map<ColumnKey, PositionedTextItem[]>[] = rowAnchors.map(() => new Map());
  for (const item of bodyItems) {
    const rowIndex = rowIndexForItem(item);
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
