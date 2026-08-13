"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { hasMultiPayment, type PaymentDetailBooking, type PaymentDetailRow } from "@/lib/booking-payment-detail-ui";

export { hasMultiPayment, type PaymentDetailBooking, type PaymentDetailRow };

/**
 * Chevron toggle polos (tanpa label teks) untuk expand/collapse detail
 * multi-payment, dipasang di bawah kolom Nominal. Sengaja tanpa badge/teks
 * "N pembayaran" apa pun — UI diminimalkan supaya baris utama transaksi
 * tetap ringkas seperti sebelum fitur multi-payment ada.
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
      className="mt-1 inline-flex min-h-[32px] items-center justify-center rounded-md px-1.5 py-1 text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
    >
      <Chevron className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
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
          className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 text-xs text-slate-500 ${index ? "border-t border-white/5" : ""}`}
        >
          <span>
            Pembayaran {index + 1}
            {detail.referenceId && (
              <>
                {" "}
                — Ref: <span className="text-slate-300">{detail.referenceId}</span>
              </>
            )}
            {" "}
            — Nominal: <span className="font-medium text-slate-200">{detail.amount}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
