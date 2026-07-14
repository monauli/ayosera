// Normalisasi field `addon_price` dari payload item Olsera. Murni (tanpa
// dependency) supaya bisa diuji unit. Add-on SUDAH termasuk dalam `amount`
// (lihat lib/olsera-sync.ts) — nilai ini hanya disimpan untuk ditampilkan
// sebagai informasi, TIDAK PERNAH dijumlahkan kembali ke amount/total manapun.

export type AddonParseResult = { value: number; warning: string | null };

/**
 * - null/undefined/string kosong → 0 (bukan warning — memang tidak ada add-on).
 * - number/string angka valid → number.
 * - selain itu (NaN, teks bukan angka, object, dst) → 0 + warning (dicatat,
 *   tidak pernah membuat NaN tersimpan).
 */
export function parseAddonPrice(raw: unknown): AddonParseResult {
  if (raw === null || raw === undefined) return { value: 0, warning: null };
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? { value: raw, warning: null }
      : { value: 0, warning: `addon_price numerik tidak valid: ${raw}` };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { value: 0, warning: null };
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed)
      ? { value: parsed, warning: null }
      : { value: 0, warning: `addon_price string tidak valid: "${raw}"` };
  }
  return { value: 0, warning: `addon_price tipe tidak dikenal: ${typeof raw}` };
}
