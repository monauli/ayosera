import "@/lib/mongodb-dns";
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { getDb, getMongoDb, mongoClient } from "@/lib/mongodb";

// Role efektif di aplikasi. Data lama di MongoDB bisa berisi "admin"/"viewer";
// keduanya dinormalisasi saat sesi dibaca (admin → supervisor) tanpa mengubah dokumen.
export type AppRole = "supervisor" | "user";

export const APP_MODULES = ["dasbor", "transaksi", "olsera", "webhook"] as const;
export type AppModule = (typeof APP_MODULES)[number];

type AuthUserDocument = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
  role?: string;
  allowedModules?: string[];
  disabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role: AppRole;
  allowedModules: AppModule[];
};

export const auth = betterAuth({
  database: mongodbAdapter(getMongoDb(), {
    client: mongoClient,
    transaction: false,
  }),
  secret: process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET || "local-dev-secret-change-before-production-please-32chars",
  baseURL: process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL,
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
  },
  user: {
    additionalFields: {
      // "admin"/"viewer" dipertahankan demi dokumen lama; nilai baru memakai supervisor/user.
      role: {
        type: ["admin", "viewer", "supervisor", "user"],
        required: false,
        defaultValue: "user",
        input: false,
      },
      allowedModules: {
        type: "string[]",
        required: false,
        input: false,
      },
      disabled: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },
  plugins: [nextCookies()],
});

function normalizeRole(role: unknown): AppRole {
  // Akun admin lama otomatis dianggap supervisor tanpa migrasi data.
  return role === "admin" || role === "supervisor" ? "supervisor" : "user";
}

function normalizeModules(role: AppRole, modules: unknown): AppModule[] {
  if (role === "supervisor") return [...APP_MODULES];
  if (!Array.isArray(modules)) return [];
  return APP_MODULES.filter((module) => modules.includes(module));
}

function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role?: unknown;
  allowedModules?: unknown;
}): SessionUser {
  const role = normalizeRole(user.role);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role,
    allowedModules: normalizeModules(role, user.allowedModules),
  };
}

export async function ensureDefaultAdmin() {
  const email = (process.env.ADMIN_EMAIL || "admin@ayo.local").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";
  const db = await getDb();
  const users = db.collection<AuthUserDocument>("user");
  const existing = await users.findOne({ email });

  if (!existing) {
    await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: "Administrator",
      },
    });
  }

  await users.updateOne(
    { email },
    {
      $set: {
        role: "admin",
        emailVerified: true,
        updatedAt: new Date(),
      },
    },
  );
}

// Seed akun supervisor dari env — idempotent, mengikuti pola ensureDefaultAdmin.
// Tanpa env SUPERVISOR_EMAIL/SUPERVISOR_PASSWORD, seeding dilewati.
export async function ensureSupervisorAccount() {
  const email = (process.env.SUPERVISOR_EMAIL || "").trim().toLowerCase();
  const password = process.env.SUPERVISOR_PASSWORD || "";
  if (!email || !password) return;

  const db = await getDb();
  const users = db.collection<AuthUserDocument>("user");
  const existing = await users.findOne({ email });

  if (!existing) {
    await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: "Supervisor",
      },
    });
  }

  await users.updateOne(
    { email },
    {
      $set: {
        role: "supervisor",
        emailVerified: true,
        disabled: false,
        updatedAt: new Date(),
      },
    },
  );
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) return null;
  // Akun yang dinonaktifkan diperlakukan seperti tidak login.
  if ((session.user as { disabled?: boolean }).disabled) return null;
  return toSessionUser(session.user);
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw jsonError("Unauthorized", 401);
  }
  return user;
}

export async function requireSupervisor() {
  const user = await requireUser();
  if (user.role !== "supervisor") {
    throw jsonError("Supervisor access required", 403);
  }
  return user;
}

export async function requireModule(module: AppModule) {
  const user = await requireUser();
  if (user.role !== "supervisor" && !user.allowedModules.includes(module)) {
    throw jsonError("Anda tidak memiliki izin untuk modul ini", 403);
  }
  return user;
}
