import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { clearSessionCookie } from "~/server/auth/cookies";
import { endImpersonationFromLogout } from "~/server/auth/impersonation";
import { db } from "~/server/db";

// Session-side router: who am I, and let me sign out. Distinct from the auth
// flow router (`auth`) used by the partner side.
export const authSessionRouter = createTRPCRouter({
  // Returns the current admin (collegepond_user) if signed in, else null.
  // Public on purpose so the client can call it without erroring on logged-out
  // users; gating is done by the consumer (e.g. middleware redirects).
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.cpUser) return null;
    const user = await db.collegepond_user.findUnique({
      where: { id: ctx.cpUser.id },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        status: true,
      },
    });
    if (user?.status !== 1) return null;
    return {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      role: user.role,
    };
  }),

  // Public so a stale/expired cookie doesn't 401 the logout itself. Clears the
  // cookie via ctx.resHeaders so the Set-Cookie actually reaches the browser.
  // Signing out also ends any impersonation (staff, or a partner one started
  // from this admin session) and records it in the audit log.
  logout: publicProcedure.mutation(async ({ ctx }) => {
    await endImpersonationFromLogout(ctx);
    ctx.resHeaders.append("Set-Cookie", clearSessionCookie());
    return { success: true as const };
  }),
});
