import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils/which";
import type { TerminalId, TerminalNotification } from "./terminal-capabilities";

const APP_NAME = "Proto";

export type DesktopNotifierKind = "notify-send" | "gdbus";

export interface DesktopNotifier {
	kind: DesktopNotifierKind;
	path: string;
}

export function hasLinuxDesktopSession(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
	fileExists: (path: string) => boolean = fs.existsSync,
): boolean {
	if (platform !== "linux") return false;
	if (env.DBUS_SESSION_BUS_ADDRESS) return true;
	const runtimeDir = env.XDG_RUNTIME_DIR;
	return Boolean(runtimeDir && fileExists(path.join(runtimeDir, "bus")));
}

export function shouldDeliverDesktopNotification(
	terminalId: TerminalId,
	notifyProtocolIsBell: boolean,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	if (!notifyProtocolIsBell) return false;
	// Terminals with native notification handling (VS Code) must not get a
	// duplicate desktop toast on top of their own bell handling.
	if (terminalId === "vscode") return false;
	if (!hasLinuxDesktopSession(platform, env)) return false;
	if (env.PI_NO_DESKTOP_NOTIFY === "1") return false;
	return true;
}

let cachedNotifier: DesktopNotifier | null | undefined;

export function resetDesktopNotifierCache(): void {
	cachedNotifier = undefined;
}

export function resolveDesktopNotifier(): DesktopNotifier | null {
	if (cachedNotifier !== undefined) return cachedNotifier;
	const notifySend = $which("notify-send");
	if (notifySend) {
		cachedNotifier = { kind: "notify-send", path: notifySend };
		return cachedNotifier;
	}
	const gdbus = $which("gdbus");
	if (gdbus) {
		cachedNotifier = { kind: "gdbus", path: gdbus };
		return cachedNotifier;
	}
	cachedNotifier = null;
	return null;
}

interface ResolvedNotificationFields {
	title: string;
	body: string;
	urgency: "low" | "normal" | "critical";
	expiresMs: number;
}

const DEFAULT_NOTIFICATION_EXPIRES_MS = 5000;

function resolveFields(message: string | TerminalNotification): ResolvedNotificationFields {
	if (typeof message === "string") {
		return { title: APP_NAME, body: message, urgency: "normal", expiresMs: DEFAULT_NOTIFICATION_EXPIRES_MS };
	}
	const title = message.title?.trim() || APP_NAME;
	const body = message.body ?? "";
	const urgency = message.urgency === "critical" || message.urgency === "low" ? message.urgency : "normal";
	const rawExpiresMs = typeof message.expiresMs === "number" ? Math.round(message.expiresMs) : Number.NaN;
	const expiresMs = Number.isFinite(rawExpiresMs) && rawExpiresMs > 0 ? rawExpiresMs : DEFAULT_NOTIFICATION_EXPIRES_MS;
	return { title, body, urgency, expiresMs };
}

const URGENCY_BYTE: Record<ResolvedNotificationFields["urgency"], number> = {
	low: 0,
	normal: 1,
	critical: 2,
};

export function buildDesktopNotifyCommand(notifier: DesktopNotifier, message: string | TerminalNotification): string[] {
	const { title, body, urgency, expiresMs } = resolveFields(message);
	if (notifier.kind === "notify-send") {
		return [notifier.path, "--app-name", APP_NAME, `--urgency=${urgency}`, `--expire-time=${expiresMs}`, title, body];
	}
	const hints = `{"urgency": <byte ${URGENCY_BYTE[urgency]}>}`;
	return [
		notifier.path,
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.Notify",
		APP_NAME,
		"0",
		"",
		title,
		body,
		"[]",
		hints,
		String(expiresMs),
	];
}

export function sendDesktopNotification(message: string | TerminalNotification): void {
	const notifier = resolveDesktopNotifier();
	if (!notifier) return;
	try {
		const child = Bun.spawn({
			cmd: buildDesktopNotifyCommand(notifier, message),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
	} catch {}
}
