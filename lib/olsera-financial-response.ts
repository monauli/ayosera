// Parser response client untuk UI Laporan Keuangan (components/olsera-financial-panel.tsx).
// Murni & tanpa dependensi Next/React supaya bisa diuji dengan node:test.
//
// Membedakan lima kelas kegagalan yang sebelumnya menyatu jadi satu pesan generik:
// auth (401/403), timeout database (HTTP 504 / status "timeout"), body bukan JSON,
// JSON valid tapi shape tidak sesuai kontrak, dan error API eksplisit (status !== "success").
// Snapshot kosong (hasData: false) BUKAN error — tetap "success" dan UI merender empty state.

export type FinancialParseResult<T> =
  | { kind: "success"; payload: T }
  | { kind: "unauthorized"; httpStatus: 401 | 403; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "invalid-json"; message: string }
  | { kind: "invalid-shape"; message: string }
  | { kind: "api-error"; message: string };

/**
 * Diagnostic AMAN untuk console: hanya status HTTP, content-type, panjang body,
 * dan nama key top-level. TIDAK PERNAH berisi nilai laporan/token/URI/cookie.
 */
export type FinancialResponseDiagnostics = {
  httpStatus: number;
  contentType: string | null;
  bodyLength: number;
  topLevelKeys: string[];
  parseErrorName: string | null;
};

export type FinancialResponseInput = {
  httpStatus: number;
  contentType: string | null;
  bodyText: string;
};

export const TIMEOUT_MESSAGE = "Koneksi database sementara bermasalah. Coba lagi.";
export const INVALID_JSON_MESSAGE = "Respons laporan keuangan tidak valid.";
export const INVALID_SHAPE_MESSAGE = "Format snapshot laporan keuangan tidak sesuai.";

const SNAPSHOT_REQUIRED_KEYS = ["status", "period", "latestSyncedPeriod", "hasData", "syncLog", "reports", "accounts"] as const;
const LEDGER_REQUIRED_KEYS = ["status", "period", "accountCode", "data", "total", "totalPages", "totals"] as const;

function tryParseJson(input: FinancialResponseInput): { payload: Record<string, unknown> | null; errorName: string | null } {
  try {
    const parsed: unknown = JSON.parse(input.bodyText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { payload: null, errorName: "NotAnObject" };
    return { payload: parsed as Record<string, unknown>, errorName: null };
  } catch (error) {
    return { payload: null, errorName: error instanceof Error ? error.name : "UnknownParseError" };
  }
}

export function describeFinancialResponse(input: FinancialResponseInput): FinancialResponseDiagnostics {
  const { payload, errorName } = tryParseJson(input);
  return {
    httpStatus: input.httpStatus,
    contentType: input.contentType,
    bodyLength: input.bodyText.length,
    topLevelKeys: payload ? Object.keys(payload) : [],
    parseErrorName: errorName,
  };
}

function parseFinancialResponse<T>(
  input: FinancialResponseInput,
  requiredKeys: readonly string[],
  validateShape: (payload: Record<string, unknown>) => boolean,
): FinancialParseResult<T> {
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return { kind: "unauthorized", httpStatus: input.httpStatus, message: input.httpStatus === 401 ? "Sesi berakhir." : "Anda tidak memiliki izin untuk modul ini." };
  }

  const { payload } = tryParseJson(input);

  // 504 diprioritaskan sebelum shape check — body 504 memang bukan payload snapshot.
  if (input.httpStatus === 504 || payload?.status === "timeout") {
    return { kind: "timeout", message: TIMEOUT_MESSAGE };
  }
  if (!payload) return { kind: "invalid-json", message: INVALID_JSON_MESSAGE };
  if (typeof payload.status !== "string") return { kind: "invalid-shape", message: INVALID_SHAPE_MESSAGE };
  if (payload.status !== "success") {
    return { kind: "api-error", message: typeof payload.message === "string" && payload.message ? payload.message : "Gagal memuat data laporan keuangan." };
  }
  if (!requiredKeys.every((key) => key in payload) || !validateShape(payload)) {
    return { kind: "invalid-shape", message: INVALID_SHAPE_MESSAGE };
  }
  return { kind: "success", payload: payload as T };
}

/** Parser response GET /api/olsera/financial/snapshot. */
export function parseSnapshotResponse<T>(input: FinancialResponseInput): FinancialParseResult<T> {
  return parseFinancialResponse<T>(
    input,
    SNAPSHOT_REQUIRED_KEYS,
    (payload) =>
      typeof payload.hasData === "boolean" &&
      typeof payload.reports === "object" &&
      payload.reports !== null &&
      Array.isArray(payload.accounts),
  );
}

/** Parser response GET /api/olsera/financial/snapshot/ledger. */
export function parseLedgerResponse<T>(input: FinancialResponseInput): FinancialParseResult<T> {
  return parseFinancialResponse<T>(
    input,
    LEDGER_REQUIRED_KEYS,
    (payload) => Array.isArray(payload.data) && typeof payload.total === "number" && typeof payload.totals === "object" && payload.totals !== null,
  );
}
