import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../../lsp/types";

interface BiomeJsonOutput {
	diagnostics: BiomeDiagnostic[];
}

interface BiomeDiagnostic {
	category: string;
	severity: string;
	message: string;
	location?: {
		path?: string;
		start?: { line: number; column: number };
		end?: { line: number; column: number };
	};
}

function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
			return 3;
		case "hint":
			return 4;
		default:
			return 2;
	}
}

async function runBiome(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "biome";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			signal,
		});

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		signal?.throwIfAborted();

		return { stdout, stderr, success: exitCode === 0 };
	} catch (err) {
		if (signal?.aborted) throw err;
		return { stdout: "", stderr: String(err), success: false };
	}
}

const reportedBiomeFailures = new Set<string>();

function warnBiomeOnce(key: string, message: string, meta: Record<string, unknown>): void {
	if (reportedBiomeFailures.has(key)) return;
	reportedBiomeFailures.add(key);
	logger.warn(message, meta);
}

export class BiomeClient implements LinterClient {
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new BiomeClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async format(filePath: string, content: string): Promise<string> {
		await Bun.write(filePath, content);

		const result = await runBiome(["format", "--write", filePath], this.cwd, this.config.resolvedCommand);

		if (result.success) {
			return await Bun.file(filePath).text();
		}

		return content;
	}

	async lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]> {
		const result = await runBiome(
			["lint", "--reporter=json", filePath],
			this.cwd,
			this.config.resolvedCommand,
			signal,
		);

		if (!result.success && result.stdout.trim().length === 0) {
			warnBiomeOnce(`run:${this.cwd}`, "Biome lint failed; reporting no diagnostics", {
				cwd: this.cwd,
				stderr: result.stderr.slice(0, 500),
			});
			return [];
		}

		return this.#parseJsonOutput(result.stdout, filePath);
	}

	#parseJsonOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
		let parsed: BiomeJsonOutput;
		try {
			parsed = JSON.parse(jsonOutput);
		} catch {
			warnBiomeOnce(`parse:${this.cwd}`, "Failed to parse Biome JSON output; reporting no diagnostics", {
				cwd: this.cwd,
				file: targetFile,
			});
			return [];
		}

		const emitted = parsed.diagnostics ?? [];
		const target = path.resolve(targetFile);
		const diagnostics: Diagnostic[] = [];

		let sawUsableLocation = false;

		for (const diag of emitted) {
			const location = diag.location;
			const filePath = location?.path;
			if (!filePath) continue;
			sawUsableLocation = true;

			const diagFile = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);

			if (path.resolve(diagFile) !== target) continue;

			const start = location.start;
			const end = location.end ?? start;
			const startLine = start?.line ?? 1;
			const startColumn = start?.column ?? 1;
			const endLine = end?.line ?? startLine;
			const endColumn = end?.column ?? startColumn;

			diagnostics.push({
				range: {
					start: { line: startLine - 1, character: startColumn - 1 },
					end: { line: endLine - 1, character: endColumn - 1 },
				},
				severity: parseSeverity(diag.severity),
				message: diag.message,
				source: "biome",
				code: diag.category,
			});
		}

		if (emitted.length > 0 && !sawUsableLocation) {
			warnBiomeOnce(
				`schema:${this.cwd}`,
				"Biome diagnostics had no recognizable location; reporter schema may have changed",
				{ cwd: this.cwd, file: targetFile, count: emitted.length },
			);
		}

		return diagnostics;
	}

	dispose(): void {}
}
