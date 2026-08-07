// Regression test penyimpanan draft Coretax — item 19 (draft dapat disimpan
// dan dibuka kembali). Fake collection in-memory (subset method Mongo yang
// benar-benar dipakai, lihat CoretaxDraftCollection) — tidak menyentuh Mongo
// sungguhan.
// Jalankan: node --no-warnings --experimental-strip-types --test lib/coretax/draft-store.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createCoretaxDraft, deleteCoretaxDraft, getCoretaxDraft, listCoretaxDrafts, updateCoretaxDraft, type CoretaxDraftCollection, type CoretaxDraftRecord } from "./draft-store.ts";
import type { CoretaxRow } from "./types.ts";

function fakeCollection(): CoretaxDraftCollection {
  const store = new Map<string, CoretaxDraftRecord>();
  return {
    async insertOne(doc) {
      store.set(doc._id, doc);
      return { acknowledged: true };
    },
    async findOne(filter) {
      return store.get(filter._id) ?? null;
    },
    find(filter) {
      return {
        project() {
          return {
            sort() {
              return {
                async toArray() {
                  return [...store.values()].filter((d) => d.moduleId === filter.moduleId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
                },
              };
            },
          };
        },
      };
    },
    async findOneAndUpdate(filter, update) {
      const existing = store.get(filter._id);
      if (!existing) return null;
      const next = { ...existing, ...update.$set } as CoretaxDraftRecord;
      store.set(filter._id, next);
      return next;
    },
    async deleteOne(filter) {
      const existed = store.delete(filter._id);
      return { deletedCount: existed ? 1 : 0 };
    },
  };
}

test("19. draft dapat dibuat, disimpan (rows/tin/period), lalu dibuka kembali dengan data yang sama persis", async () => {
  const collection = fakeCollection();
  const created = await createCoretaxDraft(collection, { moduleId: "bpu", name: "Draft Agustus", createdBy: "user@ayosera.test" });
  assert.equal(created.rows.length, 0);
  assert.equal(created.moduleId, "bpu");

  const rows: CoretaxRow[] = [
    { rowId: "r1", values: { TaxPeriodMonth: "8", CounterpartTin: "3172024806201234" }, status: "benar", errors: [] },
    { rowId: "r2", values: { TaxPeriodMonth: "8" }, status: "perlu-diperbaiki", errors: [{ field: "CounterpartTin", message: "wajib diisi" }] },
  ];
  const saved = await updateCoretaxDraft(collection, created._id, { tin: "1234567890123456", taxPeriodMonth: "8", taxPeriodYear: "2026", rows });
  assert.ok(saved);
  assert.equal(saved!.rowCount, 2);
  assert.equal(saved!.validRowCount, 1);
  assert.equal(saved!.invalidRowCount, 1);
  assert.equal(saved!.tin, "1234567890123456");

  const reopened = await getCoretaxDraft(collection, created._id);
  assert.ok(reopened);
  assert.deepEqual(reopened!.rows, rows);
  assert.equal(reopened!.taxPeriodMonth, "8");
  assert.equal(reopened!.taxPeriodYear, "2026");
});

test("daftar draft per jenis dokumen — hanya draft moduleId yang diminta, terurut terbaru dulu", async () => {
  const collection = fakeCollection();
  const a = await createCoretaxDraft(collection, { moduleId: "bpu", name: "A", createdBy: "u" }, new Date("2026-08-01T00:00:00Z"));
  await createCoretaxDraft(collection, { moduleId: "bpmp", name: "B (modul lain)", createdBy: "u" }, new Date("2026-08-02T00:00:00Z"));
  const c = await createCoretaxDraft(collection, { moduleId: "bpu", name: "C", createdBy: "u" }, new Date("2026-08-03T00:00:00Z"));

  const list = await listCoretaxDrafts(collection, "bpu");
  assert.deepEqual(list.map((d) => d._id), [c._id, a._id], "hanya modul bpu, terbaru dulu");
});

test("ganti nama draft (rename) tidak mengubah rows", async () => {
  const collection = fakeCollection();
  const draft = await createCoretaxDraft(collection, { moduleId: "bp21", name: "Lama", createdBy: "u" });
  const rows = [{ rowId: "r1", values: { TaxPeriodMonth: "1" }, status: "benar" as const, errors: [] }];
  await updateCoretaxDraft(collection, draft._id, { rows });
  const renamed = await updateCoretaxDraft(collection, draft._id, { name: "Baru" });
  assert.equal(renamed!.name, "Baru");
  assert.deepEqual(renamed!.rows, rows);
});

test("hapus draft dengan konfirmasi — draft yang dihapus tidak lagi ditemukan; id acak mengembalikan false", async () => {
  const collection = fakeCollection();
  const draft = await createCoretaxDraft(collection, { moduleId: "bpa1", name: "Hapus Saya", createdBy: "u" });
  assert.equal(await deleteCoretaxDraft(collection, draft._id), true);
  assert.equal(await getCoretaxDraft(collection, draft._id), null);
  assert.equal(await deleteCoretaxDraft(collection, "tidak-ada"), false);
});
