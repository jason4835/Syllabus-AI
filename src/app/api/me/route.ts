import { ok } from "@/lib/api";
import { ensureDemoSeed } from "@/lib/demo";
import { readSession } from "@/lib/session";
import { store } from "@/lib/store";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await readSession();
  if (!userId) return ok<User | null>(null);
  await ensureDemoSeed(userId);
  return ok<User | null>(await store.getUser(userId));
}
