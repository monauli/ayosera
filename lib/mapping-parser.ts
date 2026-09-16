// Parser laporan keuangan (Laba Rugi) dari PDF — TAHAP 1 modul Mapping.
//
// Inti file ini adalah FUNGSI MURNI tanpa import apa pun di level modul,
// supaya bisa diuji langsung dengan `node --experimental-strip-types --test`
// tanpa tsx/webpack. Jalur I/O (pdf.js + tesseract.js) memakai `import()`
// dinamis di dalam fungsi, jadi hanya dieksekusi di browser.
//
// RANCANGAN BERDASARKAN SPIKE (tmp/ocr-spike/): dua fixture nyata dari
// exporter yang sama ternyata BERBEDA di hampir semua detail permukaan, jadi
// parser ini sengaja tidak mengasumsikan satu bentuk:
//
//                      | Feb-2026 (scan)        | Mei-2026 (digital)
//   format angka       | 39,981,000.00  (US)    | 33.230.000,00  (ID)
//   negatif            | token "-" TERPISAH,    | "(162.000,00)" kurung
//                      | ~175px kiri angkanya   | atau "-" menempel
//   nilai nihil        | tanda "–"              | "0,00"
//   posisi nominal     | 1 BARIS DI ATAS label  | sebaris dengan label
//
// Dua titik rapuh yang TERBUKTI di spike dan jadi alasan utama pengaman
// aritmatika di bawah:
//   (a) tanda minus adalah token terpisah — pada render 158 DPI satu tanda
//       minus HILANG (142.000 terbaca +142.000, sign flip diam-diam) dan
//       confidence OCR tidak memberi sinyal apa pun;
//   (b) nominal tercetak 1 baris di atas labelnya, sehingga asosiasi
//       label->nominal yang lurus hanya menghasilkan 1 dari 27 benar.
// Keduanya adalah kegagalan SENYAP: angkanya tetap terlihat masuk akal.
// Karena itu hasil parsing TIDAK PERNAH dikembalikan tanpa direkonsiliasi
// dulu terhadap angka total yang tercetak di dokumen — lihat `reconcile()`.
// Dokumen yang tidak rekonsiliasi DITOLAK, bukan diterima dengan peringatan.

export type MappingToken = {
  text: string;
  /** Tepi kiri token. */
  x: number;
  /** Koordinat baris, MEMBESAR KE BAWAH (kebalikan sumbu Y pdf.js). */
  y: number;
  /** Halaman 1-based; baris tidak pernah digabung lintas halaman. */
  page: number;
};

export type MappingLineKind = "detail" | "subtotal" | "derived" | "header";

/**
 * Ketiga laporan yang ditangani modul ini.
 *
 * Tinggal di sini, BUKAN di lib/mapping-excel-parser.ts tempat ia lahir,
 * karena identitas aritmatika per laporan (reconcileFinalIdentity di bawah)
 * sekarang dipakai kedua sisi — PDF dan Excel — dan file ini adalah rumah
 * bersama pengaman aritmatika. mapping-excel-parser.ts mengekspor ulang
 * namanya supaya pemanggil lama tidak perlu diubah.
 */
export type FinancialSheetKind = "profit-loss" | "balance-sheet" | "cashflow";

/**
 * Satu baris laporan keuangan, LEPAS dari sumbernya (PDF atau Excel).
 *
 * Dipisah dari MappingLine supaya parser Excel (lib/mapping-excel-parser.ts)
 * bisa memakai pengaman aritmatika yang SAMA PERSIS — lihat
 * reconcileSubtotals() dan reconcileNetProfitChain() di bawah — tanpa perlu
 * membawa `page` yang tidak punya arti di spreadsheet, dan tanpa menduplikasi
 * logic rekonsiliasinya.
 */
export type FinancialLine = {
  /** Kode akun 4-6 digit, atau null untuk header/subtotal/baris turunan. */
  code: string | null;
  label: string;
  /** null hanya untuk header tanpa nominal. */
  value: number | null;
  kind: MappingLineKind;
  /**
   * true bila baris detail punya kode akun tapi nominalnya tidak terbaca
   * sama sekali lalu diasumsikan 0. Terjadi nyata pada fixture Feb-2026:
   * placeholder nihil "–" di baris 40004 dibaca OCR sebagai token ":"
   * dengan confidence 0. Asumsi ini AMAN karena kalau nominal sebenarnya
   * bukan 0, subtotal tidak akan rekonsiliasi dan dokumen ditolak.
   */
  assumedZero: boolean;
};

/** Baris hasil parsing PDF: FinancialLine plus halaman asalnya. */
export type MappingLine = FinancialLine & { page: number };

/**
 * Satu baris yang ikut membentuk angka `actual` sebuah cek.
 *
 * `value` adalah KONTRIBUSI baris itu terhadap `actual`, bukan selalu nilai
 * tercetaknya: pada rantai laba bersih baris biaya menyumbang negatif. Jadi
 * daftar ini selalu bisa dijumlah dengan mata dan mendarat tepat di `actual`.
 */
export type ReconciliationContributor = { code: string | null; label: string; value: number };

export type ReconciliationCheck = {
  kind: "section" | "final";
  label: string;
  expected: number;
  actual: number;
  difference: number;
  tolerance: number;
  passed: boolean;
  /**
   * Baris yang ikut dijumlah jadi `actual`.
   *
   * Ada HANYA untuk diagnosis — tidak pernah dipakai menghitung apa pun.
   * Tanpa ini sebuah penolakan cuma memberi selisih tanpa menunjuk baris
   * mana yang salah, dan itu terbukti mahal: satu label "Total Modal" yang
   * terbaca "Totai Modal" membuat baris itu terhitung sebagai detail
   * sehingga section Modal terjumlah DUA KALI, dan yang terlihat di layar
   * hanya angka selisih raksasa tanpa petunjuk asalnya.
   */
  contributors: readonly ReconciliationContributor[];
};

export type MappingParseResult =
  | {
      status: "ok";
      /** 0 = nominal sebaris label; 1 = nominal tercetak 1 baris di atas label. */
      rowOffsetApplied: 0 | 1;
      /**
       * Periode laporan "YYYY-MM" yang dibaca dari kop surat, atau null bila
       * kop-nya tidak memuat bulan+tahun yang bisa dikenali.
       *
       * WAJIB dipakai pemanggil untuk memastikan PDF yang dibaca memang
       * periode yang sedang dilihat. Tanpa ini, mengganti bulan di UI tidak
       * mengubah sisi PDF dan setiap baris berubah jadi "beda" palsu.
       */
      period: string | null;
      lines: MappingLine[];
      checks: ReconciliationCheck[];
    }
  | {
      status: "rejected";
      reason: string;
      /** Hasil rekonsiliasi tiap offset yang dicoba, untuk diagnosis. */
      attempts: { rowOffset: 0 | 1; failedChecks: ReconciliationCheck[] }[];
      /**
       * Percobaan yang PALING DEKAT benar — paling sedikit cek gagal, lalu
       * selisih terbesarnya paling kecil.
       *
       * Inilah yang harus ditampilkan, bukan percobaan terakhir. Terbukti di
       * production: Neraca gagal 1 cek pada offset 0 dan 3 cek pada offset 1,
       * dan yang tampil di layar justru diagnosa offset 1 — angka-angka yang
       * sama sekali tidak menunjuk ke masalah sebenarnya.
       */
      bestAttempt?: { rowOffset: 0 | 1; failedChecks: ReconciliationCheck[] };
      /**
       * true bila laporan ini memang TIDAK ADA di berkas — bukan ada tapi
       * angkanya tidak bisa dipercaya. Dibedakan supaya PDF yang hanya
       * memuat Laba Rugi tidak menampilkan Neraca sebagai "Ditolak", yang
       * akan terbaca seolah ada yang salah dengan dokumennya.
       */
      notFound?: boolean;
    };

export const MAPPING_PARSER_VERSION = "1";

/**
 * Skala render pdf.js untuk jalur PDF hasil scan.
 *
 * pdf.js memakai basis 72 DPI, jadi 4.2 ≈ 302 DPI. Angka ini BUKAN tebakan:
 * spike membuktikan `RENDER_SCALE = 2.2` (≈158 DPI, dipakai
 * lib/reconciliation-berita-acara-client-ocr.ts) menghilangkan satu tanda
 * minus dari 27 nominal, sedangkan pada 300 DPI ke-27 nominal terbaca utuh
 * termasuk seluruh tanda minusnya. 300 DPI juga resolusi native scan pada
 * fixture (2480x3507 px untuk A4), jadi render di atas itu hanya memperbesar
 * bitmap tanpa menambah informasi.
 *
 * Biaya: ~2500x3536 px = ~35 MB per canvas, dilepas per halaman.
 *
 * ponytail: konstanta, bukan deteksi DPI native per dokumen. Cukup untuk
 * scan 200-300 DPI (mayoritas). Kalau nanti ketemu scan >300 DPI yang
 * nominalnya meleset, naikkan ke skala native gambar tertanam.
 */
export const SCAN_RENDER_SCALE = 4.2;
// Scan PDF hasil kompresi bisa menyimpan JPEG 150 DPI. OCR langsung pada
// ukuran itu kehilangan baris saldo yang kecil; gambar asli dibesarkan di
// memori sebelum OCR, tanpa merender ulang halaman PDF lewat pdf.js.
const EMBEDDED_OCR_MIN_WIDTH = 1800;
const EMBEDDED_OCR_SCALE = 3;

/**
 * Toleransi rekonsiliasi PER BARIS DETAIL, dalam rupiah.
 *
 * Bukan longgar-longgaran: exporter memotong desimal di baris detail tapi
 * menyimpannya di subtotal. Terbukti pada fixture Feb-2026 — detail 70000
 * tercetak "42.653" sedangkan subtotalnya "40.053,48" (42.653,48 - 2.600).
 * Tiap baris terpotong kehilangan <1 rupiah, jadi galat sah maksimum adalah
 * 1 x jumlah baris detail di section tersebut.
 *
 * Margin terhadap kesalahan yang ingin ditangkap masih ~1000x: nominal
 * terkecil di fixture adalah 2.600, jadi satu baris terlewat = galat 2.600
 * dan satu tanda minus hilang = galat 2x nominalnya — keduanya jauh di atas
 * toleransi beberapa rupiah.
 */
const TRUNCATION_TOLERANCE_PER_LINE = 1;

/** Subtotal membawa desimal penuh, jadi rantai subtotal -> laba bersih harus eksak. */
export const FINAL_TOLERANCE = 0.05;
/** Neraca Excel dapat berbeda Rp1 karena pembulatan formula total akhir. */
export const BALANCE_FINAL_TOLERANCE = 1;

const ACCOUNT_CODE = /^\d{4,6}$/;
const DASH = /^[-–—]$/;
// "Jumlah" dipakai sheet Neraca di fixture Excel ("Jumlah Aset Lancar").
// OCR bisa menambahkan token pendek di depan, jadi ini sengaja bukan prefix.
const TOTAL_PREFIX = /(?:^|[^a-z])(?:sub|ub)?total\b|\bjumlah\b/i;
const EXPENSE_LABEL = /\b(biaya|beban)\b/i;
const NET_PROFIT_LABEL = /^laba\s*bersih$/i;
const MAX_EDIT_DISTANCE = 2;
const MAX_EDIT_RATIO = 0.1;

/** Bentuk label bersama untuk penjodohan dan pencocokan penanda OCR. */
export function normalizeFinancialLabel(label: string): string {
  const words = label
    .toLowerCase()
    .replace(/\b(?:sub|ub)total\b/g, "total")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  // OCR scan April kadang menempelkan nomor akun/nominal di depan nama:
  // "As 50500 Potongan pembelian", "70,000 Pendapatan lain lain", dan
  // "\"60601 Biaya Maintenance". Angka pembuka bukan bagian dari label.
  while (words.length > 1 && /^\d+$/.test(words[0])) words.shift();
  if (words.length > 2 && words[0].length <= 2) words.shift();
  while (words.length > 1 && /^\d+$/.test(words[0])) words.shift();
  return words.join(" ");
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > MAX_EDIT_DISTANCE) return MAX_EDIT_DISTANCE + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function isNearWord(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  return longest > 0 && editDistance(a, b) <= MAX_EDIT_DISTANCE && editDistance(a, b) <= Math.floor(longest * MAX_EDIT_RATIO) + 1;
}

/** Dua label sama bila beda OCR-nya ringan; kata pembuka marker boleh typo ringan. */
export function isNearLabel(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return false;
  const firstA = a.split(" ")[0];
  const firstB = b.split(" ")[0];
  const markerWords = ["total", "jumlah", "saldo", "laba"];
  const firstWordsMatch = firstA === firstB || markerWords.some((word) => isNearWord(firstA, word) && isNearWord(firstB, word));
  if (!firstWordsMatch) return false;
  const distance = editDistance(a, b);
  return distance <= MAX_EDIT_DISTANCE && distance <= Math.floor(longest * MAX_EDIT_RATIO) + 1;
}

/**
 * Singkatan bulan Indonesia DAN Inggris, karena exporter yang sama mencetak
 * "Feb-26" pada berkas scan dan "Mei 2026" pada berkas digital. Dicocokkan
 * lewat 3 huruf pertama, jadi bentuk panjang ("Februari", "February") ikut
 * tertangkap tanpa entri sendiri. "peb"/"nop"/"agt" ikut karena ejaan lama
 * itu masih muncul di dokumen Indonesia.
 */
const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 1, feb: 2, peb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6,
  jul: 7, agu: 8, ags: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10,
  nov: 11, nop: 11, des: 12, dec: 12,
};

/** "Feb-26", "Mei 2026", "Februari 2026", "Okt/25" — bulan lalu tahun 2 atau 4 digit. */
const PERIOD_PATTERN = /\b([a-z]{3})[a-z]*\.?\s*[-/]?\s*(\d{2,4})\b/gi;

/**
 * Baca periode laporan dari label kop surat, hasilnya "YYYY-MM".
 *
 * Sengaja hanya diberi makan label KOP (baris sebelum baris akun pertama),
 * bukan seluruh dokumen: angka tahun bisa muncul di mana saja dan mencocokkan
 * di seluruh laporan akan menebak periode dari baris yang bukan periode.
 *
 * ponytail: tahun 2 digit dipetakan ke 20xx. Laporan keuangan abad lain bukan
 * masalah yang perlu dipecahkan hari ini; tahun di luar 2000-2100 ditolak
 * supaya angka nyasar tidak lolos jadi periode.
 */
export function detectReportPeriod(labels: readonly string[]): string | null {
  for (const label of labels) {
    for (const match of label.matchAll(PERIOD_PATTERN)) {
      const month = MONTH_ABBREVIATIONS[match[1].toLowerCase()];
      if (!month) continue;
      const digits = match[2];
      const year = digits.length === 4 ? Number(digits) : 2000 + Number(digits);
      if (year < 2000 || year > 2100) continue;
      return `${year}-${String(month).padStart(2, "0")}`;
    }
  }
  return null;
}

/** Label penutup section (subtotal), dipakai juga parser Excel. */
function normalizeBoundaryLabel(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const markerWords = ["total", "jumlah", "saldo", "laba"];
  const markerIndex = words.findIndex((word) => markerWords.some((marker) => isNearWord(word.toLowerCase().replace(/[^a-z0-9]/g, ""), marker)));
  if (markerIndex === -1) return label.trim();
  const prefixIsNoise = words.slice(0, markerIndex).every((word) => word.replace(/[^a-z0-9]/gi, "").length <= 2);
  const start = prefixIsNoise ? markerIndex : 0;
  let end = words.length;
  while (end > start + 1 && words[end - 1].replace(/[^a-z0-9]/gi, "").length <= 2) end -= 1;
  return words.slice(start, end).join(" ");
}

export function isSubtotalLabel(label: string): boolean {
  const normalized = normalizeBoundaryLabel(label);
  return TOTAL_PREFIX.test(normalized);
}

/**
 * Baca nominal keuangan dari satu token, menangani kedua locale yang dipakai
 * exporter ini plus notasi negatif kurung akuntansi.
 *
 * Pemisah desimal ditentukan dari posisi, bukan dari asumsi locale: pemisah
 * PALING KANAN yang diikuti tepat 1-2 digit adalah desimal, sisanya pemisah
 * ribuan. "8,336,399" -> 8336399 (diikuti 3 digit = ribuan), "40,053.48" ->
 * 40053.48, "20.614.923,86" -> 20614923.86.
 *
 * Mengembalikan null bila token bukan nominal (termasuk tanda "-" telanjang,
 * yang ditangani terpisah sebagai placeholder nihil / tanda negatif).
 */
export function parseFinancialAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  const parenthesised = /^\((.*)\)$/.exec(s);
  if (parenthesised) {
    negative = true;
    s = parenthesised[1].trim();
  }
  if (/^[-–—]/.test(s)) {
    negative = true;
    s = s.slice(1).trim();
  }
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastSeparator = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let integerPart = s;
  let fraction = "";
  if (lastSeparator >= 0) {
    const tail = s.slice(lastSeparator + 1);
    if (/^\d{1,2}$/.test(tail)) {
      integerPart = s.slice(0, lastSeparator);
      fraction = tail;
    }
  }
  const digits = integerPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits) + (fraction ? Number(fraction) / 10 ** fraction.length : 0);
  return negative ? -value : value;
}

type TesseractBbox = { x0: number; y0: number; x1: number; y1: number };
type TesseractWord = { text: string; bbox: TesseractBbox };
export type TesseractBlockLike = { paragraphs?: { lines?: { words?: TesseractWord[] }[] }[] };

/**
 * Ratakan pohon hasil OCR jadi token berkoordinat.
 *
 * tesseract.js 7 TIDAK punya `result.data.words` — temuan spike. Kata-kata
 * hanya ada bila `recognize()` dipanggil dengan `output: { blocks: true }`,
 * lalu harus diambil dari data.blocks[].paragraphs[].lines[].words[].
 */
export function flattenOcrWords(blocks: TesseractBlockLike[] | null | undefined, page: number): MappingToken[] {
  const tokens: MappingToken[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text?.trim();
          if (!text) continue;
          tokens.push({ text, x: word.bbox.x0, y: (word.bbox.y0 + word.bbox.y1) / 2, page });
        }
      }
    }
  }
  return tokens;
}

/**
 * Tesseract kadang menaruh kata di `text`/TSV tetapi tidak di `blocks`.
 * TSV tetap membawa bounding box per kata, jadi dipakai sebagai fallback
 * khusus pada crop OCR yang membutuhkan baris lengkap.
 */
export function flattenOcrTsv(tsv: string | null | undefined, page: number): MappingToken[] {
  if (!tsv) return [];
  const tokens: MappingToken[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields[0] !== "5") continue;
    const text = fields.slice(11).join("\t").trim();
    const x = Number(fields[6]);
    const y = Number(fields[7]);
    const width = Number(fields[8]);
    const height = Number(fields[9]);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
    tokens.push({ text, x, y: y + height / 2, page });
  }
  return tokens;
}

/** Toleransi baris untuk token OCR: setengah tinggi kata median. */
export function ocrRowTolerance(blocks: TesseractBlockLike[] | null | undefined): number {
  const heights: number[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          if (word.text?.trim()) heights.push(word.bbox.y1 - word.bbox.y0);
        }
      }
    }
  }
  if (heights.length === 0) return 1;
  heights.sort((a, b) => a - b);
  return (heights[heights.length >> 1] ?? 1) * 0.5;
}

type Row = { page: number; labelTokens: MappingToken[]; amountTokens: MappingToken[] };

/**
 * Token nominal: angka, atau tanda hubung (tanda negatif / placeholder nihil).
 *
 * ponytail: token berbentuk kode akun (4-6 digit polos) SENGAJA tidak dihitung
 * sebagai nominal, karena di kedua fixture setiap nominal selalu membawa
 * pemisah ribuan atau desimal ("2,600", "0,00") sedangkan kode akun tidak
 * pernah. Laporan dengan nominal bulat tanpa pemisah (mis. "40000") akan
 * salah baca — dan tertangkap pengaman aritmatika, bukan lolos diam-diam.
 */
function isAmountToken(text: string): boolean {
  if (DASH.test(text)) return true;
  if (ACCOUNT_CODE.test(text)) return false;
  return parseFinancialAmount(text) !== null;
}

/**
 * Artefak scan: satu karakter, bukan digit, bukan tanda hubung.
 *
 * Pada fixture scan ini nyata dan merusak dua kali. Pertama, centang tangan
 * terbaca "V" di x≈2115 — jauh di kanan seluruh nominal. Kedua, artefak ":"
 * dan "|" yang jatuh di antara dua baris cetak MENJEMBATANI keduanya saat
 * pengelompokan baris, sehingga baris 40001 dan 40002 menyatu dan satu
 * nominal kehilangan labelnya. Penggabungan baris seperti itu TIDAK bisa
 * ditangkap pengaman aritmatika (jumlahnya tetap sama, cuma labelnya
 * bergeser), jadi artefak harus dibuang SEBELUM pengelompokan baris, bukan
 * sesudahnya.
 */
function isNoiseToken(text: string): boolean {
  return text.length === 1 && !/\d/.test(text) && !DASH.test(text);
}

/**
 * Nominal BERFORMAT: ada pemisah ribuan/desimal, bukan kode akun.
 *
 * Lebih ketat daripada isAmountToken — tanda hubung telanjang dan angka polos
 * tidak dihitung. Dipakai HANYA untuk menyelamatkan nominal yang terdorong ke
 * dalam kolom label (lihat groupTokensIntoRows), jadi syaratnya harus cukup
 * khas untuk tidak pernah mengira potongan label sebagai angka: "BANK BCA
 * 7195-332266" dan "Feb-26" tidak punya pemisah desimal, "40000" kode akun.
 */
function isFormattedAmount(text: string): boolean {
  if (!/[.,]/.test(text)) return false;
  if (ACCOUNT_CODE.test(text)) return false;
  return parseFinancialAmount(text) !== null;
}

/**
 * Kelompokkan token jadi baris per halaman, lalu pisahkan label dari nominal.
 *
 * Pemisahan dilakukan PER BARIS dari kanan ke kiri — kumpulkan token nominal
 * sampai ketemu kata label pertama — bukan lewat satu batas kolom X untuk
 * seluruh dokumen. Sebabnya konkret: batas global mana pun bisa diracuni satu
 * artefak, dan tanda negatif pada fixture scan berdiri sendiri ~175px di kiri
 * angkanya (minus di x≈1651, angka di x≈1826) sehingga batas yang cukup ketat
 * untuk memisahkan label malah membuang tanda minusnya. Pemindaian dari kanan
 * menangkap keduanya sekaligus, sekalian membiarkan tanda hubung DI DALAM
 * label ("Biaya keamanan - Security") tetap jadi bagian label karena
 * pemindaian sudah berhenti sebelum sampai ke sana.
 *
 * ponytail: pengelompokan baris memakai single-linkage (bandingkan ke token
 * sebelumnya, bukan ke rata-rata klaster) karena jarak antar token dalam satu
 * baris cetak bisa lebih besar dari jaraknya ke token pertama baris itu. Pada
 * fixture scan margin-nya tipis — gap terbesar dalam baris 18px vs gap
 * terkecil antar baris 20px pada toleransi 19px. Kalau suatu dokumen menggabung
 * dua baris, pengaman aritmatika yang menangkapnya, bukan diam-diam lolos.
 */
export function groupTokensIntoRows(tokens: readonly MappingToken[], rowTolerance: number): Row[] {
  const clean = tokens.filter((t) => !isNoiseToken(t.text));
  const rows: Row[] = [];
  const pages = [...new Set(clean.map((t) => t.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const sorted = clean.filter((t) => t.page === page).sort((a, b) => a.y - b.y || a.x - b.x);
    let current: MappingToken[] = [];
    let previousY = Number.NEGATIVE_INFINITY;
    const flush = () => {
      if (current.length === 0) return;
      const ordered = [...current].sort((a, b) => a.x - b.x);
      const amountTokens: MappingToken[] = [];
      let index = ordered.length - 1;
      for (; index >= 0 && isAmountToken(ordered[index].text); index--) amountTokens.unshift(ordered[index]);
      if (amountTokens.length === 0) {
        // Sel nominal kosong TAPI ada angka berformat di tengah label: OCR
        // menempelkan derau di KANAN angkanya sehingga pemindaian dari kanan
        // berhenti sebelum sampai ke sana. Nyata di fixture Neraca Feb-2026,
        // baris 11702 terbaca "11702 Biaya Pra Operasional 1,572,107,617.00
        // beluw Tut Ponloayor" — tanpa penyelamatan ini satu nominal terbesar
        // di laporan itu hilang dan Neraca ditolak.
        //
        // Segala yang ada di KANAN angka itu dibuang: di laporan keuangan
        // tidak ada isi sah di sebelah kanan nominal. Indeks 0 tidak pernah
        // diambil supaya kode akun tidak ikut terbaca sebagai nominal.
        for (let candidate = ordered.length - 1; candidate >= 1; candidate--) {
          if (!isFormattedAmount(ordered[candidate].text)) continue;
          amountTokens.push(ordered[candidate]);
          index = candidate - 1;
          break;
        }
      }
      rows.push({ page, labelTokens: ordered.slice(0, index + 1), amountTokens });
      current = [];
    };
    for (const token of sorted) {
      if (current.length > 0 && token.y - previousY > rowTolerance) flush();
      current.push(token);
      previousY = token.y;
    }
    flush();
  }
  return rows;
}

/** Pasangkan nominal yang OCR letakkan satu baris di atas labelnya. */
function alignLeadingAmountRows(tokens: readonly MappingToken[], rowTolerance: number): MappingToken[] {
  const rows = groupTokensIntoRows(tokens, rowTolerance);
  const targetY = new Map<MappingToken, number>();
  for (let index = 0; index + 1 < rows.length; index += 1) {
    const amountRow = rows[index];
    const labelRow = rows[index + 1];
    if (amountRow.labelTokens.length === 0 && amountRow.amountTokens.length > 0 && labelRow.labelTokens.length > 0 && labelRow.amountTokens.length === 0) {
      const y = labelRow.labelTokens[0]?.y;
      if (y !== undefined) for (const token of amountRow.amountTokens) targetY.set(token, y);
    }
  }
  return tokens.map((token) => {
    const y = targetY.get(token);
    return y === undefined ? token : { ...token, y };
  });
}

/**
 * Nilai satu sel nominal.
 *
 * Ambil token angka dengan digit TERBANYAK, bukan hasil penggabungan seluruh
 * sel, supaya coretan/centang tangan di kolom nominal tidak ikut terbaca —
 * pada fixture scan ada centang tangan yang terbaca "V" dan angka nyasar "2".
 * Tanda negatif diambil dari token "-" mana pun di kiri angka itu dalam sel
 * yang sama. Sel yang hanya berisi tanda hubung tanpa angka adalah
 * placeholder nihil -> 0.
 */
function readAmountCell(amountTokens: readonly MappingToken[]): number | null {
  let best: { token: MappingToken; value: number; digits: number } | null = null;
  for (const token of amountTokens) {
    const value = parseFinancialAmount(token.text);
    if (value === null) continue;
    const digits = token.text.replace(/\D/g, "").length;
    if (!best || digits > best.digits) best = { token, value, digits };
  }
  if (!best) return amountTokens.some((t) => DASH.test(t.text)) ? 0 : null;
  const bestToken = best.token;
  const hasLeadingMinus = amountTokens.some((t) => DASH.test(t.text) && t.x < bestToken.x);
  return hasLeadingMinus ? -Math.abs(best.value) : best.value;
}

/**
 * Buang token simbol murni di KIRI label.
 *
 * OCR menempelkan sisa garis/logo sebagai token tersendiri di awal baris —
 * "/™ Total Aset Lancar", "“™ Saldo Kas Awal". Keduanya baris penting: yang
 * pertama penutup section Neraca, yang kedua landasan identitas Arus Kas.
 * Dengan awalan itu keduanya tidak cocok pola mana pun dan laporannya gagal
 * rekonsiliasi padahal angkanya benar.
 *
 * Hanya token yang SAMA SEKALI tidak punya huruf/angka yang dibuang, jadi
 * awalan huruf seperti "Mm Biaya Pokok Penjualan" dibiarkan apa adanya —
 * itu urusan normalisasi label saat penjodohan (lib/mapping-compare.ts),
 * bukan urusan parser.
 */
function dropLeadingSymbolTokens(tokens: readonly MappingToken[]): readonly MappingToken[] {
  let start = 0;
  while (start < tokens.length && !/[a-z0-9]/i.test(tokens[start].text)) start += 1;
  return start === 0 ? tokens : tokens.slice(start);
}

/** Baris siap klasifikasi: label sudah bersih, nominal sudah diambil. */
type Cell = { page: number; label: string; code: string | null; value: number | null; empty: boolean };

/**
 * Apakah baris bernilai TANPA kode akun ini bagian dari sebuah section yang
 * ditutup subtotal — jadi baris detail — atau baris turunan?
 *
 * Pertanyaan ini tidak bisa dijawab dari barisnya sendiri, dan kode akun tidak
 * bisa dipakai sebagai jawaban karena ketiga laporan berbeda kebiasaan:
 *
 *   Laba Rugi | semua detail berkode; "Laba Kotor"/"Laba Bersih" tidak
 *   Neraca    | hampir semua berkode, KECUALI "Pendapatan Periode ini"
 *   Arus Kas  | TIDAK ADA kode akun sama sekali
 *
 * Jadi yang dipakai adalah bentuk laporannya: baris detail selalu diikuti —
 * tanpa diselingi judul section baru — oleh baris "Total ..." yang
 * menjumlahkannya. Baris turunan seperti "Laba Kotor", "Kenaikan/Penurunan
 * Kas", dan "Saldo Kas Akhir" tidak pernah punya penutup seperti itu:
 * sesudahnya judul section baru, atau habis.
 *
 * Salah tebak ke arah mana pun membuat sebuah subtotal tidak cocok dengan
 * jumlah detailnya, jadi dokumennya DITOLAK — bukan diterima dengan angka
 * yang diam-diam salah kategori.
 */
function closesIntoSubtotal(cells: readonly Cell[], from: number): boolean {
  for (let index = from + 1; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell.empty) continue;
    if (cell.value === null) return false;
    if (isSubtotalLabel(cell.label)) return true;
  }
  return false;
}

function classify(rows: readonly Row[], rowOffset: 0 | 1): MappingLine[] {
  // Label dan nominal dihitung DULU untuk seluruh baris: klasifikasi butuh
  // melihat ke depan (closesIntoSubtotal), dan keduanya tidak bergantung pada
  // hasil klasifikasi baris mana pun.
  const cells: Cell[] = rows.map((row, index) => {
    const labelTokens = dropLeadingSymbolTokens(row.labelTokens);
    // Pergeseran tidak pernah melompati batas halaman — koordinat Y tiap
    // halaman independen, jadi baris terakhir halaman sebelumnya bukan
    // tetangga visual baris pertama halaman ini.
    const source = rows[index - rowOffset];
    const amountTokens = source && source.page === row.page ? source.amountTokens : [];
    const [first, ...rest] = labelTokens;
    const hasCode = first !== undefined && ACCOUNT_CODE.test(first.text) && rest.length > 0;
    return {
      page: row.page,
      label: normalizeBoundaryLabel((hasCode ? rest : labelTokens).map((token) => token.text).join(" ").trim()),
      code: hasCode ? first.text : null,
      value: readAmountCell(amountTokens),
      empty: labelTokens.length === 0,
    };
  });

  const lines: MappingLine[] = [];
  let pendingDetails = 0;
  cells.forEach((cell, index) => {
    if (cell.empty) return;
    const base = { label: cell.label, page: cell.page };
    if (cell.code !== null) {
      pendingDetails += 1;
      lines.push({ ...base, code: cell.code, value: cell.value ?? 0, kind: "detail", assumedZero: cell.value === null });
      return;
    }
    if (cell.value === null) {
      lines.push({ ...base, code: null, value: null, kind: "header", assumedZero: false });
      return;
    }
    // Baris "Total ..." yang didahului baris detail menutup satu section.
    // Yang tidak (mis. "Total Aset" di Neraca, atau "Total pendapatan non
    // operasional" kedua di fixture Mei) adalah baris turunan.
    if (isSubtotalLabel(cell.label)) {
      const isSubtotal = pendingDetails > 0;
      if (isSubtotal) pendingDetails = 0;
      lines.push({ ...base, code: null, value: cell.value, kind: isSubtotal ? "subtotal" : "derived", assumedZero: false });
      return;
    }
    if (closesIntoSubtotal(cells, index)) {
      pendingDetails += 1;
      lines.push({ ...base, code: null, value: cell.value, kind: "detail", assumedZero: false });
      return;
    }
    lines.push({ ...base, code: null, value: cell.value, kind: "derived", assumedZero: false });
  });
  return lines;
}

/**
 * Baris PENUTUP tiap laporan. Dipakai untuk memotong bundel 3-laporan jadi
 * tiga, dan sekaligus sebagai bukti bahwa laporan itu memang ada di berkas.
 *
 * Dipilih baris penutup, bukan judul laporan di kop, karena judulnya melewati
 * OCR dengan kondisi bermacam-macam ("La Laporan Laba Rugi", "Neraca") sedang
 * baris penutup adalah baris angka yang justru dijaga pengaman aritmatika.
 */
const REPORT_END_MARKERS: Record<FinancialSheetKind, string> = {
  "profit-loss": "laba bersih",
  "balance-sheet": "total kewajiban dan modal",
  cashflow: "saldo kas akhir",
};

function matchesReportEndMarker(label: string, marker: string): boolean {
  const normalized = normalizeFinancialLabel(normalizeBoundaryLabel(label));
  if (marker === REPORT_END_MARKERS.cashflow) {
    const words = normalized.split(" ");
    return ["saldo", "kas", "akhir"].every((expected) => words.some((word) => isNearWord(word, expected)));
  }
  return isNearLabel(normalized, marker);
}

/** Nama laporan untuk pesan ke pengguna. */
export const REPORT_TITLES: Record<FinancialSheetKind, string> = {
  "profit-loss": "Laba Rugi",
  "balance-sheet": "Neraca",
  cashflow: "Arus Kas",
};

/** Urutan cetak Olsera dalam satu bundel. */
const BUNDLE_ORDER: readonly FinancialSheetKind[] = ["profit-loss", "balance-sheet", "cashflow"];

/**
 * Potong satu laporan dari bundel, atau null bila laporannya tidak ada.
 *
 * Fixture Feb-2026 bukan laporan tunggal melainkan BUNDEL: halaman 1 Laba
 * Rugi, 2 Neraca, 3 Arus Kas. Ketiganya punya kode akun dan baris "Total ...",
 * jadi tanpa pemotongan ini isi laporan tetangga ikut terhitung ke dalam
 * rekonsiliasi yang salah.
 *
 * Batas awalnya adalah penutup laporan sebelumnya yang BENAR-BENAR ADA di
 * berkas ini, jadi PDF yang hanya memuat Neraca tetap terbaca utuh dari baris
 * pertamanya.
 *
 * ponytail: mengasumsikan urutan cetak Olsera (BUNDLE_ORDER) — benar untuk
 * kedua fixture. Bundel dengan urutan lain akan gagal rekonsiliasi dan
 * DITOLAK, bukan salah baca diam-diam.
 */
function scopeToReport(lines: readonly MappingLine[], kind: FinancialSheetKind): MappingLine[] | null {
  const end = lines.findIndex((line) => matchesReportEndMarker(line.label, REPORT_END_MARKERS[kind]));
  if (end === -1) return null;
  let start = 0;
  for (const previous of BUNDLE_ORDER) {
    if (previous === kind) break;
    const boundary = lines.findIndex((line) => matchesReportEndMarker(line.label, REPORT_END_MARKERS[previous]));
    if (boundary !== -1 && boundary < end) start = Math.max(start, boundary + 1);
  }
  return lines.slice(start, end + 1);
}

/** Indeks baris akun pertama; batas antara kop surat dan isi laporan. */
function firstDetailIndex(lines: readonly MappingLine[]): number {
  return lines.findIndex((line) => line.kind === "detail");
}

/**
 * Serpihan kop surat yang lolos sebagai baris: sisa logo/judul sepanjang 1-2
 * karakter ("Ea", "FR", "WO"). Tidak pernah menyentuh baris akun atau
 * subtotal, jadi pengaman aritmatika tidak bisa terpengaruh — label laporan
 * sungguhan di dokumen ini tidak ada yang sependek itu.
 */
function isLetterheadFragment(line: MappingLine): boolean {
  if (line.kind === "detail" || line.kind === "subtotal") return false;
  return line.label.replace(/[^a-z0-9]/gi, "").length <= 2;
}

/**
 * Buang kop surat dari hasil baca.
 *
 * Potongan awal ini KEMBARAN scopeToProfitAndLoss yang memotong akhir: nama
 * perusahaan, judul laporan, dan baris periode terbaca sebagai baris data —
 * pada jalur OCR bahkan sempat membawa nominal palsu ("bi - BC PADEL CLUB"
 * bernilai 1, "Feb-26" bernilai 8) sehingga muncul di perbandingan sebagai
 * akun yang cuma ada di PDF.
 *
 * Batasnya adalah baris akun PERTAMA, dengan satu baris di atasnya
 * dipertahankan bila itu header tanpa nominal — di kedua fixture baris itu
 * adalah judul section ("Pendapatan"), bukan kop.
 *
 * AMAN terhadap pengaman aritmatika menurut konstruksinya: yang dibuang hanya
 * baris SEBELUM baris akun pertama, dan di posisi itu classify() tidak pernah
 * menghasilkan subtotal (butuh pendingDetails > 0) maupun detail (butuh kode
 * akun). Jadi tidak ada angka yang ikut hilang dari penjumlahan mana pun.
 */
export function stripLetterhead(lines: readonly MappingLine[]): MappingLine[] {
  const firstDetail = firstDetailIndex(lines);
  if (firstDetail === -1) return [...lines];
  const start = lines[firstDetail - 1]?.kind === "header" ? firstDetail - 1 : firstDetail;
  return lines.slice(start).filter((line) => !isLetterheadFragment(line));
}

/**
 * Pada section Arus Kas yang hanya punya satu baris, subtotal adalah salinan
 * angka baris itu. Jika OCR salah membaca digit pada detail, pakai subtotal
 * tercetak sebagai koreksi; section dengan >=2 detail tetap wajib lolos cek.
 */
function repairSingleLineCashflowSections(lines: readonly MappingLine[]): MappingLine[] {
  const repaired = [...lines];
  let sectionDetails: number[] = [];
  for (let index = 0; index < repaired.length; index += 1) {
    const line = repaired[index];
    if (line.kind === "detail") {
      sectionDetails.push(index);
      continue;
    }
    if (line.kind === "subtotal") {
      if (sectionDetails.length === 1) {
        const detailIndex = sectionDetails[0];
        const detail = repaired[detailIndex];
        if (detail.value !== line.value && line.value !== null) repaired[detailIndex] = { ...detail, value: line.value };
      }
      sectionDetails = [];
      continue;
    }
    sectionDetails = [];
  }
  return repaired;
}

/**
 * Pengaman aritmatika. Dua cek, keduanya terhadap angka yang TERCETAK di
 * dokumen — bukan terhadap ekspektasi yang di-hardcode:
 *
 *  1. tiap subtotal harus sama dengan jumlah baris detail di section-nya;
 *  2. rantai subtotal (pendapatan positif, biaya negatif) harus mendarat
 *     tepat di angka "Laba Bersih" yang tercetak.
 *
 * Cek 2 yang membuat kesalahan di satu section tidak bisa saling meniadakan
 * dengan kesalahan di section lain.
 */
export function reconcileSubtotals(
  lines: readonly FinancialLine[],
  /**
   * Toleransi per baris detail. Default-nya untuk sumber PDF, yang memotong
   * desimal di baris detail — lihat TRUNCATION_TOLERANCE_PER_LINE.
   *
   * Sumber Excel WAJIB mengirim 0: spreadsheet menyimpan nilai presisi penuh,
   * jadi tidak ada galat pemotongan yang perlu dimaafkan, dan toleransi
   * warisan PDF di sana hanya membutakan pengaman terhadap selisih kecil.
   */
  tolerancePerLine: number = TRUNCATION_TOLERANCE_PER_LINE,
): ReconciliationCheck[] {
  const checks: ReconciliationCheck[] = [];
  let sectionDetails: FinancialLine[] = [];
  for (const line of lines) {
    if (line.kind === "detail") {
      sectionDetails.push(line);
      continue;
    }
    if (line.kind !== "subtotal") continue;
    const sum = sectionDetails.reduce((total, detail) => total + (detail.value ?? 0), 0);
    const subtotal = line.value ?? 0;
    const tolerance = Math.max(FINAL_TOLERANCE, sectionDetails.length * tolerancePerLine);
    checks.push({
      kind: "section",
      label: line.label,
      expected: subtotal,
      actual: sum,
      difference: sum - subtotal,
      tolerance,
      passed: Math.abs(sum - subtotal) <= tolerance,
      contributors: sectionDetails.map((detail) => ({ code: detail.code, label: detail.label, value: detail.value ?? 0 })),
    });
    sectionDetails = [];
  }
  return checks;
}

/**
 * Cek 2 untuk laporan LABA RUGI: rantai subtotal (pendapatan positif, biaya
 * negatif) harus mendarat tepat di angka "Laba Bersih" yang tercetak. Ini yang
 * membuat kesalahan di satu section tidak bisa saling meniadakan dengan
 * kesalahan di section lain.
 *
 * Neraca dan Arus Kas punya identitas aritmatikanya sendiri (Total Aset =
 * Total Kewajiban dan Modal; saldo awal + arus = saldo akhir) — lihat
 * lib/mapping-excel-parser.ts.
 */
export function reconcileNetProfitChain(lines: readonly FinancialLine[]): ReconciliationCheck {
  const contributors = lines
    .filter((line) => line.kind === "subtotal")
    .map((line) => ({ code: line.code, label: line.label, value: EXPENSE_LABEL.test(line.label) ? -(line.value ?? 0) : line.value ?? 0 }));
  const runningBalance = contributors.reduce((balance, line) => balance + line.value, 0);
  const netProfit = lines.find((line) => NET_PROFIT_LABEL.test(line.label));
  if (!netProfit) {
    return { kind: "final", label: "Laba Bersih (tidak ditemukan)", expected: Number.NaN, actual: runningBalance, difference: Number.NaN, tolerance: FINAL_TOLERANCE, passed: false, contributors };
  }
  const printed = netProfit.value ?? 0;
  return {
    kind: "final",
    label: netProfit.label,
    expected: printed,
    actual: runningBalance,
    difference: runningBalance - printed,
    tolerance: FINAL_TOLERANCE,
    passed: Math.abs(runningBalance - printed) <= FINAL_TOLERANCE,
    contributors,
  };
}

function findLineByLabel(lines: readonly FinancialLine[], pattern: RegExp): FinancialLine | undefined {
  return lines.find((line) => pattern.test(line.label.trim()));
}

/**
 * Bandingkan dua angka yang secara aritmatika HARUS sama.
 *
 * Salah satu sisi tidak ada atau kosong = identitasnya tidak bisa diuji, dan
 * itu dihitung GAGAL, bukan dilewati. Nyata di fixture: sheet Arus Kas Excel
 * periode 2025-11 tidak punya Saldo Kas Awal (bulan pertama, belum ada saldo
 * sebelumnya), jadi periode itu ditolak alih-alih diterima tanpa verifikasi.
 */
function identityCheck(
  label: string,
  expected: number | undefined,
  actual: number | undefined,
  contributors: readonly ReconciliationContributor[] = [],
  tolerance: number = FINAL_TOLERANCE,
): ReconciliationCheck {
  if (expected === undefined || actual === undefined) {
    return { kind: "final", label: `${label} (nilai tidak lengkap untuk periode ini)`, expected: Number.NaN, actual: Number.NaN, difference: Number.NaN, tolerance, passed: false, contributors };
  }
  return {
    kind: "final",
    label,
    expected,
    actual,
    difference: actual - expected,
    tolerance,
    passed: Math.abs(actual - expected) <= tolerance,
    contributors,
  };
}

function asContributor(line: FinancialLine | undefined): ReconciliationContributor[] {
  return line ? [{ code: line.code, label: line.label, value: line.value ?? 0 }] : [];
}

/**
 * Cek akhir per jenis laporan, dipakai SISI PDF MAUPUN SISI EXCEL.
 *
 * Cek subtotal-vs-detail sama untuk ketiganya (reconcileSubtotals), tapi
 * "rantai subtotal vs total akhir" berbeda bentuk karena identitas
 * aritmatikanya memang berbeda:
 *
 *   Laba Rugi | rantai subtotal (pendapatan + / biaya -) = Laba Bersih
 *   Neraca    | Total Aset = Total Kewajiban dan Modal
 *   Arus Kas  | Saldo Kas Awal + jumlah subtotal aktivitas = Saldo Kas Akhir
 *
 * Fungsi ini lahir di lib/mapping-excel-parser.ts dan dipindah ke sini saat
 * sisi PDF menyusul — supaya kedua sisi diuji identitas yang SAMA PERSIS,
 * bukan dua salinan yang bisa menyimpang diam-diam.
 */
export function reconcileFinalIdentity(kind: FinancialSheetKind, lines: readonly FinancialLine[]): ReconciliationCheck {
  if (kind === "profit-loss") return reconcileNetProfitChain(lines);
  if (kind === "balance-sheet") {
    const liabilitiesAndEquity = findLineByLabel(lines, /^total\s+kewajiban\s+dan\s+modal$/i);
    return identityCheck(
      "Total Aset = Total Kewajiban dan Modal",
      findLineByLabel(lines, /^total\s+aset$/i)?.value ?? undefined,
      liabilitiesAndEquity?.value ?? undefined,
      asContributor(liabilitiesAndEquity),
      BALANCE_FINAL_TOLERANCE,
    );
  }
  const openingLine = lines.find((line) => matchesReportEndMarker(line.label, "saldo kas awal"));
  const opening = openingLine?.value;
  const closing = lines.find((line) => matchesReportEndMarker(line.label, "saldo kas akhir"))?.value;
  const activityLines = lines.filter((line) => line.kind === "subtotal");
  const activities = activityLines.reduce((sum, line) => sum + (line.value ?? 0), 0);
  return identityCheck(
    "Saldo Kas Awal + aktivitas = Saldo Kas Akhir",
    closing ?? undefined,
    opening === null || opening === undefined ? undefined : opening + activities,
    [...asContributor(openingLine), ...activityLines.map((line) => ({ code: line.code, label: line.label, value: line.value ?? 0 }))],
  );
}

function reconcile(lines: readonly MappingLine[], kind: FinancialSheetKind): ReconciliationCheck[] {
  return [...reconcileSubtotals(lines), reconcileFinalIdentity(kind, lines)];
}

/** Batas panjang daftar baris di pesan penolakan — cukup untuk menunjuk, tidak sampai jadi dump. */
const MAX_REPORTED_CONTRIBUTORS = 12;

/** Layout baris dalam bahasa manusia, dipakai di pesan penolakan. */
function describeRowOffset(rowOffset: 0 | 1): string {
  return rowOffset === 0 ? "nominal sebaris dengan label" : "nominal tercetak 1 baris di atas label";
}

type ParseAttempt = { rowOffset: 0 | 1; failedChecks: ReconciliationCheck[] };

/**
 * Percobaan yang paling dekat benar: paling sedikit cek gagal, lalu selisih
 * terbesarnya paling kecil. Selisih NaN (cek yang tidak bisa dijalankan sama
 * sekali) dihitung paling buruk.
 */
function pickBestAttempt(attempts: readonly ParseAttempt[]): ParseAttempt | undefined {
  const worstDifference = (attempt: ParseAttempt): number =>
    attempt.failedChecks.reduce(
      (worst, check) => Math.max(worst, Number.isNaN(check.difference) ? Number.POSITIVE_INFINITY : Math.abs(check.difference)),
      0,
    );
  return [...attempts].sort((a, b) => a.failedChecks.length - b.failedChecks.length || worstDifference(a) - worstDifference(b))[0];
}

/** Satu kalimat per cek gagal, lengkap dengan baris yang ikut dijumlah. */
function describeFailedCheck(check: ReconciliationCheck): string {
  const head = Number.isNaN(check.difference)
    ? `${check.label}: tidak bisa diperiksa`
    : `${check.label}: hasil hitung ${check.actual} vs tercetak ${check.expected} (selisih ${check.difference})`;
  if (check.contributors.length === 0) return head;
  const shown = check.contributors.slice(0, MAX_REPORTED_CONTRIBUTORS);
  const rest = check.contributors.length - shown.length;
  const list = shown.map((line) => `${line.code ? `${line.code} ` : ""}${line.label} ${line.value}`).join("; ");
  return `${head}; baris yang dijumlah: ${list}${rest > 0 ? `; dan ${rest} baris lain` : ""}`;
}

/**
 * Parse laporan laba rugi dari token berkoordinat.
 *
 * Offset baris DIDETEKSI, bukan di-hardcode: asosiasi lurus (offset 0) dicoba
 * lebih dulu, dan HANYA kalau rekonsiliasinya gagal offset 1 dicoba. Jadi
 * pengaman aritmatika sekaligus berperan sebagai detektor layout — offset
 * yang salah tidak bisa terpilih tanpa angka totalnya ikut cocok. Kalau kedua
 * offset gagal, dokumen ditolak dengan rincian selisih tiap cek.
 */
export function parseFinancialReport(
  tokens: readonly MappingToken[],
  options: { rowTolerance: number; kind?: FinancialSheetKind },
): MappingParseResult {
  const kind = options.kind ?? "profit-loss";
  const rows = groupTokensIntoRows(tokens, options.rowTolerance);
  const attempts: { rowOffset: 0 | 1; failedChecks: ReconciliationCheck[] }[] = [];
  for (const rowOffset of [0, 1] as const) {
    const scoped = scopeToReport(classify(rows, rowOffset), kind);
    if (scoped === null) {
      // Offset tidak mengubah label, jadi laporan yang tidak ketemu pada
      // offset 0 juga tidak akan ketemu pada offset 1.
      return { status: "rejected", reason: `${REPORT_TITLES[kind]} tidak ada di berkas PDF ini.`, attempts: [], notFound: true };
    }
    // Periode dibaca SEBELUM kop dibuang — kop itu satu-satunya tempat
    // periodenya tercetak.
    const period = detectReportPeriod(scoped.slice(0, Math.max(firstDetailIndex(scoped), 0)).map((line) => line.label));
    const lines = kind === "cashflow" ? repairSingleLineCashflowSections(stripLetterhead(scoped)) : stripLetterhead(scoped);
    const checks = reconcile(lines, kind);
    const failedChecks = checks.filter((check) => !check.passed);
    // Baris detail yang tidak ditutup subtotal tidak pernah ikut terperiksa,
    // jadi diperlakukan sebagai kegagalan — bukan diloloskan diam-diam.
    const lastLine = lines[lines.length - 1];
    if (lastLine?.kind === "detail") {
      // Baris detail yang menggantung setelah subtotal terakhir — semuanya
      // ikut disebut, karena justru merekalah yang tidak pernah terperiksa.
      const closed = lines.findLastIndex((line) => line.kind === "subtotal");
      const dangling = lines.slice(closed + 1).filter((line) => line.kind === "detail");
      failedChecks.push({
        kind: "section",
        label: "(baris detail tanpa subtotal penutup)",
        expected: Number.NaN,
        actual: Number.NaN,
        difference: Number.NaN,
        tolerance: 0,
        passed: false,
        contributors: dangling.map((line) => ({ code: line.code, label: line.label, value: line.value ?? 0 })),
      });
    }
    if (failedChecks.length === 0) {
      return { status: "ok", rowOffsetApplied: rowOffset, period, lines, checks };
    }
    attempts.push({ rowOffset, failedChecks });
  }
  const best = pickBestAttempt(attempts);
  const others = attempts
    .filter((attempt) => attempt !== best)
    .map((attempt) => `${describeRowOffset(attempt.rowOffset)} — ${attempt.failedChecks.length} cek gagal`)
    .join("; ");
  const diagnosis = best
    ? `Layout yang paling mendekati: ${describeRowOffset(best.rowOffset)}, ${best.failedChecks.length} cek gagal. ${best.failedChecks.map(describeFailedCheck).join(" | ")}.`
    : "Tidak ada satu pun percobaan layout yang bisa dijalankan.";
  return {
    status: "rejected",
    reason: `${REPORT_TITLES[kind]} tidak rekonsiliasi terhadap total yang tercetak, jadi hasil bacanya tidak bisa dipercaya. ${diagnosis}${others ? ` Layout lain yang dicoba: ${others}.` : ""}`,
    attempts,
    bestAttempt: best,
  };
}

// --- Jalur I/O (browser). Tidak pernah dieksekusi oleh test node. ---
//
// Tipe pdf.js diambil lewat `typeof import()` supaya tetap type-only dan
// terhapus saat runtime — inti murni di atas tidak ikut menarik pdfjs-dist.
// Pola sama dengan lib/reconciliation-berita-acara-client-ocr.ts.
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocumentProxy = Awaited<ReturnType<PdfjsModule["getDocument"]>>["promise"] extends Promise<infer T> ? T : never;

/** Toleransi baris untuk text layer pdf.js — sama dengan groupPdfTextItemsIntoLines. */
export const DIGITAL_ROW_TOLERANCE = 2.5;

/** Text layer di bawah panjang ini dianggap tidak ada (PDF hasil scan). */
const MIN_TEXT_LAYER_LENGTH = 20;

export type PdfAnalysisSource = "pdf-text-layer" | "pdf-scanned-ocr";

export type EmbeddedJpegPage = {
  data: Uint8Array;
  width: number;
  height: number;
};

/**
 * Ambil JPEG asli dari halaman yang hanya punya satu gambar XObject full-page.
 *
 * PDF lain tetap aman: halaman yang tidak memenuhi bentuk konservatif ini
 * mengembalikan null dan diproses lewat render canvas biasa.
 */
export async function extractEmbeddedJpegPages(bytes: Uint8Array): Promise<(EmbeddedJpegPage | null)[]> {
  const { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } = await import("pdf-lib");
  const document = await PDFDocument.load(bytes);
  return Promise.all(document.getPages().map(async (page) => {
    const resources = page.node.Resources();
    const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const images = (xObjects?.keys() ?? [])
      .map((name) => {
        const reference = xObjects?.get(name);
        const object = reference instanceof PDFRef ? document.context.lookup(reference) : reference;
        return object instanceof PDFRawStream ? object : null;
      })
      .filter((image) => image !== null)
      .filter((image) => String(image.dict.get(PDFName.of("Subtype"))) === "/Image")
      .filter((image) => String(image.dict.get(PDFName.of("Filter"))).includes("DCTDecode"));
    if (images.length !== 1) return null;
    const image = images[0];
    const width = image.dict.lookupMaybe(PDFName.of("Width"), PDFNumber)?.asNumber();
    const height = image.dict.lookupMaybe(PDFName.of("Height"), PDFNumber)?.asNumber();
    if (!width || !height) return null;
    const pageRatio = page.getWidth() / page.getHeight();
    const imageRatio = width / height;
    if (Math.abs(imageRatio - pageRatio) > 0.01) return null;
    const filter = image.dict.get(PDFName.of("Filter"));
    const filters = filter instanceof PDFArray
      ? filter.asArray().map((item) => item instanceof PDFName ? item.asString() : "")
      : filter instanceof PDFName
        ? [filter.asString()]
        : [];
    if (filters[filters.length - 1] !== "/DCTDecode" || filters.slice(0, -1).some((item) => item !== "/FlateDecode")) return null;
    let data = image.contents;
    for (const item of filters.slice(0, -1)) {
      if (item !== "/FlateDecode" || typeof DecompressionStream === "undefined") return null;
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      try {
        const stream = new Blob([copy.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        return null;
      }
    }
    return data[0] === 0xff && data[1] === 0xd8 ? { data, width, height } : null;
  }));
}

/**
 * Entry point BROWSER untuk membaca satu berkas PDF laporan keuangan.
 *
 * Pola sama dengan lib/inventory-ba-client.ts: coba text layer dulu, jatuh ke
 * OCR hanya kalau text layer benar-benar tidak ada. Bedanya, di sini jalur OCR
 * BUKAN fail-safe kosong melainkan jalur penuh — rekonstruksi baris dari
 * bounding box sudah ada (lihat groupTokensIntoRows), dan hasilnya tetap
 * dijaga rekonsiliasi aritmatika yang sama.
 *
 * Dipanggil hanya dari browser: jalur scan merender halaman ke
 * HTMLCanvasElement, yang tidak ada di serverless Vercel tanpa binary native.
 */
export async function analyzeFinancialPdf(
  file: File,
  onStatus: (status: string) => void = () => {},
): Promise<{ source: PdfAnalysisSource; reports: Record<FinancialSheetKind, MappingParseResult> }> {
  onStatus("Membuka berkas PDF...");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data: bytes });
  try {
    const doc = await loadingTask.promise;
    const digital = await extractDigitalTokens(doc);
    const digitalLength = digital?.reduce((total, token) => total + token.text.length, 0) ?? 0;
    if (digital && digitalLength >= MIN_TEXT_LAYER_LENGTH) {
      onStatus("Membaca text layer PDF...");
      return { source: "pdf-text-layer", reports: parseAllReports(digital, DIGITAL_ROW_TOLERANCE) };
    }
    let embeddedImages: (EmbeddedJpegPage | null)[] | undefined;
    try {
      embeddedImages = await extractEmbeddedJpegPages(bytes);
    } catch {
      // PDF yang tidak bisa dibaca pdf-lib tetap dicoba lewat canvas pdf.js.
    }
    const scanned = await extractScanTokens(doc, onStatus, embeddedImages);
    if (!scanned) {
      const blank: MappingParseResult = { status: "rejected", reason: "Halaman PDF tidak menghasilkan teks apa pun, baik dari text layer maupun OCR.", attempts: [] };
      return { source: "pdf-scanned-ocr", reports: { "profit-loss": blank, "balance-sheet": blank, cashflow: blank } };
    }
    const reports = parseAllReports(scanned.tokens, scanned.rowTolerance);
    if (reports.cashflow.status === "rejected" && reports.cashflow.notFound) {
      // Scan terkompresi kadang memberi jarak Y berbeda antar-kata pada satu
      // baris. Coba toleransi lebih lebar; pengaman aritmatika tetap wajib lolos.
      const wider = parseAllReports(scanned.tokens, scanned.rowTolerance * 1.5);
      if (!(wider.cashflow.status === "rejected" && wider.cashflow.notFound)) reports.cashflow = wider.cashflow;
    }
    if (reports.cashflow.status === "rejected" && reports.cashflow.notFound) {
      logMissingCashflowMarker(scanned.tokens, scanned.rowTolerance);
    }
    return { source: "pdf-scanned-ocr", reports };
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Parse KETIGA laporan dari satu set token.
 *
 * Token diekstrak sekali (OCR berkas scan memakan waktu paling lama di
 * seluruh alur), lalu tiap laporan dipotong, dideteksi offset barisnya, dan
 * direkonsiliasi sendiri-sendiri — perlu, karena dalam berkas yang SAMA
 * layout-nya bisa berbeda: pada fixture Feb-2026 Laba Rugi mencetak nominal
 * satu baris di atas labelnya (offset 1) sedangkan Neraca dan Arus Kas
 * sebaris (offset 0).
 */
function parseAllReports(tokens: readonly MappingToken[], rowTolerance: number): Record<FinancialSheetKind, MappingParseResult> {
  return {
    "profit-loss": parseFinancialReport(tokens, { rowTolerance, kind: "profit-loss" }),
    "balance-sheet": parseFinancialReport(tokens, { rowTolerance, kind: "balance-sheet" }),
    cashflow: parseFinancialReport(tokens, { rowTolerance, kind: "cashflow" }),
  };
}

/** Logging sementara untuk melihat kandidat baris penutup Arus Kas di browser. */
function logMissingCashflowMarker(tokens: readonly MappingToken[], rowTolerance: number): void {
  const rows = groupTokensIntoRows(tokens, rowTolerance);
  const interesting = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.labelTokens.some((token) => /sal|kas|akh/i.test(token.text)))
    .flatMap(({ index }) => rows.slice(Math.max(0, index - 1), index + 2).map((candidate) => ({
      page: candidate.page,
      label: candidate.labelTokens.map((token) => token.text).join(" "),
      amount: candidate.amountTokens.map((token) => token.text).join(" "),
    })));
  console.debug("[Mapping OCR] Penanda Saldo Kas Akhir tidak ditemukan; kandidat baris:", interesting);
}

/**
 * Ambil token dari PDF DIGITAL lewat text layer.
 *
 * ponytail: memakai ulang extractPdfTextLayerItems yang sudah ada, termasuk
 * batas MAX_OCR_PAGES = 3 halaman di dalamnya. Laporan yang lebih panjang
 * akan terpotong — tapi terpotong berarti baris detail hilang, subtotal tidak
 * cocok, dan dokumen DITOLAK, bukan diterima separuh. Naikkan batas itu kalau
 * ketemu laporan >3 halaman.
 */
export async function extractDigitalTokens(pdfDocument: PdfDocumentProxy): Promise<MappingToken[] | null> {
  const { extractPdfTextLayerItems } = await import("./reconciliation-berita-acara-client-ocr");
  const items = await extractPdfTextLayerItems(pdfDocument);
  if (!items) return null;
  // pdf.js: Y membesar KE ATAS. Dibalik supaya sumbu baris seragam dengan OCR.
  return items.map((item) => ({ text: item.str, x: item.x, y: -item.y, page: item.page }));
}

/**
 * Ambil token dari PDF hasil SCAN: render tiap halaman ke canvas pada
 * SCAN_RENDER_SCALE lalu OCR dengan bounding box per kata.
 */
export async function extractScanTokens(
  pdfDocument: PdfDocumentProxy,
  onStatus: (status: string) => void = () => {},
  embeddedImages: readonly (EmbeddedJpegPage | null)[] = [],
): Promise<{ tokens: MappingToken[]; rowTolerance: number } | null> {
  const [{ createWorker }, { TESSERACT_ASSET_OPTIONS }] = await Promise.all([
    import("tesseract.js"),
    import("./reconciliation-berita-acara-client-ocr"),
  ]);
  onStatus("Menyiapkan mesin OCR lokal...");
  const worker = await createWorker("ind+eng", undefined, TESSERACT_ASSET_OPTIONS);
  try {
    const tokens: MappingToken[] = [];
    const tolerances: number[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const embeddedImage = embeddedImages[pageNumber - 1] ?? null;
      onStatus(`Membaca halaman ${pageNumber} dari ${pdfDocument.numPages}${embeddedImage ? " (gambar asli)" : ""}...`);
      if (embeddedImage) {
        const imageBytes = new Uint8Array(embeddedImage.data.byteLength);
        imageBytes.set(embeddedImage.data);
        const imageBlob = new Blob([imageBytes.buffer as ArrayBuffer], { type: "image/jpeg" });
        let imageInput: Blob | HTMLCanvasElement = imageBlob;
        let enlargedCanvas: HTMLCanvasElement | null = null;
        if (embeddedImage.width < EMBEDDED_OCR_MIN_WIDTH && typeof createImageBitmap === "function") {
          try {
            const bitmap = await createImageBitmap(imageBlob);
            enlargedCanvas = document.createElement("canvas");
            enlargedCanvas.width = bitmap.width * EMBEDDED_OCR_SCALE;
            enlargedCanvas.height = bitmap.height * EMBEDDED_OCR_SCALE;
            const imageContext = enlargedCanvas.getContext("2d");
            if (imageContext) {
              // Jangan mengaburkan huruf kecil pada scan terkompresi saat
              // dibesarkan sebelum OCR.
              imageContext.imageSmoothingEnabled = false;
              imageContext.drawImage(bitmap, 0, 0, enlargedCanvas.width, enlargedCanvas.height);
              imageInput = enlargedCanvas;
            }
            bitmap.close();
          } catch {
            // Jika browser gagal membuat bitmap, tetap coba JPEG asli langsung.
          }
        }
        let { data } = await worker.recognize(imageInput, {}, { text: true, blocks: true });
        let blocks = data.blocks as TesseractBlockLike[] | null;
        // Pada JPEG terkompresi tertentu, upscale membuat Tesseract
        // mengembalikan text tetapi tanpa blocks. Ulangi ukuran asli agar
        // token berkoordinat halaman tidak hilang seluruhnya.
        if ((!blocks || blocks.length === 0) && imageInput !== imageBlob) {
          ({ data } = await worker.recognize(imageBlob, {}, { text: true, blocks: true }));
          blocks = data.blocks as TesseractBlockLike[] | null;
        }
        if (!blocks || blocks.length === 0) {
          const page = await pdfDocument.getPage(pageNumber);
          const viewport = page.getViewport({ scale: SCAN_RENDER_SCALE });
          const fallbackCanvas = document.createElement("canvas");
          fallbackCanvas.width = Math.ceil(viewport.width);
          fallbackCanvas.height = Math.ceil(viewport.height);
          const fallbackContext = fallbackCanvas.getContext("2d");
          if (fallbackContext) {
            await page.render({ canvas: fallbackCanvas, canvasContext: fallbackContext, viewport }).promise;
            ({ data } = await worker.recognize(fallbackCanvas, {}, { text: true, blocks: true }));
            blocks = data.blocks as TesseractBlockLike[] | null;
          }
          fallbackCanvas.width = 0;
          fallbackCanvas.height = 0;
        }
        let embeddedTokens = flattenOcrWords(blocks, pageNumber);
        let tokenBlocks = blocks;
        let tokenRowTolerance = ocrRowTolerance(tokenBlocks);
        const hasCashflowMarker = embeddedTokens.some((token) => /saldo/i.test(token.text))
          && embeddedTokens.some((token) => /akhir/i.test(token.text));
        const extraTokens: MappingToken[] = [];
        if (pageNumber === pdfDocument.numPages) {
          const page = await pdfDocument.getPage(pageNumber);
          const viewport = page.getViewport({ scale: SCAN_RENDER_SCALE });
          const fallbackCanvas = document.createElement("canvas");
          fallbackCanvas.width = Math.ceil(viewport.width);
          fallbackCanvas.height = Math.ceil(viewport.height);
          const fallbackContext = fallbackCanvas.getContext("2d");
          if (fallbackContext) {
            await page.render({ canvas: fallbackCanvas, canvasContext: fallbackContext, viewport }).promise;
            const fallback = await worker.recognize(fallbackCanvas, {}, { text: true, blocks: true });
            const fallbackBlocks = fallback.data.blocks as TesseractBlockLike[] | null;
            // Ambil area isi laporan saja. Ruang kosong besar pada scan
            // mengecilkan teks saat OCR satu halaman penuh.
            let cashflowBlocks: TesseractBlockLike[] | null = null;
            let cashflowTsv: string | null = null;
            const cashflowCropScale = 3;
            const cashflowSource = enlargedCanvas ?? fallbackCanvas;
            const cashflowSourceTop = Math.floor(cashflowSource.height * 0.1);
            const cashflowSourceHeight = Math.floor(cashflowSource.height * 0.42);
            const cashflowCanvas = document.createElement("canvas");
            cashflowCanvas.width = cashflowSource.width * cashflowCropScale;
            cashflowCanvas.height = cashflowSourceHeight * cashflowCropScale;
            const cashflowContext = cashflowCanvas.getContext("2d");
            if (cashflowContext) {
              cashflowContext.drawImage(
                cashflowSource,
                0,
                cashflowSourceTop,
                cashflowSource.width,
                cashflowSourceHeight,
                0,
                0,
                cashflowCanvas.width,
                cashflowCanvas.height,
              );
              const cashflow = await worker.recognize(cashflowCanvas, {}, { text: true, blocks: true, tsv: true });
              cashflowBlocks = cashflow.data.blocks as TesseractBlockLike[] | null;
              cashflowTsv = cashflow.data.tsv;
            }
            cashflowCanvas.width = 0;
            cashflowCanvas.height = 0;
            if ((!blocks || blocks.length === 0) && fallbackBlocks?.length) {
              blocks = fallbackBlocks;
            } else if (fallbackBlocks?.length) {
              const fallbackTokens = flattenOcrWords(fallbackBlocks, pageNumber);
              const fallbackRows = groupTokensIntoRows(fallbackTokens, ocrRowTolerance(fallbackBlocks));
              const rawCashflowTokens = flattenOcrTsv(cashflowTsv, pageNumber);
              const cashflowTokens = (rawCashflowTokens.length > 0 ? rawCashflowTokens : flattenOcrWords(cashflowBlocks, pageNumber)).map((token) => ({
                ...token,
                x: token.x / cashflowCropScale,
                y: token.y / cashflowCropScale + cashflowSourceTop,
              }));
              const cashflowRowTolerance = ocrRowTolerance(cashflowBlocks) / cashflowCropScale;
              const alignedCashflowTokens = alignLeadingAmountRows(cashflowTokens, cashflowRowTolerance);
              const cashflowRows = cashflowBlocks?.length
                ? groupTokensIntoRows(alignedCashflowTokens, cashflowRowTolerance)
                : fallbackRows;
              const cashflowDetailCount = cashflowRows.filter((row) => /penerimaan|pembayaran|biaya\s+operasional|pendapatan\s+lain|pengeluaran\s+lain/i.test(row.labelTokens.map((token) => token.text).join(" "))).length;
              const cashflowHasCompleteReport = cashflowDetailCount >= 3
                && cashflowRows.some((row) => /saldo\s+kas\s+akhir/i.test(row.labelTokens.map((token) => token.text).join(" ")));
              const embeddedScale = enlargedCanvas ? EMBEDDED_OCR_SCALE : 1;
              const scaleFallbackToken = (token: MappingToken) => ({
                ...token,
                x: token.x * (embeddedImage.width * embeddedScale / viewport.width),
                y: token.y * (embeddedImage.height * embeddedScale / viewport.height),
              });
              const scaleCashflowToken = enlargedCanvas ? (token: MappingToken) => token : scaleFallbackToken;
              const scaleCashflowRow = (row: (typeof fallbackRows)[number]) => [
                ...row.labelTokens,
                ...row.amountTokens,
              ]
                .filter((token) => /[a-z0-9-]/i.test(token.text))
                .map(scaleCashflowToken);
              if (cashflowHasCompleteReport) {
                // Jadikan crop terfokus sebagai basis seragam untuk semua
                // bulan; OCR halaman penuh tetap dipakai bila crop gagal.
                embeddedTokens = alignedCashflowTokens.map(scaleCashflowToken);
                tokenBlocks = cashflowBlocks;
                tokenRowTolerance = cashflowRowTolerance;
                if (!enlargedCanvas) {
                  tokenRowTolerance *= embeddedImage.width / viewport.width;
                }
              }
              const embeddedRows = groupTokensIntoRows(embeddedTokens, tokenRowTolerance);
              const hasEmbeddedCashflowRow = (pattern: RegExp) => embeddedRows.some((row) =>
                pattern.test(row.labelTokens.map((token) => token.text).join(" ")),
              );
              if (!cashflowHasCompleteReport && !hasCashflowMarker) {
                for (const row of cashflowRows) {
                  const label = row.labelTokens.map((token) => token.text).join(" ");
                  const pattern = /saldo\s+kas\s+(awal|akhir)/i.test(label)
                    ? /saldo\s+kas\s+(awal|akhir)/i
                    : /kenaikan|penurunan/i.test(label)
                      ? /kenaikan|penurunan/i
                      : null;
                  if (pattern && !hasEmbeddedCashflowRow(pattern)) extraTokens.push(...scaleCashflowRow(row));
                }
              }
              const activityRow = !cashflowHasCompleteReport && fallbackRows.find((row) => {
                const label = row.labelTokens.map((token) => token.text).join(" ");
                return /total/i.test(label) && /aktivitas/i.test(label);
              });
              if (activityRow) {
                const activityLabelTokens = activityRow.labelTokens.filter((token) => /[a-z0-9]/i.test(token.text));
                const activityText = String(fallback.data.text ?? "");
                const isNegativeActivity = /total\s+aktivitas[^\n]*-\s*[\d,.]+/i.test(activityText);
                const amount = activityRow.amountTokens.find((token) => /\d/.test(token.text));
                const embeddedAmountIndexes = amount
                  ? embeddedTokens.flatMap((token, index) => token.text.replace(/\s/g, "") === amount.text.replace(/\s/g, "") ? [index] : [])
                  : [];
                if (isNegativeActivity) {
                  for (const index of embeddedAmountIndexes) {
                    const token = embeddedTokens[index];
                    embeddedTokens[index] = { ...token, text: `-${token.text.replace(/^[-–—]/, "")}` };
                  }
                }
                const amountTokens = embeddedAmountIndexes.length < 2 ? activityRow.amountTokens : [];
                const scaledActivityTokens = [...activityLabelTokens, ...amountTokens].map((token) => ({
                    ...token,
                    x: token.x * (embeddedImage.width * embeddedScale / viewport.width),
                    y: token.y * (embeddedImage.height * embeddedScale / viewport.height),
                  }));
                extraTokens.push(...scaledActivityTokens);
                if (isNegativeActivity && embeddedAmountIndexes.length < 2 && amount) {
                  extraTokens.push({
                    text: `-${amount.text.replace(/^[-–—]/, "")}`,
                    x: amount.x * (embeddedImage.width * embeddedScale / viewport.width),
                    y: amount.y * (embeddedImage.height * embeddedScale / viewport.height),
                    page: pageNumber,
                  });
                }
              }
            }
          }
          fallbackCanvas.width = 0;
          fallbackCanvas.height = 0;
        }
        tokens.push(...embeddedTokens);
        tokens.push(...extraTokens);
        tolerances.push(tokenRowTolerance);
        if (enlargedCanvas) {
          enlargedCanvas.width = 0;
          enlargedCanvas.height = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: SCAN_RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      // `canvas` WAJIB ikut dikirim di pdfjs-dist 6, bukan hanya canvasContext.
      // Versi pertama fungsi ini menghilangkannya dan tidak pernah ketahuan
      // karena jalur scan belum pernah dieksekusi — baru terbongkar saat
      // halaman Mapping memanggilnya dan tsc memeriksa tipenya. Bentuk
      // panggilan ini disamakan dengan ocrScannedPdf di
      // lib/reconciliation-berita-acara-client-ocr.ts yang sudah jalan di produksi.
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      const blocks = data.blocks as TesseractBlockLike[] | null;
      let pageTokens = flattenOcrWords(blocks, pageNumber);
      let pageRowTolerance = ocrRowTolerance(blocks);
      const extraTokens: MappingToken[] = [];
      if (pageNumber === pdfDocument.numPages) {
        const cropCanvas = document.createElement("canvas");
        const cropScale = 3;
        const cropSourceTop = Math.floor(canvas.height * 0.1);
        const cropSourceHeight = Math.floor(canvas.height * 0.42);
        cropCanvas.width = canvas.width * cropScale;
        cropCanvas.height = cropSourceHeight * cropScale;
        const cropContext = cropCanvas.getContext("2d");
        if (cropContext) {
          cropContext.drawImage(canvas, 0, cropSourceTop, canvas.width, cropSourceHeight, 0, 0, cropCanvas.width, cropCanvas.height);
          const crop = await worker.recognize(cropCanvas, {}, { text: true, blocks: true, tsv: true });
          const cropBlocks = crop.data.blocks as TesseractBlockLike[] | null;
          if (cropBlocks?.length) {
            const pageRows = groupTokensIntoRows(pageTokens, ocrRowTolerance(blocks));
            const rawCropTokens = flattenOcrTsv(crop.data.tsv, pageNumber);
            const cropTokens = (rawCropTokens.length > 0 ? rawCropTokens : flattenOcrWords(cropBlocks, pageNumber)).map((token) => ({
              ...token,
              x: token.x / cropScale,
              y: token.y / cropScale + cropSourceTop,
            }));
            const cropRowTolerance = ocrRowTolerance(cropBlocks) / cropScale;
            const alignedCropTokens = alignLeadingAmountRows(cropTokens, cropRowTolerance);
            const cropRows = groupTokensIntoRows(alignedCropTokens, cropRowTolerance);
            const pageHasActivitySubtotal = pageRows.some((row) => {
              const label = row.labelTokens.map((token) => token.text).join(" ");
              return /total/i.test(label) && /aktivitas/i.test(label);
            });
            const cropDetailCount = cropRows.filter((row) => /penerimaan|pembayaran|biaya\s+operasional|pendapatan\s+lain|pengeluaran\s+lain/i.test(row.labelTokens.map((token) => token.text).join(" "))).length;
            const cropHasCompleteReport = cropDetailCount >= 3
              && cropRows.some((row) => /saldo\s+kas\s+akhir/i.test(row.labelTokens.map((token) => token.text).join(" ")));
            if (cropHasCompleteReport) {
              pageTokens = alignedCropTokens;
              pageRowTolerance = cropRowTolerance;
            }
            const hasPageRow = (pattern: RegExp) => pageRows.some((row) => pattern.test(row.labelTokens.map((token) => token.text).join(" ")));
            if (!cropHasCompleteReport && pageHasActivitySubtotal) {
              for (const row of cropRows) {
                const label = row.labelTokens.map((token) => token.text).join(" ");
                const pattern = /saldo\s+kas\s+(awal|akhir)/i.test(label)
                  ? /saldo\s+kas\s+(awal|akhir)/i
                  : /kenaikan|penurunan/i.test(label)
                    ? /kenaikan|penurunan/i
                    : null;
                if (pattern && !hasPageRow(pattern)) extraTokens.push(...row.labelTokens, ...row.amountTokens);
              }
            }
          }
        }
        cropCanvas.width = 0;
        cropCanvas.height = 0;
      }
      tokens.push(...pageTokens, ...extraTokens);
      tolerances.push(pageRowTolerance);
      canvas.width = 0;
      canvas.height = 0;
      // Yield ke event loop supaya UI tidak freeze antar halaman.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (tokens.length === 0) return null;
    tolerances.sort((a, b) => a - b);
    return { tokens, rowTolerance: tolerances[tolerances.length >> 1] ?? 1 };
  } finally {
    await worker.terminate();
  }
}
