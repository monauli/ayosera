// Test untuk bagian MURNI lib/reconciliation-actor-display.ts (V8 Goal 3):
// resolusi actor id mentah -> nama tampilan. fetchActorDisplayNameMap/
// attachActorDisplayNames (server-only, butuh MongoDB) SENGAJA tidak dites
// di sini — collectPeriodLockActorIds/buildActorDisplayNameMap/
// resolveActorDisplayName/withActorDisplayNames sudah cukup untuk membuktikan
// logika pemetaan id->nama benar tanpa DB sungguhan.
import assert from "node:assert/strict";
import test from "node:test";
import {
  FALLBACK_ACTOR_NAME,
  collectPeriodLockActorIds,
  buildActorDisplayNameMap,
  resolveActorDisplayName,
  withActorDisplayNames,
} from "./reconciliation-actor-display.ts";

test("collectPeriodLockActorIds: kumpulkan id unik dari attachment/lockedBy/unlockedBy/history, abaikan null", () => {
  const ids = collectPeriodLockActorIds({
    attachment: { uploadedBy: "id-1" },
    lockedBy: "id-2",
    unlockedBy: null,
    history: [{ actor: "id-1" }, { actor: "id-3" }],
  });
  assert.deepEqual(new Set(ids), new Set(["id-1", "id-2", "id-3"]));
});

test("collectPeriodLockActorIds: lock null -> array kosong (bukan crash)", () => {
  assert.deepEqual(collectPeriodLockActorIds(null), []);
});

test("buildActorDisplayNameMap: prioritas name > email > fallback 'User'", () => {
  const map = buildActorDisplayNameMap([
    { _id: { toHexString: () => "id-1" }, name: "Simon", email: "simon@ayo.local" },
    { _id: { toHexString: () => "id-2" }, name: "", email: "noname@ayo.local" },
    { _id: { toHexString: () => "id-3" }, name: null, email: null },
  ]);
  assert.equal(map["id-1"], "Simon");
  assert.equal(map["id-2"], "noname@ayo.local");
  assert.equal(map["id-3"], FALLBACK_ACTOR_NAME);
});

test("resolveActorDisplayName: id tidak ada di map (user dihapus/tidak ditemukan) -> fallback 'User', BUKAN raw id", () => {
  const map = buildActorDisplayNameMap([{ _id: { toHexString: () => "id-1" }, name: "Simon" }]);
  assert.equal(resolveActorDisplayName("id-1", map), "Simon");
  assert.equal(resolveActorDisplayName("id-deleted-user", map), FALLBACK_ACTOR_NAME);
  assert.equal(resolveActorDisplayName(null, map), FALLBACK_ACTOR_NAME);
});

test("withActorDisplayNames: menambah *Name TANPA menghapus field raw asli (backend tetap simpan actor id mentah)", () => {
  const map = { "id-1": "Simon", "id-2": "Supervisor" };
  const lock = {
    attachment: { uploadedBy: "id-1", fileName: "ba.pdf" },
    lockedBy: "id-2",
    unlockedBy: null,
    history: [
      { action: "upload", actor: "id-1", timestamp: "t1", reason: null },
      { action: "lock", actor: "id-2", timestamp: "t2", reason: "x" },
    ],
  };
  const result = withActorDisplayNames(lock, map);
  assert.equal(result.attachment?.uploadedByName, "Simon");
  assert.equal(result.attachment?.uploadedBy, "id-1", "raw uploadedBy TIDAK dihapus");
  assert.equal(result.lockedByName, "Supervisor");
  assert.equal(result.lockedBy, "id-2", "raw lockedBy TIDAK dihapus");
  assert.equal(result.unlockedByName, FALLBACK_ACTOR_NAME);
  assert.equal(result.history[0]?.actorName, "Simon");
  assert.equal(result.history[0]?.actor, "id-1", "raw actor TIDAK dihapus dari history");
  assert.equal(result.history[1]?.actorName, "Supervisor");
});

test("withActorDisplayNames: attachment null -> tetap null (bukan object kosong)", () => {
  const result = withActorDisplayNames({ attachment: null, lockedBy: null, unlockedBy: null, history: [] }, {});
  assert.equal(result.attachment, null);
});
