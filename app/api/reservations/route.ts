import { NextResponse } from "next/server";
import { z } from "zod";
import { createAyoReservation } from "@/lib/ayo";
import { requireSupervisor } from "@/lib/auth";
import { normalizeBooking } from "@/lib/booking-mapper";
import { collections, withMongo } from "@/lib/mongodb";

const reservationSchema = z.object({
  booking_id: z.string().optional(),
  field_id: z.coerce.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  total_price: z.coerce.number().int().nonnegative(),
  user: z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  const startedAt = new Date();

  try {
    await requireSupervisor();

    const body = reservationSchema.parse(await request.json());
    const response = await createAyoReservation({
      ...body,
      start_time: body.start_time.length === 5 ? `${body.start_time}:00` : body.start_time,
      end_time: body.end_time.length === 5 ? `${body.end_time}:00` : body.end_time,
    });

    const booking = response.data ? normalizeBooking(response.data) : null;

    await withMongo(async () => {
      const { bookings, syncLogs } = await collections();
      if (booking?.booking_id) {
        await bookings.updateOne(
          { booking_id: booking.booking_id },
          { $set: booking },
          { upsert: true },
        );
      }

      await syncLogs.insertOne({
        type: "manual",
        status: "success",
        recordsProcessed: booking?.booking_id ? 1 : 0,
        message: "AYO reservation created",
        startedAt,
        finishedAt: new Date(),
      });
    });

    return NextResponse.json({
      data: response.data,
      message: response.message || "Reservation created",
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
      return NextResponse.json({ error: "Invalid reservation payload" }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to create reservation" }, { status: 500 });
  }
}
