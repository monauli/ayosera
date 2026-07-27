// Helper MURNI (tanpa MongoDB/I-O) untuk diagnostic script
// scripts/audit-reconciliation-inventory-null-product.ts — memisahkan logika
// klasifikasi identitas (testable tanpa database) dari orkestrasi baca Mongo.
//
// Tujuan: mendeteksi SEMUA bentuk "identitas productId hilang/rusak" pada
// dokumen olsera_inventory_movements, TIDAK HANYA `productId === null` yang
// dipakai lib/reconciliation-sources.ts (strict equality) — supaya bisa
// dikonfirmasi/disangkal apakah strict check tsb melewatkan bentuk lain
// (field tidak ada, string kosong, tipe data tak terduga).

export type IdentityState = "null" | "absent" | "empty-string" | "unexpected-type" | "ok-number";
export type FieldState = "present" | "absent" | "null" | "empty-string";

/** Klasifikasi field `productId` pada dokumen MENTAH (bukan tipe TS yang sudah diasumsikan number|null). */
export function classifyProductId(raw: Record<string, unknown>): IdentityState {
  if (!("productId" in raw)) return "absent";
  const v = raw.productId;
  if (v === null) return "null";
  if (typeof v === "string" && v.trim() === "") return "empty-string";
  if (typeof v === "number") return "ok-number";
  return "unexpected-type"; // mis. string non-kosong, boolean, object — bukan number|null sesuai skema
}

/** Klasifikasi umum untuk field informasi tambahan (variantId, sku) — TIDAK menentukan "missing identity" sendiri. */
export function classifyField(raw: Record<string, unknown>, key: string): FieldState {
  if (!(key in raw)) return "absent";
  const v = raw[key];
  if (v === null) return "null";
  if (typeof v === "string" && v.trim() === "") return "empty-string";
  return "present";
}

/** true bila identitas productId dianggap "hilang/rusak" untuk keperluan audit (segala sesuatu SELAIN number valid). */
export function isMissingIdentity(state: IdentityState): boolean {
  return state !== "ok-number";
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateDateArg(value: string, label: string): string {
  if (!DATE_PATTERN.test(value)) throw new Error(`${label} tidak valid (wajib format YYYY-MM-DD): ${value}`);
  return value;
}

export function validateStoreIdArg(value: number | null): number {
  if (value === null || !Number.isInteger(value) || value <= 0) {
    throw new Error("storeId tidak valid — set OLSERA_INTERNAL_STORE_ID di env atau --store-id=<id integer positif>.");
  }
  return value;
}
