import { collections, type OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";
import { fetchMatchingContext, getMongoMonthlySnapshotRepo, runForwardBackfillMonth, docsToForwardAnchors, type MonthlySnapshotRepo } from "./olsera-inventory-monthly-snapshot-store.ts";
import { currentStoreId } from "./olsera-store-id.ts";

export type RebuildMode = "dryRun" | "write";
export type RebuildInput = { storeId?: number; year: number; month: number; mode: RebuildMode; repo?: MonthlySnapshotRepo; now?: Date };
export type RebuildResult = {
  ok: boolean; mode: RebuildMode; storeId: number; year: number; month: number;
  safe: boolean; existingCount: number; candidateCount: number; unmatched: number; formulaMismatch: number;
  duplicates: number; changed: boolean; error?: string; docs?: OlseraInventoryMonthlySnapshotDocument[];
};

function validPeriod(year: number, month: number) { return Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12 && year >= 2000 && year <= 2100; }
function duplicateCount(docs: OlseraInventoryMonthlySnapshotDocument[]) { return docs.length - new Set(docs.map((d) => d._id)).size; }
function formulaMismatch(docs: OlseraInventoryMonthlySnapshotDocument[]) {
  return docs.filter((d) => [d.openingQty, d.incomingQty, d.returnQty, d.salesQty, d.outgoingQty, d.closingQty].every((v) => v !== null) && d.closingQty !== d.openingQty! + d.incomingQty! + d.returnQty! - d.salesQty! - d.outgoingQty!).length;
}

export async function rebuildMonthlyInventory(input: RebuildInput): Promise<RebuildResult> {
  const storeId = input.storeId ?? currentStoreId();
  if (!validPeriod(input.year, input.month)) return { ok: false, mode: input.mode, storeId, year: input.year, month: input.month, safe: false, existingCount: 0, candidateCount: 0, unmatched: 0, formulaMismatch: 0, duplicates: 0, changed: false, error: "Periode tidak valid." };
  const repo = input.repo ?? await getMongoMonthlySnapshotRepo();
  const existing = await repo.findMonth(storeId, input.year, input.month);
  if ((await repo.findPeriodLock?.(storeId, input.year, input.month))?.status === "locked") return { ok: false, mode: input.mode, storeId, year: input.year, month: input.month, safe: false, existingCount: existing.length, candidateCount: 0, unmatched: 0, formulaMismatch: 0, duplicates: 0, changed: false, error: "Periode inventori sudah terkunci." };
  const previous = input.month === 1 ? await repo.findMonth(storeId, input.year - 1, 12) : await repo.findMonth(storeId, input.year, input.month - 1);
  if (!previous.length) return { ok: false, mode: input.mode, storeId, year: input.year, month: input.month, safe: false, existingCount: existing.length, candidateCount: 0, unmatched: 0, formulaMismatch: 0, duplicates: 0, changed: false, error: "Closing bulan sebelumnya belum tersedia sebagai anchor." };
  const context = await fetchMatchingContext();
  let candidates: OlseraInventoryMonthlySnapshotDocument[] = [];
  const captureRepo: MonthlySnapshotRepo = { upsertMany: async (docs) => { candidates = docs; }, findMonth: async () => [], findPeriodLock: async () => null };
  const built = await runForwardBackfillMonth({ month: { year: input.year, month: input.month }, storeId, anchors: docsToForwardAnchors(previous), matchingContext: context, repo: captureRepo, now: input.now });
  if (!built.ok) return { ok: false, mode: input.mode, storeId, year: input.year, month: input.month, safe: false, existingCount: existing.length, candidateCount: 0, unmatched: 0, formulaMismatch: 0, duplicates: 0, changed: false, error: built.error };
  const mismatches = formulaMismatch(candidates);
  const duplicates = duplicateCount(candidates);
  const unmatched = built.unmatchedOrAmbiguous.length;
  const safe = candidates.length > 0 && mismatches === 0 && duplicates === 0 && unmatched === 0;
  if (input.mode === "dryRun" || !safe) return { ok: safe, mode: input.mode, storeId, year: input.year, month: input.month, safe, existingCount: existing.length, candidateCount: candidates.length, unmatched, formulaMismatch: mismatches, duplicates, changed: false, error: safe ? undefined : "Periksa Dulu menemukan sumber tidak lengkap, identitas ambigu, duplikat, atau formula tidak valid.", docs: candidates };
  const c = await collections();
  await c.olseraInventoryMonthlySnapshotBackups.insertOne({ _id: `${storeId}:${input.year}-${String(input.month).padStart(2, "0")}:${Date.now()}`, storeId, year: input.year, month: input.month, createdAt: new Date(), snapshots: existing });
  const mongoRepo = input.repo ?? await getMongoMonthlySnapshotRepo();
  if (!("replaceMonth" in mongoRepo)) return { ok: false, mode: input.mode, storeId, year: input.year, month: input.month, safe: false, existingCount: existing.length, candidateCount: candidates.length, unmatched, formulaMismatch: mismatches, duplicates, changed: false, error: "Repository tidak mendukung replace atomik." };
  await (mongoRepo as MonthlySnapshotRepo & { replaceMonth(storeId: number, year: number, month: number, docs: OlseraInventoryMonthlySnapshotDocument[]): Promise<void> }).replaceMonth(storeId, input.year, input.month, candidates);
  return { ok: true, mode: input.mode, storeId, year: input.year, month: input.month, safe: true, existingCount: existing.length, candidateCount: candidates.length, unmatched, formulaMismatch: mismatches, duplicates, changed: true, docs: await mongoRepo.findMonth(storeId, input.year, input.month) };
}
