// Resolusi actor ID (better-auth user._id, mentah/raw) -> nama yang bisa
// dibaca manusia untuk Riwayat Aktivitas Berita Acara & Finalisasi
// (app/reconciliation/page.tsx). Raw ID TIDAK PERNAH boleh sampai ke UI
// (lihat instruksi V8) — modul ini SATU-SATUNYA tempat pemetaan id -> nama
// dilakukan, dipanggil dari route GET detail + upload/preview/lock/unlock,
// supaya konsisten di semua jalur yang mengembalikan periodLock ke client.
//
// Bagian pure (buildActorDisplayNameMap/resolveActorDisplayName/
// collectPeriodLockActorIds) TIDAK butuh DB — bisa dites langsung. Hanya
// fetchActorDisplayNameMap yang menyentuh MongoDB (server-only).
import "server-only";
import { ObjectId } from "mongodb";
import { getDb } from "./mongodb";

export const FALLBACK_ACTOR_NAME = "User";

export type ActorDisplayNameMap = Record<string, string>;

type PeriodLockHistoryEntryLike = { actor: string };
type PeriodLockAttachmentLike = { uploadedBy: string } | null | undefined;

/** Kumpulkan SEMUA actor id unik dari satu dokumen period lock (attachment/lockedBy/unlockedBy/history). */
export function collectPeriodLockActorIds(lock: {
  attachment?: PeriodLockAttachmentLike;
  lockedBy?: string | null;
  unlockedBy?: string | null;
  history?: readonly PeriodLockHistoryEntryLike[];
} | null | undefined): string[] {
  if (!lock) return [];
  const ids = new Set<string>();
  if (lock.attachment?.uploadedBy) ids.add(lock.attachment.uploadedBy);
  if (lock.lockedBy) ids.add(lock.lockedBy);
  if (lock.unlockedBy) ids.add(lock.unlockedBy);
  for (const entry of lock.history ?? []) if (entry.actor) ids.add(entry.actor);
  return [...ids];
}

/** id -> "name" (utama) atau "email" (fallback) atau "User" (fallback aman terakhir) — TIDAK PERNAH raw ID. */
export function buildActorDisplayNameMap(users: Array<{ _id: { toHexString(): string }; name?: string | null; email?: string | null }>): ActorDisplayNameMap {
  const map: ActorDisplayNameMap = {};
  for (const user of users) {
    const id = user._id.toHexString();
    map[id] = user.name?.trim() || user.email?.trim() || FALLBACK_ACTOR_NAME;
  }
  return map;
}

export function resolveActorDisplayName(id: string | null | undefined, map: ActorDisplayNameMap): string {
  if (!id) return FALLBACK_ACTOR_NAME;
  return map[id] ?? FALLBACK_ACTOR_NAME;
}

/** Query koleksi "user" (better-auth, lihat lib/auth.ts) untuk id yang valid sebagai ObjectId; id lain/tidak ditemukan diam-diam jatuh ke FALLBACK_ACTOR_NAME lewat resolveActorDisplayName. */
export async function fetchActorDisplayNameMap(ids: readonly string[]): Promise<ActorDisplayNameMap> {
  const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (objectIds.length === 0) return {};
  const db = await getDb();
  const users = await db.collection<{ _id: ObjectId; name?: string; email?: string }>("user").find({ _id: { $in: objectIds } }).toArray();
  return buildActorDisplayNameMap(users);
}

type PeriodLockLike = {
  attachment?: ({ uploadedBy: string; [key: string]: unknown }) | null;
  lockedBy?: string | null;
  unlockedBy?: string | null;
  history?: Array<{ actor: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/**
 * Tambahkan field *_Name (uploadedByName/lockedByName/unlockedByName/
 * history[].actorName) TANPA mengubah/menghapus field raw asli — DB/backend
 * tetap menyimpan actor id mentah (lihat instruksi: "Metadata tetap boleh
 * tersimpan di backend"). attachment/lockedBy/unlockedBy/history yang
 * hilang/undefined diperlakukan aman sebagai null/[] (dokumen lock nyata
 * SELALU mengisi field ini — lihat reconciliation-omzet-period-lock.ts — tapi
 * fixture test/versi skema lama bisa saja tidak).
 */
export function withActorDisplayNames<L extends PeriodLockLike>(lock: L, map: ActorDisplayNameMap): L & {
  attachment: (L["attachment"] extends null | undefined ? null : NonNullable<L["attachment"]> & { uploadedByName: string }) | null;
  lockedByName: string;
  unlockedByName: string;
  history: Array<NonNullable<L["history"]>[number] & { actorName: string }>;
} {
  return {
    ...lock,
    attachment: lock.attachment ? { ...lock.attachment, uploadedByName: resolveActorDisplayName(lock.attachment.uploadedBy, map) } : null,
    lockedByName: resolveActorDisplayName(lock.lockedBy, map),
    unlockedByName: resolveActorDisplayName(lock.unlockedBy, map),
    history: (lock.history ?? []).map((entry) => ({ ...entry, actorName: resolveActorDisplayName(entry.actor, map) })),
  } as L & {
    attachment: (L["attachment"] extends null | undefined ? null : NonNullable<L["attachment"]> & { uploadedByName: string }) | null;
    lockedByName: string;
    unlockedByName: string;
    history: Array<NonNullable<L["history"]>[number] & { actorName: string }>;
  };
}

/** Gabungan collect+fetch+apply — dipakai langsung dari route.ts supaya tiap endpoint yang mengembalikan periodLock hanya perlu satu panggilan. */
export async function attachActorDisplayNames<L extends PeriodLockLike>(lock: L): Promise<ReturnType<typeof withActorDisplayNames<L>>> {
  const ids = collectPeriodLockActorIds(lock);
  const map = await fetchActorDisplayNameMap(ids);
  return withActorDisplayNames(lock, map);
}
