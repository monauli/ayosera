import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auth, requireSupervisor } from "@/lib/auth";
import { getDb } from "@/lib/mongodb";
import { generatePassword } from "@/lib/password-generator";
import type { UserDoc } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseObjectId(id: string) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supervisor = await requireSupervisor();
    const { id } = await params;
    const oid = parseObjectId(id);
    if (!oid) return NextResponse.json({ error: "ID pengguna tidak valid." }, { status: 400 });

    const db = await getDb();
    const users = db.collection<UserDoc>("user");
    const target = await users.findOne({ _id: oid });
    if (!target) return NextResponse.json({ error: "Pengguna tidak ditemukan." }, { status: 404 });

    const newPassword = generatePassword();
    // Hash lewat pola yang sama dengan PATCH /api/users/[id] (satu-satunya
    // jalur set-password) — password mentah TIDAK PERNAH disimpan.
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(newPassword);
    await ctx.internalAdapter.updatePassword(id, hash);
    await users.updateOne({ _id: oid }, { $set: { updatedAt: new Date() } });

    if (id !== supervisor.id) {
      await db.collection("session").deleteMany({ $or: [{ userId: oid }, { userId: oid.toHexString() }] });
    }

    return NextResponse.json({ password: newPassword });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal mereset password." }, { status: 500 });
  }
}
