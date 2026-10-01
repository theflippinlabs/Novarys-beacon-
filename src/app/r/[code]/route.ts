import { NextResponse } from "next/server";
import { asSystem } from "@/db";
import { ipHashOf } from "@/lib/http";
import { randomToken } from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/rate-limit";
import { recordReferralVisit, resolveReferral, safeReferralDestination } from "@/services/tracking";

export const dynamic = "force-dynamic";

/**
 * Referral link: novarys.app/r/CODE → records a VISIT touch and redirects to
 * the product destination with `ref=CODE` so the product-site tracker can
 * attribute later conversions. Destinations are restricted to the product's
 * own https domain (no open redirect).
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const ipHash = ipHashOf(req);
  const found = await asSystem((tx) => resolveReferral(tx, code));
  const dest = found ? safeReferralDestination(found.code.destinationUrl, found.product?.domain) : null;
  if (!found || !dest) return new NextResponse("Link not found", { status: 404 });
  const url = new URL(dest);
  url.searchParams.set("ref", found.code.code);
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)bcn_vid=([A-Za-z0-9_-]{8,64})/)?.[1];
  const visitorId = cookie ?? randomToken(12);
  const rl = await rateLimit(`ref:${found.code.id}:${ipHash}`, 20, 3600);
  if (rl.allowed) await asSystem((tx) => recordReferralVisit(tx, found.code, visitorId, ipHash, req.headers.get("referer")));
  const res = NextResponse.redirect(url.toString(), 302);
  res.cookies.set("bcn_vid", visitorId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 365 * 86400, path: "/" });
  res.headers.set("referrer-policy", "no-referrer-when-downgrade");
  return res;
}
