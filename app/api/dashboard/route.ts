import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildBookingFilter, toCourtOptions } from "@/lib/booking-query";
import { mapStatus } from "@/lib/booking-mapper";
import { collections, type BookingDocument, withMongo } from "@/lib/mongodb";
import {
  getRevenueAmount,
  isCancelledTransaction,
  isDisplayEligibleTransaction,
  isRevenueEligibleTransaction,
  sumRevenue,
} from "@/lib/revenue";

function toIdrFull(value: number) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  })
    .format(value)
    .replace(/\s/g, " ");
}

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);
    const today = todayJakarta();
    const dashboardFilter = buildBookingFilter(searchParams);
    const courtOptionParams = new URLSearchParams(searchParams);
    courtOptionParams.delete("branch");
    const courtOptionFilter = buildBookingFilter(courtOptionParams);

    const data = await withMongo(async () => {
      const { bookings, syncLogs, fields } = await collections();
      const [filteredBookings, courtOptionBookings, todayBookings, latestLogs, fieldCount] = await Promise.all([
        bookings.find(dashboardFilter).sort({ date: -1, start_time: -1 }).toArray(),
        bookings.find(courtOptionFilter).project<BookingDocument>({ field_name: 1 }).limit(5000).toArray(),
        bookings.find({ date: today }).sort({ start_time: 1 }).toArray(),
        syncLogs.find({}).sort({ startedAt: -1 }).limit(5).toArray(),
        fields.countDocuments({ status: "ACTIVE" }),
      ]);

      const displayFilteredBookings = filteredBookings.filter(isDisplayEligibleTransaction);
      const displayTodayBookings = todayBookings.filter(isDisplayEligibleTransaction);
      const revenueEligibleFiltered = displayFilteredBookings.filter(isRevenueEligibleTransaction);
      const revenueToday = sumRevenue(displayTodayBookings);
      const revenueFiltered = sumRevenue(displayFilteredBookings);

      const hourly = Array.from({ length: 16 }, (_, index) => {
        const hour = index + 6;
        const label = `${String(hour).padStart(2, "0")}:00`;
        const bookingsInHour = displayTodayBookings.filter((booking) =>
          booking.start_time?.startsWith(String(hour).padStart(2, "0")),
        );
        return {
          time: label,
          transactions: bookingsInHour.length,
          revenue: Math.round(sumRevenue(bookingsInHour) / 1_000_000),
        };
      });

      const services = Object.values(
        revenueEligibleFiltered.reduce<Record<string, { name: string; branch: string; revenueValue: number; revenue: string; count: number; progress: number }>>(
          (acc, booking) => {
            acc[booking.field_name] ||= {
              name: booking.field_name,
              branch: booking.field_name,
              revenueValue: 0,
              revenue: "Rp 0",
              count: 0,
              progress: 0,
            };
            acc[booking.field_name].revenueValue += getRevenueAmount(booking);
            acc[booking.field_name].count += 1;
            return acc;
          },
          {},
        ),
      )
        .sort((a, b) => b.revenueValue - a.revenueValue)
        .slice(0, 6);

      const topRevenue = services[0]?.revenueValue || 1;
      const topServices = services.map((service) => ({
        ...service,
        revenue: toIdrFull(service.revenueValue),
        progress: Math.max(8, Math.round((service.revenueValue / topRevenue) * 100)),
      }));

      const paymentBreakdown = [
        { name: "Reservation", value: displayFilteredBookings.filter((booking) => booking.booking_source === "reservation").length, color: "#ec4899" },
        { name: "AYO Order", value: displayFilteredBookings.filter((booking) => booking.booking_source === "order").length, color: "#f9a8c2" },
        { name: "Pending", value: displayFilteredBookings.filter((booking) => mapStatus(booking.status) === "Pending").length, color: "#f59e0b" },
        { name: "Cancelled", value: displayFilteredBookings.filter(isCancelledTransaction).length, color: "#e11d48" },
      ];
      const totalBreakdown = paymentBreakdown.reduce((sum, item) => sum + item.value, 0) || 1;

      return {
        metrics: {
          totalTransactions: displayFilteredBookings.length,
          revenueToday: toIdrFull(revenueToday),
          revenueMonth: toIdrFull(revenueFiltered),
          activeCustomers: new Set(displayFilteredBookings.map((booking) => booking.booker_phone || booking.booker_email || booking.booker_name)).size,
        },
        hourlyTransactions: hourly,
        topServices,
        paymentBreakdown: paymentBreakdown.map((item) => ({
          ...item,
          value: Math.round((item.value / totalBreakdown) * 100),
        })),
        revenueTrend: Array.from({ length: 6 }, (_, index) => {
          const day = String((index + 1) * 4).padStart(2, "0");
          const amount = displayFilteredBookings
            .filter((booking) => Number(booking.date.slice(8, 10)) <= Number(day))
            .reduce((sum, booking) => sum + getRevenueAmount(booking), 0);
          return { day, amount: Math.round(amount / 1_000_000) };
        }),
        occupancy: Object.values(
          todayBookings.reduce<Record<string, { branch: string; count: number }>>((acc, booking) => {
            const court = booking.field_name;
            acc[court] ||= { branch: court, count: 0 };
            acc[court].count += 1;
            return acc;
          }, {}),
        ).map((item) => ({
          branch: item.branch,
          rate: fieldCount ? Math.min(98, Math.round((item.count / (fieldCount * 8)) * 100)) : 0,
        })),
        syncEvents: latestLogs.map((log) => ({
          label: log.status === "failed" ? "Sinkronisasi gagal" : "Sinkronisasi selesai",
          detail: log.errorMessage || log.message || `${log.recordsProcessed} data diproses`,
          time: log.finishedAt.toISOString(),
          tone: log.status === "failed" ? "text-rose-600" : "text-teal-600",
        })),
        branchOptions: toCourtOptions(courtOptionBookings),
      };
    });

    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to load dashboard" }, { status: 500 });
  }
}
