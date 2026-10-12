import "server-only";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "~/env";

// DigitalOcean Spaces is S3-compatible, so we drive it with the AWS S3 SDK
// pointed at the regional Spaces endpoint. When the SPACES_* env vars are
// absent we fall back to the local-disk backend (dev only) — see storage/index.

let client: S3Client | null = null;

export function spacesConfigured(): boolean {
  return Boolean(
    env.SPACES_KEY &&
      env.SPACES_SECRET &&
      env.SPACES_BUCKET &&
      env.SPACES_REGION &&
      env.SPACES_ENDPOINT,
  );
}

function getClient(): S3Client {
  if (!spacesConfigured()) {
    throw new Error("Spaces is not configured (SPACES_* env vars missing)");
  }
  client ??= new S3Client({
    region: env.SPACES_REGION!,
    endpoint: env.SPACES_ENDPOINT!,
    forcePathStyle: false,
    credentials: {
      accessKeyId: env.SPACES_KEY!,
      secretAccessKey: env.SPACES_SECRET!,
    },
  });
  return client;
}

export async function putObject(
  key: string,
  body: Buffer,
  opts: { contentType?: string; public?: boolean } = {},
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.SPACES_BUCKET!,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      // Private by default; only logos and other non-sensitive assets are
      // uploaded public-read.
      ACL: opts.public ? "public-read" : "private",
    }),
  );
}

// Permanent URL for a public-read object. Prefers the CDN base; otherwise the
// virtual-hosted bucket origin derived from the regional endpoint.
export function publicUrl(key: string): string {
  if (env.SPACES_CDN_URL) {
    return `${env.SPACES_CDN_URL.replace(/\/+$/, "")}/${key}`;
  }
  const host = env.SPACES_ENDPOINT!.replace(/^https?:\/\//, "").replace(
    /\/+$/,
    "",
  );
  return `https://${env.SPACES_BUCKET}.${host}/${key}`;
}

// Reads a whole object, for files the app serves itself (e.g. the frozen MOU).
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: env.SPACES_BUCKET!, Key: key }),
  );
  if (!res.Body) throw new Error(`Empty object: ${key}`);
  return Buffer.from(await res.Body.transformToByteArray());
}

// Short-lived signed URL for a private object, generated on demand by the
// gated /api/files proxy.
export async function presignGetUrl(key: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.SPACES_BUCKET!, Key: key }),
    { expiresIn },
  );
}
