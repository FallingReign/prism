import {
  getDelegatedDeliveryMaintenanceConfig,
  isSetupRequiredError
} from "../src/server/config";
import { closeDatabasePool, database } from "../src/server/db";
import { runPostgresDelegatedDeliveryCleanup } from "../src/server/delegated-delivery/postgres-store";

try {
  const maintenance = getDelegatedDeliveryMaintenanceConfig();
  const result = await runPostgresDelegatedDeliveryCleanup({
    database,
    statusRetentionMs: maintenance.statusRetentionMs,
    batchSize: maintenance.cleanupBatchSize
  });
  console.log("Delegated Slack delivery cleanup complete.", result);
} catch (error) {
  process.exitCode = 1;
  console.error("Delegated Slack delivery cleanup failed.", {
    errorClass: isSetupRequiredError(error) ? "setup_required" : "cleanup_failed"
  });
} finally {
  await closeDatabasePool();
}
