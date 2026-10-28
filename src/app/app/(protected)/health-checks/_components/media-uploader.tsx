"use client";

import { useId, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Camera, LoaderCircle, Video } from "lucide-react";
import { buttonClass } from "@/components/admin-ui";
import { MEDIA_PROBLEM_MESSAGES, mediaProblem, PHOTO_ACCEPT, VIDEO_ACCEPT } from "@/lib/health-checks/checklist";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { finishUploadAction, prepareUploadAction } from "../actions";

const BUCKET = "health-check-media";

/**
 * "Take photo" and "Record video" on the phone (file inputs with `capture`, so the camera opens; on
 * a desktop they pick a file). Each file is checked here, recorded by the server (which hands back
 * a signed upload URL for the garage's own folder), uploaded straight to storage and confirmed.
 */
export function MediaUploader({ checkId, itemId, label }: { checkId: string; itemId: string | null; label: string }) {
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setMessage(null);
    let added = 0;
    try {
      const supabase = createClient();
      if (!supabase) throw new Error("unavailable");
      for (const file of files.slice(0, 6)) {
        const problem = mediaProblem(file);
        if (problem) {
          setMessage({ tone: "error", text: MEDIA_PROBLEM_MESSAGES[problem] });
          continue;
        }
        const prepared = await prepareUploadAction({ checkId, itemId, contentType: file.type, size: file.size });
        if (!prepared.ok) {
          setMessage({ tone: "error", text: prepared.message });
          break;
        }
        const uploaded = await supabase.storage.from(BUCKET).uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: file.type });
        if (uploaded.error) {
          setMessage({ tone: "error", text: "The upload didn't finish. Check your signal and try again." });
          continue;
        }
        const finished = await finishUploadAction({ checkId, mediaId: prepared.mediaId });
        if (!finished.ok) {
          setMessage({ tone: "error", text: finished.message ?? "That file couldn't be added." });
          continue;
        }
        added += 1;
      }
    } catch {
      setMessage({ tone: "error", text: "Uploads aren't available right now. Try again in a moment." });
    } finally {
      setBusy(false);
    }
    if (added > 0) {
      setMessage((current) => current ?? { tone: "ok", text: added === 1 ? "Added." : `${added} files added.` });
      router.refresh();
    }
  }

  const pick = cn(
    buttonClass("secondary", "md", "cursor-pointer"),
    "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid",
    busy && "pointer-events-none opacity-60",
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <label className={pick}>
          {busy ? <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="animate-spin" /> : <Camera size={18} strokeWidth={2} aria-hidden="true" />}
          <span>Take photo</span>
          <span className="sr-only"> for {label}</span>
          <input id={`${id}-photo`} type="file" accept={PHOTO_ACCEPT} capture="environment" multiple className="sr-only" onChange={upload} disabled={busy} />
        </label>
        <label className={pick}>
          <Video size={18} strokeWidth={2} aria-hidden="true" />
          <span>Record video</span>
          <span className="sr-only"> for {label}</span>
          <input id={`${id}-video`} type="file" accept={VIDEO_ACCEPT} capture="environment" className="sr-only" onChange={upload} disabled={busy} />
        </label>
      </div>
      <p role="status" aria-live="polite" className={cn("m-0 text-[13px] font-semibold", message?.tone === "error" ? "text-[#b91c1c]" : "text-success-ink", !message && "sr-only")}>
        {busy ? "Uploading…" : (message?.text ?? "")}
      </p>
    </div>
  );
}
