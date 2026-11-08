import assert from "node:assert/strict";
import test from "node:test";
import { ayoBacklogDates } from "./ayo-backlog-sync.ts";

test("backlog covers 1 Oct .. 7 Nov on 9 Nov and every date exactly once per rotation", () => {
  const seen: string[] = [];
  for (let run = 0; run < 7; run++) seen.push(...ayoBacklogDates("2026-11-09", run));
  assert.equal(seen[0], "2026-10-01");
  assert.equal(seen.at(-1), "2026-11-07");
  assert.equal(seen.length, 38);
  assert.equal(new Set(seen).size, 38);
  assert.deepEqual(ayoBacklogDates("2026-11-09", 7), ayoBacklogDates("2026-11-09", 0));
});

test("slices are contiguous and at most 6 days", () => {
  const slice = ayoBacklogDates("2026-11-09", 3);
  assert.deepEqual(slice, ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
});

test("January wraps back to December of the previous year", () => {
  assert.equal(ayoBacklogDates("2027-01-05", 0)[0], "2026-12-01");
});
