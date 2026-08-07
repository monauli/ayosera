// Label Bahasa Indonesia untuk setiap nama field XML Coretax — SATU-SATUNYA
// kamus istilah dipakai lib/coretax/modules.ts untuk keempat modul (banyak
// nama field terpakai ulang lintas modul, mis. TaxPeriodMonth/TaxObjectCode/
// WithholdingDate). Istilah teknis XML (schema/node/root/payload/parser/
// validation engine) SENGAJA tidak pernah dipakai sebagai label di sini.

export const FIELD_LABELS: Record<string, string> = {
  TaxPeriodMonth: "Masa Pajak",
  TaxPeriodYear: "Tahun Pajak",
  TaxPeriodMonthStart: "Masa Pajak Awal",
  TaxPeriodMonthEnd: "Masa Pajak Akhir",
  CounterpartTin: "NPWP/NIK Penerima",
  CounterpartOpt: "Status Penerima (WNI/WNA)",
  CounterpartPassport: "Nomor Paspor",
  IDPlaceOfBusinessActivityOfIncomeRecipient: "NITKU Penerima",
  IDPlaceOfBusinessActivity: "NITKU Pemotong",
  TaxCertificate: "Fasilitas Pajak",
  TaxObjectCode: "Kode Objek Pajak",
  TaxBase: "Dasar Pengenaan Pajak",
  Gross: "Penghasilan Bruto",
  Deemed: "Persentase Dasar",
  Rate: "Tarif",
  Document: "Jenis Dokumen",
  DocumentNumber: "Nomor Dokumen",
  DocumentDate: "Tanggal Dokumen",
  WithholdingDate: "Tanggal Pemotongan",
  Position: "Jabatan",
  StatusTaxExemption: "Status PTKP",
  TaxExemptOpt: "Status PTKP",
  NumberOfMonths: "Jumlah Bulan",
  Article21IncomeTax: "PPh Pasal 21",
  GovTreasurerOpt: "Cara Pembayaran Instansi Pemerintah",
  SP2DNumber: "Nomor SP2D",
  WorkForSecondEmployer: "Bekerja pada Pemberi Kerja Lain",
  StatusOfWithholding: "Status Bukti Potong",
  CounterpartPosition: "Jabatan Penerima",
  SalaryPensionJhtTht: "Gaji/Pensiun/JHT/THT",
  GrossUpOpt: "Opsi Gross Up",
  IncomeTaxBenefit: "Tunjangan PPh",
  OtherBenefit: "Tunjangan Lainnya/Lembur",
  Honorarium: "Honorarium",
  InsurancePaidByEmployer: "Premi Asuransi Dibayar Pemberi Kerja",
  Natura: "Natura",
  TantiemBonusThr: "Tantiem, Bonus, Gratifikasi, THR",
  PensionContributionJhtThtFee: "Iuran Pensiun atau Biaya THT/JHT",
  Zakat: "Zakat",
  PrevWhTaxSlip: "Nomor Bukti Potong Sebelumnya",
};

/** Label untuk field yang tidak ada di kamus (fallback aman, bukan tebakan arti — hanya format nama). */
export function fieldLabel(xmlKey: string): string {
  return FIELD_LABELS[xmlKey] ?? xmlKey;
}
