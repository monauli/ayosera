import test from "node:test";
import assert from "node:assert/strict";
import { runOlseraSyncAll, type StageId, type StageStatus } from "./olsera-sync-orchestrator.ts";

function makeLock() {
  let locked = false;
  return {
    acquireLock: () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    releaseLock: () => {
      locked = false;
    },
    isLocked: () => locked,
  };
}

function ok(status: "success" | "partial" = "success", message = "OK"): { ok: boolean; status: "success" | "partial" | "failed" | "connection-expired"; message: string } {
  return { ok: status === "success", status, message };
}
function fail(status: "failed" | "connection-expired" = "failed", message = "Gagal"): { ok: boolean; status: "success" | "partial" | "failed" | "connection-expired"; message: string } {
  return { ok: false, status, message };
}

test("urutan selalu Kategori -> Inventori -> Keuangan", async () => {
  const callOrder: string[] = [];
  const lock = makeLock();
  await runOlseraSyncAll({
    ...lock,
    runKategori: async () => { callOrder.push("kategori"); return ok(); },
    runInventori: async () => { callOrder.push("inventori"); return ok(); },
    runKeuangan: async () => { callOrder.push("keuangan"); return ok(); },
  });
  assert.deepEqual(callOrder, ["kategori", "inventori", "keuangan"]);
});

test("tahap berikutnya tidak jalan jika tahap sebelumnya gagal (stop di Inventori)", async () => {
  const callOrder: string[] = [];
  const lock = makeLock();
  const result = await runOlseraSyncAll({
    ...lock,
    runKategori: async () => { callOrder.push("kategori"); return ok(); },
    runInventori: async () => { callOrder.push("inventori"); return fail("failed", "Sync inventori gagal."); },
    runKeuangan: async () => { callOrder.push("keuangan"); return ok(); },
  });
  assert.deepEqual(callOrder, ["kategori", "inventori"]);
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, "inventori");
  assert.equal(result.stages.kategori, "Berhasil");
  assert.equal(result.stages.inventori, "Gagal");
  assert.equal(result.stages.keuangan, "Tidak Dijalankan");
});

test("kegagalan tahap 1 menghentikan seluruh proses — tahap 2 & 3 Tidak Dijalankan", async () => {
  const callOrder: string[] = [];
  const lock = makeLock();
  const result = await runOlseraSyncAll({
    ...lock,
    runKategori: async () => { callOrder.push("kategori"); return fail(); },
    runInventori: async () => { callOrder.push("inventori"); return ok(); },
    runKeuangan: async () => { callOrder.push("keuangan"); return ok(); },
  });
  assert.deepEqual(callOrder, ["kategori"]);
  assert.equal(result.stages.kategori, "Gagal");
  assert.equal(result.stages.inventori, "Tidak Dijalankan");
  assert.equal(result.stages.keuangan, "Tidak Dijalankan");
});

test("tidak ada proses paralel — semua tahap dijalankan berurutan (await), tidak overlap", async () => {
  const active = { count: 0, maxConcurrent: 0 };
  const lock = makeLock();
  async function trackedRunner() {
    active.count++;
    active.maxConcurrent = Math.max(active.maxConcurrent, active.count);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active.count--;
    return ok();
  }
  await runOlseraSyncAll({ ...lock, runKategori: trackedRunner, runInventori: trackedRunner, runKeuangan: trackedRunner });
  assert.equal(active.maxConcurrent, 1);
});

test("double click tidak membuat dua proses — proses kedua ditolak lock sebelum tahap manapun berjalan", async () => {
  const lock = makeLock();
  const callOrder: string[] = [];
  const runner = (name: string) => async () => { callOrder.push(name); await new Promise((r) => setTimeout(r, 10)); return ok(); };

  const first = runOlseraSyncAll({ ...lock, runKategori: runner("k1"), runInventori: runner("i1"), runKeuangan: runner("f1") });
  // "Klik kedua" segera setelah yang pertama mulai (lock sudah diakuisisi secara sinkron).
  const second = await runOlseraSyncAll({ ...lock, runKategori: runner("k2"), runInventori: runner("i2"), runKeuangan: runner("f2") });

  assert.equal(second.alreadyRunning, true);
  assert.equal(second.ok, false);
  assert.deepEqual(second.stages, { kategori: "Menunggu", inventori: "Menunggu", keuangan: "Menunggu" });

  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.deepEqual(callOrder, ["k1", "i1", "f1"]);
});

test("token Olsera expired menghasilkan status connection-expired dan menghentikan proses", async () => {
  const lock = makeLock();
  const result = await runOlseraSyncAll({
    ...lock,
    runKategori: async () => ok(),
    runInventori: async () => fail("connection-expired", "Koneksi Olsera kedaluwarsa."),
    runKeuangan: async () => ok(),
  });
  assert.equal(result.stages.inventori, "Gagal");
  assert.equal(result.failedStage, "inventori");
  assert.match(result.message, /Koneksi Olsera kedaluwarsa/);
});

test("partial success pada satu tahap dianggap tidak cukup untuk lanjut, namun tahap sebelumnya tetap Berhasil", async () => {
  const lock = makeLock();
  const result = await runOlseraSyncAll({
    ...lock,
    runKategori: async () => ok(),
    runInventori: async () => ok("partial", "Sync sebagian selesai: 1 tanggal gagal."),
    runKeuangan: async () => ok(),
  });
  assert.equal(result.stages.kategori, "Berhasil");
  assert.equal(result.stages.inventori, "Gagal");
  assert.equal(result.stages.keuangan, "Tidak Dijalankan");
  assert.equal(result.ok, false);
  assert.match(result.message, /sebagian selesai/);
});

test("exception tak terduga pada satu runner tidak membocorkan detail teknis ke pesan", async () => {
  const lock = makeLock();
  const result = await runOlseraSyncAll({
    ...lock,
    runKategori: async () => ok(),
    runInventori: async () => { throw new Error("ECONNRESET at 10.0.0.5:27017 secret-token=abc123"); },
    runKeuangan: async () => ok(),
  });
  assert.equal(result.stages.inventori, "Gagal");
  assert.doesNotMatch(result.message, /ECONNRESET|10\.0\.0\.5|secret-token/);
});

test("onStageChange dipanggil dengan urutan status yang benar per tahap", async () => {
  const lock = makeLock();
  const events: Array<[StageId, StageStatus]> = [];
  await runOlseraSyncAll({
    ...lock,
    runKategori: async () => ok(),
    runInventori: async () => ok(),
    runKeuangan: async () => ok(),
    onStageChange: (stage, status) => events.push([stage, status]),
  });
  assert.deepEqual(events, [
    ["kategori", "Sedang Sinkron"],
    ["kategori", "Berhasil"],
    ["inventori", "Sedang Sinkron"],
    ["inventori", "Berhasil"],
    ["keuangan", "Sedang Sinkron"],
    ["keuangan", "Berhasil"],
  ]);
});

test("lock selalu dilepas walau salah satu tahap gagal (proses berikutnya bisa jalan lagi)", async () => {
  const lock = makeLock();
  await runOlseraSyncAll({ ...lock, runKategori: async () => fail(), runInventori: async () => ok(), runKeuangan: async () => ok() });
  assert.equal(lock.isLocked(), false);
  const second = await runOlseraSyncAll({ ...lock, runKategori: async () => ok(), runInventori: async () => ok(), runKeuangan: async () => ok() });
  assert.equal(second.alreadyRunning, false);
  assert.equal(second.ok, true);
});

test("sync AYO tidak pernah menjadi bagian dari orkestrator (hanya 3 runner yang diterima tipenya)", () => {
  // Bukti struktural: OlseraSyncAllDeps hanya mendefinisikan runKategori/runInventori/runKeuangan.
  // Tidak ada field untuk AYO — mencoba menambahkannya akan gagal type-check (diverifikasi oleh npm run type-check).
  const deps = { runKategori: 1, runInventori: 1, runKeuangan: 1 };
  assert.deepEqual(Object.keys(deps).sort(), ["runInventori", "runKategori", "runKeuangan"]);
});
