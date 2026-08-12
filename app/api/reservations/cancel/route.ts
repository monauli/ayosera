import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelAyoReservation } from "@/lib/ayo";
import { requireUser } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";

const cancelSchema = z.object({
  order_detail_id: z.coerce.number().int().positive(),
});

export async function POST(request: Request) {
  const startedAt = new Date();

  try {
    await requireUser();

    const body = cancelSchema.parse(await request.json());
    const response = await cancelAyoReservation(body.order_detail_id);
    const bookingId = typeof response.data?.booking_id === "string" ? response.data.booking_id : undefined;

    await withMongo(async () => {
      const { bookings, syncLogs } = await collections();

      if (bookingId) {
        await bookings.updateOne(
          { booking_id: bookingId },
          {
            $set: {
              status: "CANCELLED",
              updatedAt: new Date(),
              raw: response.data,
            },
          },
        );
      }

      await syncLogs.insertOne({
        type: "manual",
        status: "success",
        recordsProcessed: bookingId ? 1 : 0,
        message: "AYO reservation cancelled",
        startedAt,
        finishedAt: new Date(),
      });
    });

    return NextResponse.json({
      data: response.data,
      message: response.message || "Reservation cancelled",
    });
  } catch (error) {
    await withMongo(async () => {
      const { syncLogs } = await collections();
      await syncLogs.insertOne({
        type: "manual",
        status: "failed",
        recordsProcessed: 0,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        startedAt,
        finishedAt: new Date(),
      });
    }).catch(() => undefined);

    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid cancellation payload" }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to cancel reservation" }, { status: 500 });
  }
}
