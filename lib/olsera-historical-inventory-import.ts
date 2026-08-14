import type { OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

export type HistoricalInventoryRow = {
  productId: number;
  variantId: number | null;
  productName: string;
  productSku: string | null;
  groupName: string;
  openingQty: number;
  incomingQty: number;
  returnQty: number;
  salesQty: number;
  outgoingQty: number;
  closingQty: number;
  diagnostics?: string[];
};

export type HistoricalImportPlan = {
  rows: HistoricalInventoryRow[];
  rejected: string[];
  duplicates: string[];
  counts: { sold: number; unsold: number; overall: number };
  changes: { added: number; updated: number; unchanged: number };
};

export function buildHistoricalImportPlan(input: {
  sold: HistoricalInventoryRow[];
  overall: HistoricalInventoryRow[];
  existing: OlseraInventoryMonthlySnapshotDocument[];
  expected?: { sold: number; unsold: number; overall: number };
}): HistoricalImportPlan {
  const expected = input.expected ?? { sold: 31, unsold: 17, overall: 48 };
  const rejected: string[] = [];
  const duplicates: string[] = [];
  const byKey = new Map<string, HistoricalInventoryRow>();
  const add = (row: HistoricalInventoryRow) => {
    const key = `${row.productId}:${row.variantId ?? 0}`;
    if (byKey.has(key)) duplicates.push(key);
    else byKey.set(key, row);
  };
  for (const row of input.overall) add(row);
  const soldKeys = new Set(input.sold.map((row) => `${row.productId}:${row.variantId ?? 0}`));
  for (const row of byKey.values()) {
    const values = [row.openingQty, row.incomingQty, row.returnQty, row.salesQty, row.outgoingQty, row.closingQty];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) rejected.push(`${row.productId}:${row.variantId ?? 0}:angka`);
    // Workbook values are authoritative. Arithmetic gaps are retained as
    // incomplete diagnostics and intentionally do not abort the batch.
  }
  const rows = [...byKey.values()];
  const counts = { sold: rows.filter((row) => soldKeys.has(`${row.productId}:${row.variantId ?? 0}`)).length, unsold: rows.filter((row) => !soldKeys.has(`${row.productId}:${row.variantId ?? 0}`)).length, overall: rows.length };
  if (counts.sold !== expected.sold || counts.unsold !== expected.unsold || counts.overall !== expected.overall) rejected.push(`counts:${counts.sold}/${counts.unsold}/${counts.overall}`);
  const existingByKey = new Map(input.existing.map((row) => [`${row.productId}:${row.variantId ?? 0}`, row]));
  let added = 0, updated = 0, unchanged = 0;
  for (const row of rows) {
    const old = existingByKey.get(`${row.productId}:${row.variantId ?? 0}`);
    if (!old) added++;
    else if ([old.openingQty, old.incomingQty, old.returnQty, old.salesQty, old.outgoingQty, old.closingQty].some((value, i) => value !== [row.openingQty, row.incomingQty, row.returnQty, row.salesQty, row.outgoingQty, row.closingQty][i])) updated++;
    else unchanged++;
  }
  return { rows, rejected, duplicates, counts, changes: { added, updated, unchanged } };
}

export function historicalDiagnostics(row: HistoricalInventoryRow): string[] {
  const expected = row.openingQty + row.incomingQty + row.returnQty - row.salesQty - row.outgoingQty;
  return row.diagnostics?.length ? row.diagnostics : row.closingQty === expected ? [] : [`Stok awal ${row.openingQty}, terjual ${row.salesQty}, stok akhir ${row.closingQty}. Selisih ${row.closingQty - expected}; bukti arus tambahan belum ditemukan.`];
}
