/**
 * `s.cloud.job.status({ id, as? })` — read a cloud job's status.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const cloudJobStatus = defineFunction({
  name: "ex_cloud_job_status",
  stack: [s.cloud.job.status({ id: c.text("job_1"), as: "status" })],
  response: ref("status"),
});
