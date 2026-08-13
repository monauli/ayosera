"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  hasValidPriceChange,
  hasValidReschedule,
  type BookingSession,
  type SessionBooking,
} from "@/lib/booking-session";
import { getRevenueAmount } from "@/lib/revenue";
import { ChildRow, ChildRowLabel, ChildRowList } from "@/components/booking-child-row";
import {
  hasMultiPayment,
  PaymentDetailList,
  PaymentDetailToggle,
  type PaymentDetailBooking,
} from "@/components/booking-payment-detail";

/** Baris transaksi yang sudah punya nominal terformat (dipakai apa adanya untuk tampilan). */
export type SessionRowBooking = SessionBooking & { amount: string } & Partial<PaymentDetailBooking>;

export function statusVariant(status: string): "success" | "warning" | "danger" {
  if (status === "Completed") return "success";
  if (status === "Pending") return "warning";
  return "danger";
}

export function statusLabel(status: string) {
  if (status === "Completed") return "Selesai";
  if (status === "Pending") return "Belum Bayar";
  if (status === "Cancelled") return "Dibatalkan";
  return status;
}

/**
 * Satu Booking Session pada tabel Transaksi: baris ringkas (default tertutup)
 * plus baris detail berisi tiap sesi saat dibuka.
 *
 * Murni presentasi — memakai kolom tabel yang sudah ada, tidak menambah kolom,
 * tidak mengubah pagination/total, dan angkanya diambil dari helper revenue
 * existing. Istilah pembayaran (DP/pelunasan) sengaja TIDAK dipakai untuk
 * setiap slot: payload AYO tidak punya data pembayaran per slot, hanya harga.
 *
 * Audit detail pembayaran booking (lihat tmp/ai-handoff.md, "AYO Booking
 * Session and Payment Detail"): endpoint payment-event AYO
 * (report-transactions, lib/ayo-payment-events.ts) TIDAK PERNAH mengirim
 * payment created_at/urutan pembayaran untuk source_table
 * "internal_reservation" (satu-satunya sumber seluruh kasus multi-payment
 * yang ditemukan) — hanya tanggal sesi sebagai fallback, identik untuk setiap
 * payment pada booking yang sama. Status asli AYO yang tampil di app mobile
 * ("DP Sudah Lunas · Manual"/"Sudah Lunas · Manual") juga TIDAK ada di
 * payload API ini (hanya kode generik SUCCESS/SUCCESS/MANUAL). Karena itu
 * detail pembayaran per booking SENGAJA TIDAK ditampilkan di sini — keputusan
 * C pada audit (data tidak cukup, bukan ditebak).
 *
 * Jadwal awal reschedule ("Jadwal awal"/"Jadwal sekarang" di bawah) BEDA
 * kasus: field itu (`previousSchedule`) berasal dari diff snapshot sync
 * AYOSERA sendiri (lib/booking-sync.ts), sumber yang SAMA dengan yang sudah
 * menggerakkan badge "Reschedule" — bukan data baru, jadi aman ditampilkan.
 */
export function BookingSessionRow({
  session,
  expanded,
  onToggle,
  columnCount,
  formatAmount,
  expandedPayments,
  onTogglePayment,
}: {
  session: BookingSession<SessionRowBooking>;
  expanded: boolean;
  onToggle: () => void;
  columnCount: number;
  formatAmount: (value: number) => string;
  /** Booking id -> apakah detail payment slot itu terbuka. Independen dari `expanded` (buka/tutup sesi). */
  expandedPayments: ReadonlySet<string>;
  onTogglePayment: (bookingId: string) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <>
      <tr className="h-[58px]">
        <td className="whitespace-nowrap px-2 py-2">{session.date}</td>
        <td className="whitespace-nowrap px-2 py-2">
          {session.startTime} - {session.endTime}
        </td>
        <td className="px-2 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={session.id}
            aria-label={`${expanded ? "Tutup" : "Buka"} detail ${session.slotCount} sesi untuk ${session.customer}`}
            className="-ml-1 inline-flex min-h-[32px] cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            <Chevron className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
            <span className="whitespace-nowrap text-xs">{session.slotCount} sesi</span>
          </button>
        </td>
        <td className="max-w-[150px] truncate px-2 py-2">{session.customer}</td>
        <td className="max-w-[130px] truncate px-2 py-2">{session.displayPhone}</td>
        <td className="max-w-[180px] truncate px-2 py-2">{session.fieldName || "-"}</td>
        <td className="px-2 py-2 text-right font-medium">{formatAmount(session.totalRevenue)}</td>
        <td className="px-2 py-2">
          <Badge variant={statusVariant(session.statusSummary)}>{statusLabel(session.statusSummary)}</Badge>
        </td>
        <td className="px-2 py-2">
          {session.badges.length ? (
            <span className="flex flex-wrap gap-1">
              {session.badges.map((badge) => (
                <Badge key={badge} variant="warning">
                  {badge}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-slate-600">—</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr id={session.id}>
          <td colSpan={columnCount} className="border-t border-white/10 bg-white/[0.04] px-2 py-1">
            {/* Nama, tanggal, court, dan total sesi sengaja TIDAK diulang di sini —
                keempatnya sudah terbaca pada baris ringkas tepat di atasnya. */}
            <ChildRowList>
              {session.bookings.map((booking, index) => {
                const counted = getRevenueAmount(booking as Record<string, unknown>) > 0;
                const excluded = !counted && Number(booking.amountValue ?? 0) > 0;
                return (
                  <ChildRow key={booking.id} index={index}>
                    <ChildRowLabel>Slot {index + 1}</ChildRowLabel>
                    <span className="whitespace-nowrap font-medium">
                      {booking.time} - {booking.endTime || "-"}
                    </span>
                    <span className="break-all text-slate-500">
                      Booking: <span className="text-slate-300">{booking.id}</span>
                    </span>
                    <span className="whitespace-nowrap text-slate-500">
                      Nominal slot: <span className="font-medium text-slate-200">{booking.amount}</span>
                    </span>
                    <Badge variant={statusVariant(booking.status)}>{statusLabel(booking.status)}</Badge>
                    {hasValidReschedule(booking) && (
                      <>
                        <Badge variant="warning">Reschedule</Badge>
                        {/* previousSchedule berasal dari diff snapshot sync AYOSERA sendiri
                            (lib/booking-sync.ts) — SUMBER YANG SAMA yang sudah menggerakkan
                            badge Reschedule di atas, bukan data baru/tebakan. Jadwal awal
                            HANYA tampil bila field ini benar-benar ada (lihat hasValidReschedule). */}
                        {booking.previousSchedule && (
                          <span className="whitespace-nowrap text-slate-500">
                            Jadwal awal:{" "}
                            <span className="text-slate-300">
                              {booking.previousSchedule.date} {booking.previousSchedule.start_time.slice(0, 5)}-
                              {booking.previousSchedule.end_time.slice(0, 5)}
                            </span>
                            {" · "}Jadwal sekarang:{" "}
                            <span className="text-slate-300">
                              {booking.date} {booking.time}-{booking.endTime || "-"}
                            </span>
                          </span>
                        )}
                      </>
                    )}
                    {hasValidPriceChange(booking) && <Badge variant="warning">Harga Diubah</Badge>}
                    {excluded && <span className="text-slate-500">Tidak dihitung ke total sesi</span>}
                    {hasMultiPayment(booking) && (
                      <div className="basis-full">
                        <PaymentDetailToggle
                          count={booking.paymentCount!}
                          expanded={expandedPayments.has(booking.id)}
                          onToggle={() => onTogglePayment(booking.id)}
                          customer={booking.customer}
                        />
                        {expandedPayments.has(booking.id) && <PaymentDetailList details={booking.paymentDetails!} bookingId={booking.id} />}
                      </div>
                    )}
                  </ChildRow>
                );
              })}
            </ChildRowList>
          </td>
        </tr>
      )}
    </>
  );
}
