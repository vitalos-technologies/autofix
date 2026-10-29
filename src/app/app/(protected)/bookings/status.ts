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
  arrived: "bg-[#EFF6FF] text-[#1D4ED8]",
  in_progress: "bg-[#EFF6FF] text-[#1D4ED8]",
  waiting_parts: "bg-amber-100 text-amber-900",
  ready: "bg-green-100 text-green-800",
  collected: "bg-[#E2E8F0] text-[#64748b]",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-red-100 text-red-800",
};

export function bookingStatusLabel(status: BookingStatus) {
  return labels[status] ?? status;
}

/** Badge colours; every pair passes 4.5:1. */
export function bookingStatusTone(status: BookingStatus) {
  return tones[status] ?? "bg-[#E2E8F0] text-[#64748b]";
}
