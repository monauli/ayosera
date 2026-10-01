import "server-only";
import type { BookingDocument } from "./mongodb.ts";
import { collections, withMongo } from "./mongodb.ts";
import { currentStoreId } from "./reconciliation-store.ts";
import type { RacketAddonImportRow } from "./ayo-racket-addon-import.ts";

export async function saveRacketAddonImport(input: {
  rows: RacketAddonImportRow[];
  sourceFileName: string;
  importedBy: string;
}) {
  return withMongo(async () => {
    const storeId = currentStoreId();
    const { ayoRacketAddons } = await collections();
    const importedAt = new Date();
    await ayoRacketAddons.bulkWrite(
      input.rows.map((row) => ({
        updateOne: {
          filter: { _id: `racket-addon:${storeId}:${row.bookingId}` },
          update: {
            $set: {
              storeId,
              bookingId: row.bookingId,
              date: row.date,
              amount: row.amount,
              paymentId: row.paymentId,
              sourceFileName: input.sourceFileName,
              importedAt,
              importedBy: input.importedBy,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return { rowsImported: input.rows.length, importedAt };
  });
}

export async function loadRacketAddonAmounts(bookingIds: readonly string[]) {
  const ids = [...new Set(bookingIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map<string, number>();
  return withMongo(async () => {
    const { ayoRacketAddons } = await collections();
    const rows = await ayoRacketAddons.find({ storeId: currentStoreId(), bookingId: { $in: ids } }).toArray();
    return new Map(rows.map((row) => [row.bookingId, Math.max(0, Number(row.amount) || 0)]));
  });
}

export function withImportedRacketAddonAmounts(bookings: BookingDocument[], amounts: ReadonlyMap<string, number>) {
  return bookings.map((booking) => {
    const amount = amounts.get(booking.booking_id);
    return amount === undefined ? booking : { ...booking, racket_addon_amount: amount };
  });
}

