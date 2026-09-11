import { crossSiteDenied, ok } from "@/lib/api";
import { destroySession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = crossSiteDenied(req);
  if (denied) return denied;

  await destroySession();
  return ok({ ok: true });
}
