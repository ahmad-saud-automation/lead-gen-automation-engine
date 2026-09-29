import { FieldmapEditor } from "@/components/fieldmap-editor";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Field map · Lead Gen Engine" };

export default function FieldMapPage() {
  return (
    <>
      <TopBar title="Field map" sub="Engine field → your column" />
      <div className="page">
        <FieldmapEditor />
      </div>
    </>
  );
}
