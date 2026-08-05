import { isRevenueEligibleTransaction } from "./revenue.ts";

const ENDPOINT = "https://api-new.ayo.co.id/api/v2/venue_booking/path";
const DEFAULT_LIMIT = 100;
const MAX_PAGES = 200;
const REQUEST_TIMEOUT_MS = 20_000;

export type AyoPaymentEvent = {
  _id: string;
  /** Deterministic primary/fallback payment identity; never booking_id alone. */
  identity: string;
  bookingId: string;
  sourceTable: string;
  reservationPaymentId: string | null;
  nativeId: string;
  sourceId: string | null;
  /** Payment transaction timestamp; `date` remains legacy booking-date compatibility. */
  eventDate: Date;
  eventDateSource: string;
  /** Integer Rupiah selected from one source field, never a summed payment breakdown. */
  amount: number;
  amountSource: string;
  bookingPrefix: "BK" | "MN" | "OTHER" | null;
  paymentStatus: string | null;
  bookingStatus: string | null;
  source: "ayo-report-transactions";
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  paymentType: string | null;
  paymentNote: string | null;
  detailStatus: string | null;
  finalStatus: string | null;
  fieldName: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  total: number;
  finalFeeAyo: number;
  isCredit: boolean;
  raw: Record<string, unknown>;
  syncedAt: Date;
};

export type AyoPaymentPeriodMetadata = {
  _id: string;
  startDate: string;
  endDate: string;
  fetchedRows: number;
  expectedTotalTransaction: number;
  calculatedTotal: number;
  expectedTotal: number;
  validationStatus: "validated" | "invalid" | "token-invalid" | "error";
  lastSuccessfulSyncAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  conflictCount: number;
  updatedAt: Date;
};

export class AyoPaymentEventsError extends Error {
  readonly code: "TOKEN_INVALID" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | "PAGINATION_GUARD";
  constructor(code: "TOKEN_INVALID" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | "PAGINATION_GUARD", message: string) {
    super(message);
    this.code = code;
    this.name = "AyoPaymentEventsError";
  }
}

type ReportResponse = { data?: { transactions?: unknown[]; total?: unknown; total_transaction?: unknown } };
type Requester = (url: string, init: RequestInit) => Promise<Response>;

function mobileToken() {
  const token = process.env.AYO_MOBILE_TOKEN?.trim();
  if (!token) throw new AyoPaymentEventsError("TOKEN_INVALID", "AYO_MOBILE_TOKEN belum dikonfigurasi.");
  return token;
}

export function paymentEventIdentity(row: Record<string, unknown>): string | null {
  const source = String(row.source_table ?? "").trim();
  const booking = String(row.booking_id ?? "").trim();
  const reservation = String(row.reservation_payment_id ?? "").trim();
  const nativeId = String(row.id ?? "").trim();
  if (!source || !booking) return null;
  if (reservation) return `${source}:${booking}:${reservation}`;
  return nativeId ? `${source}:${booking}:id:${nativeId}` : null;
}

export function normalizeAyoPaymentEvent(row: Record<string, unknown>, syncedAt = new Date()): AyoPaymentEvent {
  const identity = paymentEventIdentity(row);
  if (!identity) throw new AyoPaymentEventsError("INVALID_RESPONSE", "Payment event tidak memiliki source_table dan identity native.");
  const number = (value: unknown) => {
    const result = typeof value === "number" ? value : Number(value ?? 0);
    return Number.isFinite(result) ? result : 0;
  };
  const text = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
  const integer = (value: unknown) => {
    const result = number(value);
    return Number.isSafeInteger(result) ? result : 0;
  };
  // `final_fee_ayo` is retained first for compatibility with the previously
  // validated report totals. It is a single payment amount, not a component to
  // add to total_price/total. The remaining fallbacks are audited API fields.
  const amountCandidates: Array<[string, unknown]> = [["final_fee_ayo", row.final_fee_ayo], ["total_price", row.total_price], ["total", row.total]];
  const [amountSource, amountValue] = amountCandidates.find(([, value]) => integer(value) !== 0) ?? ["total", row.total];
  const eventDateCandidates: Array<[string, unknown]> = [["payment_date", row.payment_date], ["transaction_date", row.transaction_date], ["created_at", row.created_at], ["date", row.date]];
  const eventDateMatch = eventDateCandidates.find(([, value]) => !Number.isNaN(Date.parse(String(value ?? ""))));
  const eventDateSource = eventDateMatch?.[0] ?? "fallback-synced-at";
  const eventDate = eventDateMatch ? new Date(String(eventDateMatch[1])) : syncedAt;
  const bookingId = String(row.booking_id ?? "").trim();
  const paymentStatus = text(row.final_status ?? row.payment_status ?? row.detail_status);
  const bookingStatus = text(row.booking_status ?? row.status);
  return {
    _id: identity,
    identity,
    bookingId,
    sourceTable: String(row.source_table).trim(),
    reservationPaymentId: text(row.reservation_payment_id),
    nativeId: String(row.id ?? "").trim(),
    sourceId: text(row.id),
    eventDate,
    eventDateSource,
    amount: integer(amountValue),
    amountSource,
    bookingPrefix: bookingId.startsWith("BK") ? "BK" : bookingId.startsWith("MN") ? "MN" : bookingId ? "OTHER" : null,
    paymentStatus,
    bookingStatus,
    source: "ayo-report-transactions",
    rawPayload: { ...row },
    normalizedPayload: { identity, bookingId, sourceTable: String(row.source_table).trim(), reservationPaymentId: text(row.reservation_payment_id), sourceId: text(row.id), eventDate: eventDate.toISOString(), eventDateSource, amount: integer(amountValue), amountSource, paymentStatus, bookingStatus },
    createdAt: syncedAt,
    updatedAt: syncedAt,
    paymentType: text(row.payment_type),
    paymentNote: text(row.payment_note),
    detailStatus: text(row.detail_status),
    finalStatus: text(row.final_status),
    fieldName: String(row.field_name ?? ""),
    date: String(row.date ?? ""),
    startTime: text(row.start_time),
    endTime: text(row.end_time),
    total: number(row.total),
    finalFeeAyo: number(row.final_fee_ayo),
    isCredit: Boolean(row.is_credit),
    raw: { ...row },
    syncedAt,
  };
}

export function paymentEventRevenue(event: Pick<AyoPaymentEvent, "total" | "finalFeeAyo" | "finalStatus" | "detailStatus" | "isCredit"> & Partial<Pick<AyoPaymentEvent, "amount">>) {
  const candidate = { total: event.amount !== undefined ? event.amount : (event.finalFeeAyo || event.total), status: event.finalStatus, detail_status: event.detailStatus, is_credit: event.isCredit };
  return isRevenueEligibleTransaction(candidate) ? Number(candidate.total) : 0;
}

export function validatePaymentPeriod(input: {
  startDate: string; endDate: string; events: readonly AyoPaymentEvent[]; expectedTotalTransaction: number; expectedTotal: number; conflictCount: number;
}): { status: AyoPaymentPeriodMetadata["validationStatus"]; calculatedTotal: number; reason: string | null } {
  const calculatedTotal = input.events.reduce((sum, event) => sum + paymentEventRevenue(event), 0);
  if (input.conflictCount > 0) return { status: "invalid", calculatedTotal, reason: "identity-conflict" };
  if (input.events.length !== input.expectedTotalTransaction) return { status: "invalid", calculatedTotal, reason: "row-count-mismatch" };
  if (calculatedTotal !== input.expectedTotal) return { status: "invalid", calculatedTotal, reason: "total-mismatch" };
  return { status: "validated", calculatedTotal, reason: null };
}

export async function fetchAyoPaymentEvents(startDate: string, endDate: string, options: { limit?: number; request?: Requester } = {}) {
  const token = mobileToken();
  const request = options.request ?? fetch;
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const events: AyoPaymentEvent[] = [];
  let startFrom = 0;
  let expectedTotal = 0;
  let expectedRows = 0;
  const seenOffsets = new Set<number>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (seenOffsets.has(startFrom)) throw new AyoPaymentEventsError("PAGINATION_GUARD", "Pagination AYO mengulang offset.");
    seenOffsets.add(startFrom);
    const params = new URLSearchParams({ url_path: "home/2428/report-transactions", mobile_token: token, start_from: String(startFrom), limit: String(limit), is_include_total_transaction: "true", start_date: startDate, end_date: endDate });
    for (const sport of ["12", "15"]) params.append("sport_ids[]", sport);
    for (const type of ["via_ayo", "payment_link", "manual"]) params.append("type_transactions[]", type);
    let response: Response;
    try {
      response = await request(`${ENDPOINT}?${params}`, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
    } catch (error) {
      if (error instanceof AyoPaymentEventsError) throw error;
      try { response = await request(`${ENDPOINT}?${params}`, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" }); }
      catch { throw new AyoPaymentEventsError("TIMEOUT", "AYO report-transactions gagal diakses."); }
    }
    if (response.status === 401 || response.status === 403) throw new AyoPaymentEventsError("TOKEN_INVALID", "Token AYO invalid atau expired.");
    if (!response.ok) throw new AyoPaymentEventsError("HTTP_ERROR", `AYO report-transactions gagal (${response.status}).`);
    let payload: ReportResponse;
    try { payload = (await response.json()) as ReportResponse; } catch { throw new AyoPaymentEventsError("INVALID_RESPONSE", "Response AYO bukan JSON valid."); }
    const rows = payload.data?.transactions;
    if (!Array.isArray(rows)) throw new AyoPaymentEventsError("INVALID_RESPONSE", "Response AYO tidak memiliki transactions.");
    expectedRows = Number(payload.data?.total_transaction ?? expectedRows);
    expectedTotal = Number(payload.data?.total ?? expectedTotal);
    for (const row of rows) if (row && typeof row === "object") events.push(normalizeAyoPaymentEvent(row as Record<string, unknown>));
    if (events.length >= expectedRows) break;
    if (rows.length === 0 || rows.length >= limit === false) throw new AyoPaymentEventsError("PAGINATION_GUARD", "Pagination AYO berhenti sebelum total tercapai.");
    startFrom += rows.length;
  }
  if (events.length !== expectedRows) throw new AyoPaymentEventsError("PAGINATION_GUARD", "Pagination AYO tidak mencapai total transaksi.");
  return { events, expectedTotalTransaction: expectedRows, expectedTotal };
}
