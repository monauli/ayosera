"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { hasMultiPayment, type PaymentDetailBooking, type PaymentDetailRow } from "@/lib/booking-payment-detail-ui";

export { hasMultiPayment, type PaymentDetailBooking, type PaymentDetailRow };

/**
 * Badge "N pembayaran" + chevron toggle, dipasang di bawah kolom Nominal.
 * Mengikuti pola visual chevron/badge yang sama dengan BookingSessionRow
 * (komponen "X sesi") untuk konsistensi UI — bukan pola baru.
 */
export function PaymentDetailToggle({
  count,
  expanded,
  onToggle,
  customer,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  customer: string;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Tutup" : "Buka"} detail ${count} pembayaran untuk ${customer}`}
      className="mt-1 inline-flex min-h-[32px] items-center gap-1 rounded-md px-1.5 py-1 text-left text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
    >
      <Chevron className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
      <Badge variant="warning">{count} pembayaran</Badge>
    </button>
  );
}

/**
 * Baris detail payment (dalam <tr> tersendiri, colSpan penuh) — TIDAK
 * menampilkan tanggal/jam sama sekali. `AyoPaymentEvent.eventDate` untuk
 * source_table "internal_reservation" (satu-satunya sumber kasus
 * multi-payment yang ditemukan) hanya fallback ke tanggal sesi booking,
 * identik untuk setiap payment pada booking yang sama (dikonfirmasi lewat
 * query read-only produksi) — menampilkannya akan terlihat seperti dua
 * tanggal pembayaran berbeda padahal datanya sama persis. Hanya nominal dan
 * reference ID yang ditampilkan, sesuai data yang benar-benar dikirim AYO.
 */
export function PaymentDetailList({ details }: { details: PaymentDetailRow[] }) {
  return (
    <ul className="pl-6">
      {details.map((detail, index) => (
        <li
          key={detail.referenceId || index}
          className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 text-xs ${index ? "border-t border-white/5" : ""}`}
        >
          <span className="w-20 shrink-0 text-slate-500">Pembayaran {index + 1}</span>
          <span className="whitespace-nowrap text-slate-500">
            Nominal: <span className="font-medium text-slate-200">{detail.amount}</span>
          </span>
          {detail.referenceId && (
            <span className="break-all text-slate-500">
              Ref: <span className="text-slate-300">{detail.referenceId}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
