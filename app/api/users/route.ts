import { NextResponse } from "next/server";
import { z } from "zod";
import { APP_MODULES, auth, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { toPublicUser, usernameFromEmail, USERNAME_REGEX, type UserDoc } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    const db = await getDb();
    const docs = await db.collection<UserDoc>("user").find({}).sort({ createdAt: 1 }).toArray();
    return NextResponse.json({ users: docs.map(toPublicUser) }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal memuat daftar pengguna." }, { status: 500 });
  }
}

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password minimal 8 karakter"),
  name: z.string().trim().min(1).optional(),
  allowedModules: z.array(z.enum(APP_MODULES)).default([]),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_REGEX, "Username harus 3-32 karakter (huruf, angka, titik, underscore, atau strip).")
    .optional(),
});

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = createSchema.parse(await request.json());
    const email = body.email.toLowerCase();

    const db = await getDb();
    const users = db.collection<UserDoc>("user");
    if (await users.findOne({ email })) {
      return NextResponse.json({ error: "Email sudah terdaftar." }, { status: 409 });
    }

    // Username harus unik terhadap username MAUPUN email user lain (celah:
    // username yang sama dengan email orang lain) — dicek eksplisit di sini,
    // bukan hanya lewat unique index, supaya pesan errornya jelas.
    let username = body.username ?? usernameFromEmail(email) ?? undefined;
    if (username) {
      const collision = await users.findOne({ $or: [{ username }, { email: username }] });
      if (collision) {
        if (body.username) {
          return NextResponse.json({ error: "Username sudah dipakai." }, { status: 409 });
        }
        // Auto-generate dari email: jangan blokir pembuatan user karena tabrakan,
        // cukup lewati (user tetap bisa login via email).
        username = undefined;
      }
    }

    await auth.api.signUpEmail({
      body: {
        email,
        password: body.password,
        name: body.name || email.split("@")[0],
      },
    });

    await users.updateOne(
      { email },
      {
        $set: {
          role: "user",
          allowedModules: body.allowedModules,
          disabled: false,
          emailVerified: true,
          updatedAt: new Date(),
          ...(username ? { username } : {}),
        },
      },
    );

    const created = await users.findOne({ email });
    return NextResponse.json({ user: created ? toPublicUser(created) : null }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Payload tidak valid." }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat pengguna." }, { status: 500 });
  }
}
