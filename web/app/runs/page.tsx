import { RunMonitor } from "@/components/run-monitor";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Runs · Lead Gen Engine" };

// ?run=<id> opens that run or push; without it, the latest run.
export default async function RunsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run } = await searchParams;
  return (
    <>
      <TopBar title="Runs" sub={run ? `Run ${run}` : "Latest run"} />
      <div className="page">
        <RunMonitor runId={run} />
      </div>
    </>
  );
}
