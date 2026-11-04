import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

for (const state of ["draft", "published", "inaccessible"] as const) {
	test(`release staging ${state === "draft" ? "uploads exact asset paths to the authenticated draft" : `refuses ${state} releases without uploading`}`, async () => {
		using dir = TempDir.createSync("@proto-release-stage-");
		const executable = dir.join("bin", "gh");
		await Bun.write(
			executable,
			`#!/bin/sh
if [ "$1 $2" = "release view" ]; then
  [ "$3" = v20.0.2 ] && [ "$4" = --repo ] && [ "$5" = myanvoos/proto ] || exit 65
  case "$TEST_RELEASE_STATE" in
    draft) echo true ;;
    published) echo false ;;
    inaccessible) exit 23 ;;
  esac
elif [ "$1 $2" = "release upload" ]; then
  printf '%s\\n' "$@" > "$TEST_UPLOAD_LOG"
else
  exit 66
fi
`,
		);
		await fs.chmod(executable, 0o755);
		const asset = dir.join("binary with spaces");
		await Bun.write(asset, "binary fixture");
		const child = Bun.spawn(["sh", path.join(import.meta.dir, "ci-stage-release-assets.sh"), "v20.0.2", asset], {
			env: {
				...process.env,
				PATH: `${dir.join("bin")}${path.delimiter}${process.env.PATH}`,
				GITHUB_REPOSITORY: "myanvoos/proto",
				TEST_RELEASE_STATE: state,
				TEST_UPLOAD_LOG: dir.join("upload.log"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (state === "draft") {
			expect(exitCode, stderr).toBe(0);
			expect(await Bun.file(dir.join("upload.log")).text()).toBe(
				`release\nupload\nv20.0.2\n--repo\nmyanvoos/proto\n--clobber\n${asset}\n`,
			);
		} else {
			expect(exitCode).not.toBe(0);
			expect(await Bun.file(dir.join("upload.log")).exists()).toBe(false);
			if (state === "published") expect(stderr).toContain("Refusing to upload assets to non-draft release");
		}
	});
}
