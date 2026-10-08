import { redirect } from "next/navigation";

/** X Research became the X Dashboard; keep old links and bookmarks working. */
export default function XResearchRedirect() {
  redirect("/x-dashboard");
}
