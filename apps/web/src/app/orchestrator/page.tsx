import type { Metadata } from "next";
import { OrchestratorDashboard } from "./orchestrator-dashboard";

export const metadata: Metadata = {
  title: "Local Orchestrator · Proof Platform",
  description: "Observe the durable roadmap and submit bounded development intent.",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function OrchestratorPage() {
  return (
    <main className="orchestrator-main">
      <OrchestratorDashboard />
    </main>
  );
}
