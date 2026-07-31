import { getRevenueAmount, isCancelledTransaction } from "./revenue.ts";

/**
 * Booking Session — pengelompokan TAMPILAN untuk booking multi-slot yang
 * benar-benar satu rangkaian main.
 *
 * API AYO memecah satu rangkaian main menjadi satu `booking_id` per slot jam,
 * masing-masing dengan harganya sendiri (mis. 15:00–16:00 Rp150.000 dan
 * 16:00–17:00 Rp50.000 = satu sesi Rp200.000). Helper ini menyatukannya kembali
 * SECARA VISUAL saja.
 *
 * Murni & deterministik: tanpa I/O, tanpa jam sistem, tanpa env. Hasilnya TIDAK
 * PERNAH disimpan ke MongoDB, tidak menyentuh /api/transactions, dan tidak
 * mengubah satu pun perhitungan revenue — total sesi dihitung memakai
 * `getRevenueAmount()` yang sudah dipakai dashboard/export.
 *
 * Catatan istilah: payload AYO tidak punya data pembayaran sama sekali (satu-
 * satunya field uang adalah `total_price`), jadi nilai per slot disebut
 * "Nominal slot" — BUKAN DP/pelunasan/uang muka.
 */

/** Bentuk minimal baris transaksi yang dibutuhkan grouping (structural, bukan duplikasi tipe UI). */
export type SessionBooking = {
  id: string;
  date?: string;
  time: string;
  endTime?: string;
  phone?: string;
  customer: string;
  fieldId?: string;
  /** Nama lapangan — TAMPILAN saja, tidak pernah dipakai sebagai kunci grouping. */
  service?: string;
  amountValue?: number;
  status: string;
  previousSchedule?: { date: string; start_time: string; end_time: string };
  fieldChanges?: { field: string; from: string; to: string }[];
};

export type SessionBadge = "Dibatalkan Sebagian" | "Reschedule" | "Harga Diubah";

export type BookingSession<T extends SessionBooking> = {
  type: "session";
  /** Stabil untuk input yang sama & aman dipakai sebagai id DOM/aria-controls. */
  id: string;
  bookings: T[];
  customer: string;
  /** Telepon ternormalisasi — kunci internal, bukan untuk ditampilkan. */
  phoneKey: string;
  /** Telepon apa adanya dari baris pertama, untuk kolom Telepon. */
  displayPhone: string;
  date: string;
  fieldId: string;
  fieldName: string;
  startTime: string;
  endTime: string;
  slotCount: number;
  /** Total sesi dari getRevenueAmount() — cancelled/Rp0/internal mengikuti engine revenue existing. */
  totalRevenue: number;
  statusSummary: string;
  badges: SessionBadge[];
};

export type BookingSessionEntry<T extends SessionBooking> = { type: "single"; booking: T } | BookingSession<T>;

// --------------------------------------------------------------- normalisasi

const PLACEHOLDER_PHONE = /^0(\d)\1+$/;

/**
 * Telepon yang layak dipakai sebagai identitas. Mengembalikan "" bila tidak
 * layak — dan tanpa telepon layak sebuah booking TIDAK PERNAH dikelompokkan.
 * Nomor placeholder (semua digit sama) ditolak: pada data nyata satu nilai
 * placeholder dipakai puluhan nama berbeda.
 */
export function normalizeSessionPhone(value: unknown): string {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("62")) digits = `0${digits.slice(2)}`;
  if (!digits.startsWith("0")) digits = `0${digits}`;
  if (digits.length < 10) return "";
  if (PLACEHOLDER_PHONE.test(digits)) return "";
  return digits;
}

/** Nama dipakai HANYA sebagai penjaga negatif (memecah sesi), tidak pernah sebagai kunci. */
export function normalizeSessionName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** "HH:MM[:SS]" -> menit sejak tengah malam. */
export function toMinutes(value: unknown): number {
  const [hour, minute] = String(value ?? "").split(":");
  return (Number(hour) || 0) * 60 + (Number(minute) || 0);
}

/** Menit selesai; slot yang melewati tengah malam (end <= start) ditambah 1 hari. */
export function endMinutesOf(booking: SessionBooking): number {
  const start = toMinutes(booking.time);
  const end = toMinutes(booking.endTime);
  return end <= start ? end + 1440 : end;
}

/**
 * Kunci kandidat sesi: telepon layak + tanggal main + court.
 * `field_id` sengaja WAJIB — `field_name` hanya untuk tampilan, tidak pernah
 * dipakai sebagai kunci. Mengembalikan null bila booking tidak boleh digabung.
 */
export function buildBookingSessionKey(booking: SessionBooking): string | null {
  const phone = normalizeSessionPhone(booking.phone);
  if (!phone) return null;
  const date = String(booking.date ?? "").trim();
  if (!date) return null;
  const fieldId = String(booking.fieldId ?? "").trim();
  if (!fieldId || fieldId === "-" || fieldId === "0") return null;
  return `${phone}|${date}|${fieldId}`;
}

// -------------------------------------------------------------------- badge

/** "Rp 150.000" -> 150000. Dipakai hanya untuk memvalidasi metadata perubahan. */
function parseRupiah(value: unknown): number | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

/**
 * Reschedule hanya bila `previousSchedule` benar-benar berbeda dari jadwal saat
 * ini. `previousSchedule`/`fieldChanges` TIDAK PERNAH dibersihkan saat upsert,
 * jadi jejak lama bisa menetap di dokumen — tanpa perbandingan ini badge akan
 * tampil untuk perubahan yang sudah tidak berlaku.
 */
export function hasValidReschedule(booking: SessionBooking): boolean {
  const previous = booking.previousSchedule;
  if (!previous) return false;
  const sameDate = String(previous.date ?? "") === String(booking.date ?? "");
  const sameStart = toMinutes(previous.start_time) === toMinutes(booking.time);
  const sameEnd = toMinutes(previous.end_time) === toMinutes(booking.endTime);
  return !(sameDate && sameStart && sameEnd);
}

/**
 * Harga Diubah hanya bila nilai TUJUAN perubahan sama dengan nominal slot saat
 * ini. Bila tidak cocok, entri itu jejak basi dari sync lama dan diabaikan.
 */
export function hasValidPriceChange(booking: SessionBooking): boolean {
  const change = booking.fieldChanges?.find((entry) => entry.field === "Harga");
  if (!change) return false;
  const target = parseRupiah(change.to);
  return target !== null && target === Number(booking.amountValue ?? NaN);
}

// Badge "Pindah Court" TIDAK diimplementasikan: `previousSchedule` hanya
// menyimpan date/start_time/end_time — tidak ada jejak court lama di mana pun,
// jadi tidak ada cara memvalidasinya secara aman. Menyimpulkannya dari booking
// lintas court akan salah (pada data nyata ada ratusan pasangan lintas court
// yang murni main berurutan, bukan pindah court).

// ------------------------------------------------------------------ grouping

function isCancelled(booking: SessionBooking): boolean {
  return isCancelledTransaction(booking as Record<string, unknown>);
}

/** Id DOM-safe & stabil: diturunkan dari booking pertama sesi (unik per sesi). */
function sessionIdFor(booking: SessionBooking): string {
  return `booking-session-${String(booking.id).replace(/[^A-Za-z0-9]+/g, "-")}`;
}

function buildSession<T extends SessionBooking>(chain: T[], key: string): BookingSession<T> {
  const first = chain[0];
  const last = chain.reduce((latest, booking) => (endMinutesOf(booking) > endMinutesOf(latest) ? booking : latest), first);
  const cancelled = chain.filter(isCancelled);
  const active = chain.filter((booking) => !isCancelled(booking));

  const badges: SessionBadge[] = [];
  if (cancelled.length && active.length) badges.push("Dibatalkan Sebagian");
  if (chain.some(hasValidReschedule)) badges.push("Reschedule");
  if (chain.some(hasValidPriceChange)) badges.push("Harga Diubah");

  return {
    type: "session",
    id: sessionIdFor(first),
    bookings: chain,
    customer: first.customer,
    phoneKey: key.split("|")[0] ?? "",
    displayPhone: String(first.phone ?? ""),
    date: String(first.date ?? ""),
    fieldId: String(first.fieldId ?? ""),
    fieldName: String(first.service ?? ""),
    startTime: first.time,
    endTime: last.endTime ?? last.time,
    slotCount: chain.length,
    // Satu-satunya sumber angka: helper revenue existing. Tidak ada rumus baru.
    totalRevenue: chain.reduce((total, booking) => total + getRevenueAmount(booking as Record<string, unknown>), 0),
    statusSummary: (active[0] ?? first).status,
    badges,
  };
}

/**
 * Mengelompokkan baris transaksi jadi sesi. Setiap booking muncul TEPAT SEKALI
 * pada hasil — sebagai `single` atau sebagai anggota satu `session`.
 *
 * Urutan hasil mengikuti urutan input (sesi muncul di posisi anggota
 * pertamanya), sehingga sort tabel yang sedang aktif tetap terasa. Slot DI
 * DALAM sesi selalu urut naik menurut jam, apa pun sort tabelnya.
 */
export function groupBookingsIntoSessions<T extends SessionBooking>(bookings: readonly T[]): BookingSessionEntry<T>[] {
  const candidates = new Map<string, T[]>();
  const order: { key: string | null; booking: T }[] = [];

  for (const booking of bookings) {
    const key = buildBookingSessionKey(booking);
    order.push({ key, booking });
    if (!key) continue;
    const bucket = candidates.get(key);
    if (bucket) bucket.push(booking);
    else candidates.set(key, [booking]);
  }

  // Pecah tiap kandidat jadi rantai yang benar-benar bersambung.
  const sessionByBookingId = new Map<string, BookingSession<T>>();
  for (const [key, bucket] of candidates) {
    const sorted = [...bucket].sort(
      (a, b) => toMinutes(a.time) - toMinutes(b.time) || endMinutesOf(a) - endMinutesOf(b) || String(a.id).localeCompare(String(b.id)),
    );

    let chain: T[] = [sorted[0]];
    let chainEnd = endMinutesOf(sorted[0]);
    let chainName = normalizeSessionName(sorted[0].customer);

    const flush = () => {
      if (chain.length < 2) return;
      const session = buildSession(chain, key);
      for (const booking of chain) sessionByBookingId.set(String(booking.id), session);
    };

    for (let index = 1; index < sorted.length; index += 1) {
      const next = sorted[index];
      // Bersambung atau tumpang tindih terhadap ujung rantai sejauh ini.
      const continues = toMinutes(next.time) <= chainEnd;
      // Nama berbeda memecah sesi (satu nomor telepon bisa dipakai bersama).
      const sameName = normalizeSessionName(next.customer) === chainName;
      if (continues && sameName) {
        chain.push(next);
        chainEnd = Math.max(chainEnd, endMinutesOf(next));
        continue;
      }
      flush();
      chain = [next];
      chainEnd = endMinutesOf(next);
      chainName = normalizeSessionName(next.customer);
    }
    flush();
  }

  const entries: BookingSessionEntry<T>[] = [];
  const emitted = new Set<string>();
  for (const { booking } of order) {
    const session = sessionByBookingId.get(String(booking.id));
    if (!session) {
      entries.push({ type: "single", booking });
      continue;
    }
    if (emitted.has(session.id)) continue;
    emitted.add(session.id);
    entries.push(session);
  }

  return entries;
}
