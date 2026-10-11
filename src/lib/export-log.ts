"use client";

import { api } from "~/trpc/react";

// Records a client-side download (CSV/XLSX/JSON) in the audit log. Fire and
// forget: a failed log never blocks the download. While a Super Admin is
// impersonating, the server attributes the row to the real admin.
export function useExportLog(side: "admin" | "partner" = "admin") {
  const admin = api.audit.logExport.useMutation();
  const partner = api.audit.logPartnerExport.useMutation();
  const m = side === "admin" ? admin : partner;
  return (file: string, rows?: number) => m.mutate({ file, rows });
}
