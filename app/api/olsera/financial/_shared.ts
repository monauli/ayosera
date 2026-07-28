import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { FinancialClientError } from "@/lib/olsera-financial-client";
export { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";
/**
 * Modul "olsera" adalah satu-satunya syarat untuk seluruh route Laporan
 * Keuangan (baca snapshot/ledger/export MAUPUN sync) — supervisor tidak lagi
 * dibedakan dari user biasa yang punya modul ini (lihat requireModule di
 * lib/auth.ts).
 */
export const guard = async () => { await requireModule("olsera"); };
export const safeError = (e: unknown) => e instanceof FinancialClientError ? e.safe : { status: "upstream-error", message: "Server Olsera sedang bermasalah. Coba lagi." };
export const json = (body: unknown, init?: ResponseInit) => NextResponse.json(body, { ...init, headers: { ...NO_CACHE_HEADERS, ...(init?.headers ?? {}) } });
export const errorJson = (e: unknown) => json(safeError(e));
