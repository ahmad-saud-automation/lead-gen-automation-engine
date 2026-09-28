import { PlanPreview } from "@/components/plan-preview";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Plan preview · Lead Gen Engine" };

export default function PlanPage() {
  return (
    <>
      <TopBar title="Plan preview" sub="Costs nothing" />
      <div className="page">
        <PlanPreview />
      </div>
    </>
  );
}
