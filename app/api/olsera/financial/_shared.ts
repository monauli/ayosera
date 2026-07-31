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
/**
 * Guard auth (`requireModule`) MELEMPAR sebuah Response 401/403 — bukan Error.
 * Response itu harus diteruskan apa adanya; kalau ikut dibungkus safeError,
 * penolakan auth berubah jadi HTTP 200 "Server Olsera sedang bermasalah" yang
 * menyesatkan. (Sebelum diperbaiki, `await guard()` berada DI LUAR try sehingga
 * Response yang dilempar tidak tertangkap sama sekali dan Next membalas 500.)
 */
export const errorJson = (e: unknown) => (e instanceof Response ? e : json(safeError(e)));
