// Registry EMPAT modul Coretax — SATU-SATUNYA tempat urutan & definisi field
// didefinisikan. Urutan array `fields` WAJIB PERSIS urutan tag XML resmi
// (dibuktikan dari Template XML + Excel Converter resmi DJP, lihat
// docs/coretax.md "Sumber Template Resmi") — lib/coretax/xml-generator.ts
// menulis field dalam urutan array ini apa adanya, tanpa penyortiran lain.
import { fieldLabel } from "./field-labels.ts";
import type { CoretaxFieldDef, CoretaxModuleConfig, CoretaxModuleId } from "./types.ts";

function field(def: Omit<CoretaxFieldDef, "label"> & { label?: string }): CoretaxFieldDef {
  return { ...def, label: def.label ?? fieldLabel(def.key) };
}

const BPU_FIELDS: CoretaxFieldDef[] = [
  field({ key: "TaxPeriodMonth", type: "month", required: true, headerAliases: ["Masa Pajak"] }),
  field({ key: "TaxPeriodYear", type: "year", required: true, headerAliases: ["Tahun Pajak"] }),
  field({ key: "CounterpartTin", type: "text", required: true, treatAsText: true, headerAliases: ["NPWP/NIK", "NPWP/NIK Penerima", "NPWP"] }),
  field({ key: "IDPlaceOfBusinessActivityOfIncomeRecipient", type: "text", required: true, treatAsText: true, headerAliases: ["NITKU", "NITKU Penerima", "ID TKU Penerima Penghasilan"] }),
  field({ key: "TaxCertificate", type: "select", required: true, referenceKey: "bpu.fasilitas", headerAliases: ["Fasilitas", "Fasilitas Pajak"] }),
  field({ key: "TaxObjectCode", type: "select", required: true, referenceKey: "bpu.taxObjectCode", headerAliases: ["Kode Objek Pajak"] }),
  field({ key: "TaxBase", type: "number", required: true, headerAliases: ["Dasar Pengenaan Pajak", "DPP"] }),
  field({ key: "Rate", type: "number", required: true, headerAliases: ["Tarif"] }),
  field({ key: "Document", type: "select", required: true, referenceKey: "bpu.document", headerAliases: ["Jenis Dokumen", "Jenis Dok. Referensi"] }),
  field({ key: "DocumentNumber", type: "text", required: false, treatAsText: true, headerAliases: ["Nomor Dokumen", "Nomor Dok. Referensi"] }),
  field({ key: "DocumentDate", type: "date", required: false, headerAliases: ["Tanggal Dokumen", "Tanggal Dok. Referensi"] }),
  field({ key: "IDPlaceOfBusinessActivity", type: "text", required: true, treatAsText: true, headerAliases: ["NITKU Pemotong", "ID TKU Pemotong"] }),
  field({ key: "GovTreasurerOpt", type: "select", required: true, referenceKey: "bpu.govTreasurerOpt", headerAliases: ["Cara Pembayaran Instansi Pemerintah", "Opsi Pembayaran (IP)"] }),
  field({ key: "SP2DNumber", type: "text", required: false, treatAsText: true, optionalXmlEmpty: true, headerAliases: ["Nomor SP2D", "Nomor SP2D (IP)"] }),
  field({ key: "WithholdingDate", type: "date", required: true, headerAliases: ["Tanggal Pemotongan"] }),
];

const BPMP_FIELDS: CoretaxFieldDef[] = [
  field({ key: "TaxPeriodMonth", type: "month", required: true, headerAliases: ["Masa Pajak"] }),
  field({ key: "TaxPeriodYear", type: "year", required: true, headerAliases: ["Tahun Pajak"] }),
  field({ key: "CounterpartOpt", type: "select", required: true, referenceKey: "bpmp.counterpartOpt", headerAliases: ["Status Pegawai", "WNI/WNA", "Status Penerima"] }),
  field({ key: "CounterpartPassport", type: "text", required: false, treatAsText: true, optionalXmlEmpty: true, headerAliases: ["Nomor Passport", "No. Paspor", "Nomor Paspor"] }),
  field({ key: "CounterpartTin", type: "text", required: true, treatAsText: true, headerAliases: ["NPWP/NIK/TIN", "NPWP/NIK"] }),
  field({ key: "StatusTaxExemption", type: "select", required: true, referenceKey: "bpmp.statusPtkp", headerAliases: ["Status PTKP", "Status"] }),
  field({ key: "Position", type: "text", required: true, headerAliases: ["Posisi", "Jabatan"] }),
  field({ key: "TaxCertificate", type: "select", required: true, referenceKey: "bp21.fasilitas", headerAliases: ["Sertifikat/Fasilitas", "Fasilitas"] }),
  field({ key: "TaxObjectCode", type: "select", required: true, referenceKey: "bpmp.taxObjectCode", headerAliases: ["Kode Objek Pajak"] }),
  field({ key: "Gross", type: "number", required: true, headerAliases: ["Penghasilan Kotor", "Penghasilan Bruto"] }),
  field({ key: "Rate", type: "number", required: true, headerAliases: ["Tarif"] }),
  field({ key: "IDPlaceOfBusinessActivity", type: "text", required: true, treatAsText: true, headerAliases: ["ID TKU", "NITKU"] }),
  field({ key: "WithholdingDate", type: "date", required: true, headerAliases: ["Tgl Pemotongan", "Tanggal Pemotongan"] }),
];

const BP21_FIELDS: CoretaxFieldDef[] = [
  field({ key: "TaxPeriodMonth", type: "month", required: true, headerAliases: ["Masa Pajak"] }),
  field({ key: "TaxPeriodYear", type: "year", required: true, headerAliases: ["Tahun Pajak"] }),
  field({ key: "CounterpartTin", type: "text", required: true, treatAsText: true, headerAliases: ["NPWP/NIK", "NPWP"] }),
  field({ key: "IDPlaceOfBusinessActivityOfIncomeRecipient", type: "text", required: true, treatAsText: true, headerAliases: ["NITKU Penerima", "ID TKU Penerima Penghasilan"] }),
  field({ key: "StatusTaxExemption", type: "select", required: true, referenceKey: "bp21.statusPtkp", headerAliases: ["Status PTKP"] }),
  field({ key: "TaxCertificate", type: "select", required: true, referenceKey: "bp21.fasilitas", headerAliases: ["Fasilitas"] }),
  field({ key: "TaxObjectCode", type: "select", required: true, referenceKey: "bp21.taxObjectCode", headerAliases: ["Kode Objek Pajak"] }),
  field({ key: "Gross", type: "number", required: true, headerAliases: ["Penghasilan", "Penghasilan Bruto"] }),
  field({ key: "Deemed", type: "number", required: true, headerAliases: ["Deemed", "Persentase Dasar"] }),
  field({ key: "Rate", type: "number", required: true, headerAliases: ["Tarif"] }),
  field({ key: "Document", type: "select", required: true, referenceKey: "bp21.document", headerAliases: ["Jenis Dokumen", "Jenis Dok. Referensi"] }),
  field({ key: "DocumentNumber", type: "text", required: false, treatAsText: true, headerAliases: ["Nomor Dokumen", "Nomor Dok. Referensi"] }),
  field({ key: "DocumentDate", type: "date", required: false, headerAliases: ["Tanggal Dokumen", "Tanggal Dok. Referensi"] }),
  field({ key: "IDPlaceOfBusinessActivity", type: "text", required: true, treatAsText: true, headerAliases: ["NITKU Pemotong", "ID TKU Pemotong"] }),
  field({ key: "WithholdingDate", type: "date", required: true, headerAliases: ["Tanggal Pemotongan"] }),
];

const BPA1_FIELDS: CoretaxFieldDef[] = [
  field({ key: "WorkForSecondEmployer", type: "select", required: true, referenceKey: "shared.yesNo", headerAliases: ["Pemberi Kerja Selanjutnya"] }),
  field({ key: "TaxPeriodMonthStart", type: "month", required: true, headerAliases: ["Masa Pajak Awal"] }),
  field({ key: "TaxPeriodMonthEnd", type: "month", required: true, headerAliases: ["Masa Pajak Akhir"] }),
  field({ key: "TaxPeriodYear", type: "year", required: true, headerAliases: ["Tahun Pajak"] }),
  field({ key: "CounterpartOpt", type: "select", required: true, referenceKey: "bpa1.counterpartOpt", headerAliases: ["WNI/WNA"] }),
  field({ key: "CounterpartPassport", type: "text", required: false, treatAsText: true, optionalXmlEmpty: true, headerAliases: ["No. Paspor", "Nomor Paspor"] }),
  field({ key: "CounterpartTin", type: "text", required: true, treatAsText: true, headerAliases: ["NPWP"] }),
  field({ key: "TaxExemptOpt", type: "select", required: true, referenceKey: "bpa1.statusPtkp", headerAliases: ["Status PTKP"] }),
  field({
    key: "StatusOfWithholding",
    type: "select",
    required: true,
    referenceKey: "bpa1.statusOfWithholdingObserved",
    headerAliases: ["Status Bukti Potong"],
    helpText: "Daftar pilihan belum terverifikasi lengkap dari Converter resmi — lihat docs/coretax.md.",
  }),
  field({ key: "CounterpartPosition", type: "text", required: true, headerAliases: ["Posisi", "Jabatan"] }),
  field({ key: "TaxObjectCode", type: "select", required: true, referenceKey: "bpa1.taxObjectCode", headerAliases: ["Kode Objek Pajak"] }),
  field({ key: "NumberOfMonths", type: "number", required: false, headerAliases: ["Jumlah Bulan Bekerja", "Jumlah Bulan"] }),
  field({ key: "SalaryPensionJhtTht", type: "number", required: true, headerAliases: ["Gaji"] }),
  field({ key: "GrossUpOpt", type: "select", required: true, referenceKey: "shared.yesNo", headerAliases: ["Opsi Gross Up"] }),
  field({ key: "IncomeTaxBenefit", type: "number", required: true, headerAliases: ["Tunjangan PPh"] }),
  field({ key: "OtherBenefit", type: "number", required: true, headerAliases: ["Tunjangan Lainnya / Lembur", "Tunjangan Lainnya"] }),
  field({ key: "Honorarium", type: "number", required: true, headerAliases: ["Honorarium"] }),
  field({ key: "InsurancePaidByEmployer", type: "number", required: true, headerAliases: ["Asuransi"] }),
  field({ key: "Natura", type: "number", required: true, headerAliases: ["Natura"] }),
  field({ key: "TantiemBonusThr", type: "number", required: true, headerAliases: ["Tantiem, Bonus, Gratifikasi, THR"] }),
  field({ key: "PensionContributionJhtThtFee", type: "number", required: true, headerAliases: ["Iuran Pensiun atau Biaya THT/JHT"] }),
  field({ key: "Zakat", type: "number", required: true, headerAliases: ["Zakat"] }),
  field({ key: "PrevWhTaxSlip", type: "text", required: false, treatAsText: true, optionalXmlEmpty: true, headerAliases: ["Nomor Bukti Potong Sebelumnya"] }),
  field({ key: "TaxCertificate", type: "select", required: true, referenceKey: "bp21.fasilitas", headerAliases: ["Fasilitas Pajak"] }),
  field({
    key: "Article21IncomeTax",
    type: "number",
    required: true,
    headerAliases: ["PPh Pasal 21*", "PPh Pasal 21"],
    helpText: "Diisi manual sesuai perhitungan PPh 21 setahun — Excel Converter resmi TIDAK menghitung nilai ini otomatis (bukan selalu 0).",
  }),
  field({ key: "IDPlaceOfBusinessActivity", type: "text", required: true, treatAsText: true, headerAliases: ["ID TKU Pemotong", "NITKU Pemotong"] }),
  field({ key: "WithholdingDate", type: "date", required: true, headerAliases: ["Tanggal Pemotongan"] }),
];

export const CORETAX_MODULES: Record<CoretaxModuleId, CoretaxModuleConfig> = {
  bpu: {
    id: "bpu",
    code: "BPU / BPPU",
    title: "Bukti Potong Unifikasi (BPU/BPPU)",
    shortDescription: "Siapkan data, periksa kesalahan, lalu unduh XML untuk diunggah ke Coretax.",
    xmlRoot: "BpuBulk",
    xmlListWrapper: "ListOfBpu",
    xmlRowTag: "Bpu",
    fileCode: "BPPU",
    hasMonthlyPeriod: true,
    fields: BPU_FIELDS,
  },
  bpmp: {
    id: "bpmp",
    code: "BPMP",
    title: "Bukti Potong Masa Pegawai (BPMP)",
    shortDescription: "Siapkan data, periksa kesalahan, lalu unduh XML untuk diunggah ke Coretax.",
    xmlRoot: "MmPayrollBulk",
    xmlListWrapper: "ListOfMmPayroll",
    xmlRowTag: "MmPayroll",
    fileCode: "BPMP",
    hasMonthlyPeriod: true,
    fields: BPMP_FIELDS,
  },
  bp21: {
    id: "bp21",
    code: "BP21",
    title: "Bukti Potong PPh Pasal 21 Tidak Final (BP21)",
    shortDescription: "Siapkan data, periksa kesalahan, lalu unduh XML untuk diunggah ke Coretax.",
    xmlRoot: "Bp21Bulk",
    xmlListWrapper: "ListOfBp21",
    xmlRowTag: "Bp21",
    fileCode: "BP21",
    hasMonthlyPeriod: true,
    fields: BP21_FIELDS,
  },
  bpa1: {
    id: "bpa1",
    code: "BPA1",
    title: "Bukti Potong Pajak PPh 21/26 (BPA1)",
    shortDescription: "Siapkan data, periksa kesalahan, lalu unduh XML untuk diunggah ke Coretax.",
    xmlRoot: "A1Bulk",
    xmlListWrapper: "ListOfA1",
    xmlRowTag: "A1",
    fileCode: "BPA1",
    hasMonthlyPeriod: false,
    fields: BPA1_FIELDS,
  },
};

export const CORETAX_MODULE_LIST: CoretaxModuleConfig[] = [CORETAX_MODULES.bpu, CORETAX_MODULES.bpmp, CORETAX_MODULES.bp21, CORETAX_MODULES.bpa1];

export function coretaxModule(id: CoretaxModuleId): CoretaxModuleConfig {
  const config = CORETAX_MODULES[id];
  if (!config) throw new Error(`Modul Coretax tidak dikenal: ${id}`);
  return config;
}

export function isCoretaxModuleId(value: string): value is CoretaxModuleId {
  return value === "bpu" || value === "bpmp" || value === "bp21" || value === "bpa1";
}

/** Baris kosong baru (semua field string kosong) — dipakai "Tambah Baris" & saat draft baru dibuat. */
export function emptyCoretaxRowValues(config: CoretaxModuleConfig): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of config.fields) values[f.key] = "";
  return values;
}
