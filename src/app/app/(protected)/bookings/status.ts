import type { BookingStatus } from "@/lib/booking-engine/types";

const labels: Record<BookingStatus, string> = {
  requested: "Needs your OK",
  confirmed: "Confirmed",
  arrived: "Arrived",
  in_progress: "In progress",
  waiting_parts: "Waiting for parts",
  ready: "Ready",
  collected: "Collected",
  cancelled: "Cancelled",
  no_show: "No show",
};

const tones: Record<BookingStatus, string> = {
  requested: "bg-amber-100 text-amber-900",
  confirmed: "bg-green-100 text-green-800",
  arrived: "bg-[#EAF3FF] text-[#1446A5]",
  in_progress: "bg-[#EAF3FF] text-[#1446A5]",
  waiting_parts: "bg-amber-100 text-amber-900",
  ready: "bg-green-100 text-green-800",
  collected: "bg-[#E4EAF0] text-[#586575]",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-red-100 text-red-800",
};

export function bookingStatusLabel(status: BookingStatus) {
  return labels[status] ?? status;
}

/** Badge colours; every pair passes 4.5:1. */
export function bookingStatusTone(status: BookingStatus) {
  return tones[status] ?? "bg-[#E4EAF0] text-[#586575]";
}
