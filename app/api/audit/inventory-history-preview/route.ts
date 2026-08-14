import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";

export const dynamic = "force-dynamic";
export const revalidate = 0;
const targets = [
  { key: "yonex", name: "YONEX SHORTS MEN", ids: [106743815, 118420650] },
  { key: "odea-rose", name: "ODEA ROSE", ids: [106817649, 116138490] },
  { key: "odea-red", name: "ODEA RED", ids: [119043265] },
] as const;
const periods = Array.from({ length: 7 }, (_, i) => `2026-${String(i + 2).padStart(2, "0")}`);
const allowed = new Set(targets.flatMap((target) => target.ids));

export async function GET() {
  try {
    await requireModule("audit");
    const data = await withMongo(async () => {
      const { olseraInventoryMonthlySnapshots, olseraInventoryMovements, olseraOrderItems, olseraProductAliases, inventoryStockOpnameReconciliations } = await collections();
      const ids = [...allowed];
      const [snapshots, movements, sales, aliases, opname] = await Promise.all([
        olseraInventoryMonthlySnapshots.find({ year: 2026, month: { $gte: 2, $lte: 8 }, productId: { $in: ids } }).project({ _id: 0, productId: 1, variantId: 1, productName: 1, year: 1, month: 1, openingQty: 1, incomingQty: 1, returnQty: 1, salesQty: 1, outgoingQty: 1, closingQty: 1, status: 1, diagnostics: 1, source: 1 }).toArray(),
        olseraInventoryMovements.find({ productId: { $in: ids }, date: { $gte: "2026-02-01", $lte: "2026-08-31" } }).project({ _id: 0, productId: 1, variantId: 1, date: 1, qtyChange: 1, type: 1, source: 1 }).toArray(),
        olseraOrderItems.find({ $or: [{ productId: { $in: ids } }, { resolvedProductId: { $in: ids } }] }).project({ _id: 0, productId: 1, resolvedProductId: 1, variantId: 1, qty: 1, orderDate: 1, date: 1 }).toArray(),
        olseraProductAliases.find({ $or: [{ oldProductId: { $in: ids } }, { newProductId: { $in: ids } }] }).project({ _id: 0, oldProductId: 1, oldVariantId: 1, newProductId: 1, newVariantId: 1, confidence: 1 }).toArray(),
        inventoryStockOpnameReconciliations.find({ productId: { $in: ids }, year: 2026, month: { $gte: 2, $lte: 8 } }).project({ _id: 0, productId: 1, variantId: 1, cutoff: 1, cutoffDate: 1, physicalQty: 1, systemClosingQty: 1, differenceQty: 1, status: 1, evidenceSource: 1, note: 1 }).toArray(),
      ]);
      const products = snapshots.map((row) => {
        const known = [row.openingQty, row.incomingQty, row.returnQty, row.salesQty, row.outgoingQty, row.closingQty].every((value) => value !== null && value !== undefined);
        const expectedClosing = known ? (row.openingQty ?? 0) + (row.incomingQty ?? 0) + (row.returnQty ?? 0) - (row.salesQty ?? 0) - (row.outgoingQty ?? 0) : null;
        const classification = !known ? "SOURCE_DATA_INCOMPLETE" : expectedClosing === row.closingQty ? "CONSISTENT" : "INCONSISTENT";
        // unresolvedGap murni aritmetika (stored closing - expected closing) untuk
        // ditampilkan sebagai diagnostic mentah — BUKAN proven adjustment/movement.
        // Tidak pernah dipakai untuk menulis/mengoreksi angka apa pun di sini.
        const unresolvedGap = classification === "INCONSISTENT" ? (row.closingQty as number) - (expectedClosing as number) : null;
        return {
          ...row,
          period: `${row.year}-${String(row.month).padStart(2, "0")}`,
          expectedClosing,
          classification,
          unresolvedGap,
          diagnostic:
            classification === "INCONSISTENT"
              ? `Stored closing ${row.closingQty} vs arithmetic expected ${expectedClosing} (gap ${unresolvedGap! >= 0 ? "+" : ""}${unresolvedGap} tidak diverifikasi/tidak proven — status unresolved, bukan final).`
              : classification === "SOURCE_DATA_INCOMPLETE"
                ? "Komponen formula belum lengkap."
                : null,
        };
      });
      const identitySources = targets.map((target) => ({ key: target.key, name: target.name, sources: target.ids.map((productId) => ({ productId, snapshotPeriods: snapshots.filter((row) => row.productId === productId).map((row) => `${row.year}-${String(row.month).padStart(2, "0")}`), movementPeriods: movements.filter((row) => row.productId === productId).map((row) => row.date), salesRows: sales.filter((row) => row.productId === productId || row.resolvedProductId === productId).length })), verifiedAliases: aliases.filter((alias) => alias.confidence === "verified" && (target.ids.includes(alias.oldProductId as never) || target.ids.includes(alias.newProductId as never))) }));
      return { checkedAt: new Date().toISOString(), scope: targets, periods, identitySources, products, evidence: { movements, sales, aliases, opname } };
    });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ error: "Preview histori inventori gagal dibaca." }, { status: 500 }); }
}
