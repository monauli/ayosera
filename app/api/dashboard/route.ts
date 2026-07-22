import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { buildBookingFilter } from "@/lib/booking-query";
import { mapStatus } from "@/lib/booking-mapper";
import { collections, type BookingDocument, withMongo } from "@/lib/mongodb";
import {
  getTransactionAmount,
  isCancelledTransaction,
  isDisplayEligibleTransaction,
} from "@/lib/revenue";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

/**
 * Analisis rule revenue dilakukan SEKALI per booking lalu dipakai ulang.
 * Sebelumnya isDisplayEligible/isCancelled/getRevenueAmount dipanggil terpisah
 * berkali-kali sehingga tiap booking di-traversal (deteksi internal/cancelled)
 * hingga 4-5x. Rule tetap identik: revenue = tampil & bukan cancelled.
 */
type AnalyzedBooking = { booking: BookingDocument; display: boolean; cancelled: boolean; revenue: number };

function analyzeBooking(booking: BookingDocument): AnalyzedBooking {
  const display = isDisplayEligibleTransaction(booking);
  const cancelled = isCancelledTransaction(booking);
  const revenue = display && !cancelled ? getTransactionAmount(booking) : 0;
  return { booking, display, cancelled, revenue };
}

// Data dashboard selalu realtime: nonaktifkan cache Next.js/Vercel.
export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  const startedAt = Date.now();
  try {
    await requireModule("dasbor");
    const { searchParams } = new URL(request.url);
    const today = todayJakarta();
    const dashboardFilter = buildBookingFilter(searchParams);
    const courtOptionParams = new URLSearchParams(searchParams);
    courtOptionParams.delete("branch");
    const courtOptionFilter = buildBookingFilter(courtOptionParams);

    const data = await withMongo(async () => {
      const { bookings, syncLogs, fields } = await collections();
      const [filteredBookings, courtNames, todayBookings, latestLogs, fieldCount] = await Promise.all([
        bookings.find(dashboardFilter).sort({ date: -1, start_time: -1 }).toArray(),
        // distinct jauh lebih ringan daripada menarik s.d. 5000 dokumen hanya untuk daftar lapangan.
        bookings.distinct("field_name", courtOptionFilter),
        bookings.find({ date: today }).sort({ start_time: 1 }).toArray(),
        syncLogs.find({}).sort({ startedAt: -1 }).limit(5).toArray(),
        fields.countDocuments({ status: "ACTIVE" }),
      ]);

      // Analisis rule revenue sekali per booking, lalu dipakai ulang di semua widget.
      const analyzedFiltered = filteredBookings.map(analyzeBooking);
      const displayFiltered = analyzedFiltered.filter((item) => item.display);
      const revenueEligible = displayFiltered.filter((item) => !item.cancelled);
      const revenueFiltered = displayFiltered.reduce((sum, item) => sum + item.revenue, 0);

      const analyzedToday = todayBookings.map(analyzeBooking);
      const displayToday = analyzedToday.filter((item) => item.display);
      const revenueToday = displayToday.reduce((sum, item) => sum + item.revenue, 0);

      const hourly = Array.from({ length: 16 }, (_, index) => {
        const hour = String(index + 6).padStart(2, "0");
        const inHour = displayToday.filter((item) => item.booking.start_time?.startsWith(hour));
        return {
          time: `${hour}:00`,
          transactions: inHour.length,
          revenue: Math.round(inHour.reduce((sum, item) => sum + item.revenue, 0) / 1_000_000),
        };
      });

      const services = Object.values(
        revenueEligible.reduce<Record<string, { name: string; branch: string; revenueValue: number; revenue: string; count: number; progress: number }>>(
          (acc, item) => {
            const name = item.booking.field_name;
            acc[name] ||= { name, branch: name, revenueValue: 0, revenue: "Rp 0", count: 0, progress: 0 };
            acc[name].revenueValue += item.revenue;
            acc[name].count += 1;
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

      // "Reservation"/"AYO Order" merepresentasikan booking yang BELUM dibayar (belum
      // final, belum cancelled) — bukan sekadar label kanal booking_source, supaya
      // booking lama yang sudah SUCCESS/FINISHED tidak nyangkut selamanya di kategori
      // ini. Kelima kategori di bawah saling eksklusif (partition dari displayFiltered)
      // agar totalnya selalu sama dengan jumlah booking pada filter aktif.
      const isFinalStatus = (item: AnalyzedBooking) => mapStatus(item.booking.status) === "Completed";
      const isPendingStatus = (item: AnalyzedBooking) => mapStatus(item.booking.status) === "Pending";
      const isUnpaid = (item: AnalyzedBooking) => !item.cancelled && !isFinalStatus(item) && !isPendingStatus(item);

      // value = RAW COUNT booking (bukan persentase) — sengaja, supaya konversi ke
      // persentase HANYA terjadi sekali, di frontend (app/page.tsx), saat dirender.
      // Mengirim persentase yang sudah dibulatkan di sini lalu dibulatkan LAGI di
      // frontend (allocateIntegerCounts) menghasilkan pembulatan ganda yang membuat
      // angka tampilan meleset dari data asli (mis. Cancelled 175 tampil jadi 169).
      const paymentBreakdown = [
        { name: "Reservation", value: displayFiltered.filter((item) => isUnpaid(item) && item.booking.booking_source === "reservation").length, color: "#ec4899" },
        { name: "AYO Order", value: displayFiltered.filter((item) => isUnpaid(item) && item.booking.booking_source === "order").length, color: "#f9a8c2" },
        { name: "Pending", value: displayFiltered.filter((item) => !item.cancelled && isPendingStatus(item)).length, color: "#f59e0b" },
        { name: "Cancelled", value: displayFiltered.filter((item) => item.cancelled).length, color: "#e11d48" },
        { name: "Completed", value: displayFiltered.filter((item) => !item.cancelled && isFinalStatus(item)).length, color: "#10b981" },
      ];

      return {
        metrics: {
          totalTransactions: displayFiltered.length,
          revenueToday: toIdrFull(revenueToday),
          revenueMonth: toIdrFull(revenueFiltered),
          activeCustomers: new Set(
            displayFiltered.map((item) => item.booking.booker_phone || item.booking.booker_email || item.booking.booker_name),
          ).size,
        },
        hourlyTransactions: hourly,
        topServices,
        paymentBreakdown,
        revenueTrend: Array.from({ length: 6 }, (_, index) => {
          const day = (index + 1) * 4;
          const amount = displayFiltered
            .filter((item) => Number(item.booking.date.slice(8, 10)) <= day)
            .reduce((sum, item) => sum + item.revenue, 0);
          return { day: String(day).padStart(2, "0"), amount: Math.round(amount / 1_000_000) };
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
        branchOptions: courtNames
          .filter((name): name is string => Boolean(name))
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ label: name, value: name })),
        _meta: { processed: filteredBookings.length },
      };
    });

    console.log(`[dashboard-api] ${Date.now() - startedAt}ms, processed ${data._meta.processed} bookings`);
    return NextResponse.json(data, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to load dashboard" }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
