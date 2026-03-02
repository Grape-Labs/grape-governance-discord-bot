import "dotenv/config";
import { runCronOnce } from "./runner.js";

async function main(): Promise<void> {
  const stats = await runCronOnce();
  console.log(
    `[local-run] targets=${stats.targets} proposals=${stats.proposalsFetched} created=${stats.createdPosted} voting=${stats.votingPosted} tracked=${stats.tracked}`
  );
}

void main().catch((error) => {
  console.error("Local run failed:", error);
  process.exit(1);
});
