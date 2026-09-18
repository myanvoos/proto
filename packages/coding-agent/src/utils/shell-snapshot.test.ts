import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOrCreateSnapshot } from "./shell-snapshot";

async function createHome(root: string, name: string): Promise<string> {
	const home = path.join(root, name);
	await fs.mkdir(home, { recursive: true });
	await Bun.write(path.join(home, ".bashrc"), 'probe_marker() { printf "%s\\n" "$SESSION_MARKER"; }\n');
	return home;
}

test("snapshot caching isolates HOME, PATH, and function-referenced environment", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-snapshot-env-"));
	try {
		const firstHome = await createHome(root, "first");
		const secondHome = await createHome(root, "second");
		const firstPath = "/snapshot/first/bin:/usr/bin:/bin";
		const secondPath = "/snapshot/second/bin:/usr/bin:/bin";
		const thirdPath = "/snapshot/third/bin:/usr/bin:/bin";

		const first = await getOrCreateSnapshot("/bin/bash", {
			HOME: firstHome,
			PATH: firstPath,
			SESSION_MARKER: "first-marker",
		});
		const second = await getOrCreateSnapshot("/bin/bash", {
			HOME: secondHome,
			PATH: secondPath,
			SESSION_MARKER: "second-marker",
		});
		const third = await getOrCreateSnapshot("/bin/bash", {
			HOME: secondHome,
			PATH: thirdPath,
			SESSION_MARKER: "third-marker",
		});

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(third).not.toBeNull();
		expect(new Set([first, second, third]).size).toBe(3);
		const [firstContent, secondContent, thirdContent] = await Promise.all([
			Bun.file(first!).text(),
			Bun.file(second!).text(),
			Bun.file(third!).text(),
		]);
		expect(firstContent).toContain(firstPath);
		expect(firstContent).toContain("first-marker");
		expect(secondContent).toContain(secondPath);
		expect(secondContent).toContain("second-marker");
		expect(thirdContent).toContain(thirdPath);
		expect(thirdContent).toContain("third-marker");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
