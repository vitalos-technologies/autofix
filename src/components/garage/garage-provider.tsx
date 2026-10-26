"use client";

import { createContext, useContext } from "react";

/** The garage fields client components may read. Built server-side by `publicGarage()`. */
export type PublicGarage = {
  id: string;
  slug: string;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  town: string | null;
  postcode: string | null;
  timezone: string;
  logoUrl: string | null;
  accent: string;
  motEnabled: boolean;
};

const GarageContext = createContext<PublicGarage | null>(null);

export function GarageProvider({ garage, children }: { garage: PublicGarage; children: React.ReactNode }) {
  return <GarageContext.Provider value={garage}>{children}</GarageContext.Provider>;
}

/** The current booking site's garage. Throws outside a `GarageProvider`. */
export function useGarage() {
  const garage = useContext(GarageContext);
  if (!garage) throw new Error("useGarage() must be used inside <GarageProvider>");
  return garage;
}

/** Like `useGarage()` but returns null outside a booking site. */
export function useOptionalGarage() {
  return useContext(GarageContext);
}
