// Test lib/reconciliation-omzet-ledger.ts — engine murni diuji langsung
// (computeOmzetOlseraLedger, tanpa MongoDB), plus loader diuji dengan koleksi
// tiruan in-memory (DI, pola sama lib/reconciliation-court-revenue.test.ts
// sebelumnya). Dijalankan via `tsx --conditions=react-server --test` karena
// modul ini memakai "server-only".
import assert from "node:assert/strict";
import test from "node:test";

process.env.OLSERA_INTERNAL_STORE_ID = "324175";
import {
  computeAyoPaymentEventSide,
  computeOmzetOlseraLedger,
  hasOmzetActivity,
  loadOmzetLedgerMonthDetail,
  loadOmzetLedgerMonthSummary,
  loadOmzetLedgerRecentSummaries,
  OMZET_LOCK_WITHOUT_EXPLANATION_MARKER,
  recentOmzetLedgerPeriods,
  type LedgerEntryInput,
  type OmzetExplanation,
  type OmzetLedgerSourceContext,
} from "./reconciliation-omzet-ledger.ts";
import type { BookingDocument } from "./mongodb.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

type Doc = Record<string, unknown>;

function matchesFilter(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      const value = doc[key] as string | number;
      if ("$gte" in c && !(value >= (c.$gte as string | number))) return false;
      if ("$lte" in c && !(value <= (c.$lte as string | number))) return false;
      return true;
    }
    return doc[key] === cond;
  });
}

function fake<T>(docs: Array<Partial<T>>) {
  return {
    find(filter: Doc) {
      const filtered = (docs as Doc[]).filter((doc) => matchesFilter(doc, filter));
      return { toArray: async () => filtered as T[] };
    },
  };
}

function paymentEvent(identity: string, bookingId: string, amount: number): AyoPaymentEvent {
  return { identity, bookingId, amount } as AyoPaymentEvent;
}

test("payment events aktif menjadi sumber omzet AYO Juni/Juli, dedupe identity bukan booking", () => {
  const june = [paymentEvent("payment-a", "BK-1", 242_895_499), paymentEvent("payment-a", "BK-1", 242_895_499)];
  const july = [paymentEvent("dp", "BK-1", 100_000_000), paymentEvent("settlement", "BK-1", 137_491_000)];
  assert.deepEqual(computeAyoPaymentEventSide(june), { count: 1, revenue: 242_895_499 });
  assert.deepEqual(computeAyoPaymentEventSide(july), { count: 2, revenue: 237_491_000 });
});

function entry(overrides: Partial<LedgerEntryInput> & { transactionNo: string }): LedgerEntryInput {
  return { transactionDate: null, description: null, debit: 0, credit: 0, isOpeningBalance: false, ...overrides };
}

const NOW = new Date("2026-06-15T00:00:00Z"); // Bulan berjalan (Asia/Jakarta) = 2026-06

function ayo(count: number, revenue: number) {
  return { count, revenue };
}

// ---------------------------------------------------------------------------
// 1. Cocok persis
// ---------------------------------------------------------------------------
test("cocok persis: 40001 tutup buku + 40004 reklasifikasi terverifikasi, sama persis dengan AYO", () => {
  const entries40001 = [
    entry({ transactionNo: "JU001", transactionDate: "2026-05-05", credit: 8_000_000 }),
    entry({ transactionNo: "CL001", transactionDate: "2026-05-31", debit: 8_000_000 }),
  ];
  const entries40004 = [
    entry({ transactionNo: "JU002", transactionDate: "2026-05-05", credit: 500_000 }),
    entry({ transactionNo: "JU003", transactionDate: "2026-05-31", debit: 500_000 }),
  ];
  const entries21003 = [entry({ transactionNo: "JU003", transactionDate: "2026-05-31", credit: 500_000 })];

  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 8_500_000), entries40001, entries40004, entries21003, null, NOW);

  assert.equal(result.courtFees.net, 8_000_000);
  assert.equal(result.pickleball.net, 500_000);
  assert.equal(result.olseraTotal, 8_500_000);
  assert.equal(result.differenceRevenue, 0);
  assert.equal(result.pickleballVerification.verified, true);
  assert.equal(result.status, "COCOK");
});

// ---------------------------------------------------------------------------
// 2. Reklasifikasi 40004 — sebelum vs sesudah, dan verifikasi gagal bila 21003 tidak cocok
// ---------------------------------------------------------------------------
test("reklasifikasi 40004: total 'sebelum reklasifikasi' tetap mengikutkan seluruh kredit periode ini (jurnal reklas didebit, bukan dikredit)", () => {
  const entries40001 = [entry({ transactionNo: "CL010", transactionDate: "2026-05-31", debit: 0 })];
  const entries40004 = [
    entry({ transactionNo: "JU010", transactionDate: "2026-05-02", credit: 300_000 }),
    entry({ transactionNo: "JU011", transactionDate: "2026-05-20", credit: 200_000 }),
    entry({ transactionNo: "JU012", transactionDate: "2026-05-31", debit: 500_000 }), // reklas: seluruh 500rb dipindah ke 21003
  ];
  const entries21003 = [entry({ transactionNo: "JU012", transactionDate: "2026-05-31", credit: 500_000 })];

  const result = computeOmzetOlseraLedger("2026-05", ayo(0, 0), entries40001, entries40004, entries21003, null, NOW);

  assert.equal(result.pickleball.creditTotal, 500_000);
  assert.equal(result.pickleball.net, 500_000, "jurnal reklas TIDAK dikurangkan dari total 'sebelum reklasifikasi'");
  assert.equal(result.pickleball.closingEntry?.transactionNo, "JU012");
  assert.equal(result.pickleballVerification.verified, true);
});

test("reklasifikasi 40004: verifikasi GAGAL bila nominal debit 40004 tidak cocok kredit 21003 -> Perlu Dicek", () => {
  const entries40001 = [entry({ transactionNo: "CL020", transactionDate: "2026-05-31", debit: 0 })];
  const entries40004 = [
    entry({ transactionNo: "JU020", transactionDate: "2026-05-02", credit: 500_000 }),
    entry({ transactionNo: "JU021", transactionDate: "2026-05-31", debit: 500_000 }),
  ];
  // 21003 credit nominal BEDA (400rb, bukan 500rb) -> tidak cocok, tidak boleh dianggap terverifikasi.
  const entries21003 = [entry({ transactionNo: "JU021", transactionDate: "2026-05-31", credit: 400_000 })];

  const result = computeOmzetOlseraLedger("2026-05", ayo(0, 500_000), entries40001, entries40004, entries21003, null, NOW);

  assert.equal(result.pickleball.closingEntry, null, "tidak boleh menebak entry mana yang reklas bila nominal tidak cocok");
  assert.equal(result.pickleballVerification.verified, false);
  assert.equal(result.status, "PERLU_DICEK");
});

// ---------------------------------------------------------------------------
// 3. Reversal / koreksi dalam periode — dinetkan, tidak dihitung ganda
// ---------------------------------------------------------------------------
test("reversal/koreksi: debit non-reklas di tengah periode dinetkan dari total (tidak dihitung ganda)", () => {
  const entries40001 = [
    entry({ transactionNo: "JU030", transactionDate: "2026-05-02", credit: 1_000_000 }),
    entry({ transactionNo: "JU031", transactionDate: "2026-05-10", debit: 200_000, description: "koreksi salah nominal" }), // reversal/koreksi
    entry({ transactionNo: "CL030", transactionDate: "2026-05-31", debit: 800_000 }), // closing = net setelah koreksi
  ];
  const entries40004: LedgerEntryInput[] = [];
  const entries21003: LedgerEntryInput[] = [];

  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 800_000), entries40001, entries40004, entries21003, null, NOW);

  assert.equal(result.courtFees.otherDebitTotal, 200_000);
  assert.equal(result.courtFees.net, 800_000, "1.000.000 kredit - 200.000 koreksi = 800.000, BUKAN 1.000.000 (tidak boleh menghitung ganda)");
  assert.equal(result.differenceRevenue, 0);
  assert.equal(result.status, "COCOK");
});

// ---------------------------------------------------------------------------
// Duplikat dokumen ledger (Known Case Juni 2026: seluruh baris tersimpan dobel di MongoDB)
// ---------------------------------------------------------------------------
test("duplikat: baris ledger identik yang tersimpan dobel HANYA dihitung sekali", () => {
  const duplicated = entry({ transactionNo: "DF001", transactionDate: "2026-06-01", credit: 300_000 });
  const entries40001 = [duplicated, { ...duplicated }, entry({ transactionNo: "CL040", transactionDate: "2026-06-30", debit: 300_000 })];

  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 300_000), entries40001, [], [], null, NOW);

  assert.equal(result.courtFees.duplicatesRemoved, 1);
  assert.equal(result.courtFees.creditTotal, 300_000, "bukan 600.000 — dokumen kedua adalah duplikat, bukan transaksi baru");
});

// ---------------------------------------------------------------------------
// 4. Beda periode (transaksi bergeser bulan) — otomatis Perlu Dicek, HANYA jadi
//    Selisih Terjelaskan lewat penjelasan eksplisit dengan bukti jurnal nyata.
// ---------------------------------------------------------------------------
test("beda periode: selisih tanpa penjelasan -> Perlu Dicek (bukan ditebak otomatis)", () => {
  const entries40001 = [
    entry({ transactionNo: "JU050", transactionDate: "2026-05-05", credit: 1_000_000 }),
    entry({ transactionNo: "CL050", transactionDate: "2026-05-31", debit: 1_000_000 }),
  ];
  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 700_000), entries40001, [], [], null, NOW);

  assert.equal(result.differenceRevenue, 300_000);
  assert.equal(result.status, "PERLU_DICEK");
});

test("beda periode: penjelasan eksplisit dengan bukti jurnal nyata (nominal sama persis) -> Selisih Terjelaskan", () => {
  const entries40001 = [
    entry({ transactionNo: "JU051", transactionDate: "2026-05-05", credit: 1_000_000 }),
    entry({ transactionNo: "CL051", transactionDate: "2026-05-31", debit: 1_000_000 }),
  ];
  const explanation: OmzetExplanation = {
    evidenceType: "shifted-period",
    description: "Transaksi BK/2428/260430 dibayar 1 Mei, dibukukan Olsera di bulan April.",
    explainedAmount: 300_000,
    createdBy: "user-1",
    createdAt: NOW,
    updatedAt: NOW,
    locked: false,
    lockedBy: null,
    lockedAt: null,
  };
  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 700_000), entries40001, [], [], explanation, NOW);

  assert.equal(result.status, "SELISIH_TERJELASKAN");
});

test("penjelasan dengan nominal TIDAK sama persis dengan selisih saat ini -> tetap Perlu Dicek (tidak ada toleransi)", () => {
  const entries40001 = [
    entry({ transactionNo: "JU052", transactionDate: "2026-05-05", credit: 1_000_000 }),
    entry({ transactionNo: "CL052", transactionDate: "2026-05-31", debit: 1_000_000 }),
  ];
  const stale: OmzetExplanation = { evidenceType: "correction", description: "nominal basi", explainedAmount: 250_000, createdBy: "u", createdAt: NOW, updatedAt: NOW, locked: false, lockedBy: null, lockedAt: null };
  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 700_000), entries40001, [], [], stale, NOW);

  assert.equal(result.differenceRevenue, 300_000);
  assert.equal(result.status, "PERLU_DICEK");
});

// ---------------------------------------------------------------------------
// 4b. Fitur Lock+Berita Acara — locked:true membekukan status, TIDAK PERNAH
// di-recompute dari differenceRevenue/dataAvailable/ambiguitas terkini.
// ---------------------------------------------------------------------------
test("locked:true tetap SELISIH_TERJELASKAN meski explainedAmount SUDAH TIDAK sama dengan differenceRevenue saat ini (Berita Acara otoritatif)", () => {
  const entries40001 = [
    entry({ transactionNo: "JU053", transactionDate: "2026-05-05", credit: 1_000_000 }),
    entry({ transactionNo: "CL053", transactionDate: "2026-05-31", debit: 1_000_000 }),
  ];
  // differenceRevenue saat ini = 300_000 (sama seperti test di atas), tapi
  // explainedAmount yang dikunci sengaja BEDA (250_000) — mensimulasikan
  // re-sync/koreksi ledger susulan SETELAH periode dikunci. Tanpa cabang
  // locked, ini akan jatuh ke PERLU_DICEK (lihat test "nominal TIDAK sama
  // persis" di atas) — DENGAN locked:true, status HARUS tetap dibekukan.
  const locked: OmzetExplanation = {
    evidenceType: "correction",
    description: "Sudah diverifikasi & ditandatangani Berita Acara.",
    explainedAmount: 250_000,
    createdBy: "user-1",
    createdAt: NOW,
    updatedAt: NOW,
    locked: true,
    lockedBy: "supervisor-1",
    lockedAt: NOW,
  };
  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 700_000), entries40001, [], [], locked, NOW);

  assert.equal(result.differenceRevenue, 300_000, "differenceRevenue tetap dihitung apa adanya, hanya STATUS yang dibekukan");
  assert.equal(result.status, "SELISIH_TERJELASKAN");
  assert.match(result.statusReason, /dikunci lewat Berita Acara/);
  assert.match(result.statusReason, /supervisor-1/);
});

test("locked:true melewati SEMUA cabang lain (bulan berjalan/data belum tersedia/ambigu) — cabang PALING AWAL di classifyStatus", () => {
  const lockedOnCurrentMonth: OmzetExplanation = {
    evidenceType: "duplicate",
    description: "Dikunci walau data ledger kosong — kasus ekstrem untuk membuktikan urutan cabang.",
    explainedAmount: 999_999,
    createdBy: "user-1",
    createdAt: NOW,
    updatedAt: NOW,
    locked: true,
    lockedBy: "supervisor-2",
    lockedAt: NOW,
  };
  // Periode BERJALAN (2026-06, sama dengan NOW) + tanpa data ledger sama
  // sekali -> tanpa cabang locked ini akan BULAN_BERJALAN (baris isCurrent,
  // cabang pertama SEBELUM perubahan ini). Dengan locked:true, cabang Lock
  // HARUS menang karena ditempatkan lebih awal dari isCurrent.
  const result = computeOmzetOlseraLedger("2026-06", ayo(0, 0), [], [], [], lockedOnCurrentMonth, NOW);

  assert.equal(result.status, "SELISIH_TERJELASKAN");
  assert.notEqual(result.status, "BULAN_BERJALAN");
  assert.match(result.statusReason, /supervisor-2/);
});

// ---------------------------------------------------------------------------
// 4c. Perbaikan Lock untuk Status Cocok — note dengan penanda
// OMZET_LOCK_WITHOUT_EXPLANATION_MARKER (dikunci LANGSUNG dari Cocok, bukan
// dari penjelasan manual) HARUS tetap COCOK, BUKAN Selisih Terjelaskan.
// ---------------------------------------------------------------------------
test("locked:true dengan penanda MATCHED_NO_EXPLANATION -> status COCOK, statusReason jujur (tidak menyebut Berita Acara/kategori bukti)", () => {
  const entries40001 = [
    entry({ transactionNo: "JU054", transactionDate: "2026-05-05", credit: 1_000_000 }),
    entry({ transactionNo: "CL054", transactionDate: "2026-05-31", debit: 1_000_000 }),
  ];
  // differenceRevenue SAAT INI = 300_000 (data berubah lewat re-sync setelah
  // dikunci, sama seperti test "Berita Acara otoritatif" di atas) — status
  // HARUS tetap dibekukan ke COCOK, TIDAK jatuh ke PERLU_DICEK/SELISIH_TERJELASKAN.
  const lockedFromCocok: OmzetExplanation = {
    evidenceType: OMZET_LOCK_WITHOUT_EXPLANATION_MARKER,
    description: "Dikunci langsung dari status Cocok (selisih Rp0) — tidak ada penjelasan manual.",
    explainedAmount: 0,
    createdBy: "supervisor-3",
    createdAt: NOW,
    updatedAt: NOW,
    locked: true,
    lockedBy: "supervisor-3",
    lockedAt: NOW,
  };
  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 700_000), entries40001, [], [], lockedFromCocok, NOW);

  assert.equal(result.differenceRevenue, 300_000, "differenceRevenue tetap dihitung apa adanya, hanya STATUS yang dibekukan");
  assert.equal(result.status, "COCOK");
  assert.match(result.statusReason, /supervisor-3/);
  assert.doesNotMatch(result.statusReason, /Berita Acara/, "tidak ada Berita Acara yang dikunci untuk kasus ini — jangan menyebutnya");
  assert.doesNotMatch(result.statusReason, /Selisih/i, "bahasa status harus jujur: tidak ada selisih yang dijelaskan");
});

test("locked:true dengan penanda MATCHED_NO_EXPLANATION melewati SEMUA cabang lain (menang atas BULAN_BERJALAN) — sama seperti lock Selisih Terjelaskan", () => {
  const lockedFromCocokOnCurrentMonth: OmzetExplanation = {
    evidenceType: OMZET_LOCK_WITHOUT_EXPLANATION_MARKER,
    description: "Dikunci langsung dari status Cocok (selisih Rp0) — tidak ada penjelasan manual.",
    explainedAmount: 0,
    createdBy: "supervisor-4",
    createdAt: NOW,
    updatedAt: NOW,
    locked: true,
    lockedBy: "supervisor-4",
    lockedAt: NOW,
  };
  const result = computeOmzetOlseraLedger("2026-06", ayo(0, 0), [], [], [], lockedFromCocokOnCurrentMonth, NOW);

  assert.equal(result.status, "COCOK");
  assert.notEqual(result.status, "BULAN_BERJALAN");
  assert.match(result.statusReason, /supervisor-4/);
});

// ---------------------------------------------------------------------------
// 5. Data ledger tidak tersedia — TIDAK jatuh ke metode lama, tampil diagnostik jelas
// ---------------------------------------------------------------------------
test("data ledger tidak tersedia (belum sync): Perlu Dicek dengan diagnostik, BUKAN dianggap Rp0 cocok", () => {
  const result = computeOmzetOlseraLedger("2026-05", ayo(3, 900_000), [], [], [], null, NOW);

  assert.equal(result.dataAvailable, false);
  assert.equal(result.status, "PERLU_DICEK");
  assert.match(result.statusReason, /belum tersedia/);
});

// ---------------------------------------------------------------------------
// 6. Bulan berjalan
// ---------------------------------------------------------------------------
test("bulan berjalan (Asia/Jakarta): selalu Bulan Berjalan walau ada selisih atau data kosong", () => {
  const resultWithData = computeOmzetOlseraLedger(
    "2026-06",
    ayo(1, 100_000),
    [entry({ transactionNo: "JU060", transactionDate: "2026-06-05", credit: 999_999 })],
    [],
    [],
    null,
    NOW,
  );
  assert.equal(resultWithData.status, "BULAN_BERJALAN");

  const resultNoData = computeOmzetOlseraLedger("2026-06", ayo(0, 0), [], [], [], null, NOW);
  assert.equal(resultNoData.status, "BULAN_BERJALAN");
});

// ---------------------------------------------------------------------------
// Kandidat ambigu (>1 jurnal penutup/reklasifikasi) — jangan menebak
// ---------------------------------------------------------------------------
test("lebih dari satu kandidat jurnal penutup 40001 -> Perlu Dicek, tidak dipilih otomatis", () => {
  const entries40001 = [
    entry({ transactionNo: "CL070", transactionDate: "2026-05-15", debit: 400_000 }),
    entry({ transactionNo: "CL071", transactionDate: "2026-05-31", debit: 400_000 }),
  ];
  const result = computeOmzetOlseraLedger("2026-05", ayo(0, 0), entries40001, [], [], null, NOW);

  assert.equal(result.courtFees.closingEntry, null);
  assert.equal(result.courtFees.ambiguousCandidates.length, 2);
  assert.equal(result.status, "PERLU_DICEK");
});

// ---------------------------------------------------------------------------
// BK/MN/POS tidak pernah dipisah — engine tidak punya field/logic kategori sumber sama sekali
// ---------------------------------------------------------------------------
test("BK/MN/POS tidak pernah dipisah sebagai sumber pendapatan berbeda — hanya akun yang dibedakan", () => {
  const entries40001 = [
    entry({ transactionNo: "JU080", transactionDate: "2026-05-05", credit: 300_000, description: "BOOKING AYO TGL 05/05/2026" }),
    entry({ transactionNo: "JU081", transactionDate: "2026-05-06", credit: 200_000, description: "Walk in (no same day)" }),
    entry({ transactionNo: "DF080", transactionDate: "2026-05-07", credit: 150_000, description: "Penjualan dari POS" }),
    entry({ transactionNo: "CL080", transactionDate: "2026-05-31", debit: 650_000 }),
  ];
  const result = computeOmzetOlseraLedger("2026-05", ayo(1, 650_000), entries40001, [], [], null, NOW);
  assert.equal(result.courtFees.net, 650_000, "BK+MN+POS dijumlahkan bersama sebagai satu akun 40001, tidak dipisah");
  assert.equal(result.status, "COCOK");
});

// ---------------------------------------------------------------------------
// Loader (DI) — ringkasan & detail memakai engine yang SAMA
// ---------------------------------------------------------------------------
function context(overrides: Partial<OmzetLedgerSourceContext> = {}): OmzetLedgerSourceContext {
  return {
    bookings: fake<Pick<BookingDocument, "date" | "total_price" | "status">>([]),
    ledgerEntries: fake<LedgerEntryInput & { accountCode: string; period: string }>([]),
    loadExplanation: async () => null,
    ...overrides,
  };
}

test("loader: ringkasan dan detail bulan yang sama menghasilkan angka & status identik", async () => {
  const ctx = context({
    bookings: fake([{ date: "2026-05-10", total_price: 500_000, status: "paid" }]),
    ledgerEntries: fake([
      { storeId: 324175, accountCode: "40001", period: "2026-05", ...entry({ transactionNo: "JU090", transactionDate: "2026-05-10", credit: 500_000 }) },
      { storeId: 324175, accountCode: "40001", period: "2026-05", ...entry({ transactionNo: "CL090", transactionDate: "2026-05-31", debit: 500_000 }) },
    ]),
  });

  const summary = await loadOmzetLedgerMonthSummary("2026-05", ctx, NOW);
  const detail = await loadOmzetLedgerMonthDetail("2026-05", ctx, NOW);

  assert.deepEqual(summary, detail);
  assert.equal(summary.status, "COCOK");
});

test("recentOmzetLedgerPeriods: mundur dari bulan berjalan, menangani pergantian tahun", () => {
  assert.deepEqual(recentOmzetLedgerPeriods(3, new Date("2026-01-15T00:00:00Z")), ["2026-01", "2025-12", "2025-11"]);
});

// ---------------------------------------------------------------------------
// hasOmzetActivity — dasar penyaringan bulan kosong di ringkasan (lihat
// app/api/reconciliation/court-revenue/route.ts loadOmzetLedgerRecentSummaries)
// ---------------------------------------------------------------------------
test("hasOmzetActivity: bulan tanpa AYO, tanpa ledger, bukan bulan berjalan -> false (disembunyikan)", () => {
  const result = computeOmzetOlseraLedger("2025-09", ayo(0, 0), [], [], [], null, NOW);
  assert.equal(result.status, "PERLU_DICEK", "status tetap dihitung apa adanya oleh engine");
  assert.equal(hasOmzetActivity(result), false, "tapi TIDAK layak tampil di ringkasan — di luar cakupan data, bukan selisih nyata");
});

test("hasOmzetActivity: ada omzet AYO walau ledger Olsera belum ada -> true", () => {
  const result = computeOmzetOlseraLedger("2025-09", ayo(2, 400_000), [], [], [], null, NOW);
  assert.equal(hasOmzetActivity(result), true);
});

test("hasOmzetActivity: tidak ada AYO tapi ledger Olsera sudah ada -> true", () => {
  const entries40001 = [entry({ transactionNo: "CL100", transactionDate: "2025-09-30", debit: 0 })];
  const result = computeOmzetOlseraLedger("2025-09", ayo(0, 0), entries40001, [], [], null, NOW);
  assert.equal(hasOmzetActivity(result), true);
});

test("hasOmzetActivity: bulan berjalan SELALU true walau data masih kosong", () => {
  const result = computeOmzetOlseraLedger("2026-06", ayo(0, 0), [], [], [], null, NOW);
  assert.equal(result.status, "BULAN_BERJALAN");
  assert.equal(hasOmzetActivity(result), true);
});

// ---------------------------------------------------------------------------
// loadOmzetLedgerRecentSummaries — daftar ringkasan SUDAH difilter, dipakai
// langsung oleh endpoint /api/reconciliation/court-revenue.
// ---------------------------------------------------------------------------
test("loadOmzetLedgerRecentSummaries: bulan kosong di luar cakupan data dibuang, Feb-Jul (data+bulan berjalan) tetap tampil", async () => {
  const bookingDocs = [{ date: "2026-05-10", total_price: 500_000, status: "paid" }];
  const ledgerDocs = [
    { storeId: 324175, accountCode: "40001", period: "2026-02", ...entry({ transactionNo: "JU200", transactionDate: "2026-02-05", credit: 300_000 }) },
    { storeId: 324175, accountCode: "40001", period: "2026-02", ...entry({ transactionNo: "CL200", transactionDate: "2026-02-28", debit: 300_000 }) },
  ];
  const ctx = context({ bookings: fake(bookingDocs), ledgerEntries: fake(ledgerDocs) });

  // NOW = 2026-06-15 -> bulan berjalan 2026-06. Minta 12 bulan mundur (2025-07..2026-06).
  const items = await loadOmzetLedgerRecentSummaries(12, ctx, NOW);
  const periods = items.map((r) => r.period);

  assert.ok(periods.includes("2026-02"), "Februari punya data ledger -> tetap tampil");
  assert.ok(periods.includes("2026-05"), "Mei punya data AYO -> tetap tampil");
  assert.ok(periods.includes("2026-06"), "bulan berjalan -> selalu tampil walau kosong");
  assert.ok(!periods.includes("2025-08"), "Agustus 2025 kosong total -> dibuang dari ringkasan");
  assert.ok(!periods.includes("2026-01"), "Januari 2026 kosong total -> dibuang dari ringkasan");
  assert.equal(items.length, 3, "hanya 3 bulan yang punya aktivitas (2026-02, 2026-05, 2026-06) dari 12 bulan yang diminta");
});
