import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";
import { fetchOlseraSalesAuditSource } from "@/lib/olsera-sync";
import { fetchStockMovementRange } from "@/lib/olsera-inventory-stockmovement";
import { getBalanceSheet, getCashFlow, getLedgerSummary, getProfitLoss } from "@/lib/olsera-financial-client";
import { normalizeBalanceSheetPayload, normalizeCashFlowPayload, normalizeLedgerSummaryPayload, normalizeProfitLossPayload } from "@/lib/olsera-financial-core";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Status = "Cocok" | "Selisih" | "Data Belum Lengkap" | "Gagal Dicek";
const iso = /^\d{4}-(0[1-9]|1[0-2])$/;
const dayEnd = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
const stable = (value: unknown) => JSON.stringify(value, (_, v) => v instanceof Date ? v.toISOString() : v);
const failed = (error: unknown) => ({ status: "Gagal Dicek" as Status, detail: error instanceof Error ? error.message : "Source Olsera tidak dapat dibaca." });
const withTimeout = async <T,>(task: Promise<T>, ms: number): Promise<T> => await Promise.race([task, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Validasi kategori melewati batas waktu.")), ms))]);

export async function GET(request: Request) {
  try {
    await requireModule("audit");
    const period = new URL(request.url).searchParams.get("period") ?? "";
    const section = new URL(request.url).searchParams.get("section");
    if (!iso.test(period)) return NextResponse.json({ error: "period harus YYYY-MM." }, { status: 400 });
    const [year, month] = period.split("-").map(Number);
    const start = `${period}-01`, end = dayEnd(period);
    const current = period === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(new Date());
    const result: Record<string, unknown> = { period, checkedAt: new Date().toISOString() };

    const sections = await Promise.allSettled([
      (async () => {
        if (section && section !== "category") return { status: "Data Belum Lengkap" as Status };
        const [live, stored] = await withTimeout(Promise.all([fetchOlseraSalesAuditSource(start, end), withMongo(async () => { const { olseraSalesByCategory } = await collections(); return olseraSalesByCategory.find({ date: { $gte: start, $lte: end } }).toArray(); })]), 45_000);
        const liveTotal = live.items.reduce((x, row) => x + (Number.isFinite(row.amount) ? row.amount : 0), 0), liveQty = live.items.reduce((x, row) => x + (Number.isFinite(row.qty) ? row.qty : 0), 0);
        const storedTotal = stored.reduce((x, row) => x + row.totalAmount, 0), storedQty = stored.reduce((x, row) => x + row.qty, 0);
        const status = current ? "Data Belum Lengkap" : live.orders.length === 0 ? "Data Belum Lengkap" : liveTotal === storedTotal && liveQty === storedQty ? "Cocok" : "Selisih";
        return { status, label: "Cocok dengan API Olsera", reason: live.orders.length === 0 ? "API Olsera tidak mengembalikan order pada periode ini." : null, ayosera: { qty: storedQty, total: storedTotal }, olseraLive: { qty: liveQty, total: liveTotal }, delta: { qty: liveQty - storedQty, total: liveTotal - storedTotal }, orders: live.orders.length };
      })(),
      (async () => {
        if (section && section !== "inventory") return { status: "Data Belum Lengkap" as Status };
        const [live, stored] = await Promise.all([fetchStockMovementRange(start, end), withMongo(async () => { const { olseraInventoryMonthlySnapshots } = await collections(); return olseraInventoryMonthlySnapshots.find({ year, month }).toArray(); })]);
        if (!live.ok) return failed(new Error(live.error));
        const byProduct = new Map(live.rows.map((row) => [String(row.productId), row]));
        const details: Array<{ product: string; ayosera: number | null; olseraLive: number | null; delta: number | null; fields: string[] }> = [];
        for (const row of stored) { const liveRow = byProduct.get(String(row.productId)); if (!liveRow) { details.push({ product: row.productName, ayosera: row.closingQty, olseraLive: null, delta: null, fields: ["product tidak ditemukan"] }); continue; } const mapping = { openingQty: "beginningQty", incomingQty: "incomingQty", returnQty: "returnQty", salesQty: "salesQty", outgoingQty: "outgoingQty", closingQty: "sisa" } as const; const fields = (Object.keys(mapping) as Array<keyof typeof mapping>).filter((key) => row[key] !== liveRow[mapping[key]]); if (fields.length) details.push({ product: row.productName, ayosera: row.closingQty, olseraLive: liveRow.sisa, delta: liveRow.sisa - (row.closingQty ?? 0), fields }); }
        return { status: stored.length === 0 || live.rows.length === 0 ? "Data Belum Lengkap" : details.length ? "Selisih" : "Cocok", checked: stored.length, liveItems: live.rows.length, matching: stored.length - details.length, incomplete: stored.length === 0 || live.rows.length === 0 ? stored.length : 0, reason: live.rows.length === 0 ? "Stockmovement API kosong untuk periode ini; tidak dianggap 0/0 Cocok." : null, differences: details, source: "/en/inventory/stockmovement" };
      })(),
      (async () => {
        if (section && section !== "financial") return { status: "Data Belum Lengkap" as Status };
        const periodReports = await withMongo(async () => { const { olseraFinancialMonthlyReports } = await collections(); return olseraFinancialMonthlyReports.find({ period }).toArray(); });
        const live = await Promise.all([getBalanceSheet(period), getProfitLoss(period), getCashFlow(period), getLedgerSummary(period)]);
        const normalized = [normalizeBalanceSheetPayload(live[0]), normalizeProfitLossPayload(live[1]), normalizeCashFlowPayload(live[2]), normalizeLedgerSummaryPayload(live[3])];
        const names = ["balanceSheet", "profitLoss", "cashFlow", "ledgerSummary"] as const;
        const reports = Object.fromEntries(names.map((name, i) => { const stored = periodReports.find((x) => x.reportType === ({ balanceSheet: "balance-sheet", profitLoss: "profit-loss", cashFlow: "cash-flow", ledgerSummary: "ledger-summary" } as const)[name]); const oldTotals = (stored?.normalizedPayload as { totals?: Record<string, unknown> } | undefined)?.totals ?? {}; const newTotals = (normalized[i] as { totals?: Record<string, unknown> })?.totals ?? {}; const totals = Object.fromEntries(Object.keys({ ...oldTotals, ...newTotals }).map((key) => [key, { ayosera: oldTotals[key] ?? null, olsera: newTotals[key] ?? null, delta: typeof oldTotals[key] === "number" && typeof newTotals[key] === "number" ? (newTotals[key] as number) - (oldTotals[key] as number) : null }])); return [name, { status: stored && stable(stored.normalizedPayload) === stable(normalized[i]) ? "Cocok" : "Selisih" as Status, detail: stored ? null : "Snapshot AYOSERA belum tersedia.", totals }]; }));
        const storedLedger = periodReports.find((x) => x.reportType === "ledger-summary")?.normalizedPayload;
        const oldRows = Array.isArray(storedLedger) ? storedLedger as Array<Record<string, unknown>> : [];
        const newRows = Array.isArray(normalized[3]) ? normalized[3] as Array<Record<string, unknown>> : [];
        const oldByCode = new Map(oldRows.map((row) => [String(row.accountCode ?? row.account_code ?? row.code), row]));
        const differences = newRows.flatMap((row) => { const code = String(row.accountCode ?? row.account_code ?? row.code); const old = oldByCode.get(code); return old && stable(old) !== stable(row) ? [{ accountCode: code, name: row.accountName ?? row.name ?? null, ayosera: old, olsera: row }] : []; });
        return { ...reports, status: Object.values(reports).every((x) => x.status === "Cocok") ? "Cocok" : "Selisih", ledgerAccounts: { checked: newRows.length, matching: newRows.length - differences.length, differences } };
      })(),
    ]);
    result.category = sections[0].status === "fulfilled" ? sections[0].value : failed(sections[0].reason);
    result.inventory = sections[1].status === "fulfilled" ? sections[1].value : failed(sections[1].reason);
    result.financial = sections[2].status === "fulfilled" ? sections[2].value : failed(sections[2].reason);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ error: "Validasi Olsera gagal dijalankan." }, { status: 500 }); }
}
