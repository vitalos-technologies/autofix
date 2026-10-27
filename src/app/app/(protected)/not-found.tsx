import Link from "next/link";
import { buttonClass, PageHeader } from "@/components/admin-ui";

/** `notFound()` inside the admin (a booking from another garage, a mistyped link): keeps the shell. */
export default function AdminNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Not found" description="This page could not be found. It may have been moved, or it belongs to another garage." />
      <div>
        <Link href="/app" className={buttonClass("secondary")}>
          Back to Today
        </Link>
      </div>
    </div>
  );
}
