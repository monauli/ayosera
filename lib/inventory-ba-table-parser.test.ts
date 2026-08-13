import assert from "node:assert/strict";
import test from "node:test";
import { parseInventoryBaTable, type PositionedTextItem } from "./inventory-ba-table-parser.ts";

// ---------------------------------------------------------------------------
// REGRESI STRUKTURAL (V4 rewrite): bug produksi terbukti nyata pada tabel BA
// Juli 2026 — baris YONEX AC102 (seharusnya Sistem 10 / Fisik 9 / Selisih -1)
// terbaca sebagai Sistem 201 / Fisik 350 / Selisih +349, angka yang
// sebenarnya milik baris NESTLE PURE LIFE 1500ML (Satuan=201, Sistem=350).
// Ini membuktikan parser baris-teks lama SALAH SECARA STRUKTURAL. Fixture di
// bawah mensimulasikan text item pdf.js REALISTIS (posisi X/Y eksplisit per
// kolom, termasuk header dua baris "Stock Sistem"/"Olsera" dan sel deskripsi
// multi-baris) — parser baru WAJIB merekonstruksi ketujuh baris tanpa
// tertukar satu angka pun.
// ---------------------------------------------------------------------------

const COL_NO = 40;
const COL_KELOMPOK = 70;
const COL_DESKRIPSI = 170;
const COL_SATUAN = 300;
const COL_SISTEM = 350;
const COL_FISIK = 420;
const COL_SELISIH = 490;
const COL_KETERANGAN = 540;

const HEADER_Y = 650;
const HEADER_Y2 = 638; // baris kedua header yang wrap ("Olsera" / "Aktual")

function header(): PositionedTextItem[] {
  return [
    { str: "Periode 01 Juli 2026 sampai 16 Juli 2026", x: COL_NO, y: 700 },
    { str: "No.", x: COL_NO, y: HEADER_Y },
    { str: "Kelompok Barang", x: COL_KELOMPOK, y: HEADER_Y },
    { str: "Deskripsi Barang", x: COL_DESKRIPSI, y: HEADER_Y },
    { str: "Satuan", x: COL_SATUAN, y: HEADER_Y },
    { str: "Stock Sistem", x: COL_SISTEM, y: HEADER_Y },
    { str: "Olsera", x: COL_SISTEM, y: HEADER_Y2 },
    { str: "Stock Fisik", x: COL_FISIK, y: HEADER_Y },
    { str: "Aktual", x: COL_FISIK, y: HEADER_Y2 },
    { str: "Selisih", x: COL_SELISIH, y: HEADER_Y },
    { str: "Keterangan", x: COL_KETERANGAN, y: HEADER_Y },
  ];
}

type RowSpec = {
  no: number;
  kelompok: string;
  deskripsiLines: string[]; // 1 baris (tanpa wrap) atau 2 baris (multiline)
  satuan: number;
  sistem: number;
  fisik: number;
  selisih: number;
  keterangan: string;
};

const ROW_SPECS: RowSpec[] = [
  { no: 1, kelompok: "GRIP", deskripsiLines: ["YONEX AC102"], satuan: 4, sistem: 10, fisik: 9, selisih: -1, keterangan: "Untuk Raket Sewa" },
  { no: 2, kelompok: "MINUMAN", deskripsiLines: ["NESTLE PURE LIFE", "1500ML"], satuan: 201, sistem: 350, fisik: 349, selisih: -1, keterangan: "Kurang 1" },
  { no: 3, kelompok: "MINUMAN", deskripsiLines: ["NESTLE PURE LIFE", "600ML"], satuan: 141, sistem: 529, fisik: 528, selisih: -1, keterangan: "Kurang 1" },
  { no: 4, kelompok: "BOLA PADEL", deskripsiLines: ["ODEA RED"], satuan: 1, sistem: 45, fisik: 47, selisih: 2, keterangan: "Salah Input di Kasir" },
  { no: 5, kelompok: "BOLA PADEL", deskripsiLines: ["ODEA ROSE"], satuan: 9, sistem: 38, fisik: 36, selisih: -2, keterangan: "Salah Input di Kasir" },
  { no: 6, kelompok: "MINUMAN", deskripsiLines: ["POCARI SWEAT PET", "500 ML"], satuan: 129, sistem: 342, fisik: 341, selisih: -1, keterangan: "Kurang 1" },
  { no: 7, kelompok: "MINUMAN", deskripsiLines: ["POCARI ION WATER", "500ML"], satuan: 76, sistem: 202, fisik: 201, selisih: -1, keterangan: "Kurang 1" },
];

const ROW_Y_STEP = 30;
const FIRST_ROW_Y = 600;

function buildRows(specs: RowSpec[]): PositionedTextItem[] {
  const items: PositionedTextItem[] = [];
  specs.forEach((spec, index) => {
    const y = FIRST_ROW_Y - index * ROW_Y_STEP;
    items.push({ str: String(spec.no), x: COL_NO, y });
    items.push({ str: spec.kelompok, x: COL_KELOMPOK, y });
    spec.deskripsiLines.forEach((line, lineIndex) => {
      items.push({ str: line, x: COL_DESKRIPSI, y: y - lineIndex * 12 });
    });
    items.push({ str: String(spec.satuan), x: COL_SATUAN, y });
    items.push({ str: String(spec.sistem), x: COL_SISTEM, y });
    items.push({ str: String(spec.fisik), x: COL_FISIK, y });
    items.push({ str: spec.selisih > 0 ? `+${spec.selisih}` : String(spec.selisih), x: COL_SELISIH, y });
    items.push({ str: spec.keterangan, x: COL_KETERANGAN, y });
  });
  return items;
}

function fullFixture(): PositionedTextItem[] {
  return [...header(), ...buildRows(ROW_SPECS)];
}

test("parseInventoryBaTable: tujuh baris terekstrak persis, periode/cutoff terbaca, status OK", () => {
  const result = parseInventoryBaTable(fullFixture());
  assert.equal(result.periodStart, "2026-07-01");
  assert.equal(result.cutoffDate, "2026-07-16");
  assert.equal(result.items.length, 7);
  assert.equal(result.status, "OK");
});

test("REGRESI UTAMA: YONEX AC102 harus persis Sistem 10 / Fisik 9 / Selisih -1 (bug produksi: sebelumnya terbaca 201/350/+349 dari baris NESTLE)", () => {
  const result = parseInventoryBaTable(fullFixture());
  const yonex = result.items.find((i) => i.description === "YONEX AC102");
  assert.ok(yonex, "YONEX AC102 harus ditemukan sebagai baris sendiri");
  assert.equal(yonex!.systemQty, 10);
  assert.equal(yonex!.physicalQty, 9);
  assert.equal(yonex!.differenceQty, -1);
  assert.equal(yonex!.satuan, 4);
  assert.equal(yonex!.kelompok, "GRIP");
  assert.equal(yonex!.keterangan, "Untuk Raket Sewa");
});

test("seluruh 7 baris: field numerik dan teks persis sesuai spesifikasi", () => {
  const result = parseInventoryBaTable(fullFixture());
  const byDescription = new Map(result.items.map((i) => [i.description, i]));
  for (const spec of ROW_SPECS) {
    const description = spec.deskripsiLines.join(" ");
    const item = byDescription.get(description);
    assert.ok(item, `${description} harus ditemukan`);
    assert.equal(item!.kelompok, spec.kelompok, `${description} kelompok`);
    assert.equal(item!.satuan, spec.satuan, `${description} satuan`);
    assert.equal(item!.systemQty, spec.sistem, `${description} sistem`);
    assert.equal(item!.physicalQty, spec.fisik, `${description} fisik`);
    assert.equal(item!.differenceQty, spec.selisih, `${description} selisih`);
    assert.equal(item!.keterangan, spec.keterangan, `${description} keterangan`);
    assert.equal(item!.status, "OK");
  }
});

test("tidak ada kebocoran angka antar baris: nilai unik satu baris tidak pernah muncul di baris lain", () => {
  const result = parseInventoryBaTable(fullFixture());
  const nestle1500 = result.items.find((i) => i.description === "NESTLE PURE LIFE 1500ML")!;
  const odeaRed = result.items.find((i) => i.description === "ODEA RED")!;
  const odeaRose = result.items.find((i) => i.description === "ODEA ROSE")!;

  // Satuan NESTLE 1500ML (201) hanya boleh muncul pada baris itu sendiri.
  for (const item of result.items) {
    if (item.description === "NESTLE PURE LIFE 1500ML") continue;
    assert.notEqual(item.satuan, 201, `Satuan 201 (milik NESTLE 1500ML) bocor ke baris ${item.description}`);
    assert.notEqual(item.systemQty, 350, `Sistem 350 (milik NESTLE 1500ML) bocor ke baris ${item.description}`);
  }
  assert.equal(nestle1500.satuan, 201);
  assert.equal(nestle1500.systemQty, 350);

  // Sistem ODEA RED (45) tidak boleh bocor ke ODEA ROSE dan sebaliknya.
  assert.equal(odeaRed.systemQty, 45);
  assert.equal(odeaRose.systemQty, 38);
  assert.notEqual(odeaRose.systemQty, odeaRed.systemQty);
});

test("ODEA RED dan ODEA ROSE adalah dua baris berbeda (tidak tergabung/tertukar)", () => {
  const result = parseInventoryBaTable(fullFixture());
  const odeaRed = result.items.find((i) => i.description === "ODEA RED");
  const odeaRose = result.items.find((i) => i.description === "ODEA ROSE");
  assert.ok(odeaRed);
  assert.ok(odeaRose);
  assert.notEqual(odeaRed, odeaRose);
  assert.equal(odeaRed!.differenceQty, 2);
  assert.equal(odeaRose!.differenceQty, -2);
});

test("aritmetika Fisik - Sistem = Selisih berlaku untuk seluruh 7 baris", () => {
  const result = parseInventoryBaTable(fullFixture());
  for (const item of result.items) {
    assert.equal(item.physicalQty! - item.systemQty!, item.differenceQty, `arithmetic gagal untuk ${item.description}`);
  }
});

test("sel Deskripsi Barang multi-baris (wrap) direkonstruksi jadi satu nama utuh", () => {
  const result = parseInventoryBaTable(fullFixture());
  const descriptions = result.items.map((i) => i.description).sort();
  assert.deepEqual(descriptions, ["NESTLE PURE LIFE 1500ML", "NESTLE PURE LIFE 600ML", "ODEA RED", "ODEA ROSE", "POCARI ION WATER 500ML", "POCARI SWEAT PET 500 ML", "YONEX AC102"].sort());
});

// ---------------------------------------------------------------------------
// Safety: baris tidak lengkap/aritmetika salah -> "Perlu Dicek", TIDAK
// meminjam angka dari baris tetangga, dan memblokir Finalisasi (lewat
// status keseluruhan PERLU_DICEK + status per-baris).
// ---------------------------------------------------------------------------

test("baris dengan aritmetika salah -> status baris PERLU_DICEK, baris lain TIDAK terpengaruh (tidak meminjam angka)", () => {
  const specs: RowSpec[] = [
    { no: 1, kelompok: "GRIP", deskripsiLines: ["YONEX AC102"], satuan: 4, sistem: 10, fisik: 9, selisih: -1, keterangan: "Untuk Raket Sewa" },
    { no: 2, kelompok: "MINUMAN", deskripsiLines: ["ODEA RED"], satuan: 1, sistem: 45, fisik: 47, selisih: 0, keterangan: "Salah cetak" }, // selisih salah: harus +2
  ];
  const items = [...header(), ...buildRows(specs)];
  const result = parseInventoryBaTable(items);
  assert.equal(result.items.length, 2);
  const yonex = result.items.find((i) => i.description === "YONEX AC102")!;
  const odea = result.items.find((i) => i.description === "ODEA RED")!;
  assert.equal(yonex.status, "OK");
  assert.equal(yonex.systemQty, 10);
  assert.equal(yonex.physicalQty, 9);
  assert.equal(yonex.differenceQty, -1);
  assert.equal(odea.status, "PERLU_DICEK");
  assert.equal(odea.systemQty, 45, "sistem ODEA RED tidak boleh berubah/dipinjam");
  assert.equal(odea.physicalQty, 47, "fisik ODEA RED tidak boleh berubah/dipinjam");
  assert.equal(result.status, "PERLU_DICEK");
});

test("baris dengan sel kosong (Selisih tidak terbaca) -> PERLU_DICEK, bukan crash/tebakan", () => {
  const items = [...header(), { str: "1", x: COL_NO, y: FIRST_ROW_Y }, { str: "GRIP", x: COL_KELOMPOK, y: FIRST_ROW_Y }, { str: "YONEX AC102", x: COL_DESKRIPSI, y: FIRST_ROW_Y }, { str: "4", x: COL_SATUAN, y: FIRST_ROW_Y }, { str: "10", x: COL_SISTEM, y: FIRST_ROW_Y }, { str: "9", x: COL_FISIK, y: FIRST_ROW_Y }];
  const result = parseInventoryBaTable(items);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, "PERLU_DICEK");
  assert.equal(result.items[0].differenceQty, null);
  assert.equal(result.status, "PERLU_DICEK");
});

test("header tidak ditemukan (bukan tabel BA) -> fail-safe 0 baris, PERLU_DICEK, bukan crash", () => {
  const result = parseInventoryBaTable([{ str: "Dokumen acak tanpa tabel", x: 0, y: 0 }]);
  assert.equal(result.items.length, 0);
  assert.equal(result.status, "PERLU_DICEK");
});

test("tidak ada item sama sekali -> fail-safe 0 baris, PERLU_DICEK", () => {
  const result = parseInventoryBaTable([]);
  assert.equal(result.items.length, 0);
  assert.equal(result.status, "PERLU_DICEK");
});

test("item pdf.js dengan urutan ekstraksi acak (bukan urutan visual) tetap direkonstruksi benar berdasarkan X/Y, bukan urutan array", () => {
  const shuffled = [...fullFixture()].sort(() => 0.5 - Math.random());
  const result = parseInventoryBaTable(shuffled);
  assert.equal(result.items.length, 7);
  const yonex = result.items.find((i) => i.description === "YONEX AC102")!;
  assert.equal(yonex.systemQty, 10);
  assert.equal(yonex.physicalQty, 9);
  assert.equal(yonex.differenceQty, -1);
});
