import "server-only";
import { collections, type MappingSourceDocument } from "./mongodb.ts";
import { selectMappingSources } from "./mapping-source-selection.ts";

export { selectMappingSources } from "./mapping-source-selection.ts";

export type SaveMappingSourceInput = Omit<MappingSourceDocument, "_id">;

export async function saveMappingSource(input: SaveMappingSourceInput): Promise<void> {
  const { mappingSources } = await collections();
  await mappingSources.insertOne(input);
}

export async function loadMappingSources(storeId: number): Promise<MappingSourceDocument[]> {
  const { mappingSources } = await collections();
  const rows = await mappingSources.find({ storeId }).sort({ uploadedAt: -1 }).toArray();
  return selectMappingSources(rows);
}

export async function tagMappingSourcePeriod(storeId: number, url: string, period: string): Promise<void> {
  const { mappingSources } = await collections();
  const result = await mappingSources.updateOne({ storeId, kind: "pdf", url }, { $set: { period } });
  if (result.matchedCount === 0) throw new Error("PDF tersimpan tidak ditemukan untuk periode ini.");
}

export async function saveMappingSourceParse(storeId: number, url: string, parsedReports: unknown, parsedWithVersion: string): Promise<void> {
  const { mappingSources } = await collections();
  const result = await mappingSources.updateOne({ storeId, kind: "pdf", url }, { $set: { parsedReports, parsedWithVersion } });
  if (result.matchedCount === 0) throw new Error("PDF tersimpan tidak ditemukan; hasil baca belum disimpan.");
}

/** Nama lama dipertahankan untuk caller di luar modul selama migrasi. */
export const loadLatestMappingSources = loadMappingSources;
