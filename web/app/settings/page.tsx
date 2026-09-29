import { SettingsForm } from "@/components/settings-form";

export const metadata = { title: "Settings · Lead Gen Engine" };

// The form draws its own top bar: the Save button lives there, always in reach.
export default function SettingsPage() {
  return <SettingsForm />;
}
