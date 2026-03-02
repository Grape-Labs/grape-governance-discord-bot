import { getConfig } from "../src/config.js";
import { runCronOnce } from "../src/runner.js";

export const config = {
  maxDuration: 60
};

function isAuthorized(req: { headers?: Record<string, string | string[] | undefined> }, secret: string | null): boolean {
  if (!secret) return true;
  const authHeader = req.headers?.authorization;
  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  return token === `Bearer ${secret}`;
}

export default async function handler(
  req: { method?: string; headers?: Record<string, string | string[] | undefined> },
  res: {
    status: (code: number) => { json: (body: unknown) => void; send: (body: string) => void };
    setHeader: (name: string, value: string) => void;
  }
): Promise<void> {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).send("Method Not Allowed");
    return;
  }

  const config = getConfig();
  if (!isAuthorized(req, config.cronSecret)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  try {
    const stats = await runCronOnce(config);
    console.log(
      `[cron] ok targets=${stats.targets} fetched=${stats.proposalsFetched} tracked=${stats.tracked} created=${stats.createdPosted} voting=${stats.votingPosted} seededWithoutAlert=${stats.seededWithoutAlert} stateInitializedBeforeRun=${stats.stateInitializedBeforeRun} fetchErrors=${stats.fetchErrors} newTargetsSeeded=${stats.newTargetsSeeded} testPostLatestPosted=${stats.testPostLatestPosted} sendErrors=${stats.sendErrors}`
    );
    res.status(200).json({ ok: true, stats });
  } catch (error) {
    console.error("[cron] fatal error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ ok: false, error: message });
  }
}
