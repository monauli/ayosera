import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ayoCourtBucket,
  classifyAyoSport,
  extractOlseraCourtNumber,
  olseraCourtBucket,
  PADEL_UNIDENTIFIED_BUCKET,
  PICKLEBALL_AGGREGATE_BUCKET,
  allCourtKeys,
} from "./court-mapping.ts";

test("classifyAyoSport: mengenali Padel dan Pickleball, UNKNOWN untuk field_name asing", () => {
  assert.equal(classifyAyoSport("Court No 1"), "PADEL");
  assert.equal(classifyAyoSport("Court No 4"), "PADEL");
  assert.equal(classifyAyoSport("Pickleball 1"), "PICKLEBALL");
  assert.equal(classifyAyoSport("Pickleball Court No 1"), "PICKLEBALL");
  assert.equal(classifyAyoSport("Studio A"), "UNKNOWN");
});

test("ayoCourtBucket: Padel dipetakan per court, Pickleball selalu digabung", () => {
  assert.deepEqual(ayoCourtBucket("Court No 1"), { courtKey: "Court No 1", sport: "PADEL", confidence: "exact" });
  assert.deepEqual(ayoCourtBucket("Court No 4"), { courtKey: "Court No 4", sport: "PADEL", confidence: "exact" });
  assert.deepEqual(ayoCourtBucket("Pickleball 1"), { courtKey: PICKLEBALL_AGGREGATE_BUCKET, sport: "PICKLEBALL", confidence: "exact" });
  assert.deepEqual(ayoCourtBucket("Pickleball Court No 1"), { courtKey: PICKLEBALL_AGGREGATE_BUCKET, sport: "PICKLEBALL", confidence: "exact" });
  assert.equal(ayoCourtBucket("Studio A"), null);
});

test("extractOlseraCourtNumber: hanya menerima suku kata digit murni, bukan placeholder", () => {
  assert.equal(extractOlseraCourtNumber("COURT FEES - 1"), 1);
  assert.equal(extractOlseraCourtNumber("COURT FEES - 9,"), 9);
  assert.equal(extractOlseraCourtNumber("COURT FEES - -"), null);
  assert.equal(extractOlseraCourtNumber("COURT FEES - ..."), null);
  assert.equal(extractOlseraCourtNumber("COURT FEES - ....,"), null);
  assert.equal(extractOlseraCourtNumber("PICKLEBALL COURT FEE - -"), null);
});

test("olseraCourtBucket: item bukan kategori lapangan dikecualikan total (null)", () => {
  assert.equal(olseraCourtBucket("Nasi Goreng", "MAKANAN"), null);
  assert.equal(olseraCourtBucket("Raket Padel", "RETAIL"), null);
});

test("olseraCourtBucket: Padel nomor 1-4 valid -> exact per court", () => {
  assert.deepEqual(olseraCourtBucket("COURT FEES - 1", "LAPANGAN PADEL"), { courtKey: "Court No 1", sport: "PADEL", confidence: "exact" });
  assert.deepEqual(olseraCourtBucket("COURT FEES - 4", "LAPANGAN PADEL"), { courtKey: "Court No 4", sport: "PADEL", confidence: "exact" });
});

test("olseraCourtBucket: Padel placeholder atau nomor di luar 1-4 -> unmapped, tetap sport PADEL", () => {
  assert.deepEqual(olseraCourtBucket("COURT FEES - -", "LAPANGAN PADEL"), { courtKey: PADEL_UNIDENTIFIED_BUCKET, sport: "PADEL", confidence: "unmapped" });
  assert.deepEqual(olseraCourtBucket("COURT FEES - 7", "LAPANGAN PADEL"), { courtKey: PADEL_UNIDENTIFIED_BUCKET, sport: "PADEL", confidence: "unmapped" });
  assert.deepEqual(olseraCourtBucket("COURT FEES - ...", "LAPANGAN PADEL"), { courtKey: PADEL_UNIDENTIFIED_BUCKET, sport: "PADEL", confidence: "unmapped" });
});

test("olseraCourtBucket: Pickleball selalu exact-aggregate, tidak pernah per court", () => {
  assert.deepEqual(olseraCourtBucket("PICKLEBALL COURT FEE - -", "LAPANGAN PICKLEBALL"), {
    courtKey: PICKLEBALL_AGGREGATE_BUCKET,
    sport: "PICKLEBALL",
    confidence: "exact",
  });
});

test("olseraCourtBucket: kategori 'court' via keyword tapi sport tak dikenali -> ambiguous, tidak dipaksakan", () => {
  const result = olseraCourtBucket("SEWA LAPANGAN MISTERI", "LAPANGAN");
  assert.equal(result?.confidence, "ambiguous");
});

test("allCourtKeys: urutan tetap dan lengkap", () => {
  assert.deepEqual(allCourtKeys(), ["Court No 1", "Court No 2", "Court No 3", "Court No 4", PADEL_UNIDENTIFIED_BUCKET, PICKLEBALL_AGGREGATE_BUCKET]);
});
