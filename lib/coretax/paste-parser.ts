// Parser paste dari Excel — MURNI (tanpa I/O, tanpa DOM). Menerima teks yang
// disalin dari Excel (TSV — Excel selalu memisah kolom dengan Tab dan baris
// dengan newline saat disalin ke clipboard) dan field urutan modul aktif,
// mengembalikan baris berupa Record<key, string> siap ditaruh ke grid.
import type { CoretaxFieldDef } from "./types.ts";

/** Pisahkan teks clipboard jadi baris x kolom. Baris kosong di akhir (sisa newline) dibuang. */
export function splitPastedGrid(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

function normalizeHeaderText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Deteksi apakah baris pertama adalah header yang dikenal — minimal SATU sel
 * baris pertama harus cocok (label utama ATAU salah satu headerAliases, tidak
 * peka besar/kecil huruf) supaya baris data yang kebetulan mirip teks header
 * tidak salah dianggap header.
 */
export function detectHeaderRow(firstRow: string[], fields: readonly CoretaxFieldDef[]): boolean {
  const known = new Set<string>();
  for (const f of fields) {
    known.add(normalizeHeaderText(f.label));
    for (const alias of f.headerAliases) known.add(normalizeHeaderText(alias));
  }
  return firstRow.some((cell) => known.has(normalizeHeaderText(cell)));
}

/** Petakan satu baris header ke index field (null bila kolom tidak dikenali — kolom itu diabaikan). */
export function mapHeaderToFieldIndex(headerRow: string[], fields: readonly CoretaxFieldDef[]): (number | null)[] {
  const byLabel = new Map<string, number>();
  fields.forEach((f, index) => {
    byLabel.set(normalizeHeaderText(f.label), index);
    for (const alias of f.headerAliases) byLabel.set(normalizeHeaderText(alias), index);
  });
  return headerRow.map((cell) => byLabel.get(normalizeHeaderText(cell)) ?? null);
}

export type ParsedPasteRow = Record<string, string>;

/**
 * Ubah grid hasil paste jadi baris `{ [fieldKey]: string }`, dimulai dari
 * kolom yang sedang dipilih user (`startFieldIndex`).
 *
 * Mode A (posisi kolom, default): kolom ke-N hasil paste -> field ke
 * `startFieldIndex + N` pada modul aktif (urut fields[]), tanpa peduli isi
 * baris pertama.
 *
 * Mode B (nama header): HANYA aktif bila baris pertama grid yang di-paste
 * dikenali sebagai header (lihat detectHeaderRow) — baris itu TIDAK ikut
 * jadi baris data, dan kolom dipetakan berdasarkan nama header per kolom
 * (mode B mengabaikan startFieldIndex — pemetaan dari nama, bukan posisi).
 */
export function parsePastedRows(text: string, fields: readonly CoretaxFieldDef[], startFieldIndex: number): ParsedPasteRow[] {
  const grid = splitPastedGrid(text);
  if (!grid.length) return [];

  const hasHeader = detectHeaderRow(grid[0], fields);
  if (hasHeader) {
    const mapping = mapHeaderToFieldIndex(grid[0], fields);
    return grid.slice(1).map((row) => {
      const values: ParsedPasteRow = {};
      row.forEach((cell, colIndex) => {
        const fieldIndex = mapping[colIndex];
        if (fieldIndex === null || fieldIndex === undefined) return;
        values[fields[fieldIndex].key] = cell;
      });
      return values;
    });
  }

  return grid.map((row) => {
    const values: ParsedPasteRow = {};
    row.forEach((cell, colIndex) => {
      const field = fields[startFieldIndex + colIndex];
      if (!field) return;
      values[field.key] = cell;
    });
    return values;
  });
}
