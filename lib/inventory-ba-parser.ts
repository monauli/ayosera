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
  // Nama produk yang panjang kadang terbungkus (wrap) menjadi baris fisik
  // terpisah pada text-layer PDF sebelum kolom angka muncul (mis. baris 1:
  // "NESTLE PURE LIFE", baris 2: "1500ML pcs 350 349 -1"). `pendingPrefix`
  // menampung fragmen deskripsi tanpa angka itu dan digabung ke baris
  // berikutnya yang benar-benar berisi triplet angka — GENERIK, tidak
  // bergantung pada nama produk tertentu.
  let pendingPrefix = "";
  for (const originalLine of raw.split("\n")) {
    let line = originalLine.trim();
    if (!line) continue;
    if (/deskripsi|stock\s+sistem|stok\s+sistem|kelompok barang|^no\.?\s/i.test(line)) {
      pendingPrefix = "";
      continue;
    }
    // Baris metadata (periode/tanggal, mis. "Periode 01 Juli 2026 sampai 16
    // Juli 2026" atau baris tanda tangan) BUKAN fragmen nama produk yang wrap
    // — jangan pernah dijadikan pendingPrefix.
    if (new RegExp(`\\b(${monthPattern})\\b`, "i").test(line) && /20\d{2}/.test(line)) {
      pendingPrefix = "";
      continue;
    }
    // Kolom "No." (indeks baris) yang ikut terbaca di depan, mis. "1 YONEX AC102 pcs 10 9 -1".
    // HANYA dilakukan pada awal baris FISIK baru (pendingPrefix kosong) dan
    // maksimal 2 digit — angka mentah 3+ digit di awal baris wrap (mis. "500
    // ML pcs ...", kelanjutan nama produk) TIDAK boleh disangka kolom No.
    if (!pendingPrefix) line = line.replace(/^\d{1,2}\s+(?=[A-Za-zÀ-ÿ])/u, "");
    const match = /^(.*?)(?:\s+)([A-Za-zÀ-ÿ]+)?\s+(-?\d+)\s+(-?\d+)\s+([+-]?\d+)\s*(.*)$/u.exec(line);
    if (!match) {
      // Baris tanpa triplet angka: kemungkinan fragmen deskripsi yang wrap
      // (bukan header/noise) -> simpan sebagai prefix untuk baris berikutnya.
      if (/[A-Za-z]/.test(line) && line.length >= 2 && !/ditandatangani/i.test(line)) {
        pendingPrefix = pendingPrefix ? `${pendingPrefix} ${line}` : line;
      } else {
        pendingPrefix = "";
      }
      continue;
    }
    const description = `${pendingPrefix} ${match[1].trim()}`.replace(/\s+/g, " ").trim();
    pendingPrefix = "";
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
