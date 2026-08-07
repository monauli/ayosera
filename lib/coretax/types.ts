// Tipe bersama modul Coretax (BPU/BPPU, BPMP, BP21, BPA1). MURNI tipe data —
// tidak ada I/O di file ini.

export type CoretaxModuleId = "bpu" | "bpmp" | "bp21" | "bpa1";

export type CoretaxFieldType = "month" | "year" | "text" | "date" | "number" | "select";

/** Satu field pada satu baris — urutan field di CoretaxModuleConfig.fields WAJIB sama persis urutan tag XML resmi. */
export type CoretaxFieldDef = {
  /** Kunci internal (key di CoretaxRowValues), SAMA PERSIS dengan nama tag XML — supaya generator XML tidak butuh peta terjemahan kedua. */
  key: string;
  /** Label Bahasa Indonesia ditampilkan sebagai header kolom grid & pesan validasi. */
  label: string;
  type: CoretaxFieldType;
  required: boolean;
  /** true = nilai HARUS diperlakukan sebagai teks (NPWP/NIK/NITKU/kode/nomor dokumen) — angka nol di depan tidak boleh hilang saat paste/parse/simpan. */
  treatAsText?: boolean;
  /** Kunci referensi dropdown (lihat REFERENCE_SETS di lib/coretax/references.ts) — hanya untuk type "select". */
  referenceKey?: string;
  /** Nama header Excel yang dikenali saat paste (case-insensitive, di luar label utama). */
  headerAliases: string[];
  /** Bantuan singkat opsional ditampilkan di tooltip sel. */
  helpText?: string;
  /** true bila field ini boleh dikosongkan sebagai tag XML kosong (self-closing) — bukan berarti tidak wajib divalidasi (lihat rule wajib bersyarat di validation.ts). */
  optionalXmlEmpty?: boolean;
};

/** Satu baris data mentah — nilai SELALU string (grid seperti Excel), dikonversi tipe hanya saat validasi/generate XML. */
export type CoretaxRowValues = Record<string, string>;

export type CoretaxRowStatus = "belum-diperiksa" | "benar" | "perlu-diperbaiki";

export type CoretaxCellError = { field: string; message: string };

/** Satu baris grid — data XML (`values`) terpisah tegas dari status UI (`status`/`errors`, TIDAK PERNAH ikut masuk XML). */
export type CoretaxRow = {
  /** Id baris lokal (UI saja, untuk key React & referensi undo) — TIDAK masuk XML. */
  rowId: string;
  values: CoretaxRowValues;
  status: CoretaxRowStatus;
  errors: CoretaxCellError[];
};

export type CoretaxModuleConfig = {
  id: CoretaxModuleId;
  /** Kode dokumen resmi ditampilkan di UI, mis. "BPU / BPPU". */
  code: string;
  title: string;
  shortDescription: string;
  /** Nama root element XML, mis. "BpuBulk". */
  xmlRoot: string;
  /** Nama elemen pembungkus daftar, mis. "ListOfBpu". */
  xmlListWrapper: string;
  /** Nama elemen satu baris, mis. "Bpu". */
  xmlRowTag: string;
  /** Prefix nama file unduhan, mis. "BPPU". */
  fileCode: string;
  /** true bila modul ini memakai Masa Pajak bulanan (TaxPeriodMonth/Year) — BPA1 memakai rentang bulan (Start/End), bukan satu bulan. */
  hasMonthlyPeriod: boolean;
  fields: CoretaxFieldDef[];
};
