import { extractBeritaAcaraTextClient, type BeritaAcaraClientOcrResult, type OnOcrStatus } from "./reconciliation-berita-acara-client-ocr";
import { parseInventoryBaText, type InventoryBaParseResult } from "./inventory-ba-parser";

export async function analyzeInventoryBaFile(file: File, onStatus?: OnOcrStatus): Promise<BeritaAcaraClientOcrResult & { parsed: InventoryBaParseResult }> {
  const extracted = await extractBeritaAcaraTextClient(file, { onStatus });
  return { ...extracted, parsed: parseInventoryBaText(extracted.text) };
}
