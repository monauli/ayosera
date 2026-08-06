import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildBookingSessionKey,
  groupBookingsIntoSessions,
  hasValidPriceChange,
  hasValidReschedule,
  normalizeSessionName,
  normalizeSessionPhone,
  type BookingSessionEntry,
} from "./booking-session.ts";

type Row = {
  id: string;
  date?: string;
  time: string;
  endTime?: string;
  phone?: string;
  customer: string;
  fieldId?: string;
  service?: string;
  amountValue?: number;
  amount: string;
  status: string;
  createdAt?: string;
  previousSchedule?: { date: string; start_time: string; end_time: string };
  fieldChanges?: { field: string; from: string; to: string }[];
};

const PHONE = "08117710303";

function plusHour(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return `${String((hour + 1) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function row(overrides: Partial<Row> & { id: string; time: string }): Row {
  const amountValue = overrides.amountValue ?? 150_000;
  return {
    date: "2026-07-30",
    endTime: plusHour(overrides.time),
    phone: PHONE,
    customer: "flora",
    fieldId: "7472",
    service: "Court No 4",
    status: "Completed",
    amount: `Rp${amountValue.toLocaleString("id-ID")}`,
    ...overrides,
    amountValue,
  };
}

function sessions(entries: BookingSessionEntry<Row>[]) {
  return entries.filter((entry) => entry.type === "session");
}

// ------------------------------------------------------------ pembentukan sesi

test("1. satu slot tidak dikelompokkan", () => {
  const entries = groupBookingsIntoSessions([row({ id: "A", time: "15:00" })]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "single");
});

test("2. dua slot berurutan dikelompokkan (kasus referensi 2759 + 2761)", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "MN/2428/260729/0002759", time: "15:00", amountValue: 150_000 }),
    row({ id: "MN/2428/260729/0002761", time: "16:00", amountValue: 50_000 }),
  ]);
  assert.equal(entries.length, 1);
  const [session] = sessions(entries);
  assert.equal(session.slotCount, 2);
  assert.equal(session.startTime, "15:00");
  assert.equal(session.endTime, "17:00");
  assert.equal(session.totalRevenue, 200_000);
});

test("3. tiga slot dikelompokkan dan urut naik", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "C", time: "17:00" }),
    row({ id: "A", time: "15:00" }),
    row({ id: "B", time: "16:00" }),
  ]);
  const [session] = sessions(entries);
  assert.equal(session.slotCount, 3);
  assert.deepEqual(session.bookings.map((booking) => booking.time), ["15:00", "16:00", "17:00"]);
});

test("4. empat slot dikelompokkan", () => {
  const entries = groupBookingsIntoSessions(
    ["15:00", "16:00", "17:00", "18:00"].map((time, index) => row({ id: `S${index}`, time })),
  );
  assert.equal(sessions(entries)[0].slotCount, 4);
  assert.equal(sessions(entries)[0].totalRevenue, 600_000);
});

test("5. jam tidak berurutan tidak dikelompokkan", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00" }),
    row({ id: "B", time: "18:00" }),
  ]);
  assert.equal(sessions(entries).length, 0);
  assert.equal(entries.length, 2);
});

test("6. slot tumpang tindih dikelompokkan", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", endTime: "17:00" }),
    row({ id: "B", time: "16:00", endTime: "17:00" }),
  ]);
  assert.equal(sessions(entries)[0].slotCount, 2);
});

// ------------------------------------------------------------------- identitas

test("7. nama sama tapi telepon berbeda tidak dikelompokkan", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00" }),
    row({ id: "B", time: "16:00", phone: "08129999888" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("8. telepon sama tapi nama berbeda tidak dikelompokkan (penjaga nama)", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", customer: "flora" }),
    row({ id: "B", time: "16:00", customer: "dinar" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("9. telepon kosong tidak pernah dikelompokkan", () => {
  assert.equal(buildBookingSessionKey(row({ id: "A", time: "15:00", phone: "" })), null);
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", phone: "" }),
    row({ id: "B", time: "16:00", phone: "" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("10. telepon terlalu pendek tidak dikelompokkan", () => {
  assert.equal(normalizeSessionPhone("0812345"), "");
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", phone: "0812345" }),
    row({ id: "B", time: "16:00", phone: "0812345" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("11. telepon placeholder (semua digit sama) tidak dikelompokkan", () => {
  assert.equal(normalizeSessionPhone("0000000000"), "");
  assert.equal(normalizeSessionPhone("9999999999"), "");
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", phone: "0000000000" }),
    row({ id: "B", time: "16:00", phone: "0000000000" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("11b. normalisasi prefix 62 dan pemisah konsisten", () => {
  assert.equal(normalizeSessionPhone("+62 811-7710-303"), PHONE);
  assert.equal(normalizeSessionPhone("628117710303"), PHONE);
  assert.equal(normalizeSessionName("  Flora   Dewi "), "flora dewi");
});

test("12. court berbeda tidak dikelompokkan (booking paralel tetap terpisah)", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", fieldId: "7472" }),
    row({ id: "B", time: "16:00", fieldId: "7473" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("12b. field_name tidak pernah dipakai sebagai kunci grouping", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", fieldId: "7472", service: "Court No 4" }),
    row({ id: "B", time: "16:00", fieldId: "7473", service: "Court No 4" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("13. tanggal berbeda tidak dikelompokkan", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", date: "2026-07-30" }),
    row({ id: "B", time: "16:00", date: "2026-07-31" }),
  ]);
  assert.equal(sessions(entries).length, 0);
});

test("14. created_at berjauhan tetap dikelompokkan bila slot berkelanjutan (B′ longgar)", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", createdAt: "2026-07-20T01:00:00.000000Z" }),
    row({ id: "B", time: "16:00", createdAt: "2026-07-29T13:54:23.000000Z" }),
  ]);
  assert.equal(sessions(entries)[0].slotCount, 2);
});

// ----------------------------------------------------------------- total sesi

test("15. cancel sebagian: total mengikuti getRevenueAmount (cancelled tidak dihitung)", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", amountValue: 150_000 }),
    row({ id: "B", time: "16:00", amountValue: 50_000, status: "Cancelled" }),
  ]);
  const [session] = sessions(entries);
  assert.equal(session.slotCount, 2, "slot cancelled tetap tampil di dalam sesi");
  assert.equal(session.totalRevenue, 150_000);
});

test("16. seluruh slot cancelled: total sesi Rp0 tapi tetap dikelompokkan", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", status: "Cancelled" }),
    row({ id: "B", time: "16:00", status: "Cancelled" }),
  ]);
  const [session] = sessions(entries);
  assert.equal(session.slotCount, 2);
  assert.equal(session.totalRevenue, 0);
});

test("17. slot Rp0 tidak menambah total", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", amountValue: 150_000 }),
    row({ id: "B", time: "16:00", amountValue: 0 }),
  ]);
  assert.equal(sessions(entries)[0].totalRevenue, 150_000);
});

test("18. slot melewati tengah malam tetap tersambung", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "22:00", endTime: "23:00" }),
    row({ id: "B", time: "23:00", endTime: "00:00" }),
  ]);
  const [session] = sessions(entries);
  assert.equal(session.slotCount, 2);
  assert.equal(session.endTime, "00:00");
});

test("19. cancelled + booking pengganti pada jam sama tidak double count", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "A", time: "22:00", amountValue: 150_000, status: "Cancelled" }),
    row({ id: "B", time: "22:00", amountValue: 150_000, status: "Completed" }),
  ]);
  const [session] = sessions(entries);
  assert.equal(session.slotCount, 2);
  assert.equal(session.totalRevenue, 150_000);
});

test("20. setiap booking muncul tepat sekali di hasil", () => {
  const input = [
    row({ id: "A", time: "15:00" }),
    row({ id: "B", time: "16:00" }),
    row({ id: "C", time: "19:00" }),
    row({ id: "D", time: "10:00", phone: "" }),
  ];
  const entries = groupBookingsIntoSessions(input);
  const seen = entries.flatMap((entry) => (entry.type === "session" ? entry.bookings.map((b) => b.id) : [entry.booking.id]));
  assert.equal(seen.length, input.length);
  assert.deepEqual([...seen].sort(), input.map((b) => b.id).sort());
});

test("21. urutan input acak menghasilkan grouping identik (deterministik)", () => {
  const input = [
    row({ id: "A", time: "15:00" }),
    row({ id: "B", time: "16:00" }),
    row({ id: "C", time: "17:00" }),
  ];
  const straight = groupBookingsIntoSessions(input);
  const shuffled = groupBookingsIntoSessions([input[2], input[0], input[1]]);
  const shape = (entries: BookingSessionEntry<Row>[]) =>
    entries.map((entry) => (entry.type === "session" ? { id: entry.id, slots: entry.bookings.map((b) => b.id), total: entry.totalRevenue } : entry.booking.id));
  assert.deepEqual(shape(straight), shape(shuffled));
});

// ---------------------------------------------------------------------- badge

test("22. badge Reschedule hanya bila previousSchedule berbeda dari jadwal saat ini", () => {
  const changed = row({ id: "A", time: "16:00", previousSchedule: { date: "2026-07-30", start_time: "09:00:00", end_time: "10:00:00" } });
  const stale = row({ id: "B", time: "16:00", previousSchedule: { date: "2026-07-30", start_time: "16:00:00", end_time: "17:00:00" } });
  assert.equal(hasValidReschedule(changed), true);
  assert.equal(hasValidReschedule(stale), false, "jadwal lama sama dengan sekarang = metadata basi");
  assert.equal(hasValidReschedule(row({ id: "C", time: "16:00" })), false);
});

test("23. badge Harga Diubah hanya bila nilai tujuan sama dengan nominal slot saat ini", () => {
  const valid = row({ id: "A", time: "16:00", amountValue: 50_000, fieldChanges: [{ field: "Harga", from: "Rp 150.000", to: "Rp 50.000" }] });
  const stale = row({ id: "B", time: "16:00", amountValue: 220_000, fieldChanges: [{ field: "Harga", from: "Rp 150.000", to: "Rp 50.000" }] });
  assert.equal(hasValidPriceChange(valid), true);
  assert.equal(hasValidPriceChange(stale), false, "nilai tujuan tidak cocok = metadata basi");
  assert.equal(hasValidPriceChange(row({ id: "C", time: "16:00", fieldChanges: [{ field: "Status", from: "SUCCESS", to: "CANCELLED" }] })), false);
});

test("24. badge Dibatalkan Sebagian dihitung dari status saat ini", () => {
  const partial = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00" }),
    row({ id: "B", time: "16:00", status: "Cancelled" }),
  ]);
  assert.deepEqual(sessions(partial)[0].badges, ["Dibatalkan Sebagian"]);

  const allCancelled = groupBookingsIntoSessions([
    row({ id: "A", time: "15:00", status: "Cancelled" }),
    row({ id: "B", time: "16:00", status: "Cancelled" }),
  ]);
  assert.deepEqual(sessions(allCancelled)[0].badges, [], "seluruhnya cancelled bukan 'sebagian'");
});

test("25. metadata basi tidak menghasilkan badge apa pun", () => {
  const entries = groupBookingsIntoSessions([
    // previousSchedule identik dengan jadwal sekarang + fieldChanges harga yang
    // nilainya tidak cocok dengan nominal sekarang: keduanya jejak sync lama.
    row({ id: "A", time: "15:00", amountValue: 150_000, previousSchedule: { date: "2026-07-30", start_time: "15:00:00", end_time: "16:00:00" }, fieldChanges: [{ field: "Harga", from: "Rp 0", to: "Rp 999.000" }] }),
    row({ id: "B", time: "16:00", amountValue: 150_000, fieldChanges: [{ field: "Status", from: "SUCCESS", to: "CANCELLED" }] }),
  ]);
  assert.deepEqual(sessions(entries)[0].badges, []);
});

test("26. session id stabil, DOM-safe, dan tidak memakai indeks array", () => {
  const entries = groupBookingsIntoSessions([
    row({ id: "MN/2428/260729/0002759", time: "15:00" }),
    row({ id: "MN/2428/260729/0002761", time: "16:00" }),
  ]);
  const [session] = sessions(entries);
  assert.equal(session.id, "booking-session-MN-2428-260729-0002759");
  assert.match(session.id, /^[A-Za-z0-9-]+$/);
});

// ---------------------------------------------------------------------------
// UI text & audit decision (components/booking-session-row.tsx) — diverifikasi
// lewat inspeksi source (pola yang sama dipakai test UI lain di repo ini,
// mis. lib/olsera-inventory-ui.test.ts), karena tidak ada harness React
// render di repo ini.
// ---------------------------------------------------------------------------

function rowComponentSource() {
  return readFileSync(new URL("../components/booking-session-row.tsx", import.meta.url), "utf8");
}

test("27. label ringkas 'X slot' sudah tidak tampil, diganti 'X sesi' (1 sesi maupun 2+ sesi memakai kata yang sama)", () => {
  const source = rowComponentSource();
  assert.equal(source.includes("slotCount} slot"), false, "teks 'X slot' seharusnya sudah tidak ada");
  assert.ok(source.includes("{session.slotCount} sesi"), "label ringkas harus memakai 'sesi'");
  assert.ok(source.includes("${session.slotCount} sesi untuk"), "aria-label harus memakai 'sesi'");
  assert.equal(source.includes("slot untuk"), false, "aria-label lama 'slot untuk' seharusnya sudah tidak ada");
});

test("28. grouping/jumlah booking tidak disentuh oleh perubahan label — component tetap memakai slotCount dari lib/booking-session.ts apa adanya", () => {
  const source = rowComponentSource();
  // slotCount tetap field data yang sama (angka sesi sebenarnya dari grouping), hanya teksnya yang berubah.
  assert.ok(source.includes("session.slotCount"));
  assert.equal(source.includes("groupBookingsIntoSessions"), false, "component presentasi tidak boleh memanggil grouping sendiri");
});

test("29. badge Reschedule tetap ada, badge Harga Diubah tidak berubah (belum diganti 'Nominal Berubah')", () => {
  const source = rowComponentSource();
  assert.ok(source.includes('{hasValidReschedule(booking) && ('));
  assert.ok(source.includes('<Badge variant="warning">Reschedule</Badge>'));
  assert.ok(source.includes('{hasValidPriceChange(booking) && <Badge variant="warning">Harga Diubah</Badge>}'));
  assert.equal(source.includes("Nominal Berubah"), false, "label Harga Diubah belum boleh diganti pada task ini");
});

test("30. Jadwal awal/sekarang HANYA dirender bila hasValidReschedule DAN previousSchedule benar-benar ada (tidak ada jadwal palsu)", () => {
  const source = rowComponentSource();
  assert.ok(source.includes("Jadwal awal:"));
  assert.ok(source.includes("Jadwal sekarang:"));
  // Guard ganda: badge Reschedule dan blok jadwal berada di dalam kondisi hasValidReschedule yang sama,
  // dan blok jadwal itu sendiri masih digerbang oleh keberadaan booking.previousSchedule.
  const rescheduleBlock = source.slice(source.indexOf("{hasValidReschedule(booking) && ("), source.indexOf("{hasValidPriceChange(booking)"));
  assert.ok(rescheduleBlock.includes("booking.previousSchedule &&"), "blok jadwal awal/sekarang harus digerbang oleh booking.previousSchedule");
  assert.ok(rescheduleBlock.includes("Jadwal awal:"));
  assert.ok(rescheduleBlock.includes("Jadwal sekarang:"));
});

test("31. jadwal awal/sekarang memakai field previousSchedule/date/time yang SUDAH ADA (diff snapshot sync sendiri) — bukan field baru/tebakan", () => {
  const source = rowComponentSource();
  assert.ok(source.includes("booking.previousSchedule.date"));
  assert.ok(source.includes("booking.previousSchedule.start_time.slice(0, 5)"));
  assert.ok(source.includes("booking.previousSchedule.end_time.slice(0, 5)"));
  assert.ok(source.includes("{booking.date} {booking.time}-{booking.endTime"));
});

test("32. detail pembayaran (nominal per payment/waktu dibuat/status asli AYO/metode) SENGAJA TIDAK ditampilkan — keputusan audit C, bukan lupa", () => {
  const source = rowComponentSource();
  // Tidak ada field payment-event yang diperkenalkan ke komponen presentasi ini
  // (nama field tidak akan pernah muncul di sini kecuali sungguh-sungguh dipakai/di-import).
  for (const forbidden of ["paymentNote", "paymentType", "reservationPaymentId", "booking.eventDate", "import.*ayo-payment-events"]) {
    assert.equal(new RegExp(forbidden).test(source), false, `komponen tidak boleh memakai field payment-event "${forbidden}" (data payment-event belum terbukti cukup)`);
  }
  // Keputusan diaudit didokumentasikan di komentar file, bukan diam-diam dihilangkan.
  assert.ok(source.includes("Karena itu"));
  assert.ok(source.includes("detail pembayaran per booking SENGAJA TIDAK ditampilkan"));
});

test("33. tidak ada total/nominal baru dihitung oleh perubahan ini — totalRevenue tetap dari getRevenueAmount() existing, tidak ada rumus baru", () => {
  const source = rowComponentSource();
  assert.ok(source.includes('import { getRevenueAmount } from "@/lib/revenue";'));
  assert.equal(source.includes("totalRevenue +"), false);
  assert.equal(source.includes("reduce("), false, "komponen presentasi tidak boleh menjumlahkan ulang — total sudah dihitung di lib/booking-session.ts");
});

test("34. e2e audit script (scripts/e2e-audit.ts) diperbarui mengikuti label 'sesi' baru — tidak ada assertion basi ke 'slot' pada label tombol/aria-label", () => {
  const source = readFileSync(new URL("../scripts/e2e-audit.ts", import.meta.url), "utf8");
  assert.equal(source.includes("/detail \\d+ slot untuk/"), false);
  assert.ok(source.includes("/detail \\d+ sesi untuk/"));
  assert.equal(source.includes("/^\\d+ slot$/"), false);
  assert.ok(source.includes("/^\\d+ sesi$/"));
});
