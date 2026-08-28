import "@/lib/mongodb-dns";
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { getDb, getMongoDb, mongoClient } from "@/lib/mongodb";
import { describeAuthBaseURLIssue } from "@/lib/auth-base-url";
import { resolveAuthSecret } from "@/lib/auth-secret";
import { APP_MODULES, normalizeModules, resolveAppRole, SUPERVISOR_EMAILS, SUPERVISOR_SEED_EMAIL, type AppModule, type AppRole } from "@/lib/app-modules";

export { APP_MODULES, normalizeModules, SUPERVISOR_EMAILS, SUPERVISOR_SEED_EMAIL };
export type { AppModule, AppRole };

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

// Better Auth menurunkan trustedOrigins (proteksi CSRF/origin) DAN flag cookie
// `Secure` langsung dari string baseURL ini — kalau nilainya tanpa skema (mis.
// "ayosera.vercel.app" tanpa "https://") atau typo, origin request yang sah dari
// domain production sendiri akan ditolak (403 "Invalid origin") secara diam-diam,
// persis penyebab bug logout 403 yang pernah terjadi. Deteksi ini SEKALI di sini
// (bukan crash startup — env yang salah tidak boleh menjatuhkan seluruh app)
// supaya kesalahan konfigurasi env langsung terlihat di log, bukan baru ketahuan
// lewat gejala 403 yang membingungkan di endpoint lain.
const rawAuthBaseURL = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;

const authBaseURLIssue = describeAuthBaseURLIssue(rawAuthBaseURL);
if (authBaseURLIssue) {
  console.error(`[auth] ${authBaseURLIssue}`);
}

export const auth = betterAuth({
  database: mongodbAdapter(getMongoDb(), {
    client: mongoClient,
    transaction: false,
  }),
  secret: resolveAuthSecret(process.env),
  baseURL: rawAuthBaseURL,
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

function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role?: unknown;
  allowedModules?: unknown;
}): SessionUser {
  const role = resolveAppRole(user.email, user.role);
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
        role: "user",
        allowedModules: [...APP_MODULES],
        emailVerified: true,
        updatedAt: new Date(),
      },
    },
  );
}

// Idempotent, mengikuti pola ensureDefaultAdmin. Dua tugas terpisah:
//
// 1. SEEDING akun bootstrap dari SUPERVISOR_PASSWORD — hanya SUPERVISOR_SEED_EMAIL.
//    Tanpa env itu, seeding dilewati.
// 2. MENYAMAKAN field `role` untuk seluruh SUPERVISOR_EMAILS yang akunnya MEMANG
//    sudah ada. Tanpa upsert: akun supervisor selain bootstrap dibuat lewat
//    Manajemen Pengguna dengan password sendiri, jadi tidak boleh dibuat di sini
//    tanpa kredensial. Ini juga membuat state DB memulihkan diri — role yang
//    terlanjur berubah kembali disamakan pada login berikutnya.
export async function ensureSupervisorAccount() {
  const db = await getDb();
  const users = db.collection<AuthUserDocument>("user");
  const password = process.env.SUPERVISOR_PASSWORD || "";

  if (password && !(await users.findOne({ email: SUPERVISOR_SEED_EMAIL }))) {
    await auth.api.signUpEmail({
      body: {
        email: SUPERVISOR_SEED_EMAIL,
        password,
        name: "Supervisor",
      },
    });
  }

  await users.updateMany(
    { email: { $in: [...SUPERVISOR_EMAILS] } },
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
  if (user.role !== "supervisor") throw jsonError("Supervisor access required", 403);
  return user;
}

export async function requireModule(module: AppModule) {
  const user = await requireUser();
  if (user.role !== "supervisor" && !user.allowedModules.includes(module)) {
    throw jsonError("Anda tidak memiliki izin untuk modul ini", 403);
  }
  return user;
}

/** Lolos bila user punya SALAH SATU modul (mis. aksi sync AYO: cukup "dasbor" atau "transaksi"). */
export async function requireAnyModule(...modules: AppModule[]) {
  const user = await requireUser();
  if (user.role !== "supervisor" && !modules.some((module) => user.allowedModules.includes(module))) {
    throw jsonError("Anda tidak memiliki izin untuk modul ini", 403);
  }
  return user;
}
