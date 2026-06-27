import crypto from "crypto";
import http from "http";
import https from "https";

export type AyoBookingPayload = {
  token?: string;
  signature?: string;
  booking_id?: string;
  field_name?: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  booking_source?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  limit?: number;
};

export type AyoReservationPayload = {
  booking_id?: string;
  field_id: number;
  date: string;
  start_time: string;
  end_time: string;
  total_price: number;
  user?: {
    name?: string;
    email?: string;
    phone?: string;
  };
};

type AyoResponse<T> = {
  error: boolean;
  status_code: number;
  data: T;
  message?: string;
  signature?: string;
};

export const DEFAULT_LIST_BOOKINGS_LIMIT = 100;
const PRODUCTION_HOST = "api.ayo.co.id";
const PRODUCTION_PATH_PREFIX = "/api/v2/third-party";

function getConfig() {
  const baseUrl = normalizeProductionBaseUrl(
    process.env.AYO_BASE_URL || `https://${PRODUCTION_HOST}${PRODUCTION_PATH_PREFIX}`,
  );
  const venueCode = process.env.AYO_VENUE_CODE;
  const token = process.env.AYO_API_TOKEN;
  const privateKey = process.env.AYO_PRIVATE_KEY;

  if (!venueCode || !token || !privateKey) {
    throw new Error("AYO credentials are not configured.");
  }

  return { baseUrl, venueCode, token, privateKey };
}

function normalizeProductionBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== PRODUCTION_HOST ||
    !url.pathname.startsWith(PRODUCTION_PATH_PREFIX)
  ) {
    throw new Error("Only the AYO production API endpoint is allowed.");
  }

  return value.replace(/\/+$/, "");
}

function toQueryValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

export function createAyoSignature(payload: Record<string, unknown>, privateKey: string) {
  const query = Object.keys(payload)
    .filter((key) => key !== "signature" && payload[key] !== undefined && payload[key] !== null && payload[key] !== "")
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(toQueryValue(payload[key])).replace(/%20/g, "+")}`)
    .join("&");

  return crypto.createHmac("sha512", privateKey).update(query).digest("hex");
}

export function signAyoPayload<T extends Record<string, unknown>>(payload: T) {
  const { token, privateKey } = getConfig();
  const body = { token, ...payload };
  return {
    ...body,
    signature: createAyoSignature(body, privateKey),
  };
}

async function requestJsonWithBody<T>(url: string, method: "GET" | "POST", body: Record<string, unknown>) {
  const payload = JSON.stringify(body);

  if (method === "POST") {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: payload,
      cache: "no-store",
    });

    return {
      ok: response.ok,
      status: response.status,
      json: (await response.json()) as T,
    };
  }

  return new Promise<{ ok: boolean; status: number; json: T }>((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      target,
      {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const status = response.statusCode || 500;
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: JSON.parse(raw || "{}") as T,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

async function ayoRequest<T>(
  path: string,
  body: Record<string, unknown>,
  method: "GET" | "POST" = "POST"
) {
  const { baseUrl } = getConfig();

  const url = `${baseUrl}${path}`;
  const signedBody = signAyoPayload(body);

  const response = await requestJsonWithBody<AyoResponse<T>>(
    url,
    method,
    signedBody
  );
  const payload = response.json;
  if (!response.ok || payload.error) {
    throw new Error(payload.message || `AYO API request failed with status ${response.status}`);
  }

  return payload;
}

export async function fetchAyoBookings(filters: AyoBookingPayload = {}) {
  const { venueCode } = getConfig();
  return ayoRequest<Record<string, unknown>[]>(
    `/list-bookings/${venueCode}`,
    sanitizeListBookingFilters(filters),
    "GET",
  );
}

export async function fetchAyoBookingsByDateRange(filters: AyoBookingPayload = {}) {
  if (!filters.start_date && !filters.end_date) {
    return fetchAyoBookings(filters);
  }

  const startDate = filters.start_date || filters.end_date;
  const endDate = filters.end_date || filters.start_date;

  if (!startDate || !endDate) {
    return fetchAyoBookings(filters);
  }

  if (startDate > endDate) {
    throw new Error("start_date must be before or equal to end_date");
  }

  const dates = listDateRange(startDate, endDate);
  const { start_date: _startDate, end_date: _endDate, ...dailyFilters } = filters;
  const merged = new Map<string, Record<string, unknown>>();
  let lastResponse: Awaited<ReturnType<typeof fetchAyoBookings>> | null = null;

  for (const date of dates) {
    const response = await fetchAyoBookings({ ...dailyFilters, date });
    lastResponse = response;
    console.log("AYO DAILY RESPONSE:", date, response.data.length);

    for (const booking of response.data) {
      merged.set(getBookingKey(booking), booking);
    }
  }

  return {
    ...(lastResponse ?? {
      error: false,
      status_code: 200,
      message: "No dates to sync",
      data: [],
    }),
    data: Array.from(merged.values()),
  };
}

export async function fetchAyoFields() {
  return ayoRequest<Record<string, unknown>[]>("/list-fields", {}, "GET");
}

export async function createAyoReservation(payload: AyoReservationPayload) {
  return ayoRequest<Record<string, unknown>>("/create-reservation", payload, "POST");
}

export async function cancelAyoReservation(orderDetailId: number) {
  return ayoRequest<Record<string, unknown>>("/cancel-reservation", { order_detail_id: orderDetailId }, "POST");
}

function listDateRange(startDate: string, endDate: string) {
  const dates: string[] = [];
  const cursor = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  const maxDays = Number(process.env.AYO_SYNC_MAX_DAYS || 62);

  while (cursor <= end) {
    if (dates.length >= maxDays) {
      throw new Error(`Date range is too large. Max ${maxDays} days per sync.`);
    }

    dates.push(formatDateOnly(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function sanitizeListBookingFilters(filters: AyoBookingPayload) {
  return {
    ...(filters.booking_id ? { booking_id: filters.booking_id } : {}),
    ...(filters.field_name ? { field_name: filters.field_name } : {}),
    ...(filters.date ? { date: filters.date } : {}),
    ...(filters.start_time ? { start_time: filters.start_time } : {}),
    ...(filters.end_time ? { end_time: filters.end_time } : {}),
    ...(filters.booking_source ? { booking_source: filters.booking_source } : {}),
    ...(filters.start_date ? { start_date: filters.start_date } : {}),
    ...(filters.end_date ? { end_date: filters.end_date } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    limit: normalizeLimit(filters.limit),
  };
}

function normalizeLimit(value: number | undefined) {
  if (!value) return DEFAULT_LIST_BOOKINGS_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIST_BOOKINGS_LIMIT;
  return Math.floor(value);
}

function parseDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function getBookingKey(booking: Record<string, unknown>) {
  return String(booking.booking_id || booking.order_detail_id || JSON.stringify(booking));
}
