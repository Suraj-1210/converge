import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const URL_PREFIX = "/uploads";

export interface StoredFile {
  path: string;
  url: string;
}

export async function saveLocal(
  buffer: Buffer,
  keyPath: string,
): Promise<StoredFile> {
  const absPath = path.join(UPLOAD_DIR, keyPath);
  const dir = path.dirname(absPath);

  const resolvedUploadDir = path.resolve(UPLOAD_DIR);
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedUploadDir + path.sep) && resolvedDir !== resolvedUploadDir) {
    throw new Error("Invalid upload path");
  }

  await mkdir(dir, { recursive: true });
  await writeFile(absPath, buffer);

  return {
    path: absPath,
    url: `${URL_PREFIX}/${keyPath.split(path.sep).join("/")}`,
  };
}

// Reads back a file saved by saveLocal, given its "/uploads/..." URL.
export async function readLocal(url: string): Promise<Buffer> {
  if (!url.startsWith(`${URL_PREFIX}/`)) throw new Error("Not a local upload");
  const absPath = path.resolve(UPLOAD_DIR, url.slice(URL_PREFIX.length + 1));
  if (!absPath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    throw new Error("Invalid upload path");
  }
  return readFile(absPath);
}
