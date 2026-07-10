import { NextResponse } from "next/server";
import { fetchAyoFields } from "@/lib/ayo";
import { requireSupervisor } from "@/lib/auth";
import { normalizeField } from "@/lib/booking-mapper";
import { collections, withMongo } from "@/lib/mongodb";

export async function POST() {
  const startedAt = new Date();
  try {
    await requireSupervisor();

    const response = await fetchAyoFields();
    const records = response.data.map(normalizeField).filter((field) => field.id);

    await withMongo(async () => {
      const { fields, syncLogs } = await collections();
      if (records.length) {
        await fields.bulkWrite(
          records.map((field) => ({
            updateOne: {
              filter: { id: field.id },
              update: { $set: field },
              upsert: true,
            },
          })),
        );
      }
      await syncLogs.insertOne({
        type: "fields",
        status: "success",
        recordsProcessed: records.length,
        message: "AYO fields synced",
        startedAt,
        finishedAt: new Date(),
      });
    });

    return NextResponse.json({ recordsProcessed: records.length });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Field sync failed" }, { status: 500 });
  }
}
