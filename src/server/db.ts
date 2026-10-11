import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Prisma, PrismaClient } from "../../generated/prisma";
import { env } from "~/env";
import { attributeAuditMetadata, currentImpersonation } from "~/server/auth/impersonation-context";

// DigitalOcean Managed MySQL requires TLS. Prisma's MySQL connector uses the
// `sslaccept` / `sslcert` query params — NOT the `?ssl-mode=REQUIRED` that DO
// prints in its connection string (Prisma ignores that). Normalize the URL here
// so a pasted DO string, or a CA cert supplied via env, connects correctly.
function resolveDatabaseUrl(): string {
  const raw = env.DATABASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // unparseable (e.g. exotic password) — use as-is
  }

  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "db") {
    return raw; // local dev DB — no TLS
  }

  // DO's `ssl-mode` param is meaningless to Prisma; drop it.
  url.searchParams.delete("ssl-mode");

  if (env.DATABASE_CA_CERT && !url.searchParams.has("sslcert")) {
    // App Platform's FS is ephemeral, so materialize the CA at boot.
    const caPath = join(mkdtempSync(join(tmpdir(), "cp-db-")), "ca.pem");
    writeFileSync(caPath, env.DATABASE_CA_CERT, { mode: 0o600 });
    url.searchParams.set("sslcert", caPath);
    if (!url.searchParams.has("sslaccept")) {
      url.searchParams.set("sslaccept", "strict");
    }
  } else if (!url.searchParams.has("sslaccept")) {
    // Encrypted but unverified — fine for prod testing; set DATABASE_CA_CERT to
    // upgrade to strict verification.
    console.warn(
      "[db] Remote MySQL without DATABASE_CA_CERT — connecting with sslaccept=accept_invalid_certs (encrypted, unverified).",
    );
    url.searchParams.set("sslaccept", "accept_invalid_certs");
  }

  // Bound the connection pool so (instance_count × connection_limit) stays under
  // the Managed MySQL connection cap (basic plans are small). Tune per plan.
  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", "5");
  }
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", "20");
  }
  return url.toString();
}

// While a Super Admin is impersonating someone, every audit_log row is
// attributed to the real admin (see ~/server/auth/impersonation-context).
function withAuditAttribution(client: PrismaClient) {
  return client.$extends({
    query: {
      audit_log: {
        create({ args, query }) {
          const imp = currentImpersonation();
          if (imp) {
            args.data.metadata = attributeAuditMetadata(args.data.metadata, imp) as Prisma.InputJsonObject;
          }
          return query(args);
        },
        createMany({ args, query }) {
          const imp = currentImpersonation();
          if (imp) {
            const rows = Array.isArray(args.data) ? args.data : [args.data];
            args.data = rows.map((r) => ({
              ...r,
              metadata: attributeAuditMetadata(r.metadata, imp) as Prisma.InputJsonObject,
            }));
          }
          return query(args);
        },
      },
    },
  });
}

const createPrismaClient = () => {
  try {
    return withAuditAttribution(
      new PrismaClient({
        datasources: { db: { url: resolveDatabaseUrl() } },
        log:
          process.env.NODE_ENV === "development"
            ? ["query", "error", "warn"]
            : ["error"],
      }),
    );
  } catch (e) {
    // In dev, allow the app to boot without a DB; in prod, fail loudly rather
    // than hand back a null client that throws cryptically later.
    if (process.env.NODE_ENV === "production") throw e;
    console.error("[db] PrismaClient init failed (dev):", e);
    return null as unknown as ReturnType<typeof withAuditAttribution>;
  }
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
