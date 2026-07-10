import type { ObjectId } from "mongodb";
import { APP_MODULES, SUPERVISOR_EMAIL } from "@/lib/auth";

export type UserDoc = {
  _id: ObjectId;
  email: string;
  name: string;
  role?: string;
  allowedModules?: string[];
  disabled?: boolean;
  createdAt?: Date;
};

export function toPublicUser(doc: UserDoc) {
  const role = doc.email.toLowerCase() === SUPERVISOR_EMAIL && (doc.role === "admin" || doc.role === "supervisor")
    ? "supervisor"
    : "user";
  return {
    id: doc._id.toHexString(),
    email: doc.email,
    name: doc.name,
    role,
    allowedModules:
      role === "supervisor"
        ? [...APP_MODULES]
        : (doc.allowedModules ?? []).filter((m) => (APP_MODULES as readonly string[]).includes(m)),
    disabled: Boolean(doc.disabled),
    createdAt: doc.createdAt ?? null,
  };
}
