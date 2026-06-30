export const CANCELLED_STATUS_MARKERS = [
  "cancelled",
  "canceled",
  "dibatalkan",
  "batal",
  "void",
  "refund",
  "refunded",
] as const;

export const CANCELLED_STATUS_PATTERN_SOURCE = CANCELLED_STATUS_MARKERS.join("|");

type RevenueTransaction = {
  status?: unknown;
  payment?: unknown;
  status_label?: unknown;
  source_status?: unknown;
  payment_status?: unknown;
  raw?: unknown;
  total_price?: unknown;
  totalPrice?: unknown;
  amountValue?: unknown;
};

const STATUS_FIELD_KEYS = new Set([
  "status",
  "payment",
  "statuslabel",
  "sourcestatus",
  "paymentstatus",
]);

const CANCELLED_STATUS_PATTERN = new RegExp(CANCELLED_STATUS_PATTERN_SOURCE, "i");

/**
 * Menentukan pembatalan dari status normalisasi maupun status mentah provider.
 * Hanya field status/payment yang diperiksa agar teks bebas seperti catatan tidak
 * salah mengubah transaksi menjadi cancelled.
 */
export function isCancelledTransaction(transaction: RevenueTransaction | null | undefined) {
  if (!transaction || typeof transaction !== "object") return false;

  const values: string[] = [];
  collectStatusValues(transaction, values, new Set<object>());
  return values.some((value) => CANCELLED_STATUS_PATTERN.test(value));
}

export function isRevenueEligibleTransaction(transaction: RevenueTransaction | null | undefined) {
  return Boolean(transaction) && !isCancelledTransaction(transaction);
}

/** Nominal asli tidak diubah; cancelled hanya menghasilkan revenue 0. */
export function getRevenueAmount(transaction: RevenueTransaction | null | undefined) {
  if (!isRevenueEligibleTransaction(transaction)) return 0;

  const amount = firstFiniteNumber(
    transaction?.total_price,
    transaction?.totalPrice,
    transaction?.amountValue,
  );
  return amount ?? 0;
}

export function sumRevenue(transactions: Iterable<RevenueTransaction>) {
  let total = 0;
  for (const transaction of transactions) total += getRevenueAmount(transaction);
  return total;
}

function collectStatusValues(value: unknown, result: string[], seen: Set<object>) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (const item of value) collectStatusValues(item, result, seen);
    return;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (STATUS_FIELD_KEYS.has(normalizedKey)) collectPrimitiveValues(nestedValue, result, new Set<object>());

    // Status provider dapat berada pada object raw/nested seperti payment.status.
    if (nestedValue && typeof nestedValue === "object") {
      collectStatusValues(nestedValue, result, seen);
    }
  }
}

function collectPrimitiveValues(value: unknown, result: string[], seen: Set<object>) {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") {
    result.push(String(value));
    return;
  }
  if (seen.has(value as object)) return;
  seen.add(value as object);

  const nestedValues = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const nestedValue of nestedValues) collectPrimitiveValues(nestedValue, result, seen);
}

function firstFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
