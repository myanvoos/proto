import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as utils from "@oh-my-pi/pi-utils";
import * as ptree from "@oh-my-pi/pi-utils/ptree";
import { ensureTool } from "./tools-manager";

afterEach(() => vi.restoreAllMocks());

test("pre-aborted missing Python tools do not start an installer", async () => {
	spyOn(utils, "$which").mockReturnValue(null);
	const exec = spyOn(ptree, "exec");
	const result = await ensureTool("trafilatura", { silent: true, signal: AbortSignal.abort() });
	expect(result).toBeUndefined();
	expect(exec).not.toHaveBeenCalled();
});

test("cancelling uv installation does not fall through to pip", async () => {
	const controller = new AbortController();
	spyOn(utils, "$which").mockImplementation(command => (command === "trafilatura" ? null : `/fake/${command}`));
	const commands: string[][] = [];
	spyOn(ptree, "exec").mockImplementation(async command => {
		commands.push(command);
		controller.abort();
		return { stdout: "", stderr: "cancelled", exitCode: null, ok: false };
	});
	const result = await ensureTool("trafilatura", { silent: true, signal: controller.signal });
	expect(result).toBeUndefined();
	expect(commands).toEqual([["/fake/uv", "tool", "install", "trafilatura"]]);
});
