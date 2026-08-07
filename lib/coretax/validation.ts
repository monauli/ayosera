// Validasi baris Coretax — MURNI (tanpa I/O). Setiap fungsi menerima
// konfigurasi modul + nilai baris, mengembalikan daftar CoretaxCellError.
// Aturan yang BELUM terbukti dari Excel Converter resmi ditandai TODO di
// bawah dan TIDAK ditegakkan (lihat docs/coretax.md "Aturan yang Belum
// Terverifikasi") — sesuai instruksi: jangan menebak aturan pajak.
import { bp21DeemedForTaxObject, bp21RateSchemeForTaxObject, bpuRateForTaxObject, REFERENCE_SETS } from "./references.ts";
import type { CoretaxCellError, CoretaxFieldDef, CoretaxModuleConfig, CoretaxRowValues } from "./types.ts";

function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY-MM-DD" valid & kalender nyata (menolak mis. 2025-02-30). */
function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function pushError(errors: CoretaxCellError[], field: string, message: string) {
  errors.push({ field, message });
}

function validateFieldBaseline(field: CoretaxFieldDef, value: string, errors: CoretaxCellError[]) {
  const blank = isBlank(value);
  if (field.required && blank) {
    pushError(errors, field.key, `${field.label} wajib diisi.`);
    return;
  }
  if (blank) return; // field opsional kosong — tidak divalidasi lebih lanjut.

  if (field.type === "month") {
    const n = toNumber(value);
    if (n === null || !Number.isInteger(n) || n < 1 || n > 12) {
      pushError(errors, field.key, `${field.label} harus angka 1–12.`);
    }
  } else if (field.type === "year") {
    const n = toNumber(value);
    if (n === null || !Number.isInteger(n) || String(Math.trunc(n)).length !== 4) {
      pushError(errors, field.key, `${field.label} harus tahun 4 digit, mis. 2026.`);
    }
  } else if (field.type === "date") {
    if (!parseIsoDate(value)) {
      pushError(errors, field.key, `${field.label} wajib diisi dengan tanggal yang valid (format YYYY-MM-DD).`);
    }
  } else if (field.type === "number") {
    const n = toNumber(value);
    if (n === null) {
      pushError(errors, field.key, `${field.label} harus berupa angka.`);
    } else if (n < 0) {
      // Validasi minimum #5: angka tidak boleh negatif kecuali Converter resmi mengizinkan —
      // tidak ada field yang terbukti mengizinkan negatif pada 8 file resmi yang diaudit.
      pushError(errors, field.key, `${field.label} tidak boleh negatif.`);
    }
  } else if (field.type === "select" && field.referenceKey) {
    const options = REFERENCE_SETS[field.referenceKey];
    if (options && !options.some((o) => o.value === value.trim())) {
      pushError(errors, field.key, `${field.label} harus dipilih dari daftar referensi resmi.`);
    }
  }

  // Validasi minimum #6 (sebagian — lihat TODO): NPWP/NIK/NITKU wajib digit saja.
  // Panjang persis (15/16 NPWP, 22 NITKU, dst.) BELUM diverifikasi dari Converter
  // resmi (tidak ada formula panjang eksplisit ditemukan di sheet DATA) — TODO:
  // konfirmasi aturan panjang dari Converter resmi sebelum ditegakkan lebih ketat.
  if (field.treatAsText && field.key !== "CounterpartPassport" && field.key !== "DocumentNumber" && field.key !== "SP2DNumber" && field.key !== "PrevWhTaxSlip") {
    if (!/^\d+$/.test(value.trim())) {
      pushError(errors, field.key, `${field.label} hanya boleh berisi angka.`);
    }
  }
}

function withholdingNotBeforePeriod(values: CoretaxRowValues, errors: CoretaxCellError[], periodYearKey: string, periodMonthKey: string | null) {
  const withholding = parseIsoDate(values.WithholdingDate ?? "");
  const year = toNumber(values[periodYearKey] ?? "");
  if (!withholding || year === null) return;
  const month = periodMonthKey ? toNumber(values[periodMonthKey] ?? "") : null;
  const periodOk = periodMonthKey && month !== null
    ? withholding.year > year || (withholding.year === year && withholding.month >= month)
    : withholding.year >= year;
  if (!periodOk) {
    pushError(errors, "WithholdingDate", "Tanggal pemotongan tidak boleh sebelum masa pajak.");
  }
}

/** Aturan lintas-field KHUSUS per modul — di luar validasi generik per field. */
function crossFieldRules(config: CoretaxModuleConfig, values: CoretaxRowValues, errors: CoretaxCellError[]) {
  if (config.id === "bpu") {
    // #9: DocumentNumber & DocumentDate wajib bila Document diisi (seluruh baris contoh Template/Converter resmi selalu mengisi keduanya bersamaan).
    if (!isBlank(values.Document)) {
      if (isBlank(values.DocumentNumber)) pushError(errors, "DocumentNumber", "Nomor dokumen wajib diisi.");
      if (isBlank(values.DocumentDate)) pushError(errors, "DocumentDate", "Tanggal dokumen wajib diisi untuk jenis dokumen ini.");
    }
    // #10: SP2DNumber wajib saat GovTreasurerOpt = Direct.
    if (values.GovTreasurerOpt?.trim() === "Direct" && isBlank(values.SP2DNumber)) {
      pushError(errors, "SP2DNumber", "Nomor SP2D wajib diisi karena cara pembayaran Direct.");
    }
    // #7: Tarif mengikuti referensi Kode Objek Pajak (REF!A:C BPU — tabel tunggal, tidak ada skema).
    if (!isBlank(values.TaxObjectCode) && !isBlank(values.Rate)) {
      const expected = bpuRateForTaxObject(values.TaxObjectCode.trim());
      const actual = toNumber(values.Rate);
      if (expected !== null && actual !== null && actual !== expected) {
        pushError(errors, "Rate", `Tarif tidak sesuai dengan Kode Objek Pajak (referensi: ${expected}%).`);
      }
    }
    withholdingNotBeforePeriod(values, errors, "TaxPeriodYear", "TaxPeriodMonth");
  }

  if (config.id === "bp21") {
    if (!isBlank(values.Document)) {
      if (isBlank(values.DocumentNumber)) pushError(errors, "DocumentNumber", "Nomor dokumen wajib diisi.");
      if (isBlank(values.DocumentDate)) pushError(errors, "DocumentDate", "Tanggal dokumen wajib diisi untuk jenis dokumen ini.");
    }
    // #8: Deemed mengikuti referensi Kode Objek Pajak (REF!A:D BP21).
    if (!isBlank(values.TaxObjectCode) && !isBlank(values.Deemed)) {
      const expected = bp21DeemedForTaxObject(values.TaxObjectCode.trim());
      const actual = toNumber(values.Deemed);
      if (expected !== null && actual !== null && actual !== expected) {
        pushError(errors, "Deemed", `Deemed tidak sesuai dengan Kode Objek Pajak (referensi: ${expected}%).`);
      }
    }
    // #7/#14: Tarif — HANYA dicek bila skema REF berupa angka final langsung (kode 21-402-xx).
    // Kode berskema TER/PS17/HARIAN/PESANGON/PENSIUN TIDAK dicek di sini — lihat TODO
    // BP21_TAX_OBJECTS di lib/coretax/references.ts (tabel bracket belum diekstraksi).
    if (!isBlank(values.TaxObjectCode) && !isBlank(values.Rate)) {
      const scheme = bp21RateSchemeForTaxObject(values.TaxObjectCode.trim());
      const actual = toNumber(values.Rate);
      if (typeof scheme === "number" && actual !== null && actual !== scheme) {
        pushError(errors, "Rate", `Tarif tidak sesuai dengan Kode Objek Pajak (referensi: ${scheme}%).`);
      }
    }
    withholdingNotBeforePeriod(values, errors, "TaxPeriodYear", "TaxPeriodMonth");
  }

  if (config.id === "bpmp") {
    // #12: CounterpartPassport mengikuti Resident/Foreign.
    if (values.CounterpartOpt?.trim() === "Foreign" && isBlank(values.CounterpartPassport)) {
      pushError(errors, "CounterpartPassport", "Nomor paspor wajib diisi untuk penerima berstatus Foreign.");
    }
    withholdingNotBeforePeriod(values, errors, "TaxPeriodYear", "TaxPeriodMonth");
  }

  if (config.id === "bpa1") {
    if (values.CounterpartOpt?.trim() === "Foreign" && isBlank(values.CounterpartPassport)) {
      pushError(errors, "CounterpartPassport", "Nomor paspor wajib diisi untuk penerima berstatus Foreign.");
    }
    // #13: NumberOfMonths mengikuti StatusOfWithholding — BELUM diverifikasi dari
    // Converter resmi (contoh baris Converter menunjukkan pola yang tidak intuitif:
    // PartialYear=0 bulan, Annualized=2 bulan), jadi TIDAK ditegakkan di sini.
    // TODO: konfirmasi aturan pastinya sebelum menambahkan validasi ini.
    withholdingNotBeforePeriod(values, errors, "TaxPeriodYear", "TaxPeriodMonthEnd");
  }
}

export function validateCoretaxRow(config: CoretaxModuleConfig, values: CoretaxRowValues): CoretaxCellError[] {
  const errors: CoretaxCellError[] = [];
  for (const field of config.fields) {
    validateFieldBaseline(field, values[field.key] ?? "", errors);
  }
  crossFieldRules(config, values, errors);
  return errors;
}

export function isRowBlank(config: CoretaxModuleConfig, values: CoretaxRowValues): boolean {
  return config.fields.every((f) => isBlank(values[f.key]));
}

/**
 * Aturan tunggal "boleh Preview/Unduh XML" — dipakai UI (components/coretax/coretax-module-page.tsx)
 * DAN diuji langsung di sini (lib/coretax/validation.test.ts) tanpa perlu me-render komponen.
 * Preview/Export DITOLAK bila: belum pernah diperiksa, tidak ada baris berisi data sama sekali,
 * atau ada baris "perlu-diperbaiki"/"belum-diperiksa" (baris kosong murni tidak dihitung).
 */
export function canExportCoretaxRows(checked: boolean, meaningfulRows: readonly { status: string }[]): boolean {
  if (!checked || meaningfulRows.length === 0) return false;
  return meaningfulRows.every((r) => r.status === "benar");
}
