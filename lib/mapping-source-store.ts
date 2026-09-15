import "server-only";
import { collections, type MappingSourceDocument } from "./mongodb.ts";

export type SaveMappingSourceInput = Omit<MappingSourceDocument, "_id">;

export async function saveMappingSource(input: SaveMappingSourceInput): Promise<void> {
  const { mappingSources } = await collections();
  await mappingSources.insertOne(input);
}

export async function loadLatestMappingSources(storeId: number): Promise<MappingSourceDocument[]> {
  const { mappingSources } = await collections();
  const rows = await mappingSources.find({ storeId }).sort({ uploadedAt: -1 }).limit(20).toArray();
  return ["excel", "pdf"].flatMap((kind) => {
    const row = rows.find((candidate) => candidate.kind === kind);
    return row ? [row] : [];
  });
}
