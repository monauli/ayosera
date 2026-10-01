export type RacketAddonImportRow = {
  bookingId: string;
  date: string;
  amount: number;
  paymentId: string;
};

export type RacketAddonImportResult = {
  rows: RacketAddonImportRow[];
  addonCount: number;
  totalAmount: number;
  periods: string[];
  headerFound: boolean;
};

function text(value: unknown): string {
  if (value && typeof value === "object") {
    const candidate = value as { result?: unknown; text?: unknown };
    if (candidate.result !== undefined) return text(candidate.result);
    if (candidate.text !== undefined) return text(candidate.text);
  }
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function headerKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseAmount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : 0;
  const raw = text(value).trim().replace(/[^\d,.-]/g, "");
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.includes(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,(?=\d{3}(?:\D|$))/g, "")
    : raw.replace(/\.(?=\d{3}(?:\D|$))/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function parseDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = text(value).trim();
  const iso = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  return "";
}

/** Parse the raw rows produced by ExcelJS without assuming fixed column positions. */
export function parseRacketAddonRows(input: readonly (readonly unknown[])[]): RacketAddonImportResult {
  const headerIndex = input.findIndex((row) => {
    const keys = row.map(headerKey);
    return keys.includes("bookingid") && keys.includes("sewaraketaddon");
  });
  if (headerIndex < 0) return { rows: [], addonCount: 0, totalAmount: 0, periods: [], headerFound: false };

  const header = input[headerIndex].map(headerKey);
  const bookingColumn = header.indexOf("bookingid");
  const addonColumn = header.indexOf("sewaraketaddon");
  const dateColumn = header.findIndex((key) => key === "dateofbooking" || key === "bookingdate");
  const paymentColumn = header.findIndex((key) => key === "paymentid");
  const byBooking = new Map<string, RacketAddonImportRow>();

  for (const row of input.slice(headerIndex + 1)) {
    const bookingId = text(row[bookingColumn]).trim();
    if (!bookingId || bookingId.toLowerCase() === "booking id") continue;
    byBooking.set(bookingId, {
      bookingId,
      date: dateColumn >= 0 ? parseDate(row[dateColumn]) : "",
      amount: parseAmount(row[addonColumn]),
      paymentId: paymentColumn >= 0 ? text(row[paymentColumn]).trim() : "",
    });
  }

  const rows = [...byBooking.values()];
  const positive = rows.filter((row) => row.amount > 0);
  return {
    rows,
    addonCount: positive.length,
    totalAmount: positive.reduce((total, row) => total + row.amount, 0),
    periods: [...new Set(positive.map((row) => row.date.slice(0, 7)).filter(Boolean))].sort(),
    headerFound: true,
  };
}
