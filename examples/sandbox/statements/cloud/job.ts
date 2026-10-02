/**
 * `s.cloud.job({ image, command, args?, await?, as? })` — launch a cloud job.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const cloudJob = defineFunction({
  name: "ex_cloud_job",
  stack: [
    s.cloud.job({
      image: c.text("acme/worker:latest"),
      command: c.text("process"),
      args: c.array(["--batch", "42"]),
      as: "job",
    }),
  ],
  response: ref("job"),
});
