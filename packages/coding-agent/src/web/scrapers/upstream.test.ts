import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { gzipSync } from "node:zlib";
import * as ptree from "@oh-my-pi/pi-utils/ptree";
import * as settingsModule from "../../config/settings";
import * as toolsManager from "../../utils/tools-manager";
import { gunzipRustdocJsonAsync } from "./docs-rs";
import { handleGitHub } from "./github";
import { handleGitLab } from "./gitlab";
import { handleReadTheDocs } from "./readthedocs";
import * as types from "./types";
import { handleYouTube } from "./youtube";

afterEach(() => vi.restoreAllMocks());

test("GitHub issues and comments from deleted users render with ghost attribution", async () => {
	const issue = {
		title: "Retained issue",
		number: 1,
		state: "open",
		user: null,
		created_at: "2026-01-01",
		updated_at: "2026-01-02",
		body: "Issue body",
		labels: [],
		comments: 1,
	};
	spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | Request | URL) =>
				Response.json(
					String(input).includes("/comments")
						? [{ user: null, body: "Comment body", created_at: "2026-01-02" }]
						: String(input).includes("?state=")
							? [issue]
							: issue,
				),
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const result = await handleGitHub("https://github.com/example/repo/issues/1", 1);
	expect(result?.content).toContain("opened by @ghost");
	expect(result?.content).toContain("### @ghost");
	expect(result?.content).toContain("Comment body");
	const list = await handleGitHub("https://github.com/example/repo/issues", 1);
	expect(list?.content).toContain("by @ghost");
});

test("GitHub repository metadata, HEAD tree and README start together", async () => {
	const requests: string[] = [];
	const pending = Promise.withResolvers<void>();
	spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | Request | URL) => {
				const url = String(input);
				requests.push(url);
				if (requests.length === 3) pending.resolve();
				await pending.promise;
				return Response.json(
					url.includes("/git/trees/")
						? { tree: [{ path: "src/main.ts", type: "blob" }] }
						: url.endsWith("/readme")
							? { encoding: "base64", content: Buffer.from("Repository README").toString("base64") }
							: { full_name: "example/repo", stargazers_count: 1, forks_count: 0, open_issues_count: 0 },
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const result = await handleGitHub("https://github.com/example/repo", 1);
	expect(requests.some(url => url.includes("/git/trees/HEAD?"))).toBe(true);
	expect(result?.content).toContain("src/main.ts");
	expect(result?.content).toContain("Repository README");
});

test("GitLab merge request descriptions resolve markdown instead of stringifying a Promise", async () => {
	spyOn(types, "loadPage").mockImplementation(async url => ({
		ok: true,
		finalUrl: url,
		contentType: "application/json",
		content: url.endsWith("/merge_requests/1")
			? JSON.stringify({
					title: "MR",
					description: "<p>Rendered <strong>description</strong></p>",
					state: "opened",
					author: { name: "Author", username: "author" },
					created_at: "2026-01-01",
					updated_at: "2026-01-02",
					source_branch: "feature",
					target_branch: "main",
					labels: [],
				})
			: JSON.stringify({ id: 42 }),
	}));
	const result = await handleGitLab("https://gitlab.com/example/repo/-/merge_requests/1", 1);
	expect(result?.content).toContain("Rendered **description**");
	expect(result?.content).not.toContain("[object Promise]");
});

test("versioned ReadTheDocs never substitutes another branch's raw source", async () => {
	const requests: string[] = [];
	spyOn(types, "loadPage").mockImplementation(async url => {
		requests.push(url);
		return {
			ok: true,
			finalUrl: "https://project.readthedocs.io/en/v1.0/api/",
			contentType: "text/html",
			content:
				'<html><body><main><p>Version one API</p><a href="https://github.com/example/repo/blob/main/api.rst">Edit source</a></main></body></html>',
		};
	});
	const result = await handleReadTheDocs("https://project.readthedocs.io/en/v1.0/api/", 1);
	expect(requests).toHaveLength(1);
	expect(result?.content).toContain("Version one API");
	expect(result?.notes.join(" ")).toContain("does not match documentation version v1.0");
	expect(result?.contentType).toBe("text/html");
});

test("ReadTheDocs failed matching raw fetch preserves HTML content type", async () => {
	spyOn(types, "loadPage").mockImplementation(async url =>
		url.includes("github.com")
			? { ok: false, content: "not found", finalUrl: url, contentType: "text/plain", status: 404 }
			: {
					ok: true,
					finalUrl: url,
					contentType: "text/html",
					content:
						'<html><body><main><p>Published docs</p><a href="https://github.com/example/repo/blob/v1.0/api.rst">Edit source</a></main></body></html>',
				},
	);
	const result = await handleReadTheDocs("https://project.readthedocs.io/en/v1.0/api/", 1);
	expect(result?.content).toContain("Published docs");
	expect(result?.contentType).toBe("text/html");
});

test("rustdoc decompression is asynchronous and rejects output above its cap", async () => {
	const source = JSON.stringify({ docs: "x".repeat(1000) });
	const compressed = gzipSync(source);
	expect(await gunzipRustdocJsonAsync(compressed, 2048)).toBe(source);
	await expect(gunzipRustdocJsonAsync(compressed, 100)).rejects.toThrow();
});

test("YouTube metadata survives manual-caption transfer failure and still requests automatic captions", async () => {
	// The scraper reads the process settings singleton. Keep initialization in a child
	// so this regression cannot replace the settings of later test files.
	if (process.env.PROTO_YOUTUBE_TEST_CHILD !== "1") {
		const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "YouTube metadata"], {
			env: { ...process.env, PROTO_YOUTUBE_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (exitCode !== 0) throw new Error(stderr);
		expect(exitCode).toBe(0);
		return;
	}
	await settingsModule.Settings.init({ inMemory: true, overrides: { "providers.fetch": "native" } });
	spyOn(toolsManager, "ensureTool").mockResolvedValue("/test/yt-dlp");
	const commands: string[][] = [];
	spyOn(ptree, "exec").mockImplementation(async command => {
		commands.push(command);
		return {
			ok: false,
			exitCode: 1,
			stderr: "caption unavailable",
			stdout:
				commands.length === 1
					? JSON.stringify({
							title: "Metadata survives",
							automatic_captions: { en: [] },
							subtitles: { en: [] },
							duration: 60,
						})
					: "",
		};
	});
	const result = await handleYouTube("https://www.youtube.com/watch?v=abcdefghijk", 1);
	expect(result?.content).toContain("Metadata survives");
	expect(result?.content).toContain("1:00");
	expect(commands[0]).toContain("--dump-json");
	expect(commands[0]).toContain("--write-sub");
	expect(commands[0]).toContain("--no-simulate");
	expect(commands).toHaveLength(2);
	expect(commands[1]).toContain("--write-auto-sub");
});
