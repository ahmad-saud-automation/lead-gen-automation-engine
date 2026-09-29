import { CampaignList } from "@/components/campaign-list";
import { TopBar } from "@/components/shell";

export const metadata = { title: "Campaigns · Lead Gen Engine" };

export default function CampaignsPage() {
  return (
    <>
      <TopBar title="Campaigns" sub="config/campaigns.json" />
      <div className="page">
        <CampaignList />
      </div>
    </>
  );
}
