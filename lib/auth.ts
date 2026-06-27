import "@/lib/mongodb-dns";
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { getDb, getMongoDb, mongoClient } from "@/lib/mongodb";

export type AppRole = "admin" | "viewer";

type AuthUserDocument = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
  role?: AppRole;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role: AppRole;
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
      role: {
        type: ["admin", "viewer"],
        required: false,
        defaultValue: "viewer",
        input: false,
      },
    },
  },
  plugins: [nextCookies()],
});

function normalizeRole(role: unknown): AppRole {
  return role === "admin" ? "admin" : "viewer";
}

function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role?: unknown;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role: normalizeRole(user.role),
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

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  return session?.user ? toSessionUser(session.user) : null;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return user;
}
