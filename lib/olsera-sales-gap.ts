export type OlseraGapStatus = "SYNCED" | "GAP_FOUND" | "DUPLICATE_FOUND" | "SOURCE_INCOMPLETE" | "TOKEN_ERROR" | "MANUAL_REVIEW_REQUIRED" | "REPAIRED";
export type OlseraAuditOrder = { identity: string; total: number; status: string | null };
export type OlseraAuditItem = { identity: string; orderIdentity: string; productId: number | null; variantId: number | null; sku: string | null; qty: number; amount: number; raw?: Record<string, unknown> };
export type OlseraGapCounts = { sourceOrderCount: number; localOrderCount: number; matchedOrderCount: number; missingOrderCount: number; localOnlyOrderCount: number; conflictOrderCount: number; duplicateOrderIdentityCount: number; sourceItemCount: number; localItemCount: number; matchedItemCount: number; missingItemCount: number; localOnlyItemCount: number; conflictItemCount: number; duplicateItemIdentityCount: number; missingProductIdentityCount: number; sourceIncompleteCount: number; missingOrderIdentities: string[]; missingItemIdentities: string[] };

function compare<T>(sourceRows: readonly T[], localRows: readonly T[], identity: (row: T) => string | null, comparable: (row: T) => unknown) {
  const source = new Map<string, T>(); const local = new Map<string, T>(); let duplicate = 0; let incomplete = 0;
  for (const row of sourceRows) { const id = identity(row); if (!id) { incomplete += 1; continue; } if (source.has(id)) { duplicate += 1; continue; } source.set(id, row); }
  for (const row of localRows) { const id = identity(row); if (!id || local.has(id)) { duplicate += 1; continue; } local.set(id, row); }
  const missing = [...source.keys()].filter((id) => !local.has(id)); const localOnly = [...local.keys()].filter((id) => !source.has(id));
  let conflicts = 0; for (const [id, row] of source) { const existing = local.get(id); if (existing && JSON.stringify(comparable(row)) !== JSON.stringify(comparable(existing))) conflicts += 1; }
  return { sourceCount: source.size, localCount: local.size, matchedCount: source.size - missing.length - conflicts, missing, localOnly, conflicts, duplicate, incomplete };
}

export function compareOlseraSalesGap(sourceOrders: readonly OlseraAuditOrder[], localOrders: readonly OlseraAuditOrder[], sourceItems: readonly OlseraAuditItem[], localItems: readonly OlseraAuditItem[]): OlseraGapCounts & { status: Exclude<OlseraGapStatus, "REPAIRED" | "TOKEN_ERROR"> } {
  const orders = compare(sourceOrders, localOrders, (row) => row.identity || null, (row) => [row.identity, row.total, row.status]);
  const items = compare(sourceItems, localItems, (row) => row.identity || null, (row) => [row.identity, row.orderIdentity, row.productId, row.variantId, row.sku, row.qty, row.amount]);
  const missingProductIdentityCount = sourceItems.filter((row) => row.productId == null || row.variantId == null || !row.sku).length;
  const sourceIncompleteCount = orders.incomplete + items.incomplete;
  const duplicateOrderIdentityCount = orders.duplicate; const duplicateItemIdentityCount = items.duplicate;
  const status = sourceIncompleteCount ? "SOURCE_INCOMPLETE" : duplicateOrderIdentityCount || duplicateItemIdentityCount ? "DUPLICATE_FOUND" : orders.conflicts || items.conflicts || missingProductIdentityCount ? "MANUAL_REVIEW_REQUIRED" : orders.missing.length || items.missing.length ? "GAP_FOUND" : "SYNCED";
  return { status, sourceOrderCount: orders.sourceCount, localOrderCount: orders.localCount, matchedOrderCount: orders.matchedCount, missingOrderCount: orders.missing.length, localOnlyOrderCount: orders.localOnly.length, conflictOrderCount: orders.conflicts, duplicateOrderIdentityCount, sourceItemCount: items.sourceCount, localItemCount: items.localCount, matchedItemCount: items.matchedCount, missingItemCount: items.missing.length, localOnlyItemCount: items.localOnly.length, conflictItemCount: items.conflicts, duplicateItemIdentityCount, missingProductIdentityCount, sourceIncompleteCount, missingOrderIdentities: orders.missing, missingItemIdentities: items.missing };
}
