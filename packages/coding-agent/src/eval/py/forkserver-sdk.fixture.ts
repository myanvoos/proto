import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { Settings } from "../../config/settings";
import { createAgentSession } from "../../sdk";
import { SessionManager } from "../../session/session-manager";
import { pythonForkserverPids } from "./forkserver";

const cwd = process.argv[2];
const { session } = await createAgentSession({
	cwd,
	agentDir: path.join(cwd, "agent"),
	settings: Settings.isolated(),
	sessionManager: SessionManager.inMemory(cwd),
	enableMCP: false,
	disableExtensionDiscovery: true,
	skills: [],
	rules: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
});
let output = "";
let parents: number[] = [];
let sockets: string[] = [];
let socketModes: number[] = [];
try {
	const seeded = await session.executePython(`import proto_harness as harness
harness.store["answer"] = 42
harness.kernel("analysis").run("value=41")
print("seeded")`);
	if (seeded.exitCode !== 0) throw new Error(seeded.output);
	const restored = await session.executePython(`import proto_harness as harness
assert harness.store["answer"] == 42
result=harness.kernel("analysis").run("value += 1; print(value)")
print(result["output"].strip())`);
	if (restored.exitCode !== 0) throw new Error(restored.output);
	output = restored.output.trim();
	parents = pythonForkserverPids();
	sockets = parents.flatMap(
		pid =>
			Process.fromPid(pid)
				?.args()
				.filter(arg => path.basename(arg) === "s") ?? [],
	);
	socketModes = await Promise.all(sockets.map(async socket => (await fs.stat(path.dirname(socket))).mode & 0o777));
} finally {
	await session.dispose();
}
await Bun.write(
	Bun.stdout,
	JSON.stringify({
		output,
		parents,
		sockets,
		remaining: pythonForkserverPids(),
		alive: parents.filter(pid => Process.fromPid(pid)?.status() === "running"),
		socketModes,
		socketDirectoryExists: await Promise.all(
			sockets.map(socket =>
				fs.access(path.dirname(socket)).then(
					() => true,
					() => false,
				),
			),
		),
	}) + "\n",
);
// The SDK host may retain unrelated services; all kernel resources were checked before this exit.
process.exit(0);
