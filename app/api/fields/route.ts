import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";

export async function GET() {
  try {
    await requireUser();

    const data = await withMongo(async () => {
      const { fields } = await collections();
      return fields.find({}).sort({ name: 1 }).toArray();
    });

    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to load fields" }, { status: 500 });
  }
}
