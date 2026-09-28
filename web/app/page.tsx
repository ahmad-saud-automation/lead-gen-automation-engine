import { redirect } from "next/navigation";

// Campaigns is where the work starts, as it was in V2.
export default function Home() {
  redirect("/campaigns");
}
