import { redirect } from "next/navigation";
import { stableIdentifierSchema } from "@proof/protocol";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** The landing page's "fetch stored proof" form: `/sessions?id=…` opens that session. */
export default async function SessionLookupPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const { id } = await searchParams;
  const parsed = stableIdentifierSchema.safeParse(typeof id === "string" ? id.trim() : undefined);
  redirect(parsed.success ? `/sessions/${encodeURIComponent(parsed.data)}` : "/");
}
