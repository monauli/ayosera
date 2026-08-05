import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

test("legacy POST tetap mewajibkan supervisor, lalu dinonaktifkan agar tidak dapat melewati berita acara", () => {
  assert.match(source, /export async function POST/);
  assert.match(source, /requireSupervisor\(\)/);
  assert.match(source, /status:\s*410/);
  assert.match(source, /finalisasi periode dengan berita acara/);
});

test("legacy endpoint tidak lagi mengimpor atau memanggil lock note lama", () => {
  assert.doesNotMatch(source, /lockOmzetPeriod/);
  assert.doesNotMatch(source, /loadOmzetLedgerMonthDetail/);
});
