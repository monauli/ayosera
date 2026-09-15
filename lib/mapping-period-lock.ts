import "server-only";
import { collections, type MappingPeriodLockDocument } from "./mongodb.ts";

export class MappingPeriodLockError extends Error {}
const valid = /^\d{4}-(0[1-9]|1[0-2])$/;
const id = (storeId: number, period: string) => `${storeId}:${period}`;

export async function getMappingPeriodLock(storeId: number, period: string) {
  if (!valid.test(period)) throw new MappingPeriodLockError("Format periode tidak valid.");
  return (await collections()).mappingPeriodLocks.findOne({ _id: id(storeId, period) });
}

export async function hasMappingPeriodLock(storeId: number, period?: string) {
  const { mappingPeriodLocks } = await collections();
  return Boolean(await mappingPeriodLocks.findOne(period ? { _id: id(storeId, period) , status: "locked" } : { storeId, status: "locked" }));
}

export async function setMappingPeriodLock(input: { storeId: number; period: string; actor: string; action: "lock" | "unlock"; reason?: string }) {
  if (!valid.test(input.period)) throw new MappingPeriodLockError("Format periode tidak valid.");
  if (input.action === "unlock" && !input.reason?.trim()) throw new MappingPeriodLockError("Reason unlock wajib diisi.");
  const c = (await collections()).mappingPeriodLocks;
  const current = await c.findOne({ _id: id(input.storeId, input.period) });
  if (input.action === "lock" && current?.status === "locked") throw new MappingPeriodLockError("Periode sudah terkunci.");
  if (input.action === "unlock" && current?.status !== "locked") throw new MappingPeriodLockError("Periode tidak sedang terkunci.");
  const now = new Date();
  const document: MappingPeriodLockDocument = { _id: id(input.storeId, input.period), storeId: input.storeId, period: input.period, status: input.action === "lock" ? "locked" : "unlocked", lockedAt: input.action === "lock" ? now : current!.lockedAt, lockedBy: input.action === "lock" ? input.actor : current!.lockedBy, unlockedAt: input.action === "unlock" ? now : null, unlockedBy: input.action === "unlock" ? input.actor : null, updatedAt: now, history: [...(current?.history ?? []), { action: input.action, actor: input.actor, reason: input.reason?.trim() || null, at: now }] };
  await c.replaceOne({ _id: document._id }, document, { upsert: true });
  return document;
}
