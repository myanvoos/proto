import type { type as ArkType } from "@oh-my-pi/omptype";
import type * as zod from "@oh-my-pi/omptype/zod";
import type { ExecOptions, ExecResult, HookCommandContext } from "../../extensibility/hooks/types";
import type * as PiCodingAgent from "../../index";

export type { ExecOptions, ExecResult, HookCommandContext };

export interface CustomCommandAPI {
	cwd: string;

	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	arktype: typeof ArkType & { type: typeof ArkType };

	zod: typeof zod;

	pi: typeof PiCodingAgent;
}

export interface CustomCommand {
	name: string;

	description: string;

	execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> | string | undefined;
}

export type CustomCommandFactory = (
	api: CustomCommandAPI,
) => CustomCommand | CustomCommand[] | Promise<CustomCommand | CustomCommand[]>;

export type CustomCommandSource = "bundled" | "user" | "project";

export interface LoadedCustomCommand {
	path: string;

	resolvedPath: string;

	command: CustomCommand;

	source: CustomCommandSource;
}

export interface CustomCommandsLoadResult {
	commands: LoadedCustomCommand[];
	errors: Array<{ path: string; error: string }>;
}
