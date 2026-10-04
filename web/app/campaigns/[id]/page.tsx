import { CampaignEditor } from "@/components/campaign-editor";

export const metadata = { title: "Campaign · Lead Gen Engine" };

// The editor draws its own top bar: the Save button lives there, always in reach.
// ?tab=schedule opens that section (a schedule save comes back to it).
export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return <CampaignEditor id={decodeURIComponent(id)} initialTab={tab} />;
}
