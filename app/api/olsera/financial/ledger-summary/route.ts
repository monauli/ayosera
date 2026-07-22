import { getLedgerSummary } from "@/lib/olsera-financial-client";
import { normalizeLedgerSummaryPayload, validatePeriod } from "@/lib/olsera-financial-core";
import { guard, json, errorJson } from "../_shared";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) { await guard(); try { const url = new URL(req.url); const period = validatePeriod(url.searchParams.get("year"), url.searchParams.get("month")); const rawPayload = await getLedgerSummary(period); const normalizedPayload = normalizeLedgerSummaryPayload(rawPayload); return json({ status: "success", period, reportType: "ledger-summary", totalAccounts: normalizedPayload.length, normalizedPayload, rawPayload }); } catch (error) { return errorJson(error); } }
