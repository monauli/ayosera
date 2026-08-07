// Penyimpanan draft Coretax — logic murni terpisah dari route Next.js supaya
// bisa diuji tanpa mem-mock Request/Response (lihat lib/coretax/draft-store.test.ts).
// API route (app/api/coretax/drafts/**) hanya pembungkus tipis di atas fungsi
// ini + requireModule("coretax").
import { randomUUID } from "node:crypto";
import type { CoretaxModuleId, CoretaxRow } from "./types.ts";

export type CoretaxDraftRecord = {
  _id: string;
  moduleId: CoretaxModuleId;
  name: string;
  tin: string;
  taxPeriodMonth: string | null;
  taxPeriodYear: string | null;
  rows: CoretaxRow[];
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Subset method MongoDB Collection yang benar-benar dipakai — memudahkan fake collection di test. */
export type CoretaxDraftCollection = {
  insertOne(doc: CoretaxDraftRecord): Promise<unknown>;
  findOne(filter: { _id: string }): Promise<CoretaxDraftRecord | null>;
  find(filter: { moduleId: CoretaxModuleId }): { project(p: unknown): { sort(s: unknown): { toArray(): Promise<CoretaxDraftRecord[]> } } };
  findOneAndUpdate(filter: { _id: string }, update: { $set: Record<string, unknown> }, options: { returnDocument: "after" }): Promise<CoretaxDraftRecord | null>;
  deleteOne(filter: { _id: string }): Promise<{ deletedCount: number }>;
};

export async function createCoretaxDraft(collection: CoretaxDraftCollection, input: { moduleId: CoretaxModuleId; name: string; createdBy: string }, now = new Date()): Promise<CoretaxDraftRecord> {
  const draft: CoretaxDraftRecord = {
    _id: randomUUID(),
    moduleId: input.moduleId,
    name: input.name.trim(),
    tin: "",
    taxPeriodMonth: null,
    taxPeriodYear: null,
    rows: [],
    rowCount: 0,
    validRowCount: 0,
    invalidRowCount: 0,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await collection.insertOne(draft);
  return draft;
}

export async function listCoretaxDrafts(collection: CoretaxDraftCollection, moduleId: CoretaxModuleId): Promise<CoretaxDraftRecord[]> {
  return collection.find({ moduleId }).project({ rows: 0 }).sort({ updatedAt: -1 }).toArray();
}

export async function getCoretaxDraft(collection: CoretaxDraftCollection, id: string): Promise<CoretaxDraftRecord | null> {
  return collection.findOne({ _id: id });
}

export type CoretaxDraftUpdateInput = {
  name?: string;
  tin?: string;
  taxPeriodMonth?: string | null;
  taxPeriodYear?: string | null;
  rows?: CoretaxRow[];
};

export async function updateCoretaxDraft(collection: CoretaxDraftCollection, id: string, input: CoretaxDraftUpdateInput, now = new Date()): Promise<CoretaxDraftRecord | null> {
  const set: Record<string, unknown> = { updatedAt: now };
  if (input.name !== undefined) set.name = input.name;
  if (input.tin !== undefined) set.tin = input.tin;
  if (input.taxPeriodMonth !== undefined) set.taxPeriodMonth = input.taxPeriodMonth;
  if (input.taxPeriodYear !== undefined) set.taxPeriodYear = input.taxPeriodYear;
  if (input.rows !== undefined) {
    set.rows = input.rows;
    set.rowCount = input.rows.length;
    set.validRowCount = input.rows.filter((r) => r.status === "benar").length;
    set.invalidRowCount = input.rows.filter((r) => r.status === "perlu-diperbaiki").length;
  }
  return collection.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: "after" });
}

export async function deleteCoretaxDraft(collection: CoretaxDraftCollection, id: string): Promise<boolean> {
  const result = await collection.deleteOne({ _id: id });
  return result.deletedCount > 0;
}
