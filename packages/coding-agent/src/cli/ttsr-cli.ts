import * as fs from "node:fs";
import * as path from "node:path";
import { FileType, type GlobMatch, glob } from "@oh-my-pi/pi-natives";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../capability/rule";
import { bucketRules } from "../capability/rule-buckets";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { TtsrSettings } from "../config/settings-schema";
import { initializeWithSettings, loadCapability } from "../discovery";
import { buildRuleFromMarkdown, createSourceMeta } from "../discovery/helpers";
import { TtsrManager, type TtsrMatch } from "../export/ttsr";
import {
	compileLegacyProgram,
	compileMatchProgram,
	type JudgeFn,
	type MatchProgram,
	mayMatch,
} from "../export/ttsr-matcher";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { createTtsrJudge } from "../session/ttsr-judge";

type TtsrAction = "test" | "list" | "scan";

export const TTSR_ACTIONS: TtsrAction[] = ["test", "list", "scan"];
export const TTSR_SOURCES: TtsrMatchSource[] = ["text", "thinking", "tool"];

export type TtsrMatchSource = "text" | "thinking" | "tool";

interface TtsrMatchContext {
	source: TtsrMatchSource;
	toolName?: string;
	filePaths?: string[];
	streamKey?: string;
	cwd?: string;
	judge?: JudgeFn;
	settled?: boolean;
}

export interface TtsrTestArgs {
	snippet?: string;
	file?: string;
	rule?: string;
	source?: TtsrMatchSource;
	tool?: string;
	filePath?: string;
	verbose?: boolean;
	llm?: boolean;
}

export interface TtsrScanArgs {
	directory?: string;
	rule?: string;
	gitignore?: boolean;
	maxBytes?: number;
	verbose?: boolean;
}

export interface TtsrCommandArgs {
	action: TtsrAction;
	test?: TtsrTestArgs;
	scan?: TtsrScanArgs;
	json?: boolean;
}

interface RuleMatchDetail {
	name: string;
	path: string;
	sourceProvider?: string;
	description: string;
	snippets: { line: number; text: string }[];
}

interface RuleCompileError {
	name: string;
	path: string;
	error: string;
}

interface TestReport {
	source: TtsrMatchSource;
	tool?: string;
	filePath?: string;
	snippetPreview: string;
	snippetBytes: number;
	evaluated: number;
	triggered: RuleMatchDetail[];
	notTriggered: RuleMatchDetail[];
	compileErrors: RuleCompileError[];
	inferenceNote?: string;
}

const STDIN_MARKER = "-";

const SOURCE_FILE_EXT =
	/^\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|cc|cpp|h|hpp|rb|php|lua|css|scss|html|json|ya?ml|toml|md|mdc|cs|razor|cshtml|fs|fsx|vb|sh|bash|sql|zig|dart|scala|ex|exs|proto|tf)$/i;

const BINARY_PROBE_BYTES = 8192;
const DEFAULT_MAX_SCAN_BYTES = 5 * 1024 * 1024;

type ReadSkipReason = "binary" | "large" | "unreadable";

interface ScanSkipSummary {
	binary: number;
	large: number;
	unreadable: number;
	noRelevantRules: number;
}

interface ScanFileCandidate {
	path: string;
	size?: number;
}

async function readSnippet(opts: { snippet?: string; file?: string }): Promise<string> {
	if (opts.file) {
		if (opts.file === STDIN_MARKER) {
			return await Bun.stdin.text();
		}
		const resolved = path.resolve(opts.file);
		const file = Bun.file(resolved);
		if (!(await file.exists())) {
			throw new Error(`Snippet file not found: ${resolved}`);
		}
		return await file.text();
	}
	if (opts.snippet !== undefined) return opts.snippet;
	if (process.stdin.isTTY === false) return await Bun.stdin.text();
	throw new Error("No snippet provided. Pass inline text, --file <path>, or pipe via --file -.");
}

function previewSnippet(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > 80 ? `${single.slice(0, 77)}…` : single;
}

function createTtsrManager(settings?: TtsrSettings): TtsrManager {
	return new TtsrManager(settings);
}

/** `--llm` opts into real model calls; without it `llm:` conditions stay unresolved and report nothing. */
async function loadJudge(cwd: string): Promise<JudgeFn> {
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage();
	const registry = new ModelRegistry(authStorage);
	await loadCliExtensionProviders(registry, settings, cwd);
	return createTtsrJudge({ settings, registry, sessionId: () => "ttsr-cli" });
}

function filterTtsrRules(
	rules: readonly Rule[],
	options: { builtinRules?: boolean; disabledRules?: readonly string[] } = {},
): Rule[] {
	const includeBuiltin = options.builtinRules !== false;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}
	return rules.filter(rule => {
		if (disabled.has(rule.name)) return false;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return false;
		return (
			rule.match !== undefined ||
			(rule.condition && rule.condition.length > 0) ||
			(rule.astCondition && rule.astCondition.length > 0)
		);
	});
}

async function loadProjectTtsrRules(cwd: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	const manager = createTtsrManager(ttsrSettings);
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	const rules = filterTtsrRules(result.items, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	// Keep normal rule bucketing semantics, then register structured-only rules
	// that the legacy bucket predicate cannot see.
	bucketRules(rules, manager, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	for (const rule of rules) manager.addRule(rule);
	return { rules, manager };
}

async function loadProjectScanRules(cwd: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	const manager = createTtsrManager(ttsrSettings);
	if (!ttsrSettings.enabled) return { rules: [], manager };
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	const rules = filterTtsrRules(result.items, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	bucketRules(rules, manager, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	for (const rule of rules) manager.addRule(rule);
	return { rules, manager };
}

function compileRule(rule: Rule): { program?: MatchProgram; errors: string[] } {
	return rule.match !== undefined
		? compileMatchProgram(rule.match, rule.name)
		: compileLegacyProgram(rule.condition, rule.astCondition);
}

function compileErrorsFor(rules: readonly Rule[]): RuleCompileError[] {
	const errors: RuleCompileError[] = [];
	for (const rule of rules) {
		for (const error of compileRule(rule).errors) errors.push({ name: rule.name, path: rule.path, error });
	}
	return errors;
}

function detailFor(match: TtsrMatch, program: MatchProgram): RuleMatchDetail {
	return {
		name: match.rule.name,
		path: match.rule.path,
		sourceProvider: match.rule._source?.provider,
		description: program.description,
		snippets: match.evidence.snippets,
	};
}

async function readIsolatedRule(rulePath: string): Promise<Rule> {
	const resolved = path.resolve(rulePath);
	const file = Bun.file(resolved);
	if (!(await file.exists())) {
		throw new Error(`Rule file not found: ${resolved}`);
	}
	const content = await file.text();
	const name = path.basename(resolved).replace(/\.(md|mdc)$/, "");
	return buildRuleFromMarkdown(name, content, resolved, createSourceMeta("ttsr-cli", resolved, "project"), {
		ruleName: name,
	});
}

async function loadIsolatedRule(rulePath: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const rule = await readIsolatedRule(rulePath);
	const manager = createTtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		builtinRules: true,
		disabledRules: [],
	});
	manager.addRule(rule);
	return { rules: [rule], manager };
}

async function loadIsolatedScanRule(rulePath: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const rule = await readIsolatedRule(rulePath);
	const manager = createTtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		builtinRules: true,
		disabledRules: [],
	});
	manager.addRule(rule);
	return { rules: filterTtsrRules([rule]), manager };
}

async function runTest(args: TtsrTestArgs, json: boolean, cwd: string): Promise<void> {
	if (args.source && !TTSR_SOURCES.includes(args.source)) {
		throw new Error(`Invalid --source: ${args.source}. Expected one of: ${TTSR_SOURCES.join(", ")}`);
	}

	const snippet = await readSnippet(args);
	const filePath = args.filePath ?? (args.file && args.file !== STDIN_MARKER ? path.resolve(args.file) : undefined);
	const source: TtsrMatchSource =
		args.source ?? (filePath && SOURCE_FILE_EXT.test(path.extname(filePath)) ? "tool" : "text");
	const tool = args.tool ?? (source === "tool" ? "bash" : undefined);
	const inferenceNote =
		!args.source && filePath && source === "text"
			? `inferred --source text from '${path.extname(filePath) || filePath}' (not in the source-file extension set); pass --source tool --tool bash to evaluate tool-scoped rules`
			: undefined;
	const context: TtsrMatchContext = {
		source,
		toolName: tool,
		filePaths: filePath ? [filePath] : undefined,
		cwd,
		judge: args.llm ? await loadJudge(cwd) : undefined,
		settled: true,
	};
	const loaded = args.rule ? await loadIsolatedRule(args.rule) : await loadProjectTtsrRules(cwd);
	const entries = loaded.manager.getEntries();
	const compileErrors = compileErrorsFor(loaded.rules);
	if (entries.length === 0 && compileErrors.length === 0) {
		const msg = args.rule
			? "Rule registered but produced no TTSR entry."
			: "No TTSR rules registered for this project. Add a `condition`, `astCondition`, or `match` to a rule file, then re-run.";
		if (json) process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		else process.stderr.write(`${chalk.yellow(msg)}\n`);
		process.exitCode = 1;
		return;
	}

	const syncMatches = loaded.manager.checkSnapshot(snippet, context);
	const asyncMatches = entries.some(entry => entry.program.needsAst || entry.program.needsJudge)
		? await loaded.manager.checkAsyncSnapshot(snippet, context)
		: [];
	const matchesByName = new Map<string, TtsrMatch>();
	for (const match of [...syncMatches, ...asyncMatches]) matchesByName.set(match.rule.name, match);
	const entriesByName = new Map(entries.map(entry => [entry.rule.name, entry]));
	const triggered: RuleMatchDetail[] = [];
	const notTriggered: RuleMatchDetail[] = [];
	for (const entry of entries) {
		const match = matchesByName.get(entry.rule.name);
		if (match) triggered.push(detailFor(match, entry.program));
		else {
			notTriggered.push({
				name: entry.rule.name,
				path: entry.rule.path,
				sourceProvider: entry.rule._source?.provider,
				description: entry.program.description,
				snippets: [],
			});
		}
	}
	// Keep this lookup explicit so a future manager result cannot introduce an
	// unregistered rule without making the CLI's report malformed.
	for (const match of matchesByName.values())
		if (!entriesByName.has(match.rule.name)) matchesByName.delete(match.rule.name);

	const report: TestReport = {
		source,
		tool,
		filePath,
		snippetPreview: previewSnippet(snippet),
		snippetBytes: snippet.length,
		evaluated: entries.length,
		triggered,
		notTriggered,
		compileErrors,
		inferenceNote,
	};
	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	renderTestReport(report, args.verbose ?? false, args.rule !== undefined);
}

function renderTestReport(report: TestReport, verbose: boolean, isolated: boolean): void {
	const ctxLabel = report.source === "tool" ? `tool:${report.tool ?? "?"}` : report.source;
	const pathLabel = report.filePath ? ` path=${report.filePath}` : "";
	process.stdout.write(
		`${chalk.bold("TTSR test")} — source=${chalk.cyan(ctxLabel)}${pathLabel} snippet=${chalk.dim(`${report.snippetBytes}b`)}\n`,
	);
	process.stdout.write(`${chalk.dim(`  "${report.snippetPreview}"`)}\n\n`);
	if (report.inferenceNote) process.stdout.write(`${chalk.yellow(`note: ${report.inferenceNote}`)}\n\n`);
	if (report.compileErrors.length > 0) {
		process.stdout.write(`${chalk.yellow(`Condition errors (${report.compileErrors.length})`)}\n`);
		for (const error of report.compileErrors) process.stdout.write(`  ${chalk.red(error.name)}: ${error.error}\n`);
		process.stdout.write("\n");
	}
	if (report.triggered.length === 0)
		process.stdout.write(`${chalk.red("No rules triggered.")} (evaluated ${report.evaluated})\n`);
	else {
		process.stdout.write(`${chalk.green.bold(`Triggered (${report.triggered.length})`)}\n`);
		for (const detail of report.triggered) renderRuleDetail(detail, true);
	}
	if (verbose && report.notTriggered.length > 0) {
		process.stdout.write(`\n${chalk.dim(`Not triggered (${report.notTriggered.length})`)}\n`);
		for (const detail of report.notTriggered) renderRuleDetail(detail, false);
	}
	if (isolated && report.triggered.length === 0) process.exitCode = 1;
}

function renderRuleDetail(detail: RuleMatchDetail, hit: boolean): void {
	const mark = hit ? chalk.green("✓") : chalk.red("✗");
	const provider = detail.sourceProvider ? chalk.dim(` [${detail.sourceProvider}]`) : "";
	process.stdout.write(
		`  ${mark} ${chalk.bold(detail.name)}  condition: ${chalk.yellow(detail.description)}${provider}\n`,
	);
	for (const snippet of detail.snippets)
		process.stdout.write(`    ${chalk.cyan(`L${snippet.line}:`)} ${snippet.text}\n`);
}

async function runList(json: boolean, cwd: string): Promise<void> {
	const loaded = await loadProjectTtsrRules(cwd);
	const entriesByName = new Map(loaded.manager.getEntries().map(entry => [entry.rule.name, entry]));
	const compileErrors = compileErrorsFor(loaded.rules);
	const rows = loaded.rules.map(rule => ({
		name: rule.name,
		path: rule.path,
		provider: rule._source?.provider,
		condition: entriesByName.get(rule.name)?.program.description,
		conditionErrors: compileErrors.filter(error => error.name === rule.name).map(error => error.error),
		scope: rule.scope ?? [],
		globs: rule.globs ?? [],
		description: rule.description,
	}));
	if (json) {
		process.stdout.write(`${JSON.stringify(rows)}\n`);
		return;
	}
	if (rows.length === 0) {
		process.stdout.write(`${chalk.yellow("No TTSR rules registered for this project.")}\n`);
		return;
	}
	process.stdout.write(`${chalk.bold(`TTSR rules (${rows.length})`)}\n`);
	for (const row of rows) {
		const provider = row.provider ? chalk.dim(` [${row.provider}]`) : "";
		const condition = row.condition ? chalk.yellow(row.condition) : chalk.red("invalid condition");
		const scope = row.scope.length > 0 ? `  scope: ${row.scope.join(", ")}` : "";
		const globs = row.globs.length > 0 ? `  globs: ${row.globs.join(", ")}` : "";
		process.stdout.write(`  ${chalk.bold(row.name)}${provider}  condition: ${condition}${scope}${globs}\n`);
		for (const error of row.conditionErrors) process.stdout.write(`    ${chalk.red(`error: ${error}`)}\n`);
		if (row.description) process.stdout.write(`${chalk.dim(`    ${row.description}`)}\n`);
	}
}

function isWithinDirectory(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function discoverScanFiles(scanDir: string, cwd: string, gitignore: boolean): Promise<ScanFileCandidate[]> {
	const globRoot = isWithinDirectory(scanDir, cwd) ? cwd : scanDir;
	const relativeScanDir = path.relative(globRoot, scanDir).replaceAll("\\", "/");
	const pattern = relativeScanDir === "" ? "**/*" : `${relativeScanDir}/**/*`;
	try {
		const result = await glob({
			pattern,
			path: globRoot,
			gitignore,
			hidden: true,
			fileType: FileType.File,
		});
		const candidates: ScanFileCandidate[] = [];
		for (const match of result.matches as GlobMatch[]) {
			const absPath = path.resolve(globRoot, match.path);
			const filePath = path.relative(scanDir, absPath).replaceAll("\\", "/");
			if (
				filePath.length === 0 ||
				filePath.startsWith("..") ||
				path.isAbsolute(filePath) ||
				filePath === ".git" ||
				filePath.startsWith(".git/")
			) {
				continue;
			}
			candidates.push({ path: filePath, size: match.size });
		}
		candidates.sort((a, b) => a.path.localeCompare(b.path));
		return candidates;
	} catch {
		return [];
	}
}

async function readScanFileText(
	absPath: string,
	maxBytes: number,
	knownSize: number | undefined,
): Promise<{ content: string } | { skip: ReadSkipReason }> {
	const file = Bun.file(absPath);
	try {
		const fileSize = knownSize ?? file.size;
		if (maxBytes > 0 && fileSize > maxBytes) {
			return { skip: "large" };
		}
		const probeBytes = Math.min(fileSize, BINARY_PROBE_BYTES);
		if (probeBytes > 0) {
			const prefix = new Uint8Array(await file.slice(0, probeBytes).arrayBuffer());
			if (prefix.includes(0)) {
				return { skip: "binary" };
			}
		}
		return { content: await file.text() };
	} catch {
		return { skip: "unreadable" };
	}
}

function countSkipped(skipped: ScanSkipSummary): number {
	return skipped.binary + skipped.large + skipped.unreadable + skipped.noRelevantRules;
}

async function runScan(args: TtsrScanArgs, json: boolean, cwd: string): Promise<void> {
	const scanDir = args.directory ? path.resolve(cwd, args.directory) : cwd;
	if (!(await fs.promises.stat(scanDir).catch(() => undefined))) {
		const error = `Directory not found: ${scanDir}`;
		if (json) process.stdout.write(`${JSON.stringify({ error })}\n`);
		else process.stderr.write(`${chalk.red(`error: ${error}`)}\n`);
		process.exitCode = 1;
		return;
	}

	const loaded = args.rule ? await loadIsolatedScanRule(args.rule) : await loadProjectScanRules(cwd);
	const entries = loaded.manager.getEntries();
	const compileErrors = compileErrorsFor(loaded.rules);
	if (entries.length === 0 && compileErrors.length === 0) {
		const msg = args.rule
			? "Rule registered but produced no TTSR entry."
			: "No TTSR rules registered for this project.";
		if (json) process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		else process.stderr.write(`${chalk.yellow(msg)}\n`);
		process.exitCode = 1;
		return;
	}

	const gitignore = args.gitignore ?? true;
	const maxBytes = Math.max(0, args.maxBytes ?? DEFAULT_MAX_SCAN_BYTES);
	const includeDetails = json || (args.verbose ?? false);
	const files = await discoverScanFiles(scanDir, cwd, gitignore);
	const emptySkipped: ScanSkipSummary = { binary: 0, large: 0, unreadable: 0, noRelevantRules: 0 };
	if (files.length === 0) {
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ files: [], errors: compileErrors, summary: { totalFiles: 0, scannedFiles: 0, matchedFiles: 0, totalMatches: 0, evaluatedRules: entries.length, skippedFiles: 0, skipped: emptySkipped, gitignore, maxBytes } })}\n`,
			);
		} else {
			for (const error of compileErrors)
				process.stdout.write(`${chalk.red(`condition error: ${error.name}: ${error.error}`)}\n`);
			process.stdout.write(`${chalk.yellow(`No files found to scan in ${scanDir}`)}\n`);
		}
		return;
	}

	const fileResults: Array<{ file: string; matches: RuleMatchDetail[] }> = [];
	const skipped: ScanSkipSummary = { binary: 0, large: 0, unreadable: 0, noRelevantRules: 0 };
	let scannedFiles = 0;
	let matchedFiles = 0;
	let totalMatches = 0;

	for (const candidate of files) {
		const file = candidate.path;
		const absPath = path.resolve(scanDir, file);
		const relToProj = path.relative(cwd, absPath).replaceAll("\\", "/");
		const filePaths = [absPath.replaceAll("\\", "/")];
		const readResult = await readScanFileText(absPath, maxBytes, candidate.size);
		if ("skip" in readResult) {
			skipped[readResult.skip]++;
			continue;
		}
		const content = readResult.content;
		const potential = entries.filter(entry => mayMatch(entry.program, content));
		if (potential.length === 0) {
			skipped.noRelevantRules++;
			continue;
		}
		scannedFiles++;
		const context: TtsrMatchContext = {
			source: "tool",
			toolName: "bash",
			filePaths,
			streamKey: `ttsr-scan:${absPath}`,
			cwd,
			settled: true,
		};
		const syncMatches = loaded.manager.checkSnapshot(content, context);
		// Scans never judge: `llm:` leaves stay unresolved without a judge, so a
		// judge-gated rule simply reports nothing rather than costing a model call
		// per file.
		const asyncMatches = potential.some(entry => entry.program.needsAst)
			? await loaded.manager.checkAsyncSnapshot(content, context)
			: [];
		const matchesByName = new Map<string, TtsrMatch>();
		for (const match of [...syncMatches, ...asyncMatches]) matchesByName.set(match.rule.name, match);
		const matches = entries
			.filter(entry => matchesByName.has(entry.rule.name))
			.map(entry => detailFor(matchesByName.get(entry.rule.name)!, entry.program));
		if (matches.length === 0) continue;
		matchedFiles++;
		totalMatches += matches.length;
		if (includeDetails) fileResults.push({ file: relToProj, matches });
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				files: fileResults.map(fr => ({
					filePath: fr.file,
					matches: fr.matches.map(match => ({
						name: match.name,
						path: match.path,
						condition: match.description,
						snippets: match.snippets,
					})),
				})),
				errors: compileErrors,
				summary: {
					totalFiles: files.length,
					scannedFiles,
					matchedFiles,
					totalMatches,
					evaluatedRules: entries.length,
					skippedFiles: countSkipped(skipped),
					skipped,
					gitignore,
					maxBytes,
				},
			})}\n`,
		);
		return;
	}
	process.stdout.write(
		`${chalk.bold("TTSR scan")} — directory=${chalk.cyan(scanDir)} files=${chalk.dim(files.length)} scanned=${chalk.dim(scannedFiles)} rules=${chalk.dim(entries.length)} gitignore=${chalk.dim(gitignore ? "on" : "off")} max-bytes=${chalk.dim(maxBytes === 0 ? "off" : String(maxBytes))}\n`,
	);
	for (const error of compileErrors)
		process.stdout.write(`${chalk.red(`condition error: ${error.name}: ${error.error}`)}\n`);
	if (countSkipped(skipped) > 0)
		process.stdout.write(
			`${chalk.dim(`  skipped: binary=${skipped.binary} large=${skipped.large} unreadable=${skipped.unreadable} no-relevant-rules=${skipped.noRelevantRules}`)}\n`,
		);
	if (matchedFiles === 0) {
		process.stdout.write(
			`${chalk.green.bold("No rule matches found.")} (evaluated ${loaded.rules.length} rules on ${scannedFiles}/${files.length} files)\n`,
		);
		return;
	}
	process.stdout.write(
		`${chalk.red.bold("Found violations/matches:")} (${totalMatches} matches across ${matchedFiles} files)\n`,
	);
	if (!includeDetails) {
		process.stdout.write(
			`${chalk.dim("  rerun with --verbose to list matched files, conditions, and evidence snippets")}\n`,
		);
		return;
	}
	process.stdout.write("\n");
	for (const result of fileResults) {
		process.stdout.write(`${chalk.bold.underline(result.file)}\n`);
		for (const detail of result.matches) renderRuleDetail(detail, true);
		process.stdout.write("\n");
	}
}

export async function runTtsrCommand(cmd: TtsrCommandArgs): Promise<void> {
	if (process.stdout.listenerCount("error") === 0) {
		process.stdout.on("error", error => {
			if (error instanceof Error && "code" in error && error.code === "EPIPE") process.exit(0);
		});
	}
	const cwd = getProjectDir();
	if (cmd.action === "test") {
		if (!cmd.test) {
			process.stderr.write(`${chalk.red("error: `ttsr test` requires a snippet, --file, or piped stdin")}\n`);
			process.exit(1);
		}
		await runTest(cmd.test, cmd.json ?? false, cwd);
		return;
	}
	if (cmd.action === "list") {
		await runList(cmd.json ?? false, cwd);
		return;
	}
	if (cmd.action === "scan") {
		if (!cmd.scan) {
			process.stderr.write(`${chalk.red("error: scan arguments missing")}\n`);
			process.exit(1);
		}
		await runScan(cmd.scan, cmd.json ?? false, cwd);
		return;
	}
	process.stderr.write(`${chalk.red(`error: unknown ttsr action: ${cmd.action}`)}\n`);
	process.exit(1);
}
