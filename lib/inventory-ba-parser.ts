// ---------------------------------------------------------------------------
// V4 REWRITE (2026-08-13): baris/text-stream heuristic parser (pendingPrefix /
// orphan-suffix, versi lama file ini) DIHAPUS SELURUHNYA. Root cause
// pembuktian produksi: BA Juli 2026 kolom YONEX AC102 (seharusnya Sistem
// 10 / Fisik 9 / Selisih -1) terbaca sebagai Sistem 201 / Fisik 350 /
// Selisih +349 — angka 201 dan 350 itu SEBENARNYA milik baris NESTLE PURE
// LIFE 1500ML (Satuan=201, Sistem=350). Ini membuktikan parsing baris teks
// SEQUENTIAL (regex per baris + heuristik prefix/suffix untuk nama yang
// wrap) secara struktural TIDAK BISA diandalkan untuk tabel PDF ini: begitu
// urutan token per baris sedikit meleset (kolom melebar/menyempit per
// baris, wrap tidak konsisten), angka antar baris ikut tertukar. Menambal
// heuristik lagi di atas heuristik lama hanya memindahkan bug, bukan
// menghilangkannya.
//
// Parser BARU (lib/inventory-ba-table-parser.ts) TIDAK LAGI memproses teks
// yang sudah diratakan jadi baris. Ia bekerja langsung pada text item
// pdf.js (str + posisi X/Y asli dari `transform`), merekonstruksi tabel
// secara SPASIAL: header dikenali dari label kolom, batas kolom diturunkan
// dari posisi X header (bukan konstanta piksel hardcode), baris dikelompokkan
// dari Y anchor kolom "No.", dan setiap text item ditempatkan ke kolom
// berdasarkan X-nya sendiri — bukan urutan ekstraksi atau tebakan "angka
// pertama setelah nama". Ini menghilangkan seluruh kelas bug "angka
// nyasar ke baris tetangga" karena kolom tidak lagi ditentukan oleh posisi
// token dalam satu baris teks gabungan.
//
// File ini sekarang HANYA menyimpan: (1) tipe data bersama, (2) helper
// murni (nomor, normalisasi nama, ekstraksi periode/cutoff dari teks bebas
// — bagian ini TIDAK bergantung pada layout tabel dan TIDAK terbukti salah,
// jadi dipertahankan apa adanya), dan (3) `inventoryBaParseFailure`, hasil
// fail-safe eksplisit untuk kasus tabel TIDAK BISA direkonstruksi secara
// spasial (mis. tidak ada data posisi sama sekali, seperti teks hasil OCR
// scan biasa yang tidak dilampiri koordinat per kata). Fail-safe ini SENGAJA
// mengembalikan 0 baris + status PERLU_DICEK, BUKAN memanggil parser lama —
// lihat AYOSERA-HANDOFF-LATEST.md untuk gap OCR table extraction.
// ---------------------------------------------------------------------------

export type InventoryBaParseStatus = "OK" | "PERLU_DICEK";

export type InventoryBaItem = {
  description: string;
  /** Kelompok Barang (kolom baru, generik — bukan bagian dari 7 kolom UI wajib tapi tetap diparse/disimpan). */
  kelompok: string | null;
  /** Kolom "Satuan" pada layout tabel ini adalah ANGKA (bukan unit teks seperti "pcs"). */
  satuan: number | null;
  systemQty: number | null;
  physicalQty: number | null;
  differenceQty: number | null;
  /** Kolom Keterangan (kolom baru, generik). */
  keterangan: string | null;
  confidence: number;
  status: InventoryBaParseStatus;
};

export type InventoryBaParseResult = {
  periodStart: string | null;
  cutoffDate: string | null;
  items: InventoryBaItem[];
  status: InventoryBaParseStatus;
  rawText: string;
};

const MONTHS: Record<string, string> = { januari: "01", februari: "02", maret: "03", april: "04", mei: "05", juni: "06", juli: "07", agustus: "08", september: "09", oktober: "10", november: "11", desember: "12" };
const monthPattern = Object.keys(MONTHS).join("|");

function dateParts(day: string, month: string, year: string) {
  return `${year}-${MONTHS[month.toLowerCase()]}-${day.padStart(2, "0")}`;
}

/** Parse angka integer (opsional tanda +/-) dari teks sel tabel; null bila bukan angka murni (fail-safe, bukan tebakan). */
export function numberValue(value: string): number | null {
  const cleaned = value.trim().replace(/[+,]/g, "");
  if (!/^-?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}

function normalized(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export function normalizeInventoryBaName(value: string) {
  return normalized(value);
}

/**
 * Ekstraksi periode/cutoff dari teks bebas. Bagian ini murni regex atas
 * seluruh teks (tidak bergantung pada baris/kolom tabel), sudah terbukti
 * benar sejak versi sebelumnya, dan TIDAK terlibat dalam bug angka
 * tertukar — dipertahankan tanpa perubahan logika.
 */
export function extractInventoryBaPeriod(rawText: string): { periodStart: string | null; cutoffDate: string | null } {
  const raw = rawText.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const period = new RegExp(`(?:periode|tanggal)?\\s*(\\d{1,2})\\s+(${monthPattern})\\s+(20\\d{2})\\s*(?:sampai|s\\/?d|[-–])\\s*(\\d{1,2})\\s+(${monthPattern})\\s+(20\\d{2})`, "i").exec(raw);
  if (!period) return { periodStart: null, cutoffDate: null };
  return { periodStart: dateParts(period[1], period[2], period[3]), cutoffDate: dateParts(period[4], period[5], period[6]) };
}

/**
 * Fail-safe eksplisit: dipakai ketika tabel TIDAK BISA direkonstruksi
 * secara spasial (tidak ada koordinat per text item sama sekali — mis.
 * hasil OCR plain text tanpa word-box, atau header tabel tidak ditemukan).
 * SENGAJA mengembalikan 0 baris + PERLU_DICEK, TIDAK PERNAH jatuh ke parser
 * baris lama yang terbukti menukar angka antar baris.
 */
export function inventoryBaParseFailure(rawText: string): InventoryBaParseResult {
  const { periodStart, cutoffDate } = extractInventoryBaPeriod(rawText);
  return { periodStart, cutoffDate, items: [], status: "PERLU_DICEK", rawText };
}
