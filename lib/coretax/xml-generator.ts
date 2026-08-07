// Generator XML Coretax — SATU mesin berbasis konfigurasi modul
// (lib/coretax/modules.ts), dipakai keempat modul (BPU/BPMP/BP21/BPA1).
// MURNI (tanpa I/O) — string masuk, string XML keluar.
//
// Aturan format mengikuti Template XML resmi DJP persis (lihat
// docs/coretax.md "Sumber Template Resmi"):
//   - deklarasi XML `<?xml version="1.0" encoding="utf-8"?>`
//   - root memakai atribut namespace persis seperti template
//     (`xsi:noNamespaceSchemaLocation="schema.xsd" xmlns:xsi="..."`)
//   - `<TIN>` tepat setelah root dibuka
//   - elemen kosong ditulis self-closing (`<Tag />`) — pola ini muncul di
//     SELURUH template resmi (mis. <SP2DNumber /> pada BPU_Template.xml,
//     <PrevWhTaxSlip /> pada BPA1_Template.xml)
//   - urutan field PERSIS urutan array `fields` konfigurasi modul (yang
//     sendiri sudah dibuktikan dari Template XML resmi)
//   - TIDAK ADA field UI (Status Data/Keterangan Kesalahan/rowId) yang ikut
//     ditulis — hanya field yang ada di CoretaxFieldDef
import type { CoretaxModuleConfig, CoretaxRow } from "./types.ts";

/** Escape lima karakter XML wajib: & < > " ' — & WAJIB lebih dulu supaya tidak escape ganda. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function fieldXml(key: string, rawValue: string | undefined, level: number): string {
  const value = (rawValue ?? "").trim();
  if (!value) return `${indent(level)}<${key} />`;
  return `${indent(level)}<${key}>${escapeXml(value)}</${key}>`;
}

/** Bangun XML lengkap satu modul dari TIN + baris data. Baris TIDAK divalidasi di sini — pemanggil (UI) wajib memblokir generate bila masih ada baris "Perlu Diperbaiki" (lihat lib/coretax/validation.ts). */
export function generateCoretaxXml(config: CoretaxModuleConfig, tin: string, rows: readonly CoretaxRow[]): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(`<${config.xmlRoot} xsi:noNamespaceSchemaLocation="schema.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
  lines.push(`${indent(1)}<TIN>${escapeXml(tin.trim())}</TIN>`);
  lines.push(`${indent(1)}<${config.xmlListWrapper}>`);
  for (const row of rows) {
    lines.push(`${indent(2)}<${config.xmlRowTag}>`);
    for (const f of config.fields) {
      lines.push(fieldXml(f.key, row.values[f.key], 3));
    }
    lines.push(`${indent(2)}</${config.xmlRowTag}>`);
  }
  lines.push(`${indent(1)}</${config.xmlListWrapper}>`);
  lines.push(`</${config.xmlRoot}>`);
  return lines.join("\n") + "\n";
}

/** Bersihkan karakter tidak aman untuk nama file (Windows/macOS/Linux) — spasi TETAP dipertahankan. */
export function sanitizeFileNamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "").trim() || "Draft";
}

/**
 * Nama file unduhan mengikuti pola contoh: `BPPU_2026-08_NamaDraft.xml`
 * (modul dengan Masa Pajak bulanan) atau `BPA1_2026_NamaDraft.xml` (BPA1,
 * hanya Tahun Pajak — tidak ada Masa Pajak tunggal karena field-nya rentang
 * bulan Start/End).
 */
export function coretaxFileName(config: CoretaxModuleConfig, period: { year: string; month?: string }, draftName: string): string {
  const periodPart = config.hasMonthlyPeriod && period.month ? `${period.year}-${period.month.padStart(2, "0")}` : period.year;
  return `${config.fileCode}_${periodPart}_${sanitizeFileNamePart(draftName)}.xml`;
}
