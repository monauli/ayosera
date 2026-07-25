import "server-only";
import { randomUUID } from "node:crypto";
import { collections, withMongo, type OlseraSyncLockDocument } from "@/lib/mongodb";

// Distributed lock/lease MongoDB — mencegah dua sync Olsera (kategori/
// penjualan, inventori, keuangan) berjalan bersamaan lintas instance Vercel.
// Berlaku untuk cron server-side (app/api/cron/olsera/*) MAUPUN tombol manual
// (Sync Semua Olsera / sync per modul) — keduanya memanggil fungsi yang sama
// di sini sehingga tidak mungkin saling bertabrakan. Sync AYO (lib/production-sync.ts,
// app/api/cron/sync) TIDAK memakai lock ini sama sekali.
//
// Satu dokumen singleton (_id="olsera-sync"). Acquisition atomik lewat
// findOneAndUpdate({_id, lockedUntil: {$lte: now}}, ..., {upsert:true}) — bila
// dokumen belum ada ATAU sudah kedaluwarsa (proses pemegang lock lama
// dianggap mati), permintaan berikutnya boleh mengambil alih. Race antara dua
// upsert pertama (belum ada dokumen sama sekali) ditangani dengan menangkap
// duplicate-key error (pola yang sama seperti olseraInventorySyncRuns di
// lib/olsera-inventory.ts) lalu membaca ulang pemegang lock yang menang.
// Release hanya berhasil bila runId cocok — pemilik lain tidak bisa melepas
// lock milik proses lain.

const LOCK_ID = "olsera-sync" as const;

export type OlseraCronModule = "sales" | "inventory" | "financial";
export type OlseraSyncLockSource = "cron" | "manual";

export type AcquireOlseraSyncLockResult =
  | { ok: true; runId: string }
  | { ok: false; activeModule: OlseraCronModule; runId: string };

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 11000);
}

/**
 * Coba ambil lock untuk `module`. `leaseMs` menentukan berapa lama lock ini
 * berlaku sebelum dianggap basi (dipulihkan otomatis oleh acquire berikutnya
 * bila proses pemegang mati sebelum sempat release).
 */
export async function acquireOlseraSyncLock(
  module: OlseraCronModule,
  source: OlseraSyncLockSource,
  leaseMs: number,
): Promise<AcquireOlseraSyncLockResult> {
  return withMongo(async () => {
    const { olseraSyncLocks } = await collections();
    const runId = randomUUID();
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + leaseMs);

    async function readActiveLock(): Promise<AcquireOlseraSyncLockResult> {
      const current = await olseraSyncLocks.findOne({ _id: LOCK_ID });
      if (current && current.lockedUntil > now) {
        return { ok: false, activeModule: current.module, runId: current.runId };
      }
      // Kondisi basi tapi gagal diambil alih (race) — anggap sementara "sedang
      // diproses" oleh proses lain, aman untuk diminta ulang oleh pemanggil.
      return { ok: false, activeModule: current?.module ?? module, runId: current?.runId ?? runId };
    }

    try {
      const updated = await olseraSyncLocks.findOneAndUpdate(
        { _id: LOCK_ID, lockedUntil: { $lte: now } },
        { $set: { runId, module, source, lockedAt: now, lockedUntil } },
        { upsert: true, returnDocument: "after" },
      );
      if (updated && updated.runId === runId) return { ok: true, runId };
      return readActiveLock();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      return readActiveLock();
    }
  });
}

/** Release hanya berhasil bila runId cocok dengan pemegang lock saat ini. */
export async function releaseOlseraSyncLock(runId: string): Promise<boolean> {
  return withMongo(async () => {
    const { olseraSyncLocks } = await collections();
    const result = await olseraSyncLocks.updateOne(
      { _id: LOCK_ID, runId },
      { $set: { lockedUntil: new Date(0) } },
    );
    return result.modifiedCount === 1;
  });
}

export type OlseraSyncLockStatus =
  | { locked: false; activeModule: null; runId: null }
  | { locked: true; activeModule: OlseraCronModule; runId: string; source: OlseraSyncLockSource };

export async function getOlseraSyncLockStatus(): Promise<OlseraSyncLockStatus> {
  return withMongo(async () => {
    const { olseraSyncLocks } = await collections();
    const doc = await olseraSyncLocks.findOne({ _id: LOCK_ID });
    const now = new Date();
    if (!doc || doc.lockedUntil <= now) return { locked: false, activeModule: null, runId: null };
    return { locked: true, activeModule: doc.module, runId: doc.runId, source: doc.source };
  });
}

export type WithOlseraSyncLockResult<T> =
  | { locked: true; activeModule: OlseraCronModule; runId: string }
  | { locked: false; result: T };

/**
 * Bungkus satu operasi sync Olsera (manual maupun cron) dengan acquire/release
 * lock atomik. Dipakai oleh route manual (app/api/olsera/sync,
 * app/api/olsera/inventory/sync, app/api/olsera/financial/sync/*) supaya
 * tombol manual dan cron server-side saling mengunci lewat mekanisme yang
 * persis sama.
 */
export async function withOlseraSyncLock<T>(
  module: OlseraCronModule,
  source: OlseraSyncLockSource,
  leaseMs: number,
  fn: () => Promise<T>,
): Promise<WithOlseraSyncLockResult<T>> {
  const lock = await acquireOlseraSyncLock(module, source, leaseMs);
  if (!lock.ok) return { locked: true, activeModule: lock.activeModule, runId: lock.runId };
  try {
    const result = await fn();
    return { locked: false, result };
  } finally {
    await releaseOlseraSyncLock(lock.runId).catch((error) => {
      console.error(`[olsera-sync-lock] gagal release lock module=${module} runId=${lock.runId}`, error);
    });
  }
}

export type { OlseraSyncLockDocument };
