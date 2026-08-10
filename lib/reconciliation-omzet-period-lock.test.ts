import assert from "node:assert/strict";
import test from "node:test";
import type { ReconciliationOmzetPeriodLockDocument } from "./mongodb.ts";
import {
  applyLockedOmzetPresentation,
  lockOmzetPeriodFinalization,
  OmzetPeriodLockError,
  previewOmzetPeriodLock,
  recordOmzetPeriodLockPreview,
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
  assert.deepEqual(applyLockedOmzetPresentation(source, unlocked), { ...source, periodLock: unlocked });
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
