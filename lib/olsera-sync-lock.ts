"use client";

/**
 * Lock lintas-komponen (bukan lintas-request) untuk mencegah sync Olsera
 * berjalan paralel: tombol per-modul (Kategori/Penjualan, Inventori,
 * Laporan Keuangan) dan orkestrator "Sync Semua Olsera" berbagi satu lock
 * ini. Tidak menggantikan guard ref lokal masing-masing komponen — ini
 * lapisan tambahan agar SATU tombol tidak bisa berjalan sementara tombol
 * lain (termasuk orkestrator) sedang sinkron.
 */
type Listener = (locked: boolean) => void;

let locked = false;
const listeners = new Set<Listener>();

export function isOlseraSyncLocked(): boolean {
  return locked;
}

export function acquireOlseraSyncLock(): boolean {
  if (locked) return false;
  locked = true;
  for (const listener of listeners) listener(true);
  return true;
}

export function releaseOlseraSyncLock(): void {
  locked = false;
  for (const listener of listeners) listener(false);
}

export function subscribeOlseraSyncLock(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
