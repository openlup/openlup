// Runs separately from the occupied proof so synchronous Compose calls cannot block Docker events.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [docker, project, alternate, barrier] = process.argv.slice(2);
const events = spawn(docker, ["events", "--since", new Date().toISOString(), "--filter", "event=create", "--filter", "event=start", "--filter", "event=die", "--filter", "event=destroy",
  "--format", '{{.Type}} {{.Action}} {{index .Actor.Attributes "com.docker.compose.project"}} {{.Actor.ID}}'
    + ' {{index .Actor.Attributes "com.docker.compose.service"}}'
    + ' {{if index .Actor.Attributes "com.docker.compose.container-number"}}managed{{end}}'
    + ' {{index .Actor.Attributes "com.openlup.proof.log-fixture"}}'],
{ stdio: ["ignore", "pipe", "ignore"] });
const inventory = new Map(), installers = new Set();
let finishing = false;
const report = result => {
  // Keep captured bytes on the private IPC channel.
  process.send(result, () => process.disconnect());
};
events.once("error", () => {
  if (!finishing) report({ error: "application_event_stream" });
});
events.once("exit", () => {
  if (!finishing) report({ error: "application_event_stream" });
});
events.once("spawn", () => process.send({ ready: true }));

function follow(id) {
  const client = spawn(docker, ["logs", "--follow", id], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  client.stdout.on("data", bytes => stdout.push(bytes));
  client.stderr.on("data", bytes => stderr.push(bytes));
  return new Promise(resolve => {
    client.once("error", () => resolve({ ok: false }));
    client.once("close", code => resolve({ ok: code === 0,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function finish() {
  finishing = true;
  events.kill();
  const logs = [];
  const errors = new Set();
  for (const [id, entry] of inventory) {
    const streams = await Promise.all(entry.followers);
    if (!entry.destroyed || entry.starts !== entry.exits || (!entry.starts && entry.fixture)
      || streams.some(result => !result.ok)) errors.add("application_log_stream_incomplete");
    logs.push({ id, fixture: entry.fixture, started: entry.starts > 0, streams: streams.flatMap(result => [result.stdout, result.stderr]) });
  }
  report({ logs, installerCount: installers.size, errors: [...errors] });
}

for await (const line of createInterface({ input: events.stdout })) {
  const [type, action, name, id, service, managed, fixture] = line.split(" ");
  if (type === "volume" && action === "create" && id === barrier) {
    await finish();
    break;
  }
  if (type !== "container" || (name !== project && name !== alternate)) continue;
  if (service === "installation" && action === "create") installers.add(id);
  if (!(service === "application" && managed === "managed") && !fixture) continue;
  if (action === "create") inventory.set(id, { fixture, followers: [follow(id)], starts: 0, exits: 0, destroyed: false });
  const entry = inventory.get(id);
  if (!entry) {
    finishing = true;
    events.kill();
    report({ error: "application_event_without_create" });
    break;
  }
  if (action === "start") {
    entry.starts++;
    // Docker closes a follower opened before start. Follow again for each running interval.
    entry.followers.push(follow(id));
  }
  if (action === "die") entry.exits++;
  if (action === "destroy") entry.destroyed = true;
}
