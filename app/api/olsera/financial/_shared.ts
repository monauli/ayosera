import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { FinancialClientError } from "@/lib/olsera-financial-client";
export { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";
export const guard = async () => { await requireModule("olsera"); await requireSupervisor(); };
/**
 * Baca-saja dari snapshot MongoDB (tidak pernah memanggil Olsera live): boleh
 * diakses siapa pun yang punya modul "olsera", tanpa syarat supervisor. Dipakai
 * oleh snapshot/snapshot-ledger/export — TIDAK oleh sync/start|step|status
 * (tetap `guard()` di atas) atau route live-Olsera lain di folder ini.
 */
export const readGuard = async () => { await requireModule("olsera"); };
export const safeError = (e: unknown) => e instanceof FinancialClientError ? e.safe : { status: "upstream-error", message: "Server Olsera sedang bermasalah. Coba lagi." };
export const json = (body: unknown, init?: ResponseInit) => NextResponse.json(body, { ...init, headers: { ...NO_CACHE_HEADERS, ...(init?.headers ?? {}) } });
export const errorJson = (e: unknown) => json(safeError(e));
