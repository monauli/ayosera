// Client tipis untuk Olsera Open API (https://api-open.olsera.co.id).
// Murni pass-through/read-only: tidak menulis apa pun ke MongoDB.

const BASE_URL = "https://api-open.olsera.co.id";

type OlseraTokenCache = {
  accessToken: string;
  // Epoch ms kapan token dianggap kedaluwarsa (dengan margin aman).
  expiresAt: number;
};

let tokenCache: OlseraTokenCache | null = null;

export type OlseraSalesCategory = {
  kategori: string;
  totalPenjualan: number;
};

export type OlseraSalesResult =
  | { ok: true; data: OlseraSalesCategory[] }
  | { ok: false; error: string };

async function getAccessToken(): Promise<{ token: string } | { error: string }> {
  const appId = process.env.OLSERA_APP_ID;
  const secretKey = process.env.OLSERA_SECRET_KEY;
  if (!appId || !secretKey) {
    return { error: "Kredensial Olsera belum dikonfigurasi (OLSERA_APP_ID / OLSERA_SECRET_KEY)." };
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return { token: tokenCache.accessToken };
  }

  const form = new FormData();
  form.append("app_id", appId);
  form.append("secret_key", secretKey);
  form.append("grant_type", "secret_key");

  let response: globalThis.Response;
  try {
    response = await fetch(`${BASE_URL}/api/open-api/v1/id/token`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: form,
      cache: "no-store",
    });
  } catch {
    return { error: "Tidak dapat terhubung ke server Olsera (autentikasi gagal karena jaringan)." };
  }

  if (!response.ok) {
    return { error: `Autentikasi Olsera gagal (HTTP ${response.status}). Periksa kredensial.` };
  }

  let body: { access_token?: string; expires_in?: number };
  try {
    body = (await response.json()) as { access_token?: string; expires_in?: number };
  } catch {
    return { error: "Respons autentikasi Olsera bukan JSON yang valid." };
  }

  if (!body.access_token) {
    return { error: "Respons autentikasi Olsera tidak berisi access token." };
  }

  // Kurangi 60 detik sebagai margin agar token tidak dipakai tepat di detik kedaluwarsa.
  const ttlSeconds = typeof body.expires_in === "number" && body.expires_in > 120 ? body.expires_in : 3600;
  tokenCache = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (ttlSeconds - 60) * 1000,
  };

  return { token: body.access_token };
}

// Nilai dari Olsera memakai format Indonesia: "173.000" = 173000 (titik = ribuan),
// dan bila ada desimal memakai koma. parseFloat langsung akan salah baca.
export function parseOlseraAmount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getSalesItemsPerGroup(from: string, to: string): Promise<OlseraSalesResult> {
  const auth = await getAccessToken();
  if ("error" in auth) return { ok: false, error: auth.error };

  const url = new URL(`${BASE_URL}/api/open-api/v1/en/report/salesitemspergroup`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);

  let response: globalThis.Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "Tidak dapat terhubung ke server Olsera. Coba lagi beberapa saat." };
  }

  if (response.status === 401) {
    // Token ditolak — buang cache supaya request berikutnya autentikasi ulang.
    tokenCache = null;
    return { ok: false, error: "Token Olsera tidak valid/kedaluwarsa. Muat ulang halaman untuk mencoba lagi." };
  }

  if (response.status === 404) {
    // Konsisten dengan perilaku endpoint order Olsera: 404 berarti tidak ada data pada rentang itu.
    return { ok: true, data: [] };
  }

  if (!response.ok) {
    return { ok: false, error: `Olsera mengembalikan HTTP ${response.status}.` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "Respons Olsera bukan JSON yang valid." };
  }

  const list = extractCategoryList(body);
  if (!list) {
    return { ok: false, error: "Struktur respons Olsera tidak dikenali." };
  }

  const data = list.map((item) => ({
    kategori: typeof item.label === "string" && item.label ? item.label : "(tanpa kategori)",
    totalPenjualan: parseOlseraAmount(item.value),
  }));

  return { ok: true, data };
}

type RawCategoryItem = { label?: unknown; value?: unknown };

function extractCategoryList(body: unknown): RawCategoryItem[] | null {
  if (Array.isArray(body)) return body as RawCategoryItem[];
  if (body && typeof body === "object") {
    const data = (body as Record<string, unknown>).data;
    if (Array.isArray(data)) return data as RawCategoryItem[];
  }
  return null;
}
