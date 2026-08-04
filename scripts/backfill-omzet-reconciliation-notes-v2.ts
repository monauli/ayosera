// Migrasi skema Lock+Berita Acara (Opsi A dari dokumen desain, lihat
// "Desain Skema Lock+Berita Acara" section 4 di tmp/ai-handoff.md).
//
// Yang dilakukan: untuk SETIAP dokumen LAMA (bentuk
// `OlseraOmzetReconciliationNoteDocument`, `_id = "${storeId}:${period}"`,
// TANPA field `isCurrent`) di collection `olsera_omzet_reconciliation_notes`,
// tambahkan (via $set, TANPA mengubah `_id`/field lama sama sekali) field
// skema baru (`OlseraOmzetReconciliationNoteV2Document`) sebagai versi
// PERTAMA yang sudah berlaku:
//   isCurrent: true, supersededBy: null, supersededAt: null,
//   previousNoteId: null, locked: false, lockedBy: null, lockedAt: null,
//   attachmentUrl: null, attachmentFileName: null.
//
// `_id` LAMA (`"${storeId}:${period}"`) SENGAJA DIPERTAHANKAN — tidak
// dikonversi ke format `note:v1:${hash}` (formula itu butuh actor+
// idempotencyKey yang tidak pernah ada untuk submit lama; memaksakan nilai
// palsu untuk field itu hanya untuk memenuhi format _id baru adalah
// fabrikasi data, bukan migrasi). Dua bentuk _id ini valid berdampingan di
// collection yang sama (lihat catatan di OlseraOmzetReconciliationNoteV2Document,
// lib/mongodb.ts).
//
// Idempoten: dokumen yang sudah punya field `isCurrent` (baik hasil migrasi
// sebelumnya maupun submit baru lewat lib/reconciliation-omzet-note-store.ts)
// TIDAK disentuh lagi — filter query hanya menyasar `{ isCurrent: { $exists: false } }`.
// Aman dijalankan berulang kali.
//
// TIDAK menyentuh collection lain, TIDAK menyentuh classifyStatus/
// computeOmzetOlseraLedger, TIDAK membuat endpoint API apa pun.
//
// Pakai:
//   node --no-warnings --experimental-strip-types scripts/backfill-omzet-reconciliation-notes-v2.ts --dry-run
//   node --no-warnings --experimental-strip-types scripts/backfill-omzet-reconciliation-notes-v2.ts
import { existsSync, readFileSync } from "fs";
import path from "path";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const DRY_RUN = process.argv.includes("--dry-run");

const { getDb, mongoClient } = await import("../lib/mongodb.ts");

console.log(`Backfill skema Lock+Berita Acara — olsera_omzet_reconciliation_notes${DRY_RUN ? " (DRY RUN, tidak menulis apa pun)" : ""}\n`);

const db = await getDb();
// Diakses tanpa generic type driver (bukan lewat collections()) — dokumen
// lama & baru punya bentuk field berbeda, dan migrasi ini sengaja menulis
// field yang tidak ada di tipe lama `OlseraOmzetReconciliationNoteDocument`.
const notes = db.collection("olsera_omzet_reconciliation_notes");

const legacyDocs = await notes.find({ isCurrent: { $exists: false } }).toArray();
console.log(`Dokumen skema lama ditemukan (belum ada field isCurrent): ${legacyDocs.length}`);

if (legacyDocs.length === 0) {
  console.log("Tidak ada yang perlu dimigrasi.");
  await mongoClient.close().catch(() => undefined);
  process.exit(0);
}

for (const doc of legacyDocs) {
  console.log(`  _id=${doc._id} storeId=${doc.storeId} period=${doc.period} evidenceType=${doc.evidenceType}`);
}

if (DRY_RUN) {
  console.log(`\nDRY RUN — ${legacyDocs.length} dokumen AKAN di-$set (isCurrent:true, locked:false, dst) bila dijalankan tanpa --dry-run.`);
  await mongoClient.close().catch(() => undefined);
  process.exit(0);
}

const patch = {
  isCurrent: true,
  supersededBy: null,
  supersededAt: null,
  previousNoteId: null,
  locked: false,
  lockedBy: null,
  lockedAt: null,
  attachmentUrl: null,
  attachmentFileName: null,
};

const result = await notes.updateMany({ isCurrent: { $exists: false } }, { $set: patch });
console.log(`\nDokumen diperbarui: ${result.modifiedCount} (matched: ${result.matchedCount})`);

const remaining = await notes.countDocuments({ isCurrent: { $exists: false } });
console.log(remaining === 0 ? "PASS  Semua dokumen lama sudah bermigrasi ke skema baru." : `PERINGATAN — masih ada ${remaining} dokumen tanpa field isCurrent.`);

await mongoClient.close().catch(() => undefined);
