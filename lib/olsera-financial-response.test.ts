import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeFinancialResponse,
  parseLedgerResponse,
  parseSnapshotResponse,
  INVALID_JSON_MESSAGE,
  INVALID_SHAPE_MESSAGE,
  TIMEOUT_MESSAGE,
  type FinancialResponseInput,
} from "./olsera-financial-response.ts";

const JSON_TYPE = "application/json";

function input(httpStatus: number, body: unknown, contentType: string | null = JSON_TYPE): FinancialResponseInput {
  return { httpStatus, contentType, bodyText: typeof body === "string" ? body : JSON.stringify(body) };
}

/** Payload snapshot valid — bentuk sama dengan yang dikirim app/api/olsera/financial/snapshot/route.ts. */
function validSnapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    period: "2026-05",
    latestSyncedPeriod: "2026-05",
    hasData: true,
    syncLog: {
      runId: "financial:1:2026-05",
      status: "success",
      phase: "completed",
      accountsProcessed: 85,
      accountsTotal: 85,
      recordsProcessed: 91,
      errorMessage: null,
      // Date server dinormalisasi jadi ISO string sebelum NextResponse.json — parser harus menerimanya.
      completedAt: "2026-06-01T03:00:00.000Z",
    },
    reports: { balanceSheet: { totals: {} }, profitLoss: { totals: {} }, cashFlow: { totals: {} }, ledgerSummary: [] },
    accounts: [{ accountCode: "11105", accountName: "Kas", classification: "Asset" }],
    ...overrides,
  };
}

test("parseSnapshotResponse: payload snapshot valid -> success, angka & ISO date utuh", () => {
  const result = parseSnapshotResponse<ReturnType<typeof validSnapshotPayload>>(input(200, validSnapshotPayload()));
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(result.payload.hasData, true);
  assert.equal((result.payload.syncLog as Record<string, unknown>).accountsTotal, 85);
  assert.equal((result.payload.syncLog as Record<string, unknown>).completedAt, "2026-06-01T03:00:00.000Z");
});

test("parseSnapshotResponse: snapshot kosong (hasData:false, reports null semua) -> tetap success, BUKAN error", () => {
  const payload = validSnapshotPayload({
    hasData: false,
    syncLog: null,
    reports: { balanceSheet: null, profitLoss: null, cashFlow: null, ledgerSummary: null },
    accounts: [],
  });
  const result = parseSnapshotResponse(input(200, payload));
  assert.equal(result.kind, "success");
});

test("parseSnapshotResponse: body HTML (mis. error page) -> invalid-json dengan pesan spesifik", () => {
  const result = parseSnapshotResponse(input(200, "<!DOCTYPE html><html><body>Error</body></html>", "text/html"));
  assert.equal(result.kind, "invalid-json");
  if (result.kind === "invalid-json") assert.equal(result.message, INVALID_JSON_MESSAGE);
});

test("parseSnapshotResponse: body kosong -> invalid-json", () => {
  assert.equal(parseSnapshotResponse(input(200, "")).kind, "invalid-json");
});

test("parseSnapshotResponse: JSON valid tapi field wajib hilang -> invalid-shape", () => {
  const { reports: _dropped, ...withoutReports } = validSnapshotPayload();
  const result = parseSnapshotResponse(input(200, withoutReports));
  assert.equal(result.kind, "invalid-shape");
  if (result.kind === "invalid-shape") assert.equal(result.message, INVALID_SHAPE_MESSAGE);
});

test("parseSnapshotResponse: accounts bukan array -> invalid-shape", () => {
  assert.equal(parseSnapshotResponse(input(200, validSnapshotPayload({ accounts: "85" }))).kind, "invalid-shape");
});

test("parseSnapshotResponse: HTTP 504 -> timeout, DIBEDAKAN dari payload error", () => {
  const result = parseSnapshotResponse(input(504, { status: "timeout", message: "..." }));
  assert.equal(result.kind, "timeout");
  if (result.kind === "timeout") assert.equal(result.message, TIMEOUT_MESSAGE);
});

test("parseSnapshotResponse: status 'timeout' pada body (walau HTTP 200) -> timeout", () => {
  assert.equal(parseSnapshotResponse(input(200, { status: "timeout", message: "..." })).kind, "timeout");
});

test("parseSnapshotResponse: HTTP 504 dengan body non-JSON -> tetap timeout (bukan invalid-json)", () => {
  assert.equal(parseSnapshotResponse(input(504, "Gateway Timeout", "text/plain")).kind, "timeout");
});

test("parseSnapshotResponse: status upstream-error -> api-error memakai message payload", () => {
  const result = parseSnapshotResponse(input(200, { status: "upstream-error", message: "Gagal membaca snapshot laporan keuangan. Coba lagi." }));
  assert.equal(result.kind, "api-error");
  if (result.kind === "api-error") assert.equal(result.message, "Gagal membaca snapshot laporan keuangan. Coba lagi.");
});

test("parseSnapshotResponse: 401/403 -> unauthorized sesuai mekanisme AYOSERA (bukan pesan generik)", () => {
  const unauthorized = parseSnapshotResponse(input(401, { error: "Unauthorized" }));
  assert.equal(unauthorized.kind, "unauthorized");
  if (unauthorized.kind === "unauthorized") assert.equal(unauthorized.httpStatus, 401);
  const forbidden = parseSnapshotResponse(input(403, { error: "Supervisor access required" }));
  assert.equal(forbidden.kind, "unauthorized");
  if (forbidden.kind === "unauthorized") assert.equal(forbidden.httpStatus, 403);
});

test("parseLedgerResponse: payload buku besar valid -> success", () => {
  const payload = {
    status: "success",
    period: "2026-05",
    accountCode: "11105",
    accountName: "Kas",
    data: [{ transactionDate: "2026-05-01", formattedTransactionDate: "01/05/2026", transactionNo: "J-1", description: "x", debit: 1000, credit: 0, isOpeningBalance: false }],
    total: 91,
    totalPages: 2,
    totals: { debit: 100, credit: 40, movement: 60 },
  };
  const result = parseLedgerResponse<typeof payload>(input(200, payload));
  assert.equal(result.kind, "success");
  if (result.kind === "success") assert.equal(result.payload.total, 91);
});

test("parseLedgerResponse: data bukan array -> invalid-shape", () => {
  const payload = { status: "success", period: "2026-05", accountCode: "11105", data: {}, total: 0, totalPages: 1, totals: {} };
  assert.equal(parseLedgerResponse(input(200, payload)).kind, "invalid-shape");
});

test("describeFinancialResponse: diagnostic hanya berisi metadata aman (tanpa nilai laporan)", () => {
  const diagnostics = describeFinancialResponse(input(200, validSnapshotPayload()));
  assert.equal(diagnostics.httpStatus, 200);
  assert.equal(diagnostics.contentType, JSON_TYPE);
  assert.ok(diagnostics.bodyLength > 0);
  assert.deepEqual(
    diagnostics.topLevelKeys.sort(),
    ["accounts", "hasData", "latestSyncedPeriod", "period", "reports", "status", "syncLog"].sort(),
  );
  // Tidak ada nilai payload apa pun di diagnostic — hanya nama key.
  assert.equal(JSON.stringify(diagnostics).includes("11105"), false);
});

test("describeFinancialResponse: body non-JSON -> parseErrorName terisi, topLevelKeys kosong", () => {
  const diagnostics = describeFinancialResponse(input(200, "<html></html>", "text/html"));
  assert.equal(diagnostics.topLevelKeys.length, 0);
  assert.equal(typeof diagnostics.parseErrorName, "string");
});
