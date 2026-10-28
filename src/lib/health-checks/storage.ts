import "server-only";

import { createAdminClient } from "@/lib/supabase/server";
import { isMediaContentType, MEDIA_TYPES, type MediaProblem } from "./checklist";
import { HEALTH_CHECK_BUCKET } from "./server";

// Service-role storage work for health check media (P5.3). Callers (the admin actions) have already
// proved through the member's RLS client that the media row exists in the context garage and the
// check is editable; every call here is scoped to that garage's id and folder. The bucket has no
// staff insert policy, so uploads use a signed upload URL for one exact path, and `uploaded` (no
// staff grant) is set here once the object is really there.

function inGarageFolder(garageId: string, path: string) {
  return path.startsWith(`${garageId}/health-checks/`);
}

/** A signed upload URL for exactly this path in the garage's folder, or null. */
export async function createMediaUploadUrl(garageId: string, path: string): Promise<{ path: string; token: string } | null> {
  const service = createAdminClient();
  if (!service || !inGarageFolder(garageId, path)) return null;
  const signed = await service.storage.from(HEALTH_CHECK_BUCKET).createSignedUploadUrl(path);
  if (signed.error || !signed.data) return null;
  return { path: signed.data.path, token: signed.data.token };
}

/**
 * Checks the uploaded object exists with the declared type and within its size limit; marks the row
 * uploaded, or removes both the object and the row. Returns null when accepted, else the problem.
 */
export async function confirmMediaUpload(garageId: string, row: { id: string; object_path: string; content_type: string }): Promise<MediaProblem | "unavailable" | null> {
  const service = createAdminClient();
  if (!service || !inGarageFolder(garageId, row.object_path)) return "unavailable";
  const folder = row.object_path.slice(0, row.object_path.lastIndexOf("/"));
  const name = row.object_path.slice(row.object_path.lastIndexOf("/") + 1);
  const { data: files } = await service.storage.from(HEALTH_CHECK_BUCKET).list(folder, { search: name, limit: 1 });
  const file = files?.find((entry) => entry.name === name);
  const metadata = (file?.metadata ?? {}) as { size?: number; mimetype?: string };
  const size = Number(metadata.size ?? 0);
  const declared = isMediaContentType(row.content_type) ? MEDIA_TYPES[row.content_type] : null;
  let problem: MediaProblem | null = null;
  if (!file || !declared || size <= 0) problem = "type";
  else if (size > declared.maxBytes) problem = "size";
  else if (metadata.mimetype && metadata.mimetype !== row.content_type) problem = "type";
  if (problem) {
    await service.storage.from(HEALTH_CHECK_BUCKET).remove([row.object_path]);
    await service.from("health_check_media").delete().eq("garage_id", garageId).eq("id", row.id);
    return problem;
  }
  await service.from("health_check_media").update({ uploaded: true, size_bytes: size }).eq("garage_id", garageId).eq("id", row.id);
  return null;
}

/** Removes objects of rows the member's RLS client just deleted (only inside the garage's folder). */
export async function removeMediaObjects(garageId: string, paths: readonly string[]): Promise<void> {
  const own = paths.filter((path) => inGarageFolder(garageId, path));
  const service = createAdminClient();
  if (service && own.length) await service.storage.from(HEALTH_CHECK_BUCKET).remove(own);
}
