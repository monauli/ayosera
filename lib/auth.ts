import "@/lib/mongodb-dns";
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { getDb, getMongoDb, mongoClient } from "@/lib/mongodb";
import { describeAuthBaseURLIssue } from "@/lib/auth-base-url";

// Hanya akun ini yang boleh memiliki hak supervisor.
export const SUPERVISOR_EMAIL = "timunemas@ayo.local";

export type AppRole = "supervisor" | "user";

// "rekonsiliasi" (Modul Rekonsiliasi, Phase 5A) ditambahkan paling akhir agar
// TIDAK mengubah urutan/nilai module yang sudah dipakai user existing —
// hanya supervisor yang otomatis mendapatkannya (lihat normalizeModules di
// bawah); user biasa TIDAK mendapat akses ini kecuali diberi eksplisit
// (default paling ketat, sesuai docs/reconciliation-design.md).
export const APP_MODULES = ["dasbor", "transaksi", "olsera", "webhook", "rekonsiliasi"] as const;
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
  secret: process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET || "local-dev-secret-change-before-production-please-32chars",
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

function normalizeRole(email: string, role: unknown): AppRole {
  return email.toLowerCase() === SUPERVISOR_EMAIL && (role === "admin" || role === "supervisor")
    ? "supervisor"
    : "user";
}

/**
 * "olsera" adalah parent permission untuk seluruh fitur terkait Olsera.
 * Kategori Penjualan/Inventori/Laporan Keuangan sudah gated lewat modul
 * "olsera" itu sendiri di setiap route (lihat requireModule("olsera") di
 * seluruh app/api/olsera/**) dan di navItems sidebar (app/page.tsx) — ketiganya
 * anak dari satu grup "Olsera", tidak punya modul terpisah.
 *
 * Rekonsiliasi (Omset AYO vs Olsera & Inventori) historisnya memakai modul
 * terpisah "rekonsiliasi" (Phase 5A, lihat APP_MODULES di atas), tapi secara
 * bisnis juga bagian dari Olsera. Supaya TIDAK perlu checkbox baru di
 * Manajemen Pengguna, user yang diberi "olsera" otomatis mendapat
 * "rekonsiliasi" juga — dinormalisasi SATU KALI di sini sehingga berlaku untuk
 * getCurrentUser/requireModule/requireAnyModule/sidebar/semua route sekaligus
 * (satu-satunya sumber kebenaran, bukan dicek ulang per tempat).
 */
function normalizeModules(role: AppRole, modules: unknown): AppModule[] {
  if (role === "supervisor") return [...APP_MODULES];
  if (!Array.isArray(modules)) return [];
  const granted = new Set(APP_MODULES.filter((module) => modules.includes(module)));
  if (granted.has("olsera")) granted.add("rekonsiliasi");
  return APP_MODULES.filter((module) => granted.has(module));
}

function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role?: unknown;
  allowedModules?: unknown;
}): SessionUser {
  const role = normalizeRole(user.email, user.role);
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

// Seed akun supervisor dari env — idempotent, mengikuti pola ensureDefaultAdmin.
// Tanpa env SUPERVISOR_EMAIL/SUPERVISOR_PASSWORD, seeding dilewati.
export async function ensureSupervisorAccount() {
  const email = SUPERVISOR_EMAIL;
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

/** Lolos bila user punya SALAH SATU modul (mis. aksi sync AYO: cukup "dasbor" atau "transaksi"). */
export async function requireAnyModule(...modules: AppModule[]) {
  const user = await requireUser();
  if (user.role !== "supervisor" && !modules.some((module) => user.allowedModules.includes(module))) {
    throw jsonError("Anda tidak memiliki izin untuk modul ini", 403);
  }
  return user;
}
