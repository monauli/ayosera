import "server-only";
import type { SessionUser } from "@/lib/auth";

export type TokenHealthStatus = "AKTIF" | "AKAN_KEDALUWARSA" | "KEDALUWARSA" | "UNAUTHORIZED" | "TIDAK_DIKONFIGURASI" | "TEMPORARY" | "MANUAL_IMPORT_REQUIRED";
export type TokenHealth = { source: "ayo-mobile" | "olsera-bearer"; label: string; status: TokenHealthStatus; expiresAt: string | null; remainingDays: number | null; checkedAt: string; lastSuccessfulUse: string | null; lastError: string | null; lastValidSource: string | null };

/**
 * @deprecated Akses Monitoring Integritas Data sekarang memakai modul "audit"
 * biasa (lihat requireModule("audit") di app/api/private/integration-monitor/route.ts
 * dan APP_MODULES di lib/auth.ts), dicentang/dicabut lewat menu Pengguna —
 * BUKAN lagi lewat env AYOSERA_PRIVATE_TOOLS_USER_IDS. Fungsi ini dipertahankan
 * hanya untuk kompatibilitas mundur dan tidak lagi dipanggil oleh route manapun.
 */
export function privateToolsAllowlist(value = process.env.AYOSERA_PRIVATE_TOOLS_USER_IDS ?? "") {
  return new Set(value.split(",").map((id) => id.trim()).filter(Boolean));
}

/** @deprecated lihat catatan pada privateToolsAllowlist di atas. */
export function isPrivateToolsUser(user: Pick<SessionUser, "id">, allowlist = privateToolsAllowlist()) {
  return allowlist.size > 0 && allowlist.has(user.id);
}

function jwtExpiry(value: string): Date | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    const seconds = Number(payload.exp);
    return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
  } catch { return null; }
}

/** Threshold terpusat untuk AKAN_KEDALUWARSA — satu tempat, tidak tersebar/hardcode di banyak lokasi. */
export const OLSERA_TOKEN_EXPIRING_SOON_DAYS = 7;

export function classifyTokenHealth(source: TokenHealth["source"], token: string | undefined, now = new Date(), lastSuccessfulUse: Date | null = null, lastError: string | null = null): TokenHealth {
  const label = source === "ayo-mobile" ? "AYO Mobile Token" : "Olsera Bearer Token";
  const configured = token?.trim();
  if (!configured) return { source, label, status: "TIDAK_DIKONFIGURASI", expiresAt: null, remainingDays: null, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: null, lastValidSource: lastSuccessfulUse ? "Penggunaan API terakhir" : null };
  if (/unauthorized|401/i.test(lastError ?? "")) return { source, label, status: "UNAUTHORIZED", expiresAt: null, remainingDays: null, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: "Unauthorized", lastValidSource: lastSuccessfulUse ? "Penggunaan API terakhir" : null };
  const expiry = jwtExpiry(configured);
  if (!expiry) return { source, label, status: "MANUAL_IMPORT_REQUIRED", expiresAt: null, remainingDays: null, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: lastError ? "Pemeriksaan token terakhir gagal." : null, lastValidSource: lastSuccessfulUse ? "Penggunaan API terakhir" : "Expiry tidak diketahui" };
  const remainingDays = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
  const status: TokenHealthStatus = remainingDays <= 0 ? "KEDALUWARSA" : remainingDays <= OLSERA_TOKEN_EXPIRING_SOON_DAYS ? "AKAN_KEDALUWARSA" : "AKTIF";
  return { source, label, status, expiresAt: expiry.toISOString(), remainingDays, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: null, lastValidSource: "JWT expiry" };
}

export function integrationTokenHealth(now = new Date()): TokenHealth[] {
  return [classifyTokenHealth("ayo-mobile", process.env.AYO_MOBILE_TOKEN, now), classifyTokenHealth("olsera-bearer", process.env.OLSERA_INTERNAL_TOKEN, now)];
}

// --- Status AYO Mobile Token (dedicated) ---------------------------------
//
// AYO_MOBILE_TOKEN diaudit (lib/ayo-payment-events.ts: mobileToken()) dan
// hasilnya BUKAN JWT — token opaque hasil ekstraksi manual dari sesi AYO
// Mobile (tidak ada flow refresh/import otomatis di codebase ini; tidak ada
// endpoint AYO yang mengeluarkan token ini secara resmi dengan expiry). Tidak
// ada klaim `exp`/`iat`, tidak ada metadata masa berlaku resmi, dan tidak ada
// `importedAt` yang disimpan di mana pun — classifyTokenHealth lama SALAH
// mengklasifikasikannya sebagai MANUAL_IMPORT_REQUIRED hanya karena gagal
// didekode sebagai JWT, padahal token BISA saja masih aktif & terpakai.
// Model di bawah ini TIDAK PERNAH menebak tanggal expiry untuk token opaque —
// EXPIRY_UNKNOWN adalah representasi jujur dari "tidak ada bukti", bukan error.
export type AyoTokenStatus = "ACTIVE" | "EXPIRING_SOON" | "EXPIRED" | "EXPIRY_UNKNOWN" | "MANUAL_IMPORT_REQUIRED" | "INVALID" | "UNAVAILABLE";

export const AYO_TOKEN_STATUS_LABEL: Record<AyoTokenStatus, string> = {
  ACTIVE: "Aktif",
  EXPIRING_SOON: "Akan Kedaluwarsa",
  EXPIRED: "Kedaluwarsa",
  EXPIRY_UNKNOWN: "Expiry Tidak Diketahui",
  MANUAL_IMPORT_REQUIRED: "Perlu Import Manual",
  INVALID: "Token Tidak Valid",
  UNAVAILABLE: "Tidak Tersedia",
};

const AYO_TOKEN_RECOMMENDATION: Record<AyoTokenStatus, string> = {
  ACTIVE: "Token aktif, tidak ada tindakan diperlukan.",
  EXPIRING_SOON: "Segera perbarui token sebelum kedaluwarsa.",
  EXPIRED: "Token sudah kedaluwarsa — perbarui segera untuk memulihkan sinkronisasi.",
  EXPIRY_UNKNOWN: "Token tersedia, tetapi sumber AYO tidak menyediakan metadata kedaluwarsa yang dapat diverifikasi.",
  MANUAL_IMPORT_REQUIRED: "Token AYO belum tersedia atau perlu diperbarui secara manual.",
  INVALID: "Token ditolak AYO atau formatnya rusak — perbarui token.",
  UNAVAILABLE: "Pemeriksaan gagal karena jaringan/backend, bukan karena token. Coba lagi nanti.",
};

/** Threshold terpusat untuk EXPIRING_SOON — satu tempat, tidak tersebar/hardcode di banyak lokasi. */
export const AYO_TOKEN_EXPIRING_SOON_DAYS = 7;

export type AyoMobileTokenHealth = {
  status: AyoTokenStatus;
  label: string;
  expiresAt: string | null;
  expirySource: "jwt" | "unknown";
  remainingDays: number | null;
  /** Tidak ada sumber yang melacak ini untuk token opaque — selalu null, tidak pernah ditebak. */
  importedAt: string | null;
  lastSuccessfulCheck: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  checkedAt: string;
  recommendation: string;
};

/**
 * Klasifikasi AYO Mobile Token berdasarkan bukti nyata saja:
 * 1. Tidak ada token → MANUAL_IMPORT_REQUIRED.
 * 2. Berbentuk JWT (3 segmen) tapi tidak bisa didekode/tanpa `exp` → INVALID (format rusak, bukan expired).
 * 3. `exp` JWT sudah lewat → EXPIRED (bukti kalender, prioritas tertinggi).
 * 4. Checkpoint terakhir menunjukkan penolakan resmi (401/unauthorized) → INVALID.
 * 5. Checkpoint terakhir menunjukkan kegagalan jaringan/infra → UNAVAILABLE (bukan token).
 * 6. `exp` JWT tersedia dan belum lewat → EXPIRING_SOON/ACTIVE sesuai threshold.
 * 7. Token ada, opaque, tidak ada bukti negatif → EXPIRY_UNKNOWN (tidak pernah ditebak jadi ACTIVE/EXPIRED).
 */
export function classifyAyoMobileToken(params: {
  token: string | undefined;
  now?: Date;
  lastAttemptAt?: Date | null;
  lastSuccessfulSyncAt?: Date | null;
  lastError?: string | null;
}): AyoMobileTokenHealth {
  const { token, now = new Date(), lastAttemptAt = null, lastSuccessfulSyncAt = null, lastError = null } = params;
  const build = (status: AyoTokenStatus, extra: Partial<Pick<AyoMobileTokenHealth, "expiresAt" | "expirySource" | "remainingDays">> = {}): AyoMobileTokenHealth => ({
    status,
    label: AYO_TOKEN_STATUS_LABEL[status],
    expiresAt: extra.expiresAt ?? null,
    expirySource: extra.expirySource ?? "unknown",
    remainingDays: extra.remainingDays ?? null,
    importedAt: null,
    lastSuccessfulCheck: lastSuccessfulSyncAt?.toISOString() ?? null,
    lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
    lastError,
    checkedAt: now.toISOString(),
    recommendation: AYO_TOKEN_RECOMMENDATION[status],
  });

  const configured = token?.trim();
  if (!configured) return build("MANUAL_IMPORT_REQUIRED");

  const looksLikeJwt = configured.split(".").length === 3;
  const decodedExpiry = looksLikeJwt ? jwtExpiry(configured) : null;
  if (looksLikeJwt && !decodedExpiry) return build("INVALID");

  if (decodedExpiry) {
    const remainingDays = Math.ceil((decodedExpiry.getTime() - now.getTime()) / 86_400_000);
    if (remainingDays <= 0) return build("EXPIRED", { expiresAt: decodedExpiry.toISOString(), expirySource: "jwt", remainingDays });
    const errorText = lastError ?? "";
    if (/unauthorized|invalid.?token|401|403/i.test(errorText)) return build("INVALID");
    if (/timeout|network|ECONNREFUSED|ETIMEDOUT|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(errorText)) return build("UNAVAILABLE");
    const status: AyoTokenStatus = remainingDays <= AYO_TOKEN_EXPIRING_SOON_DAYS ? "EXPIRING_SOON" : "ACTIVE";
    return build(status, { expiresAt: decodedExpiry.toISOString(), expirySource: "jwt", remainingDays });
  }

  const errorText = lastError ?? "";
  if (/unauthorized|invalid.?token|401|403/i.test(errorText)) return build("INVALID");
  if (/timeout|network|ECONNREFUSED|ETIMEDOUT|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(errorText)) return build("UNAVAILABLE");
  return build("EXPIRY_UNKNOWN");
}
