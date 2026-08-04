import type { ObjectId } from "mongodb";
import { APP_MODULES } from "@/lib/auth";

export { USERNAME_REGEX, usernameFromEmail } from "@/lib/username";

export type UserDoc = {
  _id: ObjectId;
  email: string;
  name: string;
  role?: string;
  allowedModules?: string[];
  disabled?: boolean;
  createdAt?: Date;
  // Opsional: user lama (dibuat sebelum fitur username) tidak memilikinya —
  // mereka tetap login via email (lihat app/api/auth/login/route.ts).
  username?: string;
};

export function toPublicUser(doc: UserDoc) {
  const role = doc.role === "admin" || doc.role === "supervisor" ? "supervisor" : "user";
  return {
    id: doc._id.toHexString(),
    email: doc.email,
    name: doc.name,
    username: doc.username ?? null,
    role,
    allowedModules:
      role === "supervisor"
        ? [...APP_MODULES]
        : (doc.allowedModules ?? []).filter((m) => (APP_MODULES as readonly string[]).includes(m)),
    disabled: Boolean(doc.disabled),
    createdAt: doc.createdAt ?? null,
  };
}
