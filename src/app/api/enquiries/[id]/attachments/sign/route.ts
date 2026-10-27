import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { attachmentRequestSchema } from "@/lib/enquiries/schema";
import { verifyUploadToken } from "@/lib/enquiries/upload-token";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveRouteGarage } from "@/lib/tenancy/route";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { garage, response } = await resolveRouteGarage();
  if (response) return response;
  const { id } = await context.params;
  if (!verifyUploadToken(request.headers.get("x-upload-token"), id, garage.id)) return NextResponse.json({ error: "Invalid upload session" }, { status: 403 });
  const parsed = attachmentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unsupported attachment" }, { status: 400 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Uploads are unavailable" }, { status: 503 });

  const { data: enquiry } = await admin.from("enquiries").select("id").eq("garage_id", garage.id).eq("id", id).maybeSingle();
  if (!enquiry) return NextResponse.json({ error: "Invalid upload session" }, { status: 403 });
  const { count } = await admin.from("enquiry_attachments").select("id", { count: "exact", head: true }).eq("garage_id", garage.id).eq("enquiry_id", id);
  if ((count || 0) >= 5) return NextResponse.json({ error: "Attachment limit reached" }, { status: 400 });
  const extension = parsed.data.contentType === "image/jpeg" ? "jpg" : parsed.data.contentType.split("/")[1];
  // Storage paths start with the garage id (storage policies and a table check rely on it).
  const objectPath = `${garage.id}/${id}/${randomUUID()}.${extension}`;
  const attachmentId = randomUUID();
  const { error: insertError } = await admin.from("enquiry_attachments").insert({ id: attachmentId, garage_id: garage.id, enquiry_id: id, object_path: objectPath, file_name: parsed.data.name, content_type: parsed.data.contentType, size_bytes: parsed.data.size });
  if (insertError) return NextResponse.json({ error: "Could not prepare upload" }, { status: 400 });
  const { data, error } = await admin.storage.from("enquiry-attachments").createSignedUploadUrl(objectPath);
  if (error) return NextResponse.json({ error: "Could not prepare upload" }, { status: 503 });
  return NextResponse.json({ path: data.path, token: data.token, attachmentId });
}
