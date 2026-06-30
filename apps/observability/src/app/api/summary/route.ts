import { NextResponse } from "next/server";
import { getObservabilitySummary } from "@/lib/observability-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const summary = await getObservabilitySummary(url.searchParams.get("refresh") === "1");
  return NextResponse.json(summary);
}

export async function POST() {
  const summary = await getObservabilitySummary(true);
  return NextResponse.json(summary);
}
