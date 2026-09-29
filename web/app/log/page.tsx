import { LogViewer } from "@/components/log-view";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Log · Lead Gen Engine" };

export default function LogPage() {
  return (
    <>
      <TopBar title="Log" sub="Every event, every run" />
      <div className="page">
        <LogViewer />
      </div>
    </>
  );
}
