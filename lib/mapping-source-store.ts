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
  await mappingSources.updateOne({ storeId, kind: "pdf", url }, { $set: { period } });
}

/** Nama lama dipertahankan untuk caller di luar modul selama migrasi. */
export const loadLatestMappingSources = loadMappingSources;
