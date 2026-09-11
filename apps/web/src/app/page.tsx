import { StoredProofWorkspace } from "../features/stored-proof-workspace";
import { readConfiguredProofSession } from "../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  const loaded = await readConfiguredProofSession();
  return (
    <main>
      <StoredProofWorkspace session={loaded.session} node={loaded.node} />
    </main>
  );
}
