/**
 * `s.cloud.job.await({ ids, timeout, as? })` — block until cloud jobs finish.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const cloudJobAwait = defineFunction({
  name: "ex_cloud_job_await",
  stack: [s.cloud.job.await({ ids: c.array(["job_1", "job_2"]), timeout: c.int(60), as: "results" })],
  response: ref("results"),
});
