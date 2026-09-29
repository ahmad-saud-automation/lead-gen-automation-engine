import { Dashboard } from "@/components/dashboard";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Dashboard · Lead Gen Engine" };

export default function DashboardPage() {
  return (
    <>
      <TopBar title="Dashboard" sub="Lead Gen Engine" />
      <div className="page">
        <Dashboard />
      </div>
    </>
  );
}
