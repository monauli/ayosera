// Test unit endpoint cron Inventori Olsera: auth, lock, loop step dalam satu
// invocation (fix 2026-07-30, lihat audit tmp/ai-handoff.md), deadline/max-
// iterations safety, MongoDB timeout.
//
// Catatan implementasi test: node:test `mock.fn().mock.mockImplementationOnce()`
// TANPA parameter `onCall` eksplisit TIDAK antre FIFO seperti intuisi umum
// (dibuktikan manual: dua panggilan mockImplementationOnce tanpa onCall
// berturut-turut membuat registrasi PERTAMA hilang, hanya yang TERAKHIR
// berlaku untuk panggilan berikutnya). Supaya urutan multi-step pasti benar,
// test di sini memakai antrean implementasi manual (queueStepResults) alih-
// alih menumpuk mockImplementationOnce — lebih eksplisit dan tidak bergantung
// pada detail semantik onCall.
//
// Jalankan: npm run test:cron-olsera-inventory
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import { MongoServerSelectionError } from "mongodb";

process.env.CRON_SECRET = "test-secret";

function fakeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    status: "running",
    phase: "movements",
    startDate: "2026-07-01",
    endDate: "2026-07-20",
    currentDate: "2026-07-10",
    processedDays: 0,
    totalDays: 2,
    totalProducts: 100,
    totalMovements: 50,
    createdRecords: 10,
    updatedRecords: 5,
    failedDates: [],
    errorMessage: null,
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: null,
    isStale: false,
    lastHeartbeatAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

type StepOutcome = { done: boolean; run: ReturnType<typeof fakeRun> } | { error: string };

const startInventorySyncMock = mock.fn(async () => fakeRun({ phase: "products", processedDays: 0, totalDays: 2 }));
const stepInventorySyncMock = mock.fn(async (): Promise<StepOutcome> => ({ done: false, run: fakeRun({ processedDays: 1 }) }));

mock.module("@/lib/olsera-inventory", {
  namedExports: {
    startInventorySync: startInventorySyncMock,
    stepInventorySync: stepInventorySyncMock,
  },
});

const acquireOlseraSyncLockMock = mock.fn(async () => ({ ok: true, runId: "run-inventory-lock-1" }));
const releaseOlseraSyncLockMock = mock.fn(async (_runId: string) => true);

mock.module("@/lib/olsera-cron-lock", {
  namedExports: {
    acquireOlseraSyncLock: acquireOlseraSyncLockMock,
    releaseOlseraSyncLock: releaseOlseraSyncLockMock,
  },
});

mock.module("@/lib/february-historical-migration", {
  namedExports: { runFebruaryHistoricalMigration: mock.fn(async () => ({ status: "skipped" })) },
});

const { runOlseraInventoryCron, ROUTE_MAX_DURATION_MS, LOOP_BUDGET_MS, MAX_STEP_ITERATIONS } = await import("./cron-olsera-inventory.ts");

/** Antrean implementasi manual untuk stepInventorySyncMock — lihat catatan di atas soal mockImplementationOnce. */
function queueStepResults(...results: (StepOutcome | (() => StepOutcome))[]) {
  const queue = [...results];
  stepInventorySyncMock.mock.mockImplementation(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("queueStepResults: dipanggil lebih banyak dari yang diantisipasi test ini");
    return typeof next === "function" ? next() : next;
  });
}

function resetMocks() {
  startInventorySyncMock.mock.resetCalls();
  stepInventorySyncMock.mock.resetCalls();
  acquireOlseraSyncLockMock.mock.resetCalls();
  releaseOlseraSyncLockMock.mock.resetCalls();
  startInventorySyncMock.mock.mockImplementation(async () => fakeRun({ phase: "products", processedDays: 0, totalDays: 2 }));
  stepInventorySyncMock.mock.mockImplementation(async () => ({ done: false, run: fakeRun({ processedDays: 1 }) }));
  acquireOlseraSyncLockMock.mock.mockImplementation(async () => ({ ok: true, runId: "run-inventory-lock-1" }));
  releaseOlseraSyncLockMock.mock.mockImplementation(async () => true);
}

test("401 bila header Authorization salah", async () => {
  resetMocks();
  const res = await runOlseraInventoryCron("Bearer salah");
  assert.equal(res.status, 401);
});

test("409 sync-in-progress bila lock sedang dipegang cron/manual lain — step tidak pernah dipanggil", async () => {
  resetMocks();
  acquireOlseraSyncLockMock.mock.mockImplementationOnce(async () => ({
    ok: false,
    activeModule: "financial",
    runId: "run-financial-2",
  }));
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { status: "sync-in-progress", activeModule: "financial", runId: "run-financial-2" });
  assert.equal(stepInventorySyncMock.mock.callCount(), 0);
});

test("satu invocation melewati fase products lalu memproses seluruh movements sampai selesai (success) — TIDAK menunggu invocation berikutnya", async () => {
  resetMocks();
  // step1: fase products selesai -> phase movements. step2: tanggal movements
  // pertama. step3: tanggal movements terakhir -> done:true, status success.
  queueStepResults(
    { done: false, run: fakeRun({ phase: "movements", processedDays: 0, totalDays: 2 }) },
    { done: false, run: fakeRun({ phase: "movements", processedDays: 1, totalDays: 2 }) },
    { done: true, run: fakeRun({ phase: "done", status: "success", processedDays: 2, totalDays: 2, currentDate: null }) },
  );

  const res = await runOlseraInventoryCron("Bearer test-secret");

  assert.equal(res.status, 200);
  assert.equal(
    startInventorySyncMock.mock.callCount(),
    1,
    "startInventorySync HANYA dipanggil sekali per invocation — loop tidak pernah membuat run baru per iterasi",
  );
  assert.equal(stepInventorySyncMock.mock.callCount(), 3);
  assert.equal(res.body.done, true);
  assert.equal(res.body.status, "success");
  assert.equal(res.body.iterations, 3);
  assert.equal(res.body.continuation, "none");
  assert.equal(res.body.nextCheckpoint, null);
});

test("loop berhenti begitu step melaporkan done:true, tidak memanggil step lagi setelahnya", async () => {
  resetMocks();
  queueStepResults({
    done: true,
    run: fakeRun({ phase: "done", status: "partial", processedDays: 1, totalDays: 1, failedDates: ["2026-07-10"] }),
  });
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(stepInventorySyncMock.mock.callCount(), 1);
  assert.equal(res.body.done, true);
  assert.equal(res.body.status, "partial");
  assert.equal(res.body.continuation, "none");
});

test("deadline: loop berhenti aman sebelum maxDuration, run TIDAK ditandai gagal, response menjelaskan pending continuation", async (t) => {
  resetMocks();
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    // Step pertama "menghabiskan" waktu jauh melewati safety budget (maxDuration
    // route 300s dikurangi buffer) — loop harus berhenti SEBELUM memanggil step
    // kedua, bukan di tengah step yang sedang jalan. queueStepResults sendiri
    // melempar bila dipanggil lebih dari sekali (hanya satu entri diantre) —
    // itu sudah jadi jaring pengaman "tidak boleh dipanggil lagi".
    queueStepResults(() => {
      t.mock.timers.tick(280_000);
      return { done: false, run: fakeRun({ phase: "movements", processedDays: 1, totalDays: 50 }) };
    });

    const res = await runOlseraInventoryCron("Bearer test-secret");

    assert.equal(res.status, 200);
    assert.equal(stepInventorySyncMock.mock.callCount(), 1, "loop berhenti sebelum iterasi kedua");
    assert.equal(res.body.iterations, 1);
    assert.equal(res.body.done, false);
    assert.equal(res.body.status, "running", "run TETAP running, bukan failed/partial palsu");
    assert.equal(res.body.success, true, "deadline BUKAN kegagalan");
    assert.equal(res.body.continuation, "deadline");
    assert.equal(res.body.nextCheckpoint, "2026-07-10");
    assert.match(String(res.body.message), /invocation cron berikutnya/);
  } finally {
    t.mock.timers.reset();
  }
});

test("max-iterations: loop tetap berhenti (tidak infinite) walau step selalu done:false dan waktu tidak maju", async () => {
  resetMocks();
  // Step SELALU melapor belum selesai, dan waktu (Date.now() nyata, tidak
  // di-fake) nyaris tidak bergerak dalam durasi test — hanya batas iterasi
  // yang bisa menghentikan loop ini.
  stepInventorySyncMock.mock.mockImplementation(async () => ({
    done: false,
    run: fakeRun({ phase: "movements", processedDays: 1, totalDays: 999_999 }),
  }));

  const res = await runOlseraInventoryCron("Bearer test-secret");

  assert.equal(res.status, 200);
  assert.equal(res.body.continuation, "max-iterations");
  assert.equal(res.body.done, false);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, "running");
  const iterations = res.body.iterations as number;
  assert.ok(iterations > 0 && iterations < 10_000, `iterations harus berhenti di batas wajar, dapat ${iterations}`);
  assert.equal(stepInventorySyncMock.mock.callCount(), iterations);
});

test("step gagal (\"error\" pada hasil) setelah beberapa iterasi -> status failed aman, tanpa raw payload, loop berhenti", async () => {
  resetMocks();
  queueStepResults(
    { done: false, run: fakeRun({ phase: "movements", processedDays: 1, totalDays: 2 }) },
    { error: "Tidak ada sync inventori yang sedang berjalan." },
  );

  const res = await runOlseraInventoryCron("Bearer test-secret");

  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.status, "failed");
  assert.equal(res.body.safeErrorCode, "step-failed");
  assert.equal(res.body.continuation, "none");
  assert.equal(stepInventorySyncMock.mock.callCount(), 2, "loop berhenti tepat saat error, tidak lanjut ke iterasi ketiga");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1, "lock tetap dilepas meski step gagal");
});

test("resume: run yang dikembalikan startInventorySync (checkpoint lama) dipakai apa adanya — orkestrasi tidak membuat/menimpa run", async () => {
  resetMocks();
  // Simulasikan startInventorySync yang MELANJUTKAN checkpoint lama (mis. run
  // stale sebelumnya sudah ditutup & digantikan run baru OLEH startInventorySync
  // sendiri — logika itu ada di lib/olsera-inventory.ts, tidak diduplikasi di
  // sini). Orkestrasi cron harus mempercayai run yang dikembalikan apa adanya.
  startInventorySyncMock.mock.mockImplementationOnce(async () => fakeRun({ phase: "movements", processedDays: 5, totalDays: 8 }));
  queueStepResults({ done: true, run: fakeRun({ phase: "done", status: "success", processedDays: 8, totalDays: 8 }) });

  const res = await runOlseraInventoryCron("Bearer test-secret");

  assert.equal(startInventorySyncMock.mock.callCount(), 1);
  assert.equal(stepInventorySyncMock.mock.callCount(), 1, "langsung lanjut dari processedDays=5, bukan mengulang dari 0");
  assert.equal(res.body.done, true);
  assert.equal(res.body.status, "success");
});

test("MongoDB timeout saat start -> HTTP 504 terstruktur, lock tetap dilepas, step tidak pernah dipanggil", async () => {
  resetMocks();
  startInventorySyncMock.mock.mockImplementationOnce(async () => {
    throw new MongoServerSelectionError("Server selection timed out after 5000 ms", {} as never);
  });
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(res.status, 504);
  assert.equal(res.body.safeErrorCode, "mongodb-timeout");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
  assert.equal(stepInventorySyncMock.mock.callCount(), 0);
});

test("exception tak terduga di tengah loop -> ditangkap, lock tetap dilepas (finally selalu jalan)", async () => {
  resetMocks();
  queueStepResults(
    { done: false, run: fakeRun({ phase: "movements", processedDays: 1, totalDays: 3 }) },
    () => {
      throw new Error("kegagalan tak terduga di tengah loop");
    },
  );

  const res = await runOlseraInventoryCron("Bearer test-secret");

  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.status, "failed");
  assert.equal(res.body.safeErrorCode, "upstream-error");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
});

// --- Review tambahan (final review sebelum commit/deploy) ---

test("konsistensi: ROUTE_MAX_DURATION_MS harus sama persis dengan maxDuration (detik) di app/api/cron/olsera/inventory/route.ts", () => {
  const routeSource = readFileSync(new URL("../app/api/cron/olsera/inventory/route.ts", import.meta.url), "utf8");
  const match = routeSource.match(/export const maxDuration = (\d+);/);
  assert.ok(match, "tidak menemukan `export const maxDuration = <angka>;` di route.ts — update regex bila formatnya berubah");
  const routeMaxDurationSeconds = Number(match![1]);
  assert.equal(
    ROUTE_MAX_DURATION_MS,
    routeMaxDurationSeconds * 1000,
    "budget loop (ROUTE_MAX_DURATION_MS) di lib/cron-olsera-inventory.ts harus disamakan manual dengan maxDuration route bila salah satunya diubah",
  );
});

test("konsistensi: LOOP_BUDGET_MS punya safety buffer nyata (bukan 0/negatif, bukan 100% dari maxDuration)", () => {
  assert.ok(LOOP_BUDGET_MS > 0);
  assert.ok(LOOP_BUDGET_MS < ROUTE_MAX_DURATION_MS, "harus ada buffer sebelum maxDuration, tidak boleh memakai seluruh durasi");
  assert.equal(LOOP_BUDGET_MS, 255_000);
});

test("MAX_STEP_ITERATIONS cukup besar untuk backlog wajar tapi tetap jadi batas nyata (bukan efektif tak terbatas)", () => {
  assert.ok(MAX_STEP_ITERATIONS >= 100, "harus menampung backlog realistis (baseline s/d hari ini bisa >100 hari)");
  assert.ok(MAX_STEP_ITERATIONS <= 10_000, "harus tetap jadi batas pengaman nyata, bukan angka yang secara efektif tak terbatas");
});

test("concurrency: dua invocation \"bersamaan\" -> hanya satu yang benar-benar memproses step, yang lain 409 tanpa pernah memanggil step", async () => {
  resetMocks();
  let sharedLocked = false;
  const winnerRunId = "run-concurrent-winner";
  // Simulasi distributed lock (findOneAndUpdate atomik di produksi) — cek-lalu-set
  // dilakukan SINKRON di badan mock (tanpa await di dalamnya), sehingga dua
  // panggilan yang "bersamaan" lewat Promise.all tetap diserialisasi dengan
  // benar oleh runtime-to-completion JS, persis seperti operasi atomik Mongo.
  acquireOlseraSyncLockMock.mock.mockImplementation(async () => {
    if (sharedLocked) return { ok: false, activeModule: "inventory", runId: winnerRunId };
    sharedLocked = true;
    return { ok: true, runId: winnerRunId };
  });
  releaseOlseraSyncLockMock.mock.mockImplementation(async (runId: string) => {
    if (runId === winnerRunId) sharedLocked = false;
    return true;
  });
  queueStepResults({ done: true, run: fakeRun({ phase: "done", status: "success", processedDays: 1, totalDays: 1 }) });

  const [resA, resB] = await Promise.all([runOlseraInventoryCron("Bearer test-secret"), runOlseraInventoryCron("Bearer test-secret")]);

  const results = [resA, resB];
  const winners = results.filter((r) => r.status === 200 && r.body.runId === winnerRunId && r.body.done === true);
  const losers = results.filter((r) => r.status === 409);
  assert.equal(winners.length, 1, "tepat satu invocation yang berhasil memproses sampai selesai");
  assert.equal(losers.length, 1, "invocation lainnya ditolak 409 sync-in-progress, tidak ikut memproses");
  assert.equal(stepInventorySyncMock.mock.callCount(), 1, "step HANYA dipanggil oleh invocation yang menang lock");
  assert.equal(startInventorySyncMock.mock.callCount(), 1, "startInventorySync HANYA dipanggil oleh invocation yang menang lock");
});

test("invocation lanjutan setelah deadline -> melanjutkan run yang sama (bukan mulai dari awal) sampai success", async (t) => {
  resetMocks();

  // --- Invocation 1: satu step lalu berhenti karena deadline ---
  t.mock.timers.enable({ apis: ["Date"] });
  let res1: Awaited<ReturnType<typeof runOlseraInventoryCron>>;
  try {
    queueStepResults(() => {
      t.mock.timers.tick(280_000);
      return { done: false, run: fakeRun({ phase: "movements", processedDays: 1, totalDays: 3, currentDate: "2026-07-11" }) };
    });
    res1 = await runOlseraInventoryCron("Bearer test-secret");
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(res1.body.continuation, "deadline");
  assert.equal(res1.body.status, "running");
  assert.equal(res1.body.processedDays, 1);

  // --- Invocation 2 (panggilan cron berikutnya): startInventorySync mengembalikan
  // run PERSIS seperti yang ditinggalkan invocation 1 (checkpoint tersimpan di
  // Mongo, disimulasikan lewat mock) -> loop lanjut dari processedDays=1, BUKAN
  // dari 0, dan startInventorySync tetap hanya dipanggil sekali di invocation ini.
  startInventorySyncMock.mock.resetCalls();
  stepInventorySyncMock.mock.resetCalls();
  startInventorySyncMock.mock.mockImplementationOnce(async () =>
    fakeRun({ phase: "movements", processedDays: 1, totalDays: 3, currentDate: "2026-07-11" }),
  );
  queueStepResults(
    { done: false, run: fakeRun({ phase: "movements", processedDays: 2, totalDays: 3, currentDate: "2026-07-12" }) },
    { done: true, run: fakeRun({ phase: "done", status: "success", processedDays: 3, totalDays: 3, currentDate: null }) },
  );

  const res2 = await runOlseraInventoryCron("Bearer test-secret");

  assert.equal(startInventorySyncMock.mock.callCount(), 1, "invocation 2 juga hanya start SEKALI, mempercayai checkpoint yang di-resume");
  assert.equal(stepInventorySyncMock.mock.callCount(), 2, "melanjutkan 2 step tersisa (processedDays 1->2->3), bukan mengulang dari 0");
  assert.equal(res2.body.done, true);
  assert.equal(res2.body.status, "success");
  assert.equal(res2.body.processedDays, 3);
});
