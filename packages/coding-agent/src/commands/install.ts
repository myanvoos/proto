import { existsSync } from "node:fs";
import * as path from "node:path";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { installHelp as commandHelp } from "../cli/command-help";
import { type PluginAction, type PluginCommandArgs, runPluginCommand } from "../cli/plugin-cli";
import { initTheme } from "../modes/theme/theme";

export function looksLikeLocalPath(target: string, cwd?: string): boolean {
	if (target.startsWith(".") || target.startsWith("/") || target.startsWith("~")) return true;

	if (/^[a-zA-Z]:[\\/]/.test(target)) return true;

	try {
		return existsSync(cwd ? path.resolve(cwd, target) : path.resolve(target));
	} catch {
		return false;
	}
}

export default class Install extends Command {
	static description = commandHelp.description;
	static args = {
		targets: Args.string({
			description: "Local path, npm spec, or marketplace ref (e.g. ./my-ext, my-pkg@1.2.3, name@marketplace)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		force: Flags.boolean({ description: "Force install" }),
		"dry-run": Flags.boolean({ description: "Show actions without applying changes" }),
		scope: Flags.string({
			description: 'Install scope: "user" (default) or "project" (marketplace installs only)',
			options: ["user", "project"],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Install);
		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];

		if (targets.length === 0) {
			process.stderr.write("Usage: proto install <path | npm-spec | name@marketplace> [...]\n");
			process.exit(1);
		}

		await initTheme();

		const localPaths: string[] = [];
		const remoteSpecs: string[] = [];
		for (const target of targets) {
			if (looksLikeLocalPath(target)) localPaths.push(target);
			else remoteSpecs.push(target);
		}

		const baseFlags: PluginCommandArgs["flags"] = {
			json: flags.json,
			force: flags.force,
			dryRun: flags["dry-run"],
			scope: flags.scope as "user" | "project" | undefined,
		};

		for (const localPath of localPaths) {
			await runPluginCommand({
				action: "link" satisfies PluginAction,
				args: [localPath],
				flags: baseFlags,
			});
		}

		if (remoteSpecs.length > 0) {
			await runPluginCommand({
				action: "install" satisfies PluginAction,
				args: remoteSpecs,
				flags: baseFlags,
			});
		}
	}
}
