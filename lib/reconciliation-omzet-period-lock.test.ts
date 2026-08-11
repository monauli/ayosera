import assert from "node:assert/strict";
import test from "node:test";
import type { ReconciliationOmzetPeriodLockDocument } from "./mongodb.ts";
import {
  applyLockedOmzetPresentation,
  cleanupOmzetPeriodUploadHistory,
  computeCleanedUploadHistory,
  computeHiddenHistory,
  computeHistoryAfterReset,
  hideOmzetPeriodHistoryEntry,
  isBeritaAcaraVerifiedUnlocked,
  lockOmzetPeriodFinalization,
  OmzetPeriodLockError,
  previewOmzetPeriodLock,
  recordOmzetPeriodLockPreview,
  resetOmzetPeriodFinalization,
  unlockOmzetPeriodFinalization,
  uploadOmzetPeriodLockAttachment,
  validateOmzetPeriodLockAttachment,
  type OmzetPeriodLockContext,
} from "./reconciliation-omzet-period-lock.ts";

const june = { ayo: 242_895_499, olsera: 242_895_500, difference: 1 };
const attachment = { fileName: "berita-acara.pdf", mimeType: "application/pdf", size: 512, url: "https://blob.example/berita-acara.pdf", uploadedAt: new Date("2026-06-30T00:00:00.000Z"), uploadedBy: "supervisor-a" };

function matches(value: Record<string, unknown>, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = value[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const operators = expected as Record<string, unknown>;
      if ("$exists" in operators) return Boolean(actual !== undefined) === operators.$exists;
      if ("$ne" in operators) return actual !== operators.$ne;
      if ("$in" in operators) return Array.isArray(operators.$in) && operators.$in.includes(actual);
    }
    return actual === expected;
  });
}

function fixture() {
  let value: ReconciliationOmzetPeriodLockDocument | null = null;
  let failWrites = false;
  const context: OmzetPeriodLockContext = {
    locks: {
      async findOne(filter) { return value && matches(value as unknown as Record<string, unknown>, filter) ? structuredClone(value) : null; },
      async findOneAndUpdate(filter, update, options) {
        if (failWrites) throw new Error("MongoDB unavailable");
        // Meniru validasi MongoDB sungguhan (server error code 40): sebuah
        // field TIDAK BOLEH disasar oleh dua operator update berbeda dalam
        // update document yang sama (mis. $setOnInsert.version DAN $inc.version
        // sekaligus) — MongoDB menolak update itu dengan "Updating the path
        // 'x' would create a conflict at 'x'" TERLEPAS apakah insert benar2
        // terjadi atau tidak (ini validasi STRUKTUR update, bukan efeknya).
        // Root cause upload berita acara gagal generik di produksi (V6)
        // adalah persis pelanggaran ini (version & history) — mock lama TIDAK
        // menangkapnya karena menerapkan $setOnInsert/$inc/$push independen
        // tanpa cek konflik path. Reproduksi nyata sudah diverifikasi langsung
        // terhadap MongoDB Atlas (server error code 40) sebelum fixture ini
        // ditulis ulang.
        const setOnInsertKeys = new Set(Object.keys((update.$setOnInsert ?? {}) as object));
        for (const key of [...Object.keys((update.$inc ?? {}) as object), ...Object.keys((update.$push ?? {}) as object)]) {
          if (setOnInsertKeys.has(key)) {
            const conflictError = new Error(`Updating the path '${key}' would create a conflict at '${key}'`) as Error & { name: string; code: number };
            conflictError.name = "MongoServerError";
            conflictError.code = 40;
            throw conflictError;
          }
        }
        if (!value && !options.upsert) return null;
        if (value && !matches(value as unknown as Record<string, unknown>, filter)) return null;
        // Meniru perilaku MongoDB sungguhan: pada upsert yang benar-benar
        // insert, field filter yang berupa equality literal (mis. { _id: id })
        // otomatis ikut menjadi bagian dokumen baru walau tidak disebut di
        // $setOnInsert — inilah kenapa menaruh _id di KEDUA filter dan
        // $setOnInsert memicu konflik "immutable field '_id'" pada Mongo asli.
        const filterLiterals = Object.fromEntries(Object.entries(filter).filter(([, v]) => !(v && typeof v === "object" && !Array.isArray(v))));
        const target = value ?? structuredClone({ ...filterLiterals, ...(update.$setOnInsert ?? {}) } as ReconciliationOmzetPeriodLockDocument);
        Object.assign(target, (update.$set ?? {}) as object);
        // $inc pada field yang belum ada di dokumen (mis. dokumen legacy tanpa
        // `version`, atau insert baru sekarang tanpa version:0 di $setOnInsert)
        // meniru MongoDB asli: field diinisialisasi 0 dulu baru ditambah.
        for (const [key, increment] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
          const current = target[key as keyof ReconciliationOmzetPeriodLockDocument];
          target[key as keyof ReconciliationOmzetPeriodLockDocument] = ((typeof current === "number" ? current : 0) + increment) as never;
        }
        const push = (update.$push ?? {}) as Record<string, unknown>;
        // $push pada array yang belum ada (dokumen legacy tanpa `history`, atau
        // insert baru tanpa history:[] di $setOnInsert) meniru MongoDB asli:
        // array baru dibuat berisi elemen yang di-push.
        if (push.history) target.history = [...(target.history ?? []), push.history as ReconciliationOmzetPeriodLockDocument["history"][number]];
        value = structuredClone(target);
        return structuredClone(value);
      },
    },
  };
  return {
    context,
    document: () => value && structuredClone(value),
    failWrites: () => { failWrites = true; },
    // Menyuntik dokumen "sudah ada" langsung ke penyimpanan fake — dipakai
    // untuk mensimulasikan bentuk dokumen produksi nyata/legacy (record
    // kosong/partial dari upaya gagal sebelumnya, dokumen lama tanpa field
    // baru, dst.) TANPA harus melalui uploadOmzetPeriodLockAttachment dulu.
    seed: (doc: Partial<ReconciliationOmzetPeriodLockDocument> & { _id: string }) => { value = doc as ReconciliationOmzetPeriodLockDocument; },
  };
}

async function upload(f = fixture()) {
  const lock = await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment }, f.context);
  return { f, lock };
}
async function previewForLock(f: ReturnType<typeof fixture>, version: number, finalAgreedAmount = june.olsera, adjustmentReason = "Pembulatan") {
  return recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: version, original: june, finalAgreedAmount, adjustmentReason }, f.context);
}

test("upload validates PDF and rejects oversized or invalid MIME", async () => {
  assert.doesNotThrow(() => validateOmzetPeriodLockAttachment({ name: "berita.pdf", type: "application/pdf", size: 10 * 1024 * 1024 }));
  assert.throws(() => validateOmzetPeriodLockAttachment({ name: "berita.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1 }), OmzetPeriodLockError);
  assert.throws(() => validateOmzetPeriodLockAttachment({ name: "berita.exe", type: "application/octet-stream", size: 1 }), OmzetPeriodLockError);
  const { lock } = await upload();
  assert.equal(lock.status, "draft");
  assert.equal(lock.attachment?.fileName, attachment.fileName);
  assert.equal(lock.history[0]?.action, "upload");
});

test("upload attachment persists and survives a simulated page refresh (fresh findOne)", async () => {
  const { f, lock } = await upload();
  assert.equal(lock._id, "1:2026-06");
  assert.equal(lock.version, 1);
  // Simulasikan refresh halaman: baca ulang lewat findOne murni, terpisah
  // dari nilai `lock` yang dikembalikan upload() di atas.
  const reloaded = await f.context.locks.findOne({ _id: "1:2026-06" });
  assert.ok(reloaded, "dokumen periode harus ditemukan setelah upload (bug _id upsert sebelumnya membuat ini gagal)");
  assert.equal(reloaded?.attachment?.fileName, attachment.fileName);
  assert.equal(reloaded?.status, "draft");
});

test("preview requires attachment and never changes the source presentation", () => {
  assert.throws(() => previewOmzetPeriodLock({ original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan", attachment: null }), OmzetPeriodLockError);
  const original = structuredClone(june);
  const preview = previewOmzetPeriodLock({ original, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan", attachment });
  assert.equal(preview.lockedDisplay.difference, 0);
  assert.deepEqual(original, june);
});

test("preview audit increments version but leaves status draft", async () => {
  const { f, lock } = await upload();
  const result = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  assert.equal(result.lock.status, "draft");
  assert.equal(result.lock.version, lock.version + 1);
  assert.equal(result.lock.history.at(-1)?.action, "preview");
});

test("lock rejects missing attachment and missing reason", async () => {
  const f = fixture();
  await assert.rejects(() => lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: 1, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Alasan" }, f.context), OmzetPeriodLockError);
  const { lock } = await upload(f);
  await assert.rejects(() => lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "" }, f.context), OmzetPeriodLockError);
});

test("lock snapshots original June, applies a clean display, and preserves source", async () => {
  const { f, lock } = await upload();
  const preview = await previewForLock(f, lock.version, june.olsera, "Penyesuaian pembulatan rekonsiliasi");
  const source = { ayo: { count: 99, revenue: june.ayo }, olseraTotal: june.olsera, differenceRevenue: june.difference, status: "PERLU_DICEK", statusReason: "Selisih" };
  const result = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Penyesuaian pembulatan rekonsiliasi" }, f.context);
  const presentation = applyLockedOmzetPresentation(source, result);
  assert.equal(result.originalAyoAmount, 242_895_499);
  assert.equal(result.originalOlseraAmount, 242_895_500);
  assert.equal(result.originalDifference, 1);
  assert.equal(presentation.ayo.revenue, 242_895_500);
  assert.equal(presentation.olseraTotal, 242_895_500);
  assert.equal(presentation.differenceRevenue, 0);
  assert.equal(presentation.status, "COCOK");
  assert.deepEqual(source, { ayo: { count: 99, revenue: june.ayo }, olseraTotal: june.olsera, differenceRevenue: june.difference, status: "PERLU_DICEK", statusReason: "Selisih" });
});

test("unlock restores original presentation and retains attachment and audit history", async () => {
  const { f, lock } = await upload();
  const preview = await previewForLock(f, lock.version);
  const locked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  const unlocked = await unlockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: locked.version, reason: "Uji coba selesai" }, f.context);
  const source = { ayo: { count: 1, revenue: june.ayo }, olseraTotal: june.olsera, differenceRevenue: june.difference, status: "COCOK", statusReason: "Toleransi" };
  assert.equal(unlocked.status, "unlocked");
  assert.equal(unlocked.attachment?.url, attachment.url);
  assert.equal(unlocked.history.at(-1)?.action, "unlock");
  assert.deepEqual(applyLockedOmzetPresentation(source, unlocked), { ...source, periodLock: unlocked, beritaAcaraVerified: false });
});

test("unlock rejects empty/whitespace-only reason and non-locked status", async () => {
  const { f, lock } = await upload();
  const preview = await previewForLock(f, lock.version);
  const locked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  await assert.rejects(() => unlockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: locked.version, reason: "   " }, f.context), OmzetPeriodLockError);
  await assert.rejects(() => unlockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: locked.version, reason: "" }, f.context), OmzetPeriodLockError);
  const draftFixture = await upload();
  await assert.rejects(() => unlockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: draftFixture.lock.version, reason: "Alasan valid" }, draftFixture.f.context), OmzetPeriodLockError);
});

test("relock is additive and stale/concurrent submissions conflict safely", async () => {
  const { f, lock } = await upload();
  const preview = await previewForLock(f, lock.version);
  const first = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  await assert.rejects(() => lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-b", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context), OmzetPeriodLockError);
  const unlocked = await unlockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: first.version, reason: "Perlu koreksi" }, f.context);
  const relockPreview = await previewForLock(f, unlocked.version, june.ayo, "Nominal disepakati ulang");
  const relocked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-b", expectedVersion: relockPreview.lock.version, original: june, finalAgreedAmount: june.ayo, adjustmentReason: "Nominal disepakati ulang" }, f.context);
  assert.equal(relocked.history.at(-1)?.action, "relock");
  assert.equal(relocked.history.filter((entry) => entry.action === "lock" || entry.action === "relock").length, 2);
});

test("MongoDB write failure never produces a false locked document", async () => {
  const f = fixture();
  f.failWrites();
  await assert.rejects(() => uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment }, f.context));
  assert.equal(f.document(), null);
});

// V6: regresi produksi Maret 2026 — root cause SEBENARNYA (terverifikasi
// lewat reproduksi langsung terhadap MongoDB Atlas sungguhan, BUKAN mock
// lokal) adalah MongoDB server error code 40 "Updating the path 'version'
// would create a conflict at 'version'" (dan sama untuk 'history') karena
// $setOnInsert dan $inc/$push menyasar field yang sama pada update document
// yang SAMA — SELALU terjadi, baik dokumen periode belum ada (insert
// pertama, persis kasus Maret 2026 yang koleksi produksinya kosong sama
// sekali) MAUPUN dokumen sudah ada (MongoDB memvalidasi struktur update-nya,
// bukan cuma efeknya). Fixture di atas sekarang meniru validasi ini secara
// setia, jadi skenario di bawah gagal lagi kalau bug ini terulang.
test("V6 regresi: skenario data legacy/produksi nyata pada uploadOmzetPeriodLockAttachment", async (t) => {
  await t.test("1. periode tanpa dokumen sama sekali (persis Maret 2026 di produksi) -> upload sukses", async () => {
    const f = fixture();
    const lock = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment }, f.context);
    assert.equal(lock.status, "draft");
    assert.equal(lock.version, 1);
    assert.equal(lock.attachment?.fileName, attachment.fileName);
  });

  await t.test("2. dokumen existing nyaris-kosong (hanya _id/version/status/history) -> upload sukses", async () => {
    const f = fixture();
    f.seed({ _id: "324175:2026-03", storeId: 324175, year: 2026, month: 3, version: 1, status: "draft", history: [] });
    const lock = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment }, f.context);
    assert.equal(lock.version, 2);
    assert.equal(lock.attachment?.fileName, attachment.fileName);
  });

  await t.test("3. dokumen sisa percobaan gagal sebelum fix (attachment null, history kosong) -> retry sukses", async () => {
    const f = fixture();
    f.seed({ _id: "324175:2026-03", storeId: 324175, year: 2026, month: 3, version: 1, status: "draft", attachment: null, history: [] });
    const lock = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment }, f.context);
    assert.equal(lock.attachment?.fileName, attachment.fileName);
    assert.equal(lock.status, "draft");
  });

  await t.test("4. dokumen dengan attachment valid -> ganti file baru sukses", async () => {
    const { f, lock } = await upload();
    const newAttachment = { ...attachment, fileName: "berita-acara-v2.pdf" };
    const replaced = await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment: newAttachment, expectedVersion: lock.version }, f.context);
    assert.equal(replaced.attachment?.fileName, "berita-acara-v2.pdf");
    assert.equal(replaced.version, lock.version + 1);
  });

  await t.test("5. upload file yang sama dua kali berturut-turut -> tidak error/crash", async () => {
    const { f, lock } = await upload();
    const second = await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment, expectedVersion: lock.version }, f.context);
    assert.equal(second.attachment?.fileName, attachment.fileName);
    assert.equal(second.version, lock.version + 1);
    const third = await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment, expectedVersion: second.version }, f.context);
    assert.equal(third.attachment?.fileName, attachment.fileName);
    assert.equal(third.version, second.version + 1);
  });

  await t.test("6. dokumen legacy tanpa field `version` (missing, bukan 0) -> tetap bisa diupdate tanpa kehilangan data lama", async () => {
    const f = fixture();
    f.seed({ _id: "324175:2026-03", storeId: 324175, year: 2026, month: 3, status: "draft", history: [], finalAgreedAmount: 123 } as unknown as ReconciliationOmzetPeriodLockDocument);
    const lock = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment }, f.context);
    assert.equal(lock.attachment?.fileName, attachment.fileName);
    // Data lama (finalAgreedAmount) tidak boleh hilang oleh $set parsial.
    assert.equal((lock as unknown as { finalAgreedAmount: number }).finalAgreedAmount, 123);
  });

  await t.test("7. tidak ada konflik field immutable `_id` saat insert maupun update", async () => {
    const f = fixture();
    const lock = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment }, f.context);
    assert.equal(lock._id, "324175:2026-03");
    const again = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment, expectedVersion: lock.version }, f.context);
    assert.equal(again._id, "324175:2026-03");
  });

  await t.test("8. percobaan upload berulang tidak memicu duplicate-key", async () => {
    const f = fixture();
    let version: number | undefined;
    for (let i = 0; i < 4; i += 1) {
      const lock = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment, expectedVersion: version ?? null }, f.context);
      version = lock.version;
    }
    assert.equal(version, 4);
  });

  await t.test("9. Blob sukses + Mongo save sukses -> hasil akhir mencerminkan sukses (attachment tersimpan)", async () => {
    const f = fixture();
    const lock = await uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment }, f.context);
    assert.ok(lock.attachment);
    assert.equal(lock.attachment?.url, attachment.url);
  });

  await t.test("10. kegagalan Mongo sungguhan (driver-level, bukan Error generik) -> pesan/kode error dapat dibedakan, bukan silent generic", async () => {
    const f = fixture();
    f.failWrites();
    await assert.rejects(
      () => uploadOmzetPeriodLockAttachment({ storeId: 324175, period: "2026-03", actor: "supervisor-a", attachment }, f.context),
      (error: unknown) => error instanceof Error && error.message === "MongoDB unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// V10: status "Cocok karena Berita Acara" begitu Simpan sukses (SEBELUM
// Kunci Periode), selisih ASLI TETAP tampil (tidak di-collapse ke Rp0),
// diverifikasi SERVER-SIDE (matchBeritaAcaraToSystemDifference terhadap
// original.difference, bukan klaim client) — lihat komentar ROOT CAUSE/Goal
// di reconciliation-omzet-period-lock.ts.
// ---------------------------------------------------------------------------

const maret = { ayo: 197_855_000, olsera: 198_595_000, difference: 740_000 };
const april = { ayo: 0, olsera: 0, difference: -739_999 };

test("previewOmzetPeriodLock: V10 test wajib #2/#4 — verifiedMatchStatus dihitung server-side dari original.difference, BUKAN klaim client mentah", () => {
  const maretPreview = previewOmzetPeriodLock({ original: maret, finalAgreedAmount: maret.olsera, adjustmentReason: "x", attachment, beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" });
  assert.equal(maretPreview.verifiedMatchStatus, "COCOK");
  assert.equal(maretPreview.beritaAcaraNominal, 740_000);
  assert.equal(maretPreview.beritaAcaraDirection, "PENAMBAHAN");

  const aprilPreview = previewOmzetPeriodLock({ original: april, finalAgreedAmount: april.olsera, adjustmentReason: "x", attachment, beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENGURANGAN" });
  assert.equal(aprilPreview.verifiedMatchStatus, "COCOK", "toleransi ±Rp1 tetap berlaku (740.000 vs 739.999)");
});

test("previewOmzetPeriodLock: V10 test wajib #5/#6 — nominal beda >Rp1 atau arah salah -> TIDAK_COCOK, bukan COCOK dipalsukan", () => {
  const wrongAmount = previewOmzetPeriodLock({ original: maret, finalAgreedAmount: maret.olsera, adjustmentReason: "x", attachment, beritaAcaraNominal: 750_000, beritaAcaraDirection: "PENAMBAHAN" });
  assert.equal(wrongAmount.verifiedMatchStatus, "TIDAK_COCOK");
  const wrongDirection = previewOmzetPeriodLock({ original: maret, finalAgreedAmount: maret.olsera, adjustmentReason: "x", attachment, beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENGURANGAN" });
  assert.equal(wrongDirection.verifiedMatchStatus, "TIDAK_COCOK");
});

test("previewOmzetPeriodLock: V10 test wajib #7 — tanpa nominal/direction (upload tanpa analisis valid) -> PERLU_REVIEW, bukan COCOK", () => {
  const noSignal = previewOmzetPeriodLock({ original: maret, finalAgreedAmount: maret.olsera, adjustmentReason: "x", attachment });
  assert.equal(noSignal.verifiedMatchStatus, "PERLU_REVIEW");
  assert.equal(noSignal.beritaAcaraNominal, null);
  assert.equal(noSignal.beritaAcaraDirection, null);
});

test("previewOmzetPeriodLock: input beritaAcaraNominal/direction sampah (bukan angka positif / bukan enum valid) diperlakukan sebagai tidak ada sinyal, TIDAK PERNAH throw", () => {
  const garbage = previewOmzetPeriodLock({ original: maret, finalAgreedAmount: maret.olsera, adjustmentReason: "x", attachment, beritaAcaraNominal: "bukan-angka", beritaAcaraDirection: "SALAH" });
  assert.equal(garbage.verifiedMatchStatus, "PERLU_REVIEW");
  assert.equal(garbage.beritaAcaraNominal, null);
  assert.equal(garbage.beritaAcaraDirection, null);
});

test("recordOmzetPeriodLockPreview: V10 test wajib #2 — Simpan (preview) sebelum ada nominal/direction valid -> verifiedMatchStatus TIDAK COCOK, status tetap draft", async () => {
  const { f, lock } = await upload();
  const result = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  assert.equal(result.lock.verifiedMatchStatus, "PERLU_REVIEW");
  assert.equal(result.lock.status, "draft", "Simpan TIDAK PERNAH mengubah status draft/unlocked/locked itu sendiri — hanya verifiedMatchStatus");
});

test("recordOmzetPeriodLockPreview: V10 test wajib #3 — Simpan dengan nominal/direction COCOK mempersist verifiedMatchStatus=COCOK ke dokumen (survive refresh)", async () => {
  const { f, lock } = await upload();
  const result = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan", beritaAcaraNominal: 1, beritaAcaraDirection: "PENAMBAHAN" }, f.context);
  assert.equal(result.lock.verifiedMatchStatus, "COCOK");
  // "refresh" = findOne baru, terpisah dari nilai yang dikembalikan langsung — data harus dari record tersimpan (Goal 8), bukan cuma state React.
  const reloaded = await f.context.locks.findOne({ _id: "1:2026-06" });
  assert.equal(reloaded?.verifiedMatchStatus, "COCOK");
  assert.equal(reloaded?.beritaAcaraNominal, 1);
  assert.equal(reloaded?.beritaAcaraDirection, "PENAMBAHAN");
});

test("isBeritaAcaraVerifiedUnlocked / applyLockedOmzetPresentation: V10 test wajib #1 — tanpa periodLock sama sekali -> selisih 0 -> Cocok lewat toleransi existing (tidak berubah)", () => {
  assert.equal(isBeritaAcaraVerifiedUnlocked(null), false);
  const source = { ayo: { count: 1, revenue: 100 }, olseraTotal: 100, differenceRevenue: 0, status: "COCOK", statusReason: "Toleransi" };
  const presentation = applyLockedOmzetPresentation(source, null);
  assert.equal(presentation.status, "COCOK");
  assert.equal(presentation.beritaAcaraVerified, false);
});

test("applyLockedOmzetPresentation: V10 test wajib #3/#9 — periode Cocok karena Berita Acara (Simpan, belum lock) -> status Cocok + beritaAcaraVerified true, TAPI selisih ASLI TIDAK diubah ke Rp0", async () => {
  const { f, lock } = await upload();
  const saved = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: maret, finalAgreedAmount: maret.olsera, adjustmentReason: "Pembayaran di muka Maret", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" }, f.context);
  assert.equal(isBeritaAcaraVerifiedUnlocked(saved.lock), true);
  const source = { ayo: { count: 1, revenue: maret.ayo }, olseraTotal: maret.olsera, differenceRevenue: maret.difference, status: "PERLU_DICEK", statusReason: "Selisih Rp740.000 menunggu verifikasi Berita Acara." };
  const presentation = applyLockedOmzetPresentation(source, saved.lock);
  assert.equal(presentation.status, "COCOK");
  assert.equal(presentation.beritaAcaraVerified, true);
  assert.equal(presentation.differenceRevenue, 740_000, "V10: selisih asli JANGAN diubah menjadi Rp0 (beda dari periode locked)");
  assert.equal(presentation.olseraTotal, maret.olsera, "olseraTotal TIDAK di-collapse ke finalAgreedAmount seperti periode locked");
  assert.match(presentation.statusReason, /telah diverifikasi dengan Berita Acara/);
  assert.match(presentation.statusReason, /Rp740\.000/);
});

test("applyLockedOmzetPresentation: V10 test wajib #2 — upload saja TANPA Simpan (verifiedMatchStatus masih null) -> TETAP Perlu Dicek, bukan Cocok", async () => {
  const { f, lock } = await upload();
  assert.equal(isBeritaAcaraVerifiedUnlocked(lock), false, "belum Simpan sama sekali -> belum verified");
  const source = { ayo: { count: 1, revenue: maret.ayo }, olseraTotal: maret.olsera, differenceRevenue: maret.difference, status: "PERLU_DICEK", statusReason: "Selisih Rp740.000 menunggu verifikasi Berita Acara." };
  const presentation = applyLockedOmzetPresentation(source, lock);
  assert.equal(presentation.status, "PERLU_DICEK");
  assert.equal(presentation.beritaAcaraVerified, false);
});

test("applyLockedOmzetPresentation: V10 test wajib #6 — Simpan dengan arah/nominal SALAH (TIDAK_COCOK) -> TETAP Perlu Dicek, tidak pernah Cocok palsu", async () => {
  const { f, lock } = await upload();
  const saved = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: maret, finalAgreedAmount: maret.olsera, adjustmentReason: "x", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENGURANGAN" }, f.context);
  assert.equal(saved.lock.verifiedMatchStatus, "TIDAK_COCOK");
  const source = { ayo: { count: 1, revenue: maret.ayo }, olseraTotal: maret.olsera, differenceRevenue: maret.difference, status: "PERLU_DICEK", statusReason: "Selisih Rp740.000 menunggu verifikasi Berita Acara." };
  const presentation = applyLockedOmzetPresentation(source, saved.lock);
  assert.equal(presentation.status, "PERLU_DICEK");
  assert.equal(presentation.beritaAcaraVerified, false);
});

test("applyLockedOmzetPresentation: V10 test wajib #4 — April PENGURANGAN toleransi ±Rp1 -> Cocok, selisih -Rp739.999 tetap tampil", async () => {
  const { f, lock } = await upload();
  const saved = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: april, finalAgreedAmount: april.olsera, adjustmentReason: "Sudah diakui Maret", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENGURANGAN" }, f.context);
  const source = { ayo: { count: 1, revenue: april.ayo }, olseraTotal: april.olsera, differenceRevenue: april.difference, status: "PERLU_DICEK", statusReason: "x" };
  const presentation = applyLockedOmzetPresentation(source, saved.lock);
  assert.equal(presentation.status, "COCOK");
  assert.equal(presentation.beritaAcaraVerified, true);
  assert.equal(presentation.differenceRevenue, -739_999);
});

test("applyLockedOmzetPresentation: cabang locked TETAP tidak berubah (collapse Rp0, beritaAcaraVerified true juga) — regresi V10 tidak boleh mengubah perilaku lock lama", async () => {
  const { f, lock } = await upload();
  const preview = await previewForLock(f, lock.version);
  const locked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  const source = { ayo: { count: 1, revenue: june.ayo }, olseraTotal: june.olsera, differenceRevenue: june.difference, status: "PERLU_DICEK", statusReason: "x" };
  const presentation = applyLockedOmzetPresentation(source, locked);
  assert.equal(presentation.differenceRevenue, 0);
  assert.equal(presentation.status, "COCOK");
  assert.equal(presentation.beritaAcaraVerified, true);
  assert.equal(presentation.statusReason, "Cocok — Terkunci berdasarkan berita acara rekonsiliasi.");
});

// ---------------------------------------------------------------------------
// V10 Goal 9-13: "Bersihkan Riwayat Upload" — computeCleanedUploadHistory
// (murni) dan cleanupOmzetPeriodUploadHistory (integrasi via fixture).
// ---------------------------------------------------------------------------

function historyEntry(action: ReconciliationOmzetPeriodLockDocument["history"][number]["action"], extra: Partial<ReconciliationOmzetPeriodLockDocument["history"][number]> = {}) {
  return { action, actor: "supervisor-a", timestamp: new Date(), reason: null, before: {}, after: {}, hiddenAt: null, hiddenBy: null, ...extra };
}

test("computeCleanedUploadHistory: test wajib #12/#13 — banyak upload duplikat -> hanya upload TERAKHIR (aktif) yang dipertahankan", () => {
  const history = [
    historyEntry("upload", { after: { fileName: "a.pdf" } }),
    historyEntry("upload", { after: { fileName: "a.pdf" } }),
    historyEntry("upload", { after: { fileName: "b.pdf" } }),
  ];
  const cleaned = computeCleanedUploadHistory(history);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0], history[2], "upload TERAKHIR (indeks paling akhir) yang dipertahankan, apa pun nama filenya");
});

test("computeCleanedUploadHistory: test wajib #14/#15/#16 — preview/lock/unlock TIDAK PERNAH terhapus, urutan lainnya tidak berubah", () => {
  const history = [
    historyEntry("upload"),
    historyEntry("upload"),
    historyEntry("preview"),
    historyEntry("lock"),
    historyEntry("unlock"),
    historyEntry("upload"),
    historyEntry("preview"),
  ];
  const cleaned = computeCleanedUploadHistory(history);
  assert.equal(cleaned.filter((e) => e.action === "upload").length, 1);
  assert.equal(cleaned.filter((e) => e.action === "preview").length, 2);
  assert.equal(cleaned.filter((e) => e.action === "lock").length, 1);
  assert.equal(cleaned.filter((e) => e.action === "unlock").length, 1);
  // Urutan relatif entri yang dipertahankan tidak berubah.
  assert.deepEqual(cleaned.map((e) => e.action), ["preview", "lock", "unlock", "upload", "preview"]);
});

test("computeCleanedUploadHistory: 0 atau 1 entri upload -> history dikembalikan APA ADANYA (tidak ada yang dibersihkan)", () => {
  const noUpload = [historyEntry("preview"), historyEntry("lock")];
  assert.equal(computeCleanedUploadHistory(noUpload), noUpload);
  const oneUpload = [historyEntry("upload"), historyEntry("preview")];
  assert.equal(computeCleanedUploadHistory(oneUpload), oneUpload);
});

test("cleanupOmzetPeriodUploadHistory: test wajib #10/#12/#13/#17 — hapus upload duplikat, sisakan upload aktif, attachment TIDAK berubah, version bertambah", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  const second = await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment: { ...attachment, fileName: "revisi.pdf" }, expectedVersion: firstUpload.version }, f.context);
  const preview = await previewForLock(f, second.version);
  const result = await cleanupOmzetPeriodUploadHistory({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version }, f.context);
  assert.equal(result.removedCount, 1);
  assert.equal(result.lock.history.filter((e) => e.action === "upload").length, 1);
  assert.equal(result.lock.history.filter((e) => e.action === "preview").length, 1, "entri preview (Simpan) TIDAK ikut terhapus");
  assert.equal(result.lock.attachment?.fileName, "revisi.pdf", "attachment aktif TIDAK berubah oleh cleanup");
  assert.equal(result.lock.version, preview.lock.version + 1);
});

test("cleanupOmzetPeriodUploadHistory: test wajib #14/#15/#16 — Simpan/Kunci/Buka Kunci history tetap utuh setelah cleanup", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment, expectedVersion: firstUpload.version }, f.context);
  const reuploaded = await f.context.locks.findOne({ _id: "1:2026-06" });
  const preview = await previewForLock(f, reuploaded!.version);
  const locked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  const unlocked = await unlockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: locked.version, reason: "Koreksi" }, f.context);
  const result = await cleanupOmzetPeriodUploadHistory({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: unlocked.version }, f.context);
  assert.equal(result.lock.history.some((e) => e.action === "preview"), true);
  assert.equal(result.lock.history.some((e) => e.action === "lock"), true);
  assert.equal(result.lock.history.some((e) => e.action === "unlock"), true);
});

test("cleanupOmzetPeriodUploadHistory: hanya satu upload (belum ada duplikat) -> removedCount 0, version TIDAK berubah", async () => {
  const { f, lock } = await upload();
  const result = await cleanupOmzetPeriodUploadHistory({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version }, f.context);
  assert.equal(result.removedCount, 0);
  assert.equal(result.lock.version, lock.version, "tidak ada perubahan -> tidak perlu increment version");
});

test("cleanupOmzetPeriodUploadHistory: periode tidak ditemukan -> NOT_FOUND, bukan crash", async () => {
  const f = fixture();
  await assert.rejects(() => cleanupOmzetPeriodUploadHistory({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: 1 }, f.context), OmzetPeriodLockError);
});

test("cleanupOmzetPeriodUploadHistory: version basi (konflik konkuren) -> CONFLICT, bukan silent overwrite", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment, expectedVersion: firstUpload.version }, f.context);
  await assert.rejects(() => cleanupOmzetPeriodUploadHistory({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: firstUpload.version }, f.context), OmzetPeriodLockError);
});

// ---------------------------------------------------------------------------
// V11 Goal 8-11: "×" per-item pada Riwayat Aktivitas — computeHiddenHistory
// (murni) dan hideOmzetPeriodHistoryEntry (integrasi via fixture). SOFT
// DELETE: entri asli TIDAK PERNAH hilang dari array, hanya ditandai
// hiddenAt/hiddenBy — beda dari computeCleanedUploadHistory (V10, HARD
// remove) di atas.
// ---------------------------------------------------------------------------

test("computeHiddenHistory: test wajib #27 — hanya entri di index target yang dapat hiddenAt/hiddenBy, entri lain (isi & urutan) TIDAK berubah sama sekali", () => {
  const now = new Date("2026-08-11T14:32:00.000Z");
  const history = [historyEntry("upload"), historyEntry("preview", { reason: "Pembulatan" }), historyEntry("lock")];
  const result = computeHiddenHistory(history, 1, "supervisor-a", now);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], history[0], "entri index 0 sama sekali tidak disentuh");
  assert.equal(result[1].hiddenAt, now);
  assert.equal(result[1].hiddenBy, "supervisor-a");
  assert.equal(result[1].reason, "Pembulatan", "field asli entri yang di-hide tetap utuh — hanya menambahkan hiddenAt/hiddenBy");
  assert.deepEqual(result[2], history[2], "entri index 2 sama sekali tidak disentuh");
});

test("computeHiddenHistory: index di luar jangkauan -> array dikembalikan tanpa ada yang berubah (guard, dipanggil pemanggil yang sudah validasi bounds)", () => {
  const history = [historyEntry("upload")];
  const result = computeHiddenHistory(history, 99, "supervisor-a", new Date());
  assert.deepEqual(result, history);
});

test("hideOmzetPeriodHistoryEntry: test wajib #22/#25/#26/#27 — sembunyikan satu entri, tersimpan (survive refresh), entri lain & attachment aktif tidak berubah", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  const preview = await previewForLock(f, firstUpload.version);
  const result = await hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, entryIndex: 0 }, f.context);
  assert.ok(result.history[0].hiddenAt, "entri upload (index 0) harus tersembunyi");
  assert.equal(result.history[0].hiddenBy, "supervisor-a");
  assert.equal(result.history[1].hiddenAt, null, "entri preview (index 1) TIDAK ikut tersembunyi");
  assert.equal(result.attachment?.fileName, attachment.fileName, "attachment aktif tidak berubah oleh hide");
  assert.equal(result.version, preview.lock.version + 1);
  // "refresh" = findOne baru, terpisah dari nilai yang dikembalikan langsung.
  const reloaded = await f.context.locks.findOne({ _id: "1:2026-06" });
  assert.ok(reloaded?.history[0].hiddenAt, "hide harus persist setelah reload, bukan cuma state React");
});

test("hideOmzetPeriodHistoryEntry: test wajib #27 — event asli (action/actor/reason/before/after) TIDAK dihapus permanen, hanya ditandai hidden", async () => {
  const { f, lock } = await upload();
  const result = await hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-b", expectedVersion: lock.version, entryIndex: 0 }, f.context);
  assert.equal(result.history.length, 1, "entri TIDAK dihapus dari array — cuma di-flag");
  assert.equal(result.history[0].action, "upload");
  assert.equal(result.history[0].actor, "supervisor-a", "actor ASLI (yang mengunggah) tidak berubah — hiddenBy beda dari actor");
  assert.equal(result.history[0].hiddenBy, "supervisor-b", "hiddenBy mencatat siapa yang menyembunyikan, terpisah dari actor asli");
});

test("hideOmzetPeriodHistoryEntry: periode tidak ditemukan -> NOT_FOUND", async () => {
  const f = fixture();
  await assert.rejects(() => hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: 1, entryIndex: 0 }, f.context), OmzetPeriodLockError);
});

test("hideOmzetPeriodHistoryEntry: entryIndex di luar jangkauan -> NOT_FOUND, bukan crash", async () => {
  const { f, lock } = await upload();
  await assert.rejects(() => hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, entryIndex: 99 }, f.context), OmzetPeriodLockError);
});

test("hideOmzetPeriodHistoryEntry: entryIndex negatif/bukan integer -> ditolak sebagai VALIDATION, tidak pernah menyentuh DB", async () => {
  const { f, lock } = await upload();
  await assert.rejects(() => hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, entryIndex: -1 }, f.context), OmzetPeriodLockError);
  await assert.rejects(() => hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, entryIndex: 1.5 }, f.context), OmzetPeriodLockError);
});

test("hideOmzetPeriodHistoryEntry: version basi (konflik konkuren) -> CONFLICT, bukan silent overwrite", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment, expectedVersion: firstUpload.version }, f.context);
  await assert.rejects(() => hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: firstUpload.version, entryIndex: 0 }, f.context), OmzetPeriodLockError);
});

test("hideOmzetPeriodHistoryEntry: hide TIDAK merusak precondition lock (last audit entry) — Simpan lalu Kunci setelah entri LAIN disembunyikan tetap sukses", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  await hideOmzetPeriodHistoryEntry({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: firstUpload.version, entryIndex: 0 }, f.context);
  const reloaded = await f.context.locks.findOne({ _id: "1:2026-06" });
  const preview = await previewForLock(f, reloaded!.version);
  const locked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  assert.equal(locked.status, "locked", "hide entri upload lama tidak boleh menghalangi alur Simpan -> Kunci berikutnya");
});

// ---------------------------------------------------------------------------
// V12 CRITICAL: masalah #1 — "Nominal final disepakati" Maret jadi
// Rp199.335.000 (SALAH, seharusnya Rp198.595.000 — Rp740.000 ditambahkan
// DUA KALI). Root cause SEBENARNYA ada di computeAutoFinalAgreedAmount
// (lib/reconciliation-berita-acara-ui.ts, sudah diperbaiki+diuji di sana) —
// test di sini mengunci bahwa SISI SERVER (previewOmzetPeriodLock/
// recordOmzetPeriodLockPreview) TIDAK PERNAH menerapkan aritmetika BA kedua
// apa pun terhadap finalAgreedAmount yang dikirim client: server HANYA
// menghitung adjustmentAmount = finalAgreedAmount - original.olsera dari
// input apa adanya (tidak menyentuh nominal/direction BA sama sekali untuk
// aritmetika) — jadi begitu client mengirim finalAgreedAmount yang BENAR
// (= originalOlseraAmount, hasil computeAutoFinalAgreedAmount yang sudah
// diperbaiki), hasil akhir yang tersimpan juga benar, dan adjustmentAmount
// yang tersimpan adalah 0 (BA hanya BUKTI, bukan penyesuaian kedua).
// ---------------------------------------------------------------------------

const maretExact = { ayo: 197_855_000, olsera: 198_595_000, difference: 740_000 };
const aprilExact = { ayo: 242_129_999, olsera: 241_390_000, difference: -739_999 };

test("V12 REGRESSION test wajib #16 — Maret end-to-end: client mengirim finalAgreedAmount = olseraTotal (hasil computeAutoFinalAgreedAmount yang SUDAH diperbaiki) -> tersimpan PERSIS Rp198.595.000, BUKAN Rp199.335.000; adjustmentAmount = 0", async () => {
  const { f, lock } = await upload();
  const result = await recordOmzetPeriodLockPreview(
    { storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: maretExact, finalAgreedAmount: maretExact.olsera, adjustmentReason: "Pembayaran di muka diterima pada bulan Maret dan diakui sebagai pendapatan bulan Maret.", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" },
    f.context,
  );
  assert.equal(result.preview.finalAgreedAmount, 198_595_000);
  assert.notEqual(result.preview.finalAgreedAmount, 199_335_000, "regresi ke bug double-count produksi asli");
  assert.equal(result.preview.adjustmentAmount, 0, "BA hanya BUKTI selisih valid, bukan penyesuaian numerik kedua");
  assert.equal(result.lock.verifiedMatchStatus, "COCOK");
  // Persisted ke top-level dokumen (V12 fix masalah #2/#3), bukan hanya history.
  assert.equal(result.lock.finalAgreedAmount, 198_595_000);
  assert.equal(result.lock.adjustmentAmount, 0);
});

test("V12 REGRESSION test wajib #16 — April end-to-end: client mengirim finalAgreedAmount = olseraTotal -> tersimpan PERSIS Rp241.390.000, TIDAK dikurangi Rp740.000 lagi; COCOK dalam toleransi ±Rp1", async () => {
  const { f, lock } = await upload();
  const result = await recordOmzetPeriodLockPreview(
    { storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: aprilExact, finalAgreedAmount: aprilExact.olsera, adjustmentReason: "Sudah diakui sebagai pendapatan Maret", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENGURANGAN" },
    f.context,
  );
  assert.equal(result.preview.finalAgreedAmount, 241_390_000);
  assert.notEqual(result.preview.finalAgreedAmount, 240_650_000, "240.650.000 = double-count arah PENGURANGAN, tidak boleh terjadi");
  assert.equal(result.preview.adjustmentAmount, 0);
  assert.equal(result.lock.verifiedMatchStatus, "COCOK", "toleransi ±Rp1 (740.000 vs 739.999) tetap berlaku");
});

// ---------------------------------------------------------------------------
// V12 masalah #2/#3/#4 — "Alasan penyesuaian bisa kosong setelah reopen":
// root cause SEBENARNYA adalah finalAgreedAmount/adjustmentAmount/
// adjustmentReason/original* SEBELUMNYA hanya di-$set saat LOCK, bukan saat
// SIMPAN — periode yang sudah Simpan tapi belum dikunci punya field-field
// itu tetap null di top-level dokumen. Sekarang Simpan JUGA menulis field
// ini (lihat komentar di recordOmzetPeriodLockPreview).
// ---------------------------------------------------------------------------
test("recordOmzetPeriodLockPreview: V12 FIX — finalAgreedAmount/adjustmentAmount/adjustmentReason/original* dipersist ke TOP-LEVEL dokumen saat Simpan (SEBELUM lock), survive refresh", async () => {
  const { f, lock } = await upload();
  await recordOmzetPeriodLockPreview(
    { storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: maretExact, finalAgreedAmount: maretExact.olsera, adjustmentReason: "Pembayaran di muka diterima pada bulan Maret dan diakui sebagai pendapatan bulan Maret.", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" },
    f.context,
  );
  // "refresh" = findOne baru, terpisah dari nilai yang dikembalikan langsung.
  const reloaded = await f.context.locks.findOne({ _id: "1:2026-06" });
  assert.equal(reloaded?.status, "draft", "Simpan TIDAK mengubah status draft/unlocked itu sendiri — hanya field finalisasi");
  assert.equal(reloaded?.finalAgreedAmount, 198_595_000);
  assert.equal(reloaded?.adjustmentAmount, 0);
  assert.equal(reloaded?.adjustmentReason, "Pembayaran di muka diterima pada bulan Maret dan diakui sebagai pendapatan bulan Maret.");
  assert.equal(reloaded?.originalAyoAmount, maretExact.ayo);
  assert.equal(reloaded?.originalOlseraAmount, maretExact.olsera);
  assert.equal(reloaded?.originalDifference, maretExact.difference);
});

test("V12 test wajib #17 — RESTORE FILE TERAKHIR: upload file A -> Simpan, lalu upload file B -> Simpan -> top-level dokumen mencerminkan file B (attachment/nominal/direction TERAKHIR), file A tidak mengisi state", async () => {
  const f = fixture();
  const { lock: uploadA } = await upload(f);
  await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: uploadA.version, original: maretExact, finalAgreedAmount: maretExact.olsera, adjustmentReason: "Alasan dari file A", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" }, f.context);
  const afterA = await f.context.locks.findOne({ _id: "1:2026-06" });
  const attachmentB = { ...attachment, fileName: "berita-acara-B.pdf" };
  const uploadB = await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-b", attachment: attachmentB, expectedVersion: afterA!.version }, f.context);
  const savedB = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-b", expectedVersion: uploadB.version, original: aprilExact, finalAgreedAmount: aprilExact.olsera, adjustmentReason: "Alasan dari file B", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENGURANGAN" }, f.context);
  assert.equal(savedB.lock.attachment?.fileName, "berita-acara-B.pdf", "attachment aktif harus file B, bukan file A");
  assert.equal(savedB.lock.beritaAcaraDirection, "PENGURANGAN", "arah BA harus dari file B (PENGURANGAN), bukan file A (PENAMBAHAN)");
  assert.equal(savedB.lock.adjustmentReason, "Alasan dari file B", "alasan harus dari file B, bukan file A");
  assert.equal(savedB.lock.finalAgreedAmount, aprilExact.olsera, "nominal final harus dari file B (April), bukan file A (Maret)");
});

// ---------------------------------------------------------------------------
// V12 Goal 8-11: "Reset Finalisasi" — computeHistoryAfterReset (murni) dan
// resetOmzetPeriodFinalization (integrasi via fixture).
// ---------------------------------------------------------------------------

test("computeHistoryAfterReset: semua entri yang masih terlihat disembunyikan, entri yang SUDAH hidden dibiarkan apa adanya, SATU entri 'reset' baru ditambahkan TETAP terlihat", () => {
  const now = new Date("2026-08-11T14:32:00.000Z");
  const alreadyHiddenAt = new Date("2026-08-01T00:00:00.000Z");
  const history = [
    historyEntry("upload"),
    historyEntry("preview", { hiddenAt: alreadyHiddenAt, hiddenBy: "supervisor-x" }),
    historyEntry("lock"),
  ];
  const result = computeHistoryAfterReset(history, "supervisor-a", now);
  assert.equal(result.length, 4);
  assert.equal(result[0].hiddenAt, now);
  assert.equal(result[0].hiddenBy, "supervisor-a");
  assert.equal(result[1].hiddenAt, alreadyHiddenAt, "entri yang sudah hidden sebelumnya TIDAK ditimpa ulang");
  assert.equal(result[1].hiddenBy, "supervisor-x");
  assert.equal(result[2].hiddenAt, now);
  assert.equal(result[3].action, "reset");
  assert.equal(result[3].hiddenAt, null, "entri reset baru TETAP terlihat");
  assert.equal(result[3].actor, "supervisor-a");
});

test("resetOmzetPeriodFinalization: test wajib #19 — mengosongkan SELURUH active state (attachment/verifiedMatchStatus/nominal/direction/finalAgreedAmount/adjustmentAmount/adjustmentReason/original*) kembali ke draft, TIDAK menyentuh source AYO/Olsera (fungsi ini tidak pernah membaca collection lain)", async () => {
  const { f, lock } = await upload();
  const saved = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: maretExact, finalAgreedAmount: maretExact.olsera, adjustmentReason: "Pembayaran di muka Maret", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" }, f.context);
  assert.equal(isBeritaAcaraVerifiedUnlocked(saved.lock), true, "prasyarat: sebelum reset, periode ini sudah verified");
  const result = await resetOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: saved.lock.version }, f.context);
  assert.equal(result.status, "draft");
  assert.equal(result.attachment, null);
  assert.equal(result.verifiedMatchStatus, null);
  assert.equal(result.beritaAcaraNominal, null);
  assert.equal(result.beritaAcaraDirection, null);
  assert.equal(result.finalAgreedAmount, null);
  assert.equal(result.adjustmentAmount, null);
  assert.equal(result.adjustmentReason, null);
  assert.equal(result.originalAyoAmount, null);
  assert.equal(result.originalOlseraAmount, null);
  assert.equal(result.originalDifference, null);
  assert.equal(isBeritaAcaraVerifiedUnlocked(result), false, "verified state harus hilang setelah reset");
});

test("resetOmzetPeriodFinalization: riwayat lama di-soft-hide (BUKAN dihapus), entri 'reset' baru ditambahkan dan tetap terlihat", async () => {
  const { f, lock } = await upload();
  const saved = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: lock.version, original: maretExact, finalAgreedAmount: maretExact.olsera, adjustmentReason: "x", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" }, f.context);
  const countBefore = saved.lock.history.length;
  const result = await resetOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: saved.lock.version }, f.context);
  assert.equal(result.history.length, countBefore + 1, "TIDAK ADA entri lama yang dihapus, hanya ditambah 1 entri reset");
  assert.equal(result.history.slice(0, countBefore).every((entry) => entry.hiddenAt !== null), true, "semua entri lama harus soft-hidden");
  assert.equal(result.history.at(-1)?.action, "reset");
  assert.equal(result.history.at(-1)?.hiddenAt, null, "entri reset baru harus tetap terlihat");
  assert.equal(result.history.at(-1)?.actor, "supervisor-a");
});

test("resetOmzetPeriodFinalization: periode locked -> ditolak (harus buka kunci dulu), bukan langsung di-reset", async () => {
  const { f, lock } = await upload();
  const preview = await previewForLock(f, lock.version);
  const locked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: preview.lock.version, original: june, finalAgreedAmount: june.olsera, adjustmentReason: "Pembulatan" }, f.context);
  await assert.rejects(
    () => resetOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: locked.version }, f.context),
    (error: unknown) => error instanceof OmzetPeriodLockError && error.code === "LOCKED",
  );
});

test("resetOmzetPeriodFinalization: periode tidak ditemukan -> NOT_FOUND", async () => {
  const f = fixture();
  await assert.rejects(() => resetOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: 1 }, f.context), OmzetPeriodLockError);
});

test("resetOmzetPeriodFinalization: version basi (konflik konkuren) -> CONFLICT, bukan silent overwrite", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment, expectedVersion: firstUpload.version }, f.context);
  await assert.rejects(() => resetOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: firstUpload.version }, f.context), OmzetPeriodLockError);
});

test("resetOmzetPeriodFinalization: setelah reset, user bisa mulai ulang siklus Upload -> Simpan -> Kunci dari nol", async () => {
  const f = fixture();
  const { lock: firstUpload } = await upload(f);
  const saved = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: firstUpload.version, original: maretExact, finalAgreedAmount: 999, adjustmentReason: "salah", beritaAcaraNominal: 1, beritaAcaraDirection: "PENAMBAHAN" }, f.context);
  const afterReset = await resetOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: saved.lock.version }, f.context);
  const reuploaded = await uploadOmzetPeriodLockAttachment({ storeId: 1, period: "2026-06", actor: "supervisor-a", attachment, expectedVersion: afterReset.version }, f.context);
  const resaved = await recordOmzetPeriodLockPreview({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: reuploaded.version, original: maretExact, finalAgreedAmount: maretExact.olsera, adjustmentReason: "Pembayaran di muka Maret", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN" }, f.context);
  const relocked = await lockOmzetPeriodFinalization({ storeId: 1, period: "2026-06", actor: "supervisor-a", expectedVersion: resaved.lock.version, original: maretExact, finalAgreedAmount: maretExact.olsera, adjustmentReason: "Pembayaran di muka Maret" }, f.context);
  assert.equal(relocked.status, "locked");
  assert.equal(relocked.finalAgreedAmount, 198_595_000);
});
