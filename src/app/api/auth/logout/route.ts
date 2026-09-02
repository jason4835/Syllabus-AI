import { ok } from "@/lib/api";
import { destroySession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  await destroySession();
  return ok({ ok: true });
}
