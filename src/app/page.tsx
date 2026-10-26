import { redirect } from "next/navigation";

// The admin host has no public home page. Garage booking sites are served
// from their own hosts (P1.7), so the bare root sends staff to the admin.
export default function HomePage() {
  redirect("/admin");
}
