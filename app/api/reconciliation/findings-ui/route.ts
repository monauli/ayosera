import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId, ReconciliationValidationError } from "@/lib/reconciliation-store";
import { isReconciliationConfidence, isReconciliationDomain, isReconciliationImpact, isReconciliationStatus } from "@/lib/reconciliation-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PERIOD = /^\d{4}-\d{2}$/;
const EFFECTIVE = ["OPEN", "CONFIRMED", "DISMISSED", "MANUAL_ACTION_REQUIRED", "DEFERRED", "RESOLVED"] as const;
const DECISIONS = ["CONFIRMED_FINDING", "FALSE_POSITIVE", "REQUIRES_MANUAL_ADJUSTMENT", "DEFERRED", "RESOLVED", "REVOKED"] as const;
const REASONS = ["SOURCE_DATA_INCOMPLETE", "PRODUCT_ID_CHANGED", "PRODUCT_IDENTITY_AMBIGUOUS", "LEGACY_STORE_ID_NULL", "STALE_SNAPSHOT", "EXPECTED_NON_STOCK_ITEM", "CURRENT_MONTH_BOUNDARY", "VERIFIED_FALSE_POSITIVE", "VERIFIED_CORRECT", "MANUAL_INVENTORY_ADJUSTMENT_REQUIRED", "OTHER"] as const;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function optionalEnum(value: string | null, allowed: readonly string[], label: string) { if (!value) return undefined; if (!allowed.includes(value)) throw new ReconciliationValidationError(`${label} tidak valid.`); return value; }
function positive(value: string | null, fallback: number, max: number) { const n = Number(value ?? fallback); if (!Number.isInteger(n) || n < 1) throw new ReconciliationValidationError("page/limit tidak valid."); return Math.min(n, max); }

/** Read model UI: agregasi dan pagination dikerjakan MongoDB, bukan browser. */
export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const p = new URL(request.url).searchParams;
    const storeId = currentStoreId(); const page = positive(p.get("page"), 1, 1_000_000); const limit = positive(p.get("limit"), 25, 100);
    const match: Record<string, unknown> = { storeId };
    const period = p.get("period"); if (period) { if (!PERIOD.test(period)) throw new ReconciliationValidationError("period tidak valid."); match.period = period; }
    const domain = p.get("domain"); if (domain) { if (!isReconciliationDomain(domain)) throw new ReconciliationValidationError("domain tidak valid."); match.domain = domain; }
    const impact = p.get("impact"); if (impact) { if (!isReconciliationImpact(impact)) throw new ReconciliationValidationError("impact tidak valid."); match.impact = impact; }
    const confidence = p.get("confidence"); if (confidence) { if (!isReconciliationConfidence(confidence)) throw new ReconciliationValidationError("confidence tidak valid."); match.confidence = confidence; }
    const status = p.get("status"); if (status) { if (!isReconciliationStatus(status)) throw new ReconciliationValidationError("status tidak valid."); match.status = status; }
    const keyword = p.get("keyword")?.trim(); if (keyword) { if (keyword.length > 100) throw new ReconciliationValidationError("keyword terlalu panjang."); match.entityKey = { $regex: `^${escapeRegex(keyword)}`, $options: "i" }; }
    const effectiveStatus = optionalEnum(p.get("effectiveStatus"), EFFECTIVE, "effectiveStatus");
    const decision = optionalEnum(p.get("decision"), DECISIONS, "decision"); const reasonCode = optionalEnum(p.get("reasonCode"), REASONS, "reasonCode");
    const needsAction = p.get("needsAction"); if (needsAction && needsAction !== "true" && needsAction !== "false") throw new ReconciliationValidationError("needsAction tidak valid.");
    const { reconciliationFindings } = await collections();
    const pipeline: Record<string, unknown>[] = [
      { $match: match },
      { $lookup: { from: "reconciliation_manual_resolutions", let: { fid: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$findingId", "$$fid"] }, isCurrent: true } }, { $limit: 1 }], as: "resolutionRows" } },
      { $set: { currentResolution: { $arrayElemAt: ["$resolutionRows", 0] } } },
      { $set: { effectiveStatus: { $switch: { branches: [
        { case: { $eq: ["$currentResolution.decision", "CONFIRMED_FINDING"] }, then: "CONFIRMED" },
        { case: { $eq: ["$currentResolution.decision", "FALSE_POSITIVE"] }, then: "DISMISSED" },
        { case: { $eq: ["$currentResolution.decision", "REQUIRES_MANUAL_ADJUSTMENT"] }, then: "MANUAL_ACTION_REQUIRED" },
        { case: { $eq: ["$currentResolution.decision", "DEFERRED"] }, then: "DEFERRED" },
        { case: { $eq: ["$currentResolution.decision", "RESOLVED"] }, then: "RESOLVED" },
        { case: { $eq: ["$currentResolution.decision", "REVOKED"] }, then: { $ifNull: ["$currentResolution.metadata.effectiveStatus", "OPEN"] } },
      ], default: "OPEN" } }, impactRank: { $switch: { branches: [{ case: { $eq: ["$impact", "CRITICAL"] }, then: 0 }, { case: { $eq: ["$impact", "ERROR"] }, then: 1 }, { case: { $eq: ["$impact", "WARNING"] }, then: 2 }], default: 3 } } } },
    ];
    const postMatch: Record<string, unknown> = {};
    if (effectiveStatus) postMatch.effectiveStatus = effectiveStatus; if (decision) postMatch["currentResolution.decision"] = decision; if (reasonCode) postMatch["currentResolution.reasonCode"] = reasonCode;
    if (needsAction === "true") postMatch.effectiveStatus = { $in: ["OPEN", "MANUAL_ACTION_REQUIRED", "DEFERRED"] };
    if (Object.keys(postMatch).length) pipeline.push({ $match: postMatch });
    pipeline.push({ $facet: { items: [{ $sort: { impactRank: 1, updatedAt: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: { resolutionRows: 0, impactRank: 0 } }], totals: [{ $group: { _id: null, total: { $sum: 1 }, critical: { $sum: { $cond: [{ $eq: ["$impact", "CRITICAL"] }, 1, 0] } }, error: { $sum: { $cond: [{ $eq: ["$impact", "ERROR"] }, 1, 0] } }, warning: { $sum: { $cond: [{ $eq: ["$impact", "WARNING"] }, 1, 0] } }, open: { $sum: { $cond: [{ $eq: ["$effectiveStatus", "OPEN"] }, 1, 0] } }, manual: { $sum: { $cond: [{ $eq: ["$effectiveStatus", "MANUAL_ACTION_REQUIRED"] }, 1, 0] } }, resolved: { $sum: { $cond: [{ $eq: ["$effectiveStatus", "RESOLVED"] }, 1, 0] } }, dismissed: { $sum: { $cond: [{ $eq: ["$effectiveStatus", "DISMISSED"] }, 1, 0] } }, needsAction: { $sum: { $cond: [{ $in: ["$effectiveStatus", ["OPEN", "MANUAL_ACTION_REQUIRED", "DEFERRED"]] }, 1, 0] } } } }] } });
    const [result] = await reconciliationFindings.aggregate(pipeline).toArray() as Array<{ items: unknown[]; totals: Array<Record<string, number>> }>;
    return NextResponse.json({ items: result?.items ?? [], pagination: { page, limit, total: result?.totals?.[0]?.total ?? 0 }, aggregates: result?.totals?.[0] ?? { total: 0 }, appliedFilters: Object.fromEntries(p.entries()) }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ReconciliationValidationError) return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
    console.error("[reconciliation:findings-ui]", error);
    return NextResponse.json({ error: "Gagal memuat data rekonsiliasi." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
