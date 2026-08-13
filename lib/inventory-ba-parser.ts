export type InventoryBaParseStatus = "OK" | "PERLU_DICEK";
export type InventoryBaItem = { description: string; systemQty: number | null; physicalQty: number | null; differenceQty: number | null; unit: string | null; confidence: number; status: InventoryBaParseStatus };
export type InventoryBaParseResult = { periodStart: string | null; cutoffDate: string | null; items: InventoryBaItem[]; status: InventoryBaParseStatus; rawText: string };

const MONTHS: Record<string, string> = { januari: "01", februari: "02", maret: "03", april: "04", mei: "05", juni: "06", juli: "07", agustus: "08", september: "09", oktober: "10", november: "11", desember: "12" };
const monthPattern = Object.keys(MONTHS).join("|");

function dateParts(day: string, month: string, year: string) { return `${year}-${MONTHS[month.toLowerCase()]}-${day.padStart(2, "0")}`; }
function numberValue(value: string): number | null { const cleaned = value.trim().replace(/[+,]/g, ""); if (!/^-?\d+$/.test(cleaned)) return null; const n = Number(cleaned); return Number.isSafeInteger(n) ? n : null; }
function normalized(value: string) { return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(); }

export function parseInventoryBaText(rawText: string): InventoryBaParseResult {
  const raw = rawText.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const period = new RegExp(`(?:periode|tanggal)?\\s*(\\d{1,2})\\s+(${monthPattern})\\s+(20\\d{2})\\s*(?:sampai|s\\/?d|[-–])\\s*(\\d{1,2})\\s+(${monthPattern})\\s+(20\\d{2})`, "i").exec(raw);
  const periodStart = period ? dateParts(period[1], period[2], period[3]) : null;
  const cutoffDate = period ? dateParts(period[4], period[5], period[6]) : null;
  const items: InventoryBaItem[] = [];
  for (const originalLine of raw.split("\n")) {
    const line = originalLine.trim();
    if (!line || /deskripsi|stock\s+sistem|stok\s+sistem|kelompok barang/i.test(line)) continue;
    const match = /^(.*?)(?:\s+)([A-Za-zÀ-ÿ]+)?\s+(-?\d+)\s+(-?\d+)\s+([+-]?\d+)\s*(.*)$/u.exec(line);
    if (!match) continue;
    const description = match[1].trim();
    if (description.length < 3 || !/[A-Za-z]/.test(description)) continue;
    const systemQty = numberValue(match[3]);
    const physicalQty = numberValue(match[4]);
    const differenceQty = numberValue(match[5]);
    const arithmeticOk = systemQty !== null && physicalQty !== null && differenceQty === physicalQty - systemQty;
    items.push({ description, unit: match[2] ?? null, systemQty, physicalQty, differenceQty, confidence: arithmeticOk ? 1 : 0, status: arithmeticOk ? "OK" : "PERLU_DICEK" });
  }
  const unique = items.filter((item, index) => items.findIndex((candidate) => normalized(candidate.description) === normalized(item.description)) === index);
  return { periodStart, cutoffDate, items: unique, status: periodStart && cutoffDate && unique.length ? (unique.every((item) => item.status === "OK") ? "OK" : "PERLU_DICEK") : "PERLU_DICEK", rawText };
}

export function normalizeInventoryBaName(value: string) { return normalized(value); }
