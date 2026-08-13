import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ---------------------------------------------------------------------------
// REGRESI FILE PDF ASLI (BA Juli 2026, ground-truth 2026-08-13/14): fixture
// di bawah BUKAN direkonstruksi/ditebak — nilai str/x/y untuk setiap item
// disalin VERBATIM dari dump mentah pdf.js atas file production sungguhan
// `tmp/fixtures/BA Daily Stock Opname BC Padel 01-16 Juli 2026.pdf`
// (2 halaman; halaman 1 berisi 177 text item, halaman 2 kosong/0 item).
// Fixture ini hanya membuang paragraf non-tabel (nama penandatangan, dsb)
// per permintaan sanitasi — koordinat baris periode/cutoff dan seluruh
// tabel (header + 7 baris data) tetap persis seperti pdf.js mengembalikannya.
//
// TEMUAN GROUND-TRUTH PENTING dari raw dump (bukan tebakan):
// 1. Header kolom deskripsi PADA FILE ASLI tertulis "Deksripsi Barang" (typo
//    k/s tertukar dari dokumen sumber, BUKAN typo test) — inilah SATU-
//    SATUNYA penyebab parser lama gagal total (0 baris) pada file real ini
//    walau lulus 100% pada fixture sintetis lama yang mengeja "Deskripsi"
//    dengan benar.
// 2. Kalimat periode/cutoff berbunyi "...untuk periode 01 Juli 2026 sampai
//    16 Juli 2026." -> periodStart 2026-07-01, cutoffDate 2026-07-16.
// 3. Ada tanggal penandatanganan "17 Juli 2026" (ditulis dieja: "tanggal
//    Tujuh Belas Bulan Juli Tahun Dua Ribu Dua Puluh Enam (17-07-2026)")
//    yang TIDAK boleh tertangkap sebagai cutoff — regex periode hanya cocok
//    pola "<tgl> <bulan> <tahun> sampai/s.d./- <tgl> <bulan> <tahun>" dalam
//    angka, dan kalimat tanggal penandatanganan ditulis dieja (bukan format
//    itu) sehingga otomatis tidak cocok; dibuktikan di test di bawah.
// 4. Jumlah baris data tabel = 7 (dihitung dari 7 anchor kolom "No." unik:
//    1..7), BUKAN diasumsikan dari task — lihat AYOSERA-HANDOFF-LATEST.md.
// ---------------------------------------------------------------------------

function loadRealJuli2026Fixture(): PositionedTextItem[] {
  const path = fileURLToPath(new URL("./__fixtures__/inventory-ba-juli-2026-real-items.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

test("REGRESI FILE PDF ASLI: BA Juli 2026 — periode, cutoff, 7 baris, status OK", () => {
  const items = loadRealJuli2026Fixture();
  const result = parseInventoryBaTable(items);
  assert.equal(result.periodStart, "2026-07-01");
  assert.equal(result.cutoffDate, "2026-07-16", "cutoff harus 16 Juli 2026, BUKAN tanggal penandatanganan 17 Juli");
  assert.equal(result.items.length, 7);
  assert.equal(result.status, "OK");
});

test("REGRESI FILE PDF ASLI: seluruh 7 baris persis sesuai raw pdf.js dump (bukan angka dari prompt)", () => {
  const items = loadRealJuli2026Fixture();
  const result = parseInventoryBaTable(items);
  const expected = [
    { description: "YONEX AC102", kelompok: "GRIP", systemQty: 10, physicalQty: 9, differenceQty: -1 },
    { description: "NESTLE PURE LIFE 1500ML", kelompok: "MINUMAN", systemQty: 350, physicalQty: 349, differenceQty: -1 },
    { description: "NESTLE PURE LIFE 600ML", kelompok: "MINUMAN", systemQty: 529, physicalQty: 528, differenceQty: -1 },
    { description: "ODEA RED", kelompok: "BOLA PADEL", systemQty: 45, physicalQty: 47, differenceQty: 2 },
    { description: "ODEA ROSE", kelompok: "BOLA PADEL", systemQty: 38, physicalQty: 36, differenceQty: -2 },
    { description: "POCARI SWEAT PET 500 ML", kelompok: "MINUMAN", systemQty: 342, physicalQty: 341, differenceQty: -1 },
    { description: "POCARI ION WATER 500ML", kelompok: "MINUMAN", systemQty: 202, physicalQty: 201, differenceQty: -1 },
  ];
  for (const exp of expected) {
    const item = result.items.find((i) => i.description === exp.description);
    assert.ok(item, `${exp.description} harus ditemukan`);
    assert.equal(item!.kelompok, exp.kelompok, `${exp.description} kelompok`);
    assert.equal(item!.systemQty, exp.systemQty, `${exp.description} systemQty`);
    assert.equal(item!.physicalQty, exp.physicalQty, `${exp.description} physicalQty`);
    assert.equal(item!.differenceQty, exp.differenceQty, `${exp.description} differenceQty`);
    assert.equal(item!.status, "OK", `${exp.description} status`);
  }
});

// ---------------------------------------------------------------------------
// REGRESI GENERIK JUMLAH BARIS — parser TIDAK boleh mengasumsikan jumlah
// baris (bukan hardcode "7"). Fixture di bawah SENGAJA sintetis dan
// dilabeli sebagai sintetis (bukan mengklaim data real) — hanya untuk
// menguji struktur generik parser terlepas dari jumlah barisnya.
// ---------------------------------------------------------------------------

function makeRow(no: number, y: number): PositionedTextItem[] {
  return [
    { str: String(no), x: COL_NO, y },
    { str: "KATEGORI", x: COL_KELOMPOK, y },
    { str: `PRODUK ${no}`, x: COL_DESKRIPSI, y },
    { str: "1", x: COL_SATUAN, y },
    { str: String(10 + no), x: COL_SISTEM, y },
    { str: String(9 + no), x: COL_FISIK, y },
    { str: "-1", x: COL_SELISIH, y },
    { str: "Ket", x: COL_KETERANGAN, y },
  ];
}

test("GENERIK: tabel dengan 1 baris -> parser mengembalikan tepat 1 baris benar", () => {
  const items = [...header(), ...makeRow(1, FIRST_ROW_Y)];
  const result = parseInventoryBaTable(items);
  assert.equal(result.items.length, 1);
  assert.equal(result.status, "OK");
  assert.equal(result.items[0].description, "PRODUK 1");
});

test("GENERIK: tabel dengan 3 baris -> parser mengembalikan tepat 3 baris benar", () => {
  const rows = [1, 2, 3].flatMap((no, idx) => makeRow(no, FIRST_ROW_Y - idx * ROW_Y_STEP));
  const result = parseInventoryBaTable([...header(), ...rows]);
  assert.equal(result.items.length, 3);
  assert.equal(result.status, "OK");
  assert.deepEqual(
    result.items.map((i) => i.description),
    ["PRODUK 1", "PRODUK 2", "PRODUK 3"],
  );
});

test("GENERIK: tabel dengan 23 baris -> semua baris terbaca, tidak ada yang hilang/tergabung", () => {
  const n = 23;
  const rows = Array.from({ length: n }, (_, idx) => makeRow(idx + 1, FIRST_ROW_Y - idx * ROW_Y_STEP)).flat();
  const result = parseInventoryBaTable([...header(), ...rows]);
  assert.equal(result.items.length, n);
  assert.equal(result.status, "OK");
  for (let i = 1; i <= n; i++) {
    assert.ok(
      result.items.some((item) => item.description === `PRODUK ${i}`),
      `PRODUK ${i} harus ada`,
    );
  }
});

test("GENERIK: tabel bersambung 2 halaman (row anchor terpisah page) -> baris tergabung benar lintas halaman", () => {
  // Halaman 1: baris 1-3 (header + anchor "No." di halaman 1, page default 1).
  const page1Rows = [1, 2, 3].flatMap((no, idx) => makeRow(no, FIRST_ROW_Y - idx * ROW_Y_STEP).map((it) => ({ ...it, page: 1 })));
  // Halaman 2: baris 4-6, koordinat Y MULAI LAGI dari atas halaman (mirip
  // Y baris 1-3 di halaman 1) — TANPA header ulang, seperti tabel BA nyata
  // yang bersambung ke halaman berikutnya tanpa mencetak ulang label kolom.
  const page2Rows = [4, 5, 6].flatMap((no, idx) => makeRow(no, FIRST_ROW_Y - idx * ROW_Y_STEP).map((it) => ({ ...it, page: 2 })));
  const items = [...header().map((it) => ({ ...it, page: 1 })), ...page1Rows, ...page2Rows];
  const result = parseInventoryBaTable(items);
  assert.equal(result.items.length, 6, "6 baris total lintas 2 halaman, tidak ada yang hilang/tertukar");
  assert.deepEqual(
    result.items.map((i) => i.description),
    ["PRODUK 1", "PRODUK 2", "PRODUK 3", "PRODUK 4", "PRODUK 5", "PRODUK 6"],
  );
  for (const item of result.items) assert.equal(item.status, "OK");
});

test("GENERIK: 0 baris valid (header ditemukan, tidak ada anchor baris) -> fail-safe, tidak crash, PERLU_DICEK", () => {
  const result = parseInventoryBaTable(header());
  assert.equal(result.items.length, 0);
  assert.equal(result.status, "PERLU_DICEK");
});

test("GENERIK: 1 baris rusak di tengah tabel valid -> hanya baris itu PERLU_DICEK, baris lain (sebelum & sesudah) tetap benar & tidak bergeser nomor", () => {
  const rows = [1, 2, 3, 4, 5].map((no, idx) => {
    const y = FIRST_ROW_Y - idx * ROW_Y_STEP;
    if (no === 3) {
      // Baris 3 rusak: Selisih tidak terbaca sama sekali (bukan angka salah).
      return [
        { str: String(no), x: COL_NO, y },
        { str: "KATEGORI", x: COL_KELOMPOK, y },
        { str: `PRODUK ${no}`, x: COL_DESKRIPSI, y },
        { str: "1", x: COL_SATUAN, y },
        { str: String(10 + no), x: COL_SISTEM, y },
        { str: String(9 + no), x: COL_FISIK, y },
      ];
    }
    return makeRow(no, y);
  });
  const items = [...header(), ...rows.flat()];
  const result = parseInventoryBaTable(items);
  assert.equal(result.items.length, 5, "semua 5 baris tetap tampil, baris rusak TIDAK dibuang");
  assert.equal(result.status, "PERLU_DICEK");
  const byDesc = new Map(result.items.map((i) => [i.description, i]));
  assert.equal(byDesc.get("PRODUK 1")!.status, "OK");
  assert.equal(byDesc.get("PRODUK 2")!.status, "OK");
  assert.equal(byDesc.get("PRODUK 3")!.status, "PERLU_DICEK");
  assert.equal(byDesc.get("PRODUK 3")!.differenceQty, null, "baris rusak tidak boleh meminjam angka baris lain");
  assert.equal(byDesc.get("PRODUK 4")!.status, "OK");
  assert.equal(byDesc.get("PRODUK 4")!.systemQty, 14, "baris sesudah baris rusak tidak boleh bergeser nomor/nilai");
  assert.equal(byDesc.get("PRODUK 5")!.status, "OK");
});
