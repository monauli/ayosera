// Entry point BROWSER-SIDE untuk membaca Berita Acara Stock Opname. Jalur
// utama (PDF dengan text layer): ekstrak text item MENTAH (posisi X/Y asli)
// lalu rekonstruksi tabel secara SPASIAL (lib/inventory-ba-table-parser.ts) —
// lihat AYOSERA-HANDOFF-LATEST.md untuk bukti root cause kenapa parser baris
// teks lama (pendingPrefix/orphan-suffix) menukar angka antar baris.
//
// Jalur fallback (PDF hasil scan / gambar, tidak ada text layer dengan
// koordinat): TIDAK ADA rekonstruksi tabel dari OCR plain text di codebase
// ini saat ini (lihat AYOSERA-HANDOFF-LATEST.md, bagian gap). Untuk kasus
// ini kita SENGAJA mengembalikan fail-safe eksplisit (0 baris, PERLU_DICEK)
// alih-alih memakai parser baris teks lama yang terbukti salah sebagai
// fallback diam-diam — periode/cutoff pada teks OCR tetap dicoba dibaca
// (regex bebas layout, tidak bergantung pada tabel) untuk kenyamanan
// tampilan, tapi baris item TIDAK PERNAH ditebak dari teks tanpa posisi.
import { extractBeritaAcaraTextClient, extractInventoryBaPdfItems, type BeritaAcaraClientOcrResult, type OnOcrStatus } from "./reconciliation-berita-acara-client-ocr";
import { inventoryBaParseFailure, type InventoryBaParseResult } from "./inventory-ba-parser";
import { parseInventoryBaTable } from "./inventory-ba-table-parser";

export async function analyzeInventoryBaFile(file: File, onStatus?: OnOcrStatus): Promise<BeritaAcaraClientOcrResult & { parsed: InventoryBaParseResult }> {
  const status = onStatus ?? (() => {});
  if (file.type === "application/pdf") {
    const items = await extractInventoryBaPdfItems(file, status);
    if (items) {
      const parsed = parseInventoryBaTable(items);
      return { text: items.map((i) => i.str).join(" "), confidence: 1, source: "pdf-text-layer", parsed };
    }
  }
  // Tidak ada text layer dengan posisi (PDF scan) atau file bukan PDF (JPG/PNG):
  // tetap ekstrak teks (OCR) untuk tampilan/periode, tapi baris item WAJIB
  // fail-safe — lihat catatan gap OCR table extraction di atas.
  const extracted = await extractBeritaAcaraTextClient(file, { onStatus: status });
  return { ...extracted, parsed: inventoryBaParseFailure(extracted.text) };
}
