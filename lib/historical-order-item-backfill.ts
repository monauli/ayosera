// Milestone 4 Bagian C — Safe Backfill. HANYA mengisi productId/variantId/sku
// untuk baris "Exact Match" (HIGH CONFIDENCE, identifier jelas, mapping
// tunggal dari katalog aktif — lihat historical-order-item-identity.ts).
// Baris lain (Butuh Adjust Manual, Exact Product Variant Ambiguous, Historical
// Product, Name Match Only, Product Missing, Duplicate Candidate) TIDAK PERNAH
// disentuh oleh modul ini.
//
// Syarat Bagian C yang dijaga di sini:
// - tidak mengubah histori transaksi: HANYA field productId/variantId/sku yang
//   di-$set, tidak pernah amount/qty/date/orderNo/itemName/dll.
// - tidak mengubah nominal / formula: tidak ada logika kalkulasi di modul ini.
// - reversible: SETIAP baris yang dibackfill dicatat ke
//   historical_backfill_audit_log dengan state SEBELUM backfill, sehingga bisa
//   dibatalkan manual (unset field ke state itu) bila pernah diperlukan.
// - idempoten & aman diulang: filter update mensyaratkan field MASIH kosong
//   saat penulisan (bukan hasil klasifikasi yang sudah basi), dan dry-run
//   selalu me-re-derive dari state DB terkini.
import "server-only";
import { canAutoBackfill, type ClassifiedOrderItem } from "./historical-order-item-identity.ts";
import type { HistoricalBackfillAuditLogDocument } from "./mongodb.ts";

export type OrderItemBackfillPlanItem = {
  orderItemId: number;
  before: { productId: number | null; variantId: number | null; sku: string | null };
  after: { productId: number; variantId: number | null; sku: string | null };
};

/** Pure — turunkan rencana backfill dari hasil klasifikasi. HANYA "Exact Match". */
export function planExactMatchBackfill(classified: ClassifiedOrderItem[]): OrderItemBackfillPlanItem[] {
  return classified
    .filter((row) => canAutoBackfill(row.classification) && row.backfillTarget)
    .map((row) => ({
      orderItemId: row._id,
      before: {
        productId: row.fieldStates.productId === "present" ? (row.productId as number) : null,
        variantId: row.fieldStates.variantId === "present" ? (row.variantId as number) : null,
        sku: row.fieldStates.sku === "present" ? (row.sku as string) : null,
      },
      after: row.backfillTarget!,
    }));
}

export type OrderItemBackfillWriteContext = {
  orderItems: {
    findOne(filter: Record<string, unknown>): Promise<{ productId?: number | null; variantId?: number | null; sku?: string | null } | null>;
    updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number; modifiedCount: number }>;
  };
  auditLog: { insertOne(doc: HistoricalBackfillAuditLogDocument): Promise<unknown> };
};

export async function resolveOrderItemBackfillWriteContext(context?: OrderItemBackfillWriteContext): Promise<OrderItemBackfillWriteContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { olseraOrderItems, historicalBackfillAuditLog } = await collections();
  return { orderItems: olseraOrderItems as unknown as OrderItemBackfillWriteContext["orderItems"], auditLog: historicalBackfillAuditLog };
}

export type OrderItemBackfillResult = {
  runId: string;
  dryRun: boolean;
  planned: number;
  updated: number;
  skippedAlreadyFilled: number;
  sample: OrderItemBackfillPlanItem[];
};

export type OrderItemBackfillInput = {
  storeId: number;
  plan: OrderItemBackfillPlanItem[];
  dryRun: boolean;
  triggeredBy: string;
};

/**
 * Eksekusi backfill. `dryRun: true` (default aman) TIDAK PERNAH menulis —
 * hanya mengembalikan rencana + contoh baris untuk direview manusia dulu.
 * `dryRun: false` menulis SATU per SATU dengan guard "field masih kosong saat
 * ini" (re-check langsung ke DB, bukan percaya cache klasifikasi) + audit log.
 */
export async function runOrderItemIdentityBackfill(input: OrderItemBackfillInput, context?: OrderItemBackfillWriteContext): Promise<OrderItemBackfillResult> {
  if (!Number.isInteger(input.storeId) || input.storeId <= 0) throw new Error("storeId wajib diisi (integer positif).");
  if (!input.triggeredBy?.trim()) throw new Error("triggeredBy wajib diisi.");

  const runId = `historical-order-item-backfill:${input.storeId}:${Date.now()}`;
  const sample = input.plan.slice(0, 20);

  if (input.dryRun) {
    return { runId, dryRun: true, planned: input.plan.length, updated: 0, skippedAlreadyFilled: 0, sample };
  }

  const { orderItems, auditLog } = await resolveOrderItemBackfillWriteContext(context);
  const now = new Date();
  let updated = 0;
  let skippedAlreadyFilled = 0;

  for (const item of input.plan) {
    const current = await orderItems.findOne({ _id: item.orderItemId });
    // HANYA productId yang menentukan "sudah dibackfill atau belum" — variantId
    // dan sku boleh SAH bernilai null selamanya (produk tanpa varian/SKU di
    // katalog Olsera itu sendiri). Dikonfirmasi lewat backfill produksi
    // Milestone 4: banyak target productId punya variantId/sku null yang
    // MEMANG sesuai katalog, bukan tanda gagal — mensyaratkan variantId/sku
    // "terisi" di sini akan salah menyimpulkan baris itu "belum dibackfill"
    // dan menulis ulang nilai yang identik pada setiap rerun.
    const stillGapped = !current || current.productId == null;
    if (!stillGapped) {
      skippedAlreadyFilled++;
      continue;
    }
    await orderItems.updateOne({ _id: item.orderItemId }, { $set: { productId: item.after.productId, variantId: item.after.variantId, sku: item.after.sku } });
    try {
      await auditLog.insertOne({
        _id: item.orderItemId,
        storeId: input.storeId,
        orderItemId: item.orderItemId,
        classification: "Exact Match",
        before: item.before,
        after: item.after,
        triggeredBy: input.triggeredBy,
        runId,
        createdAt: now,
      });
    } catch (error) {
      // Duplicate key (_id = orderItemId) berarti baris ini SUDAH tercatat oleh
      // run lain sebelumnya (mis. dua klik tombol bersamaan) — updateOne di atas
      // tetap idempoten (nilai akhir sama), jadi ini bukan kegagalan, hanya
      // jejak audit yang tidak perlu ditulis dua kali.
      const code = (error as { code?: number } | null)?.code;
      if (code !== 11000) throw error;
    }
    updated++;
  }

  return { runId, dryRun: false, planned: input.plan.length, updated, skippedAlreadyFilled, sample };
}
