import fs from "node:fs";

const generation = Number.parseInt(process.env.ADDROID_WORKER_GENERATION ?? "0", 10);
const eventsFile = process.env.ADDROID_TEST_SUPERVISOR_EVENTS;
const jobEvidenceFile = process.env.ADDROID_TEST_SCHEDULED_JOB_EVIDENCE;

function record(event) {
  if (!eventsFile) return;
  fs.appendFileSync(eventsFile, `${JSON.stringify({ event, generation, pid: process.pid })}\n`, "utf8");
}

function send(type) {
  process.send?.({ type, generation });
}

record("spawned");
send("ready");

if (generation === 1 && process.env.ADDROID_TEST_DIE_FIRST_GENERATION === "1") {
  setTimeout(() => {
    record("fixture-disconnect-fatal");
    process.exit(17);
  }, 25);
} else {
  if (jobEvidenceFile) {
    try {
      const fd = fs.openSync(jobEvidenceFile, "wx", 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({ jobId: "scheduled-fixture-1", generation, status: "completed" }) + "\n",
        "utf8"
      );
      fs.closeSync(fd);
      record("scheduled-job-completed");
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      record("scheduled-job-duplicate-skipped");
    }
  }
  setInterval(() => send("heartbeat"), 20);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    record(`received-${signal}`);
    process.exit(0);
  });
}
