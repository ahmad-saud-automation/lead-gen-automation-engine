import { ImportPage } from "@/components/import-page";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Import · Lead Gen Engine" };

// ?tab=<tab> previews that upload (import:<name>) or sheet tab.
export default async function ImportRoute({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return (
    <>
      <TopBar title="Import" sub="Upload a CSV or check a sheet tab" />
      <div className="page">
        <ImportPage tab={tab} />
      </div>
    </>
  );
}
