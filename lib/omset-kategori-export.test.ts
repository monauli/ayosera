import assert from "node:assert/strict";
import test from "node:test";
import { canonicalOmsetCategoryBookings, courtCategoryAmounts } from "./omset-kategori-export.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";
import type { BookingDocument } from "./mongodb.ts";

function booking(overrides: Partial<BookingDocument>): BookingDocument {
  return { booking_id: "BOOKING", date: "2026-07-01", field_name: "Court No 1", status: "SUCCESS", total_price: 0, ...overrides } as BookingDocument;
}

function event(identity: string, bookingId: string, amount: number): AyoPaymentEvent {
  return { identity, bookingId, amount } as AyoPaymentEvent;
}

test("Export Omset Kategori Juli memakai payment tervalidasi untuk Padel/Pickleball tanpa menggeser tanggal", () => {
  const bookings = [
    booking({ booking_id: "PAD", date: "2026-07-30", field_name: "Court No 4", total_price: 50_000 }),
    booking({ booking_id: "PICKLE", date: "2026-07-31", field_name: "Pickleball Court No 1", total_price: 25_000 }),
  ];
  const canonical = canonicalOmsetCategoryBookings(bookings, [event("pad-dp", "PAD", 150_000), event("pad-settlement", "PAD", 50_000), event("pickle", "PICKLE", 25_000)]);
  const totals = courtCategoryAmounts(canonical, 31);
  assert.equal(canonical.find((row) => row.booking_id === "PAD")?.date, "2026-07-30");
  assert.equal(totals.padel[29], 200_000);
  assert.equal(totals.pickle[30], 25_000);
  assert.equal(totals.padel.reduce((sum, amount) => sum + amount, 0) + totals.pickle.reduce((sum, amount) => sum + amount, 0), 225_000);
});

test("Export Omset Kategori Juni menambahkan empat pembayaran Rp150.000 tanpa duplikasi atau booking tanpa payment", () => {
  const ids = ["JUNE-1", "JUNE-2", "JUNE-3", "JUNE-4"];
  const bookings = [
    booking({ booking_id: "BASE", date: "2026-06-01", total_price: 241_945_499 }),
    ...ids.map((booking_id, index) => booking({ booking_id, date: `2026-06-${String(index + 4).padStart(2, "0")}`, total_price: index < 2 ? 125_000 : 50_000 })),
    booking({ booking_id: "NO-PAYMENT", date: "2026-06-10", total_price: 999_999 }),
  ];
  const events = [
    event("base", "BASE", 241_945_499),
    ...ids.flatMap((bookingId, index) => [event(`${bookingId}-dp`, bookingId, 150_000), event(`${bookingId}-settlement`, bookingId, index < 2 ? 125_000 : 50_000)]),
    event("JUNE-1-dp", "JUNE-1", 150_000),
  ];
  const canonical = canonicalOmsetCategoryBookings(bookings, events);
  assert.equal(canonical.some((row) => row.booking_id === "NO-PAYMENT"), false);
  assert.equal(canonical.reduce((sum, row) => sum + row.total_price, 0), 242_895_499);
  assert.equal(courtCategoryAmounts(canonical, 30).padel.reduce((sum, amount) => sum + amount, 0), 242_895_499);
});

test("tanpa source payment tervalidasi, fallback booking dan kategori lain tidak berubah", () => {
  const bookings = [booking({ booking_id: "FALLBACK", date: "2026-05-15", total_price: 175_000 })];
  assert.equal(canonicalOmsetCategoryBookings(bookings, null), bookings);
  assert.equal(courtCategoryAmounts(bookings, 31).padel[14], 175_000);
});
