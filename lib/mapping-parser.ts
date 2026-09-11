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

export type MappingLine = {
  /** Kode akun 4-6 digit, atau null untuk header/subtotal/baris turunan. */
  code: string | null;
  label: string;
  /** null hanya untuk header tanpa nominal. */
  value: number | null;
  kind: MappingLineKind;
  page: number;
  /**
   * true bila baris detail punya kode akun tapi nominalnya tidak terbaca
   * sama sekali lalu diasumsikan 0. Terjadi nyata pada fixture Feb-2026:
   * placeholder nihil "–" di baris 40004 dibaca OCR sebagai token ":"
   * dengan confidence 0. Asumsi ini AMAN karena kalau nominal sebenarnya
   * bukan 0, subtotal tidak akan rekonsiliasi dan dokumen ditolak.
   */
  assumedZero: boolean;
};

export type ReconciliationCheck = {
  kind: "section" | "final";
  label: string;
  expected: number;
  actual: number;
  difference: number;
  tolerance: number;
  passed: boolean;
};

export type MappingParseResult =
  | {
      status: "ok";
      /** 0 = nominal sebaris label; 1 = nominal tercetak 1 baris di atas label. */
      rowOffsetApplied: 0 | 1;
      lines: MappingLine[];
      checks: ReconciliationCheck[];
    }
  | {
      status: "rejected";
      reason: string;
      /** Hasil rekonsiliasi tiap offset yang dicoba, untuk diagnosis. */
      attempts: { rowOffset: 0 | 1; failedChecks: ReconciliationCheck[] }[];
    };

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
const FINAL_TOLERANCE = 0.05;

const ACCOUNT_CODE = /^\d{4,6}$/;
const DASH = /^[-–—]$/;
const TOTAL_PREFIX = /^total\b/i;
const EXPENSE_LABEL = /\b(biaya|beban)\b/i;
const NET_PROFIT_LABEL = /^laba\s*bersih$/i;

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

function classify(rows: readonly Row[], rowOffset: 0 | 1): MappingLine[] {
  const lines: MappingLine[] = [];
  let pendingDetails = 0;
  rows.forEach((row, index) => {
    if (row.labelTokens.length === 0) return;
    const source = rows[index - rowOffset];
    // Pergeseran tidak pernah melompati batas halaman — koordinat Y tiap
    // halaman independen, jadi baris terakhir halaman sebelumnya bukan
    // tetangga visual baris pertama halaman ini.
    const amountTokens = source && source.page === row.page ? source.amountTokens : [];
    const value = readAmountCell(amountTokens);
    const [first, ...rest] = row.labelTokens;
    const isDetail = ACCOUNT_CODE.test(first.text) && rest.length > 0;
    const label = (isDetail ? rest : row.labelTokens).map((t) => t.text).join(" ").trim();
    if (isDetail) {
      pendingDetails += 1;
      lines.push({ code: first.text, label, value: value ?? 0, kind: "detail", page: row.page, assumedZero: value === null });
      return;
    }
    if (value === null) {
      lines.push({ code: null, label, value: null, kind: "header", page: row.page, assumedZero: false });
      return;
    }
    // Baris "Total ..." yang didahului baris detail menutup satu section.
    // Yang tidak (mis. "Total pendapatan non operasional" kedua di fixture
    // Mei, nilainya netto) adalah baris turunan, sama seperti "Laba Kotor".
    const isSubtotal = TOTAL_PREFIX.test(label) && pendingDetails > 0;
    if (isSubtotal) pendingDetails = 0;
    lines.push({ code: null, label, value, kind: isSubtotal ? "subtotal" : "derived", page: row.page, assumedZero: false });
  });
  return lines;
}

/**
 * Potong di baris "Laba Bersih", baris penutup sebuah laporan laba rugi.
 *
 * Fixture Feb-2026 bukan laporan tunggal melainkan BUNDEL: halaman 1 Laba
 * Rugi, halaman 2 Neraca, halaman 3 Arus Kas. Neraca dan Arus Kas juga punya
 * kode akun dan baris "Total ...", jadi tanpa pemotongan ini keduanya ikut
 * terhitung ke dalam rekonsiliasi laba rugi.
 *
 * ponytail: mengasumsikan laba rugi ada di awal berkas (benar untuk kedua
 * fixture). Bundel yang menaruh Neraca lebih dulu akan gagal rekonsiliasi dan
 * DITOLAK — bukan salah baca diam-diam. Kalau urutan lain ternyata muncul,
 * tambahkan deteksi judul laporan di sini.
 */
function scopeToProfitAndLoss(lines: readonly MappingLine[]): MappingLine[] {
  const end = lines.findIndex((line) => NET_PROFIT_LABEL.test(line.label));
  return end === -1 ? [...lines] : lines.slice(0, end + 1);
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
function reconcile(lines: readonly MappingLine[]): ReconciliationCheck[] {
  const checks: ReconciliationCheck[] = [];
  let sectionDetails: MappingLine[] = [];
  let runningBalance = 0;
  for (const line of lines) {
    if (line.kind === "detail") {
      sectionDetails.push(line);
      continue;
    }
    if (line.kind !== "subtotal") continue;
    const sum = sectionDetails.reduce((total, detail) => total + (detail.value ?? 0), 0);
    const subtotal = line.value ?? 0;
    const tolerance = Math.max(FINAL_TOLERANCE, sectionDetails.length * TRUNCATION_TOLERANCE_PER_LINE);
    checks.push({
      kind: "section",
      label: line.label,
      expected: subtotal,
      actual: sum,
      difference: sum - subtotal,
      tolerance,
      passed: Math.abs(sum - subtotal) <= tolerance,
    });
    runningBalance += EXPENSE_LABEL.test(line.label) ? -subtotal : subtotal;
    sectionDetails = [];
  }
  const netProfit = lines.find((line) => NET_PROFIT_LABEL.test(line.label));
  if (!netProfit) {
    return [
      ...checks,
      { kind: "final", label: "Laba Bersih (tidak ditemukan)", expected: Number.NaN, actual: runningBalance, difference: Number.NaN, tolerance: FINAL_TOLERANCE, passed: false },
    ];
  }
  const printed = netProfit.value ?? 0;
  return [
    ...checks,
    {
      kind: "final",
      label: netProfit.label,
      expected: printed,
      actual: runningBalance,
      difference: runningBalance - printed,
      tolerance: FINAL_TOLERANCE,
      passed: Math.abs(runningBalance - printed) <= FINAL_TOLERANCE,
    },
  ];
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
  options: { rowTolerance: number },
): MappingParseResult {
  const rows = groupTokensIntoRows(tokens, options.rowTolerance);
  const attempts: { rowOffset: 0 | 1; failedChecks: ReconciliationCheck[] }[] = [];
  for (const rowOffset of [0, 1] as const) {
    const lines = scopeToProfitAndLoss(classify(rows, rowOffset));
    const checks = reconcile(lines);
    const failedChecks = checks.filter((check) => !check.passed);
    // Baris detail yang tidak ditutup subtotal tidak pernah ikut terperiksa,
    // jadi diperlakukan sebagai kegagalan — bukan diloloskan diam-diam.
    const lastLine = lines[lines.length - 1];
    if (lastLine?.kind === "detail") {
      failedChecks.push({ kind: "section", label: "(baris detail tanpa subtotal penutup)", expected: Number.NaN, actual: Number.NaN, difference: Number.NaN, tolerance: 0, passed: false });
    }
    if (failedChecks.length === 0) {
      return { status: "ok", rowOffsetApplied: rowOffset, lines, checks };
    }
    attempts.push({ rowOffset, failedChecks });
  }
  const summary = attempts
    .map((attempt) => `offset ${attempt.rowOffset}: ${attempt.failedChecks.map((c) => `${c.label} selisih ${c.difference}`).join("; ")}`)
    .join(" | ");
  return {
    status: "rejected",
    reason: `Laporan tidak rekonsiliasi terhadap total yang tercetak, jadi hasil bacanya tidak bisa dipercaya. ${summary}`,
    attempts,
  };
}

// --- Jalur I/O (browser). Tidak pernah dieksekusi oleh test node. ---

/** Toleransi baris untuk text layer pdf.js — sama dengan groupPdfTextItemsIntoLines. */
export const DIGITAL_ROW_TOLERANCE = 2.5;

/**
 * Ambil token dari PDF DIGITAL lewat text layer.
 *
 * ponytail: memakai ulang extractPdfTextLayerItems yang sudah ada, termasuk
 * batas MAX_OCR_PAGES = 3 halaman di dalamnya. Laporan yang lebih panjang
 * akan terpotong — tapi terpotong berarti baris detail hilang, subtotal tidak
 * cocok, dan dokumen DITOLAK, bukan diterima separuh. Naikkan batas itu kalau
 * ketemu laporan >3 halaman.
 */
export async function extractDigitalTokens(pdfDocument: unknown): Promise<MappingToken[] | null> {
  const { extractPdfTextLayerItems } = await import("./reconciliation-berita-acara-client-ocr");
  const items = await extractPdfTextLayerItems(pdfDocument as Parameters<typeof extractPdfTextLayerItems>[0]);
  if (!items) return null;
  // pdf.js: Y membesar KE ATAS. Dibalik supaya sumbu baris seragam dengan OCR.
  return items.map((item) => ({ text: item.str, x: item.x, y: -item.y, page: item.page }));
}

/**
 * Ambil token dari PDF hasil SCAN: render tiap halaman ke canvas pada
 * SCAN_RENDER_SCALE lalu OCR dengan bounding box per kata.
 */
export async function extractScanTokens(
  pdfDocument: {
    numPages: number;
    getPage: (n: number) => Promise<{
      getViewport: (o: { scale: number }) => { width: number; height: number };
      render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
    }>;
  },
  onStatus: (status: string) => void = () => {},
): Promise<{ tokens: MappingToken[]; rowTolerance: number } | null> {
  const [{ createWorker }, { TESSERACT_ASSET_OPTIONS }] = await Promise.all([
    import("tesseract.js"),
    import("./reconciliation-berita-acara-client-ocr"),
  ]);
  const worker = await createWorker("ind+eng", undefined, TESSERACT_ASSET_OPTIONS);
  try {
    const tokens: MappingToken[] = [];
    const tolerances: number[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      onStatus(`Membaca halaman ${pageNumber} dari ${pdfDocument.numPages}...`);
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: SCAN_RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      await page.render({ canvasContext: context, viewport }).promise;
      const { data } = await worker.recognize(canvas, {}, { text: false, blocks: true });
      const blocks = data.blocks as TesseractBlockLike[] | null;
      tokens.push(...flattenOcrWords(blocks, pageNumber));
      tolerances.push(ocrRowTolerance(blocks));
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
