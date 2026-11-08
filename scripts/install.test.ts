import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

async function runInstaller(
	dir: TempDir,
	access: "public" | "private" | "denied",
	ref?: string,
	library: "present" | "missing" = "present",
) {
	const executables = {
		uname: '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) exit 64 ;; esac\n',
		curl: `#!/bin/sh
[ "$TEST_RELEASE_ACCESS" = public ] || exit 22
url=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in -o) output="$2"; shift ;; https://*) url="$1" ;; esac
  shift
done
case "$url" in
  "https://api.github.com/repos/myanvoos/proto/releases/$TEST_API_SUFFIX")
    printf '{"tag_name":"v20.0.1"}\\n' ;;
  https://github.com/myanvoos/proto/releases/download/v20.0.1/proto-linux-x64)
    cp "$TEST_BINARY" "$output" ;;
  https://github.com/myanvoos/proto/releases/download/v20.0.1/protofs-linux-x64)
    cp "$TEST_PROTOFS_BINARY" "$output" ;;
  https://github.com/myanvoos/proto/releases/download/v20.0.1/libprotofs-linux-x64.so)
    [ "$TEST_LIBRARY_ACCESS" = present ] || exit 65
    cp "$TEST_PROTOFS_LIBRARY" "$output" ;;
  *) exit 65 ;;
esac
`,
		gh: `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_GH_LOG"
[ "$TEST_RELEASE_ACCESS" = private ] || exit 4
if [ "$1" = api ]; then
  [ "$2" = "repos/myanvoos/proto/releases/$TEST_API_SUFFIX" ] || exit 65
  printf '{"tag_name":"v20.0.1"}\\n'
elif [ "$1 $2" = "release download" ]; then
  [ "$3" = v20.0.1 ] || exit 66
  shift 3
  repo=""; pattern=""; output=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo) repo="$2"; shift ;;
      --pattern) pattern="$2"; shift ;;
      --output) output="$2"; shift ;;
      --clobber) ;;
      *) exit 67 ;;
    esac
    shift
  done
  [ "$repo" = myanvoos/proto ] || exit 68
  case "$pattern" in
    proto-linux-x64) cp "$TEST_BINARY" "$output" ;;
    protofs-linux-x64) cp "$TEST_PROTOFS_BINARY" "$output" ;;
    libprotofs-linux-x64.so)
      [ "$TEST_LIBRARY_ACCESS" = present ] || exit 68
      cp "$TEST_PROTOFS_LIBRARY" "$output" ;;
    *) exit 68 ;;
  esac
else
  exit 69
fi
`,
	};
	for (const [name, content] of Object.entries(executables)) {
		const executable = dir.join("bin", name);
		await Bun.write(executable, content);
		await fs.chmod(executable, 0o755);
	}
	await Bun.write(dir.join("fixture-binary"), '#!/bin/sh\n[ "$1" = --version ] || exit 70\necho 20.0.1\n');
	await Bun.write(dir.join("fixture-protofs"), '#!/bin/sh\n[ "$1" = version ] || exit 70\necho "protofs test"\n');
	await Bun.write(dir.join("fixture-protofs-library"), "fixture libprotofs shared library\n");
	await Bun.write(dir.join("gh.log"), "");
	const child = Bun.spawn(
		["sh", path.join(import.meta.dir, "install.sh"), "--binary", ...(ref ? ["--ref", ref] : [])],
		{
			cwd: dir.path(),
			env: {
				...process.env,
				PATH: `${dir.join("bin")}${path.delimiter}${process.env.PATH}`,
				PI_INSTALL_DIR: dir.join("installed"),
				TEST_RELEASE_ACCESS: access,
				TEST_BINARY: dir.join("fixture-binary"),
				TEST_PROTOFS_BINARY: dir.join("fixture-protofs"),
				TEST_PROTOFS_LIBRARY: dir.join("fixture-protofs-library"),
				TEST_LIBRARY_ACCESS: library,
				TEST_GH_LOG: dir.join("gh.log"),
				TEST_API_SUFFIX: ref ? `tags/${ref}` : "latest",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr, ghLog: await Bun.file(dir.join("gh.log")).text() };
}

for (const scenario of [
	{ name: "public latest release installs without invoking authenticated GitHub", access: "public", ref: undefined },
	{ name: "private latest release uses authentication for metadata and binary", access: "private", ref: undefined },
	{ name: "private pinned release downloads the requested tag instead of latest", access: "private", ref: "v20.0.1" },
] as const) {
	test(scenario.name, async () => {
		using dir = TempDir.createSync("@proto-installer-");
		const result = await runInstaller(dir, scenario.access, scenario.ref);
		expect(result.exitCode, result.stderr).toBe(0);
		const installed = Bun.spawn([dir.join("installed/proto"), "--version"], { stdout: "pipe", stderr: "pipe" });
		expect(await new Response(installed.stdout).text()).toBe("20.0.1\n");
		expect(await installed.exited).toBe(0);
		const installedProtofs = Bun.spawn([dir.join("installed/protofs"), "version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await new Response(installedProtofs.stdout).text()).toBe("protofs test\n");
		expect(await installedProtofs.exited).toBe(0);
		expect(await Bun.file(dir.join("installed/libprotofs-linux-x64.so")).text()).toBe(
			"fixture libprotofs shared library\n",
		);
		if (scenario.access === "public") expect(result.ghLog).toBe("");
		else {
			expect(result.ghLog).toContain(
				`api repos/myanvoos/proto/releases/${scenario.ref ? `tags/${scenario.ref}` : "latest"}`,
			);
			expect(result.ghLog).toContain("release download v20.0.1 --repo myanvoos/proto --pattern proto-linux-x64");
			expect(result.ghLog).toContain("release download v20.0.1 --repo myanvoos/proto --pattern protofs-linux-x64");
			expect(result.ghLog).toContain(
				"release download v20.0.1 --repo myanvoos/proto --pattern libprotofs-linux-x64.so",
			);
		}
	});
}

test("a release without libprotofs still installs proto and warns instead of failing", async () => {
	using dir = TempDir.createSync("@proto-installer-");
	const result = await runInstaller(dir, "public", undefined, "missing");
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("libprotofs not available in this release");
	expect(await Bun.file(dir.join("installed/proto")).exists()).toBe(true);
	expect(await Bun.file(dir.join("installed/protofs")).exists()).toBe(true);
	expect(await Bun.file(dir.join("installed/libprotofs-linux-x64.so")).exists()).toBe(false);
});

test("inaccessible private release reports required access without installing a binary", async () => {
	using dir = TempDir.createSync("@proto-installer-");
	const result = await runInstaller(dir, "denied");
	expect(result.exitCode).not.toBe(0);
	expect(result.stdout).toContain("gh auth login");
	expect(result.stdout).toContain("repository access");
	expect(await Bun.file(dir.join("installed/proto")).exists()).toBe(false);
});
