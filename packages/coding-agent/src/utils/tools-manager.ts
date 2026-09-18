import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$which,
	atomicWriteFileWith,
	getToolsDir,
	isEnoent,
	logger,
	ptree,
	TempDir,
	USER_AGENT,
} from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";

const TOOLS_DIR = getToolsDir();
const TOOL_DOWNLOAD_TIMEOUT_MS = 120_000;
const TOOL_METADATA_TIMEOUT_MS = 5000;

type BodyReadResult = Bun.ReadableStreamDefaultReadResult<Uint8Array>;
type BodyReader = {
	read(): Promise<BodyReadResult>;
	cancel(reason?: unknown): Promise<void>;
};

function isAbortLikeError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function readBodyChunk(reader: BodyReader, signal: AbortSignal | undefined): Promise<BodyReadResult> {
	if (!signal) return await reader.read();
	if (signal.aborted) throw abortReason(signal);

	const abort = Promise.withResolvers<BodyReadResult>();
	const onAbort = () => abort.reject(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([reader.read(), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function writeResponseBody(
	dest: string,
	body: NonNullable<Response["body"]>,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const sink = Bun.file(dest).writer();
	let completed = false;

	try {
		while (true) {
			const { done, value } = await readBodyChunk(reader, signal);
			if (done) break;
			if (value) {
				await sink.write(value);
			}
		}
		await sink.end();
		completed = true;
	} finally {
		if (!completed) {
			await reader.cancel().catch(() => {});
			await Promise.resolve(sink.end()).catch(() => {});
			await fs.promises.rm(dest, { force: true }).catch(() => {});
		}
	}
}

interface ToolConfig {
	name: string;
	repo: string;
	binaryName: string;
	tagPrefix: string;
	isDirectBinary?: boolean;
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	sd: {
		name: "sd",
		repo: "chmln/sd",
		binaryName: "sd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
			}
			return null;
		},
	},
	sg: {
		name: "ast-grep",
		repo: "ast-grep/ast-grep",
		binaryName: "sg",
		tagPrefix: "",
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-apple-darwin.zip`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-unknown-linux-gnu.zip`;
			}
			return null;
		},
	},
	"yt-dlp": {
		name: "yt-dlp",
		repo: "yt-dlp/yt-dlp",
		binaryName: "yt-dlp",
		tagPrefix: "",
		isDirectBinary: true,
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				return "yt-dlp_macos";
			} else if (plat === "linux") {
				return architecture === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
			}
			return null;
		},
	},
};

interface PythonPackageToolConfig {
	name: string;
	package: string;
	binaryName: string;
}

const PYTHON_TOOLS: Record<string, PythonPackageToolConfig> = {
	trafilatura: {
		name: "trafilatura",
		package: "trafilatura",
		binaryName: "trafilatura",
	},
};

export type ToolName = "sd" | "sg" | "yt-dlp" | "trafilatura";

function getToolPath(tool: ToolName): string | null {
	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		return $which(pythonConfig.binaryName);
	}

	const config = TOOLS[tool];
	if (!config) return null;

	const localPath = path.join(TOOLS_DIR, config.binaryName);
	if (fs.existsSync(localPath)) {
		return localPath;
	}

	return $which(config.binaryName);
}

async function getLatestVersion(repo: string, signal?: AbortSignal): Promise<string> {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { "User-Agent": USER_AGENT },
			signal: ptree.combineSignals(signal, TOOL_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error("GitHub API request timed out");
		}
		throw err;
	}

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

export async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
	const downloadSignal = ptree.combineSignals(signal, TOOL_DOWNLOAD_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			signal: downloadSignal,
		});
		if (!response.ok) {
			throw new Error(`Failed to download: ${response.status}`);
		} else if (!response.body) {
			throw new Error("No response body");
		}
		await writeResponseBody(dest, response.body, downloadSignal);
	} catch (err) {
		if (isAbortLikeError(err)) {
			throw new Error(`Download timed out: ${url}`);
		}
		throw err;
	}
}

async function validateDownloadedFile(filePath: string, label: string): Promise<void> {
	const stat = await fs.promises.stat(filePath);
	if (!stat.isFile() || stat.size === 0) {
		throw new Error(`Downloaded ${label} is not a non-empty regular file`);
	}
}

async function downloadTool(tool: ToolName, signal?: AbortSignal): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = os.platform();
	const architecture = os.arch();

	const version = await getLatestVersion(config.repo, signal);

	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const binaryPath = path.join(TOOLS_DIR, config.binaryName);

	if (config.isDirectBinary) {
		await atomicWriteFileWith(
			binaryPath,
			async tempPath => {
				await downloadFile(downloadUrl, tempPath, signal);
				await validateDownloadedFile(tempPath, assetName);
			},
			{ mode: 0o755 },
		);
		return binaryPath;
	}

	const tmp = await TempDir.create("@proto-tools-extract-");
	const archivePath = path.join(tmp.path(), assetName);
	const extractDir = path.join(tmp.path(), "extract");

	try {
		if (!assetName.endsWith(".tar.gz") && !assetName.endsWith(".zip")) {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		await downloadFile(downloadUrl, archivePath, signal);
		await validateDownloadedFile(archivePath, assetName);
		try {
			await extractArchive(archivePath, extractDir);
		} catch (err) {
			throw new Error(`Failed to extract ${assetName}: ${err instanceof Error ? err.message : String(err)}`);
		}

		const extractedBinary =
			tool === "sg"
				? path.join(extractDir, config.binaryName)
				: path.join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""), config.binaryName);
		try {
			await validateDownloadedFile(extractedBinary, config.binaryName);
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Binary not found in archive: ${extractedBinary}`);
			throw error;
		}

		await atomicWriteFileWith(
			binaryPath,
			async tempPath => {
				await fs.promises.copyFile(extractedBinary, tempPath);
				await validateDownloadedFile(tempPath, config.binaryName);
			},
			{ mode: 0o755 },
		);
	} finally {
		await tmp.remove();
	}

	return binaryPath;
}

async function installPythonPackage(pkg: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const uv = $which("uv");
		if (uv) {
			const result = await ptree.exec([uv, "tool", "install", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			if (result.exitCode === 0) return true;
		}

		const pip = $which("pip3") || $which("pip");
		if (pip) {
			const result = await ptree.exec([pip, "install", "--user", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			return result.exitCode === 0;
		}

		return false;
	} catch (error) {
		logger.warn(`Failed to install Python package ${pkg}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

const TERMUX_PACKAGES: Partial<Record<ToolName, string>> = {
	sd: "sd",
	sg: "ast-grep",
};

type EnsureToolOptions = {
	signal?: AbortSignal;
	silent?: boolean;
	notify?: (message: string) => void;
};

const toolInstallations = new Map<ToolName, Promise<string | undefined>>();

export async function ensureTool(tool: ToolName, options?: EnsureToolOptions): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) return existingPath;

	const pending = toolInstallations.get(tool);
	if (pending) return await pending;

	const installation = ensureToolOnce(tool, options);
	toolInstallations.set(tool, installation);
	try {
		return await installation;
	} finally {
		if (toolInstallations.get(tool) === installation) {
			toolInstallations.delete(tool);
		}
	}
}

async function ensureToolOnce(tool: ToolName, silentOrOptions?: EnsureToolOptions): Promise<string | undefined> {
	const { signal, silent = false, notify } = silentOrOptions ?? {};
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	if (os.platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			logger.warn(`${TOOLS[tool]?.name ?? tool} not found. Install with: pkg install ${pkgName}`);
		}
		return undefined;
	}

	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		if (!silent) {
			logger.debug(`${pythonConfig.name} not found. Installing via uv/pip...`);
		}
		notify?.(`Installing ${pythonConfig.name}…`);
		const success = await installPythonPackage(pythonConfig.package, signal);
		if (success) {
			const path = $which(pythonConfig.binaryName);
			if (path) {
				if (!silent) {
					logger.debug(`${pythonConfig.name} installed successfully`);
				}
				return path;
			}
		}
		if (!silent) {
			logger.warn(`Failed to install ${pythonConfig.name}`);
		}
		return undefined;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (!silent) {
		logger.debug(`${config.name} not found. Downloading...`);
	}
	notify?.(`Downloading ${config.name}…`);

	try {
		const path = await downloadTool(tool, signal);
		if (!silent) {
			logger.debug(`${config.name} installed to ${path}`);
		}
		return path;
	} catch (e) {
		if (!silent) {
			logger.warn(`Failed to download ${config.name}`, {
				error: e instanceof Error ? e.message : String(e),
			});
		}
		return undefined;
	}
}
