import { redirect } from "next/navigation";

/** Root → projects list. */
export default function HomePage() {
  redirect("/projects");
}
