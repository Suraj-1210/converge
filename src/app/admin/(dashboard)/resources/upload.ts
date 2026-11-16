import { RESOURCE_MAX_BYTES } from "~/lib/resources";

export interface UploadedResourceFile {
  upload: string;
  fileName: string;
  mime: string;
  size: number;
}

// Sends one file to /api/resources/upload. Returns the signed receipt the
// resources.adminCreate / adminAddVersion mutations take, or throws with the
// server's message.
export async function uploadResourceFile(file: File): Promise<UploadedResourceFile> {
  if (file.size > RESOURCE_MAX_BYTES) throw new Error("File too large (25 MB max)");
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/resources/upload", { method: "POST", body });
  let data: Partial<UploadedResourceFile> & { error?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // Non-JSON (e.g. a proxy error page).
  }
  if (!res.ok || !data.upload) throw new Error(data.error ?? "Upload failed. Please try again.");
  return data as UploadedResourceFile;
}
