export type HistoricalReconciliationRow = {
  productId: number;
  variantId: number | null;
  productSku: string | null;
  productName: string;
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  closingQty: number | null;
};

export type HistoricalReconciliationStatus = "COCOK" | "SELISIH" | "PERLU_VERIFIKASI";

const key = (row: Pick<HistoricalReconciliationRow, "productId" | "variantId">) => `${row.productId}:${row.variantId ?? 0}`;
const fields = ["openingQty", "incomingQty", "returnQty", "salesQty", "outgoingQty", "closingQty"] as const;

export function compareHistoricalInventoryRows(
  systemRows: readonly HistoricalReconciliationRow[],
  approvedRows: readonly HistoricalReconciliationRow[],
  options: { sourceRevision?: string } = {},
) {
  const system = new Map<string, HistoricalReconciliationRow>();
  const approved = new Map<string, HistoricalReconciliationRow>();
  const duplicate = new Set<string>();
  for (const row of systemRows) { const id = key(row); if (system.has(id)) duplicate.add(id); system.set(id, row); }
  for (const row of approvedRows) { const id = key(row); if (approved.has(id)) duplicate.add(id); approved.set(id, row); }
  const rows = [...new Set([...system.keys(), ...approved.keys()])].map((id) => {
    const left = system.get(id); const right = approved.get(id);
    let status: HistoricalReconciliationStatus = "COCOK";
    if (duplicate.has(id) || !left || !right || fields.some((field) => left[field] === null || right[field] === null)) status = "PERLU_VERIFIKASI";
    else if ((left.productSku && right.productSku && left.productSku !== right.productSku) || fields.some((field) => left[field] !== right[field])) status = "SELISIH";
    return { key: id, system: left ?? null, approved: right ?? null, status };
  });
  return {
    sourceRevision: options.sourceRevision ?? null,
    rows,
    summary: {
      total: rows.length,
      cocok: rows.filter((row) => row.status === "COCOK").length,
      selisih: rows.filter((row) => row.status === "SELISIH").length,
      perluVerifikasi: rows.filter((row) => row.status === "PERLU_VERIFIKASI").length,
      duplicate: duplicate.size,
    },
  };
}
