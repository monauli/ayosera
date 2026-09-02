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
// Word-boundary (\b), BUKAN substring bebas: sebelumnya /kelompok/i dkk. bisa
// cocok dengan kata itu sendiri di manapun ia muncul, termasuk di paragraf
// naratif BA (mis. "...penghitungan fisik persediaan barang tersebut...")
// yang letaknya jauh dari header tabel sungguhan. \b membatasi ke kata utuh
// saja (menolak "spesifik"). Kata pengganggu "fisik" (ejaan benar) di
// paragraf tetap KATA UTUH juga, jadi \b saja tidak cukup untuk kasus itu —
// fix scope pencarian ada di findHeaderTopY()/countHeaderKeywordsOnLine() di
// bawah, bukan di regex ini.
//
// ROOT CAUSE (BA Mei 2026, real production file — pdf.js raw dump proved
// this): header kolom Fisik PADA FILE PDF ASLI tertulis "Fislk" (huruf "i"
// kedua tertukar jadi "l" — typo/rendering asli dokumen sumber, BUKAN typo
// ekstraksi), sedangkan regex sebelumnya hanya cocok ejaan baku "Fisik".
// Fix generik (pola sama seperti toleransi "Deksripsi"/"Deskripsi" di atas,
// bukan hardcode satu dokumen): terima kebingungan huruf i/l (visual mirip,
// umum pada font/rendering tertentu) di KEDUA posisi "i" pada kata "fisik".
const COLUMN_LABELS: Record<ColumnKey, RegExp> = {
  no: /^no\.?$/i,
  kelompok: /\bkelompok\b/i,
  deskripsi: /\bde[ks]{2}ripsi\b/i,
  satuan: /^satuan$/i,
  sistem: /\bsistem\b/i,
  fisik: /\bf[il]s[il]k\b/i,
  selisih: /^selisih$/i,
  keterangan: /\bketerangan\b/i,
};

// Header tabel WAJIB memuat BEBERAPA label kolom sekaligus pada baris Y yang
// SAMA (header rekonsiliasi/BA selalu multi-kolom dalam satu baris cetak) —
// dipakai countHeaderKeywordsOnLine() untuk menolak baris manapun yang cuma
// kebetulan memuat SATU kata kunci sendirian (mis. satu kalimat naratif yang
// cuma memuat kata "fisik" atau "sistem"), bukan header sungguhan.
const MIN_HEADER_KEYWORDS_ON_LINE = 3;

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
/**
 * Tentukan batas ATAS wilayah header (headerTopY) secara generik dari jarak
 * antar-baris INTERNAL header itu sendiri (baris label yang wrap, mis.
 * "Kelompok"/"Satuan"/"Stock Sistem"/"Stock Fisik" di atas/bawah baris utama
 * "No."), BUKAN dari tinggi baris tabel data (row height) seperti
 * sebelumnya.
 *
 * ROOT CAUSE (BA Mei 2026, real production file): baris paragraf naratif di
 * atas tabel ("...penghitungan fisik persediaan barang tersebut...",
 * "...fisik persediaan barang (stock opname) di area gudang...") punya
 * jarak antar-kalimat (~15-32pt) yang KEBETULAN lebih kecil dari ambang
 * lama (rowHeight tabel data × 1.5 ≈ 43pt) — walk-up lama akhirnya menyapu
 * SELURUH paragraf pembuka sampai judul dokumen sebagai "header", membuat
 * kata "fisik" di paragraf itu (X-nya lebih kiri dari header sungguhan)
 * terpilih sebagai posisi kolom Fisik. Fix generik: ukur jarak baris header
 * SUNGGUHAN itu sendiri (baris tepat di atas "No.", biasanya label kolom
 * yang wrap ke 2-3 baris cetak, berjarak ~6-7pt pada kedua file real yang
 * tersedia) sebagai acuan ambang — bukan tinggi baris tabel data (orde
 * besarnya berbeda, tidak relevan untuk memutuskan seberapa jauh header
 * boleh melebar). Ambang = 3× jarak acuan itu (longgar untuk toleransi
 * jitter baseline antar font), dengan lantai minimum kecil untuk kasus
 * tanpa baris wrap sama sekali di atas "No.".
 */
function findHeaderTopY(items: readonly PositionedTextItem[], headerPage: number, pageOf: (item: PositionedTextItem) => number, noHeaderY: number): number {
  const aboveYs = [...new Set(items.filter((item) => pageOf(item) === headerPage && item.y > noHeaderY).map((item) => item.y))].sort((a, b) => a - b);
  if (aboveYs.length === 0) return noHeaderY;
  const referenceGap = aboveYs[0] - noHeaderY;
  const threshold = Math.max(referenceGap * 3, 10);
  let headerTopY = noHeaderY;
  for (const y of aboveYs) {
    if (y - headerTopY > threshold) break;
    headerTopY = y;
  }
  return headerTopY;
}

/**
 * Validasi bahwa baris Y `noHeaderY` (tempat "No." ditemukan) benar-benar
 * baris header tabel, bukan kebetulan satu kata yang cocok regex kolom di
 * tengah paragraf naratif: header tabel BA SELALU multi-kolom pada satu
 * baris cetak yang sama (lihat MIN_HEADER_KEYWORDS_ON_LINE). Mengembalikan
 * jumlah label kolom BERBEDA yang ditemukan PERSIS pada baris itu (bukan di
 * seluruh halaman).
 */
function countHeaderKeywordsOnLine(items: readonly PositionedTextItem[], headerPage: number, pageOf: (item: PositionedTextItem) => number, noHeaderY: number): number {
  const lineItems = items.filter((item) => pageOf(item) === headerPage && Math.abs(item.y - noHeaderY) <= LINE_Y_TOLERANCE);
  return (Object.keys(COLUMN_LABELS) as ColumnKey[]).filter((key) => lineItems.some((item) => COLUMN_LABELS[key].test(item.str.trim()))).length;
}

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

  // Header tabel BA SELALU multi-kolom pada satu baris cetak yang sama —
  // tolak baris "No." palsu (kebetulan cocok regex di tengah kalimat lain)
  // yang TIDAK disertai label kolom lain sama sekali pada baris Y yang sama.
  if (countHeaderKeywordsOnLine(items, headerPage, pageOf, noHeaderY) < MIN_HEADER_KEYWORDS_ON_LINE) return inventoryBaParseFailure(rawText);

  // Batas ATAS wilayah header, dihitung SEKALI dari jarak antar-baris
  // internal header itu sendiri (lihat findHeaderTopY) — dipakai untuk
  // membatasi KEDUA pencarian di bawah (roughColumns dan header final)
  // supaya paragraf naratif di atas tabel tidak pernah ikut tersapu sebagai
  // header, walau isinya kebetulan memuat kata seperti "fisik"/"sistem".
  const headerTopY = findHeaderTopY(items, headerPage, pageOf, noHeaderY);

  // Batas kanan kolom "No." dipakai untuk membatasi pencarian anchor angka
  // baris supaya tidak salah menangkap angka kolom lain yang kebetulan
  // berada di baris yang sama. Perkiraan awal: gunakan X kolom kedua
  // (kelompok/deskripsi) sebagai batas atas sementara — dihitung ulang di
  // bawah setelah header final ditemukan, tapi untuk anchor baris kita
  // hanya perlu rentang kasar di sekitar X kolom No.
  const roughColumns = findHeaderColumns(items.filter((item) => pageOf(item) === headerPage && item.y >= noHeaderY - LINE_Y_TOLERANCE && item.y <= headerTopY + LINE_Y_TOLERANCE));
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
  const rawRowAnchors = items
    .filter((item) => {
      if (item.x < noHeaderX - LINE_Y_TOLERANCE || item.x >= noColXEnd) return false;
      if (!/^\d+\.?$/.test(item.str.trim())) return false;
      if (pageOf(item) === headerPage) return item.y < noHeaderY;
      return true;
    })
    .sort((a, b) => pageOf(a) - pageOf(b) || b.y - a.y);

  // ROOT CAUSE (BA Mei 2026, real production file): nomor kolom "No." pada
  // halaman SELAIN halaman header tidak dibatasi rentang Y sama sekali (lihat
  // komentar di atas — tidak ada baris header untuk dibandingkan di halaman
  // lain), sehingga angka murni APA PUN pada rentang X kolom "No." di halaman
  // itu ikut lolos jadi anchor — termasuk digit acak pada blok tanda
  // tangan/footer (mis. "0" pada teks "0 # t r v? %") yang kebetulan berada
  // pada X yang sama. Fix generik (tidak hardcode nilai/posisi tertentu):
  // nomor urut tabel BA SELALU naik 1, 2, 3, ... N tanpa lompatan/duplikat —
  // jadi anchor yang valid harus PERSIS mengikuti urutan itu. Anchor mana pun
  // yang nilainya tidak sama dengan angka berikutnya yang diharapkan dibuang
  // sebagai noise (bukan baris tabel), bukan menyebabkan gagal total — baris
  // asli yang memang berurutan tetap lolos apa adanya.
  const rowAnchors: PositionedTextItem[] = [];
  let expectedRowNo = 1;
  for (const anchor of rawRowAnchors) {
    const value = Number(anchor.str.trim().replace(/\.$/, ""));
    if (value === expectedRowNo) {
      rowAnchors.push(anchor);
      expectedRowNo++;
    }
  }

  if (rowAnchors.length === 0) return inventoryBaParseFailure(rawText);

  const headerPageRowYs = rowAnchors.filter((a) => pageOf(a) === headerPage).map((a) => a.y);
  const headerCutoffY = headerPageRowYs.length > 0 ? headerPageRowYs[0] + LINE_Y_TOLERANCE : noHeaderY;

  // headerTopY (batas atas) sudah dihitung generik di awal (findHeaderTopY,
  // dari jarak antar-baris internal header sendiri — lihat komentar di
  // sana untuk ROOT CAUSE BA Mei 2026 yang digantikan pendekatan lama di
  // sini). headerCutoffY (batas bawah, dari anchor baris pertama yang sudah
  // tervalidasi berurutan) tetap seperti semula.
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
  //
  // ROOT CAUSE TIE-BREAK (BA Mei 2026, real production file): pada layout
  // ini, offset baris-pertama sel yang wrap (di ATAS anchor-nya sendiri)
  // kebetulan nyaris PERSIS separuh jarak antar-anchor (mis. 13.44pt vs
  // jarak antar-baris ~28pt) — sehingga jarak ke anchor SEBELUMNYA (di
  // atas) dan ke anchor MILIKNYA SENDIRI (di bawah) nyaris identik, dan
  // "jarak minimum murni" di atas memilih anchor PERTAMA yang ditemukan
  // (di atas, bukan pemiliknya) pada seri seperti itu — nama produk baris
  // berikutnya (mis. "POCARI SWEAT PET") ikut "tercuri" ke baris
  // sebelumnya. Fix generik (BUKAN hardcode posisi/nilai): kumpulkan semua
  // anchor yang jaraknya dalam toleransi kecil dari jarak minimum (seri),
  // lalu di antara yang seri itu menangkan anchor dengan Y PALING KECIL
  // (paling bawah/dekat) — bukti empiris dari KEDUA file real yang
  // tersedia: baris pertama sel yang wrap SELALU tercetak DI ATAS anchor
  // miliknya sendiri (tidak pernah "melompati" anchor sendiri untuk
  // menempel ke anchor SEBELUMNYA). Toleransi seri dibatasi (LINE_Y_TOLERANCE)
  // supaya kasus BA Juli 2026 (jarak 6.7pt vs 22.4pt, jauh berbeda, tidak
  // pernah seri) tidak terpengaruh sama sekali oleh perubahan ini.
  function rowIndexForItem(item: PositionedTextItem): number {
    const page = pageOf(item);
    const candidates = rowAnchors.map((anchor, index) => ({ index, y: anchor.y, dist: Math.abs(anchor.y - item.y) })).filter((_, index) => pageOf(rowAnchors[index]) === page);
    if (candidates.length === 0) return -1;
    const minDist = Math.min(...candidates.map((c) => c.dist));
    const tied = candidates.filter((c) => c.dist <= minDist + LINE_Y_TOLERANCE);
    tied.sort((a, b) => a.y - b.y);
    return tied[0].index;
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
