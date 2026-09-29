import { CampaignEditor } from "@/components/campaign-editor";

export const metadata = { title: "Campaign · Lead Gen Engine" };

// The editor draws its own top bar: the Save button lives there, always in reach.
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignEditor id={decodeURIComponent(id)} />;
}
