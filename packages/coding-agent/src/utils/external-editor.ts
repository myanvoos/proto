import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, Snowflake } from "@oh-my-pi/pi-utils";

export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	return undefined;
}

interface OpenInEditorOptions {
	extension?: string;

	trimTrailingNewline?: boolean;
}

function resolveEditorSpawnCommand(editorCmd: string, tmpFile: string): string[] {
	return [$which("sh") ?? "sh", "-c", `${editorCmd} "$1"`, "sh", tmpFile];
}

export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `proto-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const cmd = resolveEditorSpawnCommand(editorCmd, tmpFile);

		const child = Bun.spawn(cmd, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const exitCode = await child.exited;
		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {}
	}
}
