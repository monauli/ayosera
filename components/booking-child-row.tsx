"use client";

import type { ReactNode } from "react";

/**
 * Struktur "child row" generik dipakai bersama oleh detail per-sesi
 * ("Slot N", booking-session-row.tsx) dan detail per-payment ("Pembayaran N",
 * booking-payment-detail.tsx). Diekstrak ke satu tempat supaya className
 * kedua child row DIJAMIN identik secara struktural (satu sumber literal),
 * bukan sekadar disalin manual dan berisiko menyimpang seiring waktu.
 *
 * Murni presentasi — tidak membawa logic data apa pun.
 */
export function ChildRowList({ children }: { children: ReactNode }) {
  return <ul className="pl-6">{children}</ul>;
}

export function ChildRow({ index, children }: { index: number; children: ReactNode }) {
  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 text-xs ${index ? "border-t border-white/5" : ""}`}
    >
      {children}
    </li>
  );
}

/**
 * Kolom label urutan child row ("Slot 1" / "Pembayaran 1") — style sama persis
 * di kedua fitur. Lebar `w-28` (bukan `w-12`) dan `whitespace-nowrap` sengaja
 * dipilih supaya label terpanjang yang dipakai saat ini, "Pembayaran 1"/
 * "Pembayaran 2" (12-13 karakter), tidak wrap ke baris kedua maupun overflow
 * menimpa kolom di sebelahnya. "Slot 1"/"Slot 2" (lebih pendek) otomatis tetap
 * rapi di lebar yang sama — hanya menyisakan sedikit spasi ekstra sebelum
 * kolom berikutnya, tidak mengubah alignment vertikal/tinggi baris.
 */
export function ChildRowLabel({ children }: { children: ReactNode }) {
  return <span className="w-28 shrink-0 whitespace-nowrap text-slate-500">{children}</span>;
}
