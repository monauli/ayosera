/**
 * Logic murni (tanpa JSX) di belakang badge/expand "N pembayaran" pada UI
 * Transaksi (components/booking-payment-detail.tsx) — dipisah dari komponen
 * .tsx supaya bisa ditest dengan `node --test` biasa, sama seperti
 * lib/booking-session.ts di belakang komponen "X sesi".
 */

export type PaymentDetailRow = { referenceId: string; amount: string; paymentTime?: string };

/** Bentuk minimal baris transaksi yang punya rincian payment (structural, bukan duplikasi tipe UI). */
export type PaymentDetailBooking = {
  id: string;
  customer?: string;
  paymentCount?: number;
  paymentDetails?: PaymentDetailRow[];
};

/** true hanya bila booking benar-benar punya >1 payment — badge/expand tidak pernah muncul untuk 1 payment. */
export function hasMultiPayment(booking: PaymentDetailBooking): boolean {
  return Boolean(booking.paymentCount && booking.paymentCount > 1 && booking.paymentDetails && booking.paymentDetails.length > 1);
}
