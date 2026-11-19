import "server-only";
import { syncShortlistCases } from "~/server/shortlist-follow-up";
import { runDayCloseDigest, syncLinkedTasks } from "~/server/tasks";

// The two scheduled runs behind /api/cron/tasks. Both only catch up or send
// email; every rule (overdue, the 7 PM day close, which stage is due) is
// worked out from the time on read.
export async function runTasksCron(run: "morning" | "evening") {
  await syncLinkedTasks(true);
  await syncShortlistCases({ force: true });
  if (run === "morning") return { synced: true };
  return { synced: true, digest: await runDayCloseDigest() };
}
