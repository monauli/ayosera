"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ChildRow, ChildRowLabel, ChildRowList } from "@/components/booking-child-row";
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
      className="-ml-1 inline-flex min-h-[32px] items-center gap-1 rounded-md px-1.5 py-1 text-left text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
    >
      <Chevron className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
      <span className="whitespace-nowrap text-xs">{count} pembayaran</span>
    </button>
  );
}

/**
 * Baris detail payment — SATU CHILD ROW per payment, struktur dan className
 * SAMA PERSIS dengan child row "Slot N" (multi-session) di
 * booking-session-row.tsx: dipakai lewat komponen generik
 * ChildRowList/ChildRow/ChildRowLabel (components/booking-child-row.tsx) yang
 * literal sama untuk kedua fitur, bukan disalin manual. Setiap kolom adalah
 * elemen terpisah (bukan satu kalimat panjang dengan em-dash).
 *
 * TIDAK menampilkan tanggal/jam payment sama sekali. `AyoPaymentEvent.eventDate`
 * untuk source_table "internal_reservation" (satu-satunya sumber kasus
 * multi-payment yang ditemukan) hanya fallback ke tanggal sesi booking,
 * identik untuk setiap payment pada booking yang sama (dikonfirmasi lewat
 * query read-only produksi) — menampilkannya akan terlihat seperti dua
 * tanggal pembayaran berbeda padahal datanya sama persis, jadi kolom itu
 * SENGAJA tidak ada. Status/metode payment per-item juga tidak ada di
 * `PaymentDetailRow` (lib/booking-payment-aggregate.ts hanya menurunkan
 * `referenceId` dan `amount` dari payment-events) sehingga kolom itu pun
 * tidak ditampilkan. Hanya nominal dan reference ID yang ditampilkan, sesuai
 * data yang benar-benar dikirim AYO.
 */
export function PaymentDetailList({ details, bookingId }: { details: PaymentDetailRow[]; bookingId: string }) {
  return (
    <ChildRowList>
      {details.map((detail, index) => (
        <ChildRow key={detail.referenceId || index} index={index}>
          <ChildRowLabel>Pembayaran {index + 1}</ChildRowLabel>
          {detail.paymentTime && <span className="whitespace-nowrap font-medium">{detail.paymentTime}</span>}
          <span className="break-all text-slate-500">
            Booking: <span className="text-slate-300">{bookingId}</span>
          </span>
          <span className="whitespace-nowrap text-slate-500">
            Nominal pembayaran: <span className="font-medium text-slate-200">{detail.amount}</span>
          </span>
          <Badge variant="success">Selesai</Badge>
        </ChildRow>
      ))}
    </ChildRowList>
  );
}
