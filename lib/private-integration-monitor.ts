import "server-only";
import { requireUser, type SessionUser } from "@/lib/auth";

export type TokenHealthStatus = "AKTIF" | "AKAN_KEDALUWARSA" | "KEDALUWARSA" | "UNAUTHORIZED" | "TIDAK_DIKONFIGURASI" | "TEMPORARY" | "MANUAL_IMPORT_REQUIRED";
export type TokenHealth = { source: "ayo-mobile" | "olsera-bearer"; label: string; status: TokenHealthStatus; expiresAt: string | null; remainingDays: number | null; checkedAt: string; lastSuccessfulUse: string | null; lastError: string | null; lastValidSource: string | null };

export function privateToolsAllowlist(value = process.env.AYOSERA_PRIVATE_TOOLS_USER_IDS ?? "") {
  return new Set(value.split(",").map((id) => id.trim()).filter(Boolean));
}

export function isPrivateToolsUser(user: Pick<SessionUser, "id">, allowlist = privateToolsAllowlist()) {
  return allowlist.size > 0 && allowlist.has(user.id);
}

export async function requirePrivateToolsUser() {
  const user = await requireUser();
  if (!isPrivateToolsUser(user)) throw new Response(JSON.stringify({ error: "Private integration tools access required" }), { status: 403, headers: { "Content-Type": "application/json" } });
  return user;
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

export function classifyTokenHealth(source: TokenHealth["source"], token: string | undefined, now = new Date(), lastSuccessfulUse: Date | null = null, lastError: string | null = null): TokenHealth {
  const label = source === "ayo-mobile" ? "AYO Mobile Token" : "Olsera Bearer Token";
  const configured = token?.trim();
  if (!configured) return { source, label, status: "TIDAK_DIKONFIGURASI", expiresAt: null, remainingDays: null, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: null, lastValidSource: lastSuccessfulUse ? "Penggunaan API terakhir" : null };
  if (/unauthorized|401/i.test(lastError ?? "")) return { source, label, status: "UNAUTHORIZED", expiresAt: null, remainingDays: null, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: "Unauthorized", lastValidSource: lastSuccessfulUse ? "Penggunaan API terakhir" : null };
  const expiry = jwtExpiry(configured);
  if (!expiry) return { source, label, status: "MANUAL_IMPORT_REQUIRED", expiresAt: null, remainingDays: null, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: lastError ? "Pemeriksaan token terakhir gagal." : null, lastValidSource: lastSuccessfulUse ? "Penggunaan API terakhir" : "Expiry tidak diketahui" };
  const remainingDays = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
  const status: TokenHealthStatus = remainingDays <= 0 ? "KEDALUWARSA" : remainingDays <= 3 ? "AKAN_KEDALUWARSA" : "AKTIF";
  return { source, label, status, expiresAt: expiry.toISOString(), remainingDays, checkedAt: now.toISOString(), lastSuccessfulUse: lastSuccessfulUse?.toISOString() ?? null, lastError: null, lastValidSource: "JWT expiry" };
}

export function integrationTokenHealth(now = new Date()): TokenHealth[] {
  return [classifyTokenHealth("ayo-mobile", process.env.AYO_MOBILE_TOKEN, now), classifyTokenHealth("olsera-bearer", process.env.OLSERA_INTERNAL_TOKEN, now)];
}
