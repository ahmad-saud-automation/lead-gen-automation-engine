import { HistoryList } from "@/components/history-list";
import { TopBar } from "@/components/shell";

export const metadata = { title: "History · Lead Gen Engine" };

export default function HistoryPage() {
  return (
    <>
      <TopBar title="History" sub="Every run and push" />
      <div className="page">
        <HistoryList />
      </div>
    </>
  );
}
