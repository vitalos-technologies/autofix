import type { HealthCheckMedia } from "@/lib/health-checks/view";
import { cn } from "@/lib/utils";

/** "Photo 2", "Video 1": each kind numbered in order. */
function numbered(media: readonly HealthCheckMedia[]) {
  const counts = { image: 0, video: 0 };
  return media.map((entry) => {
    counts[entry.kind] += 1;
    return { entry, number: counts[entry.kind] };
  });
}

/**
 * Photos and videos of a health check line (P5.3). URLs are short-lived signed URLs; an entry whose
 * URL could not be signed is skipped. Videos play inline on phones with the native controls.
 */
export function MediaGallery({ media, label, className }: { media: readonly HealthCheckMedia[]; label: string; className?: string }) {
  const shown = numbered(media.filter((entry) => entry.url));
  if (shown.length === 0) return null;
  return (
    <ul className={cn("m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3", className)} aria-label={`Photos and videos: ${label}`}>
      {shown.map(({ entry, number }) =>
        entry.kind === "video" ? (
          <li key={entry.id} className="overflow-hidden rounded-[12px] border border-grey-200 bg-navy-950">
            <video
              src={entry.url ?? undefined}
              controls
              playsInline
              preload="metadata"
              aria-label={`Video ${number} of ${label}`}
              className="aspect-[4/3] w-full bg-navy-950 object-contain"
            />
          </li>
        ) : (
          <li key={entry.id} className="overflow-hidden rounded-[12px] border border-grey-200 bg-grey-100">
            {/* Signed storage URLs expire in minutes, so next/image's cache would serve dead links. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={entry.url ?? undefined} alt={`Photo ${number} of ${label}`} loading="lazy" className="aspect-[4/3] w-full object-cover" />
          </li>
        ),
      )}
    </ul>
  );
}
