import { FieldmapEditor } from "@/components/fieldmap-editor";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Field map · Lead Gen Engine" };

// ?tab=<tab> opens that tab's map (a sheet tab, or an upload: import:<name>); without it, the
// first campaign's tab.
export default async function FieldMapPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return (
    <>
      <TopBar title="Field map" sub="Engine field → your column" />
      <div className="page">
        <FieldmapEditor tab={tab} />
      </div>
    </>
  );
}
