import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { FinancialClientError } from "@/lib/olsera-financial-client";
export { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";
export const guard = async () => { await requireModule("olsera"); await requireSupervisor(); };
export const safeError = (e: unknown) => e instanceof FinancialClientError ? e.safe : { status: "upstream-error", message: "Server Olsera sedang bermasalah. Coba lagi." };
export const json = (body: unknown, init?: ResponseInit) => NextResponse.json(body, { ...init, headers: { ...NO_CACHE_HEADERS, ...(init?.headers ?? {}) } });
export const errorJson = (e: unknown) => json(safeError(e));
