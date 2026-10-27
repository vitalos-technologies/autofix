"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { startTransition, useRef, useState } from "react";
import type { TrashActionResult } from "@/app/app/(protected)/trash/actions";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";

export function AdminBulkActions({ entity, children, mode = "active", action }: {
  entity: string;
  children: React.ReactNode;
  mode?: "active" | "trash";
  action: (formData: FormData) => Promise<TrashActionResult>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [result, setResult] = useState<TrashActionResult | null>(null);

  function itemCheckboxes() {
    return [...(root.current?.querySelectorAll<HTMLInputElement>("input[data-trash-item]") || [])]
      .filter((checkbox) => checkbox.offsetParent !== null);
  }

  function updateSelection() {
    const checkboxes = itemCheckboxes();
    const count = checkboxes.filter((checkbox) => checkbox.checked).length;
    setSelected(count);
    if (selectAll.current) {
      selectAll.current.checked = checkboxes.length > 0 && count === checkboxes.length;
      selectAll.current.indeterminate = count > 0 && count < checkboxes.length;
    }
  }

  function toggleAll(checked: boolean) {
    for (const checkbox of itemCheckboxes()) checkbox.checked = checked;
    updateSelection();
  }

  function run(intent: "trash" | "restore" | "delete") {
    const ids = itemCheckboxes().filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
    if (!ids.length) return;
    const formData = new FormData();
    formData.set("entity", entity);
    formData.set("intent", intent);
    for (const id of ids) formData.append("ids", id);
    setPending(true);
    setResult(null);
    startTransition(() => {
      void action(formData).then((next) => {
        setResult(next);
        setSelected(0);
        if (selectAll.current) selectAll.current.checked = false;
      }).finally(() => {
        setPending(false);
        setConfirmDelete(false);
      });
    });
  }

  return <div ref={root} onChange={updateSelection}>
    <div className="mt-5 flex min-h-14 flex-wrap items-center gap-3 rounded-card border border-grey-200 bg-white px-3.5 py-1.5 font-sans">
      <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[14px] font-semibold text-navy-950"><input ref={selectAll} type="checkbox" onChange={(event) => toggleAll(event.currentTarget.checked)} className="size-[18px] accent-[var(--garage-accent)]" /> Select all visible</label>
      <span className="text-[13px] font-semibold text-grey-600">{selected} selected</span>
      <div className="ml-auto flex flex-wrap gap-2">
        {mode === "active" ? <button type="button" disabled={!selected || pending} onClick={() => run("trash")} className="inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-[#f3c4c4] bg-white px-3 text-[14px] font-semibold text-[#991b1b] hover:bg-[#fdecec] disabled:opacity-60"><Trash2 size={18} aria-hidden="true" /> Move to trash</button> : <>
          <button type="button" disabled={!selected || pending} onClick={() => run("restore")} className="inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-grey-300 bg-white px-3 text-[14px] font-semibold text-navy-950 hover:border-grey-600 disabled:opacity-60"><RotateCcw size={18} aria-hidden="true" /> Restore</button>
          <button type="button" disabled={!selected || pending} onClick={() => setConfirmDelete(true)} className="inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-[#b91c1c] px-3 text-[14px] font-bold text-white hover:bg-[#991b1b] disabled:opacity-60"><Trash2 size={18} aria-hidden="true" /> Delete permanently</button>
        </>}
      </div>
    </div>
    {result && <p role="status" className={`mt-3 rounded-input px-4 py-3 text-[14px] font-semibold ${result.success ? "bg-success-bg text-success-ink" : "bg-[#fdecec] text-[#991b1b]"}`}>{result.message}</p>}
    {children}
    <ConfirmActionDialog open={confirmDelete} pending={pending} tone="danger" title="Permanently delete selected items?" message={`${selected} selected ${selected === 1 ? "item" : "items"} will be permanently deleted. This cannot be undone. Issued invoices and records protected by linked financial data will be kept.`} confirmLabel="Delete permanently" onCancel={() => setConfirmDelete(false)} onConfirm={() => run("delete")} />
  </div>;
}

export function AdminItemCheckbox({ id, label }: { id: string; label: string }) {
  return <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center" onClick={(event) => event.stopPropagation()}><input data-trash-item type="checkbox" value={id} aria-label={label} className="size-[18px] accent-[var(--garage-accent)]" /></label>;
}
