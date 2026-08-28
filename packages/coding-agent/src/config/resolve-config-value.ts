import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact } from "@oh-my-pi/pi-utils";

const commandResultCache = new Map<string, string>();

const commandInFlight = new Map<string, Promise<string | undefined>>();

export async function resolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) {
		return await executeCommand(config);
	}
	const envValue = $envExact(config);
	return envValue || config;
}

async function executeCommand(commandConfig: string): Promise<string | undefined> {
	const cached = commandResultCache.get(commandConfig);
	if (cached !== undefined) {
		return cached;
	}

	const existing = commandInFlight.get(commandConfig);
	if (existing) {
		return await existing;
	}

	const command = commandConfig.slice(1);
	const promise = runShellCommand(command, 10_000)
		.then(result => {
			if (result !== undefined) {
				commandResultCache.set(commandConfig, result);
			}
			return result;
		})
		.finally(() => {
			commandInFlight.delete(commandConfig);
		});

	commandInFlight.set(commandConfig, promise);
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number): Promise<string | undefined> {
	try {
		let output = "";
		const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
			if (!err) {
				output += chunk;
			}
		});
		if (result.timedOut || result.exitCode !== 0) {
			return undefined;
		}
		const trimmed = output.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}
