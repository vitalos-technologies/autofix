import { permanentRedirect } from "next/navigation";

// SOB's read-only service list moved to Setup → Services & prices (P3.4).
export default function AdminServiceCataloguePage() {
  permanentRedirect("/app/settings/services");
}
