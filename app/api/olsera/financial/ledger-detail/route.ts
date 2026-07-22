import { getLedgerDetail } from "@/lib/olsera-financial-client";
import { normalizeLedgerDetailPayload, validatePeriod } from "@/lib/olsera-financial-core";
import { guard, json, errorJson } from "../_shared";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) { await guard(); try { const url = new URL(req.url); const period = validatePeriod(url.searchParams.get("year"), url.searchParams.get("month")); const accountCode = url.searchParams.get("accountCode") ?? ""; if (!/^\d{1,20}$/.test(accountCode)) return json({ status: "upstream-error", message: "Nomor akun tidak valid." }); const rawPayload = await getLedgerDetail(period, accountCode); return json({ status: "success", period, reportType: "ledger-detail", accountCode, normalizedPayload: normalizeLedgerDetailPayload(rawPayload, accountCode), rawPayload }); } catch (error) { return errorJson(error); } }
