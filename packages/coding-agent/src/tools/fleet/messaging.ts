import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage } from "../../irc/bus";
import type { Theme } from "../../modes/theme/theme";
import { type AgentRegistry, agentLifecycle, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../../tui";
import {
	createCachedComponent,
	formatBadge,
	formatErrorDetail,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
} from "../render-utils";
import { type FleetDetails, type FleetPeerInfo, type FleetRenderArgs, fleetErrorResult } from "./types";

export function isIrcEnabled(_settings: Settings, _taskDepth: number): boolean {
	return true;
}

function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	return `[${msg.id}] ${msg.from}${replyTag}: ${msg.body}`;
}

export function drainPendingInbox(
	registry: AgentRegistry,
	senderId: string,
	from?: string,
	fleetRoot?: string,
): IrcMessage | undefined {
	const session = fleetRoot ? registry.getInFleet(senderId, fleetRoot)?.session : registry.get(senderId)?.session;
	return typeof session?.drainPendingIrcInboxMessages === "function"
		? session.drainPendingIrcInboxMessages(senderId, { from, limit: 1 })[0]
		: undefined;
}

export async function executeList(
	registry: AgentRegistry,
	senderId: string,
	fleetRoot?: string,
): Promise<AgentToolResult<FleetDetails>> {
	let refs = registry.listInFleet(senderId, fleetRoot);
	if (!refs.some(ref => ref.id !== senderId && ref.status !== "aborted" && ref.kind !== "advisor")) {
		const { registerPersistedSubagents } = await import("../../registry/persisted-agents");
		const sender = fleetRoot ? registry.getInFleet(senderId, fleetRoot) : registry.get(senderId);
		await registerPersistedSubagents(registry, sender?.sessionFile);
		refs = registry.listInFleet(senderId, fleetRoot);
	}

	const bus = IrcBus.global();
	const peers: FleetPeerInfo[] = refs
		.filter(ref => ref.id !== senderId && ref.kind !== "advisor")
		.map(ref => ({
			id: ref.id,
			label: ref.label,
			kind: ref.kind,
			...agentLifecycle(ref.status),
			parentId: ref.parentId,
			unread: bus.unreadCount(ref.id, fleetRoot),
			lastActivity: ref.lastActivity,
			activity: ref.activity,
		}));
	const lines: string[] = [];
	if (peers.length === 0) {
		lines.push("No other agents.");
	} else {
		lines.push(`${peers.length} peer(s):`);
		for (const peer of peers) {
			const extras = [
				peer.activity || undefined,
				peer.unread > 0 ? `unread ${peer.unread}` : undefined,
				peer.parentId ? `parent ${peer.parentId}` : undefined,
				`active ${formatDuration(Date.now() - peer.lastActivity)} ago`,
			].filter(Boolean);
			lines.push(
				`- ${peer.id} [${peer.label} · ${peer.kind} · lifecycle=${peer.lifecycle} · turn=${peer.turnState}] — ${extras.join(", ")}`,
			);
		}
		if (peers.some(peer => peer.lifecycle === "parked")) {
			lines.push("");
			lines.push("Parked agents are revived automatically when you message them.");
		}
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "list", scope: "visible", senderId, peers },
	};
}

interface FleetMessageParams {
	to: string;
	message: string;
	replyTo?: string;
}

/** Peer communication: delivery receipts only; a delivered message never proves a turn started. */
export async function executeMessage(
	deps: { registry: AgentRegistry; senderId: string; fleetRoot?: string },
	params: FleetMessageParams,
): Promise<AgentToolResult<FleetDetails>> {
	const { registry, senderId, fleetRoot } = deps;
	const to = params.to.trim();
	const message = params.message.trim();
	if (to === senderId) {
		return fleetErrorResult("Cannot send a message to yourself.", { op: "message", senderId, to });
	}
	const isBroadcast = to === "all";
	const bus = IrcBus.global();
	const targets = isBroadcast ? registry.listVisibleTo(senderId, fleetRoot).map(ref => ref.id) : [to];
	const suppressRelay = isBroadcast && targets.includes(MAIN_AGENT_ID);
	const receipts = await Promise.all(
		targets.map(target =>
			bus.send(
				{ from: senderId, to: target, body: message, replyTo: params.replyTo },
				{ suppressRelay: suppressRelay || undefined, fleetRoot },
			),
		),
	);

	const lines: string[] = [];
	const accepted = receipts.filter(receipt => receipt.outcome === "delivered" || receipt.outcome === "queued");
	if (targets.length === 0) {
		lines.push("No live peers to broadcast to.");
	} else if (accepted.length === 0) {
		lines.push("No recipients accepted the message.");
	} else {
		const deliveredCount = accepted.filter(receipt => receipt.outcome === "delivered").length;
		const queuedCount = accepted.length - deliveredCount;
		lines.push(`Accepted by ${accepted.length} peer(s): ${deliveredCount} delivered, ${queuedCount} queued.`);
	}
	for (const receipt of receipts) {
		const effect =
			receipt.effect === "injected"
				? "; injected into an existing consumer; no worker turn was started"
				: receipt.effect === "wake_requested"
					? "; wake requested; turn start is not confirmed"
					: "";
		const revival = receipt.revived ? "; session revived" : "";
		const detail = receipt.error ? ` — ${receipt.error}` : "";
		lines.push(`- ${receipt.to}: ${receipt.outcome}${effect}${revival}${detail}`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "message", senderId, to, receipts },
		isError: accepted.length === 0 && targets.length > 0,
	};
}

export function executeInbox(
	registry: AgentRegistry,
	senderId: string,
	peek?: boolean,
	fleetRoot?: string,
): AgentToolResult<FleetDetails> {
	const busMessages = IrcBus.global().inbox(senderId, { peek, fleetRoot });
	const session = fleetRoot ? registry.getInFleet(senderId, fleetRoot)?.session : registry.get(senderId)?.session;
	const pendingMessages =
		typeof session?.drainPendingIrcInboxMessages === "function"
			? session.drainPendingIrcInboxMessages(senderId, peek ? { peek: true } : undefined)
			: [];
	const messages = [...busMessages, ...pendingMessages].sort((a, b) => a.ts - b.ts);
	if (messages.length === 0) {
		return {
			content: [{ type: "text", text: "Inbox empty." }],
			details: { op: "inbox", senderId, inbox: [] },

			useless: true,
		};
	}
	const header = peek ? `${messages.length} unread message(s):` : `${messages.length} message(s):`;
	const lines = [header, ...messages.map(msg => `- ${formatIncoming(msg)}`)];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "inbox", senderId, inbox: messages },
	};
}

const BODY_LINES_COLLAPSED = 2;
const BODY_LINE_WIDTH = 100;

const PEER_STATE_ORDER: Record<string, number> = { "live/running": 0, "live/idle": 1, "parked/idle": 2 };

function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}

function outcomeColor(outcome: IrcDeliveryReceipt["outcome"]): ToolUIColor {
	switch (outcome) {
		case "delivered":
			return "success";
		case "queued":
			return "warning";
		case "rejected":
		case "dropped":
			return "error";
	}
}

function peerStatusBadge(
	lifecycle: "live" | "parked" | "terminal",
	turnState: "running" | "idle" | undefined,
	theme: Theme,
): string {
	if (lifecycle === "terminal") return theme.fg("muted", `${theme.status.disabled} terminal`);
	if (lifecycle === "parked") return theme.fg("muted", `${theme.status.shadowed} parked/idle`);
	return turnState === "running"
		? theme.fg("accent", `${theme.status.running} live/running`)
		: theme.fg("success", `${theme.status.enabled} live/idle`);
}

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text?.trim() ?? "";
}

function bodyLines(
	body: string,
	expanded: boolean,
	theme: Theme,
	options: { indent?: string; tone?: "dim" | "toolOutput"; collapsedLines?: number } = {},
): string[] {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "toolOutput";
	const max = expanded ? Number.POSITIVE_INFINITY : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
	const total = body.split("\n").filter(line => line.trim()).length;
	const quote = theme.fg("dim", theme.md.quoteBorder);
	const lines = getPreviewLines(body, max, BODY_LINE_WIDTH, Ellipsis.Unicode).map(
		line => `${indent}${quote} ${theme.fg(tone, replaceTabs(sanitizeText(line)))}`,
	);
	const hidden = total - Math.min(total, max);
	if (hidden > 0) {
		lines.push(`${indent}${quote} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
	}
	return lines;
}

function callTitle(args: FleetRenderArgs | undefined, theme: Theme): string {
	switch (args?.op) {
		case "message":
			return `Fleet ${theme.nav.selected} ${sanitizeText(args.to?.trim() || "…")}`;
		case "inbox":
			return "Fleet inbox";
		case "list":
			return "Fleet peers";
		default:
			return "Fleet";
	}
}

function callMeta(args: FleetRenderArgs | undefined): string[] {
	const meta: string[] = [];
	if (args?.op === "message") {
		if (args.to === "all") meta.push("broadcast");
		if (args.replyTo) meta.push("reply");
	}
	if (args?.op === "inbox" && args.peek) meta.push("peek");
	return meta;
}

function renderErrorResult(
	result: { content: Array<{ type: string; text?: string }> },
	args: FleetRenderArgs | undefined,
	theme: Theme,
): string[] {
	const text = textContent(result) || "Fleet call failed.";
	return [
		renderStatusLine({ icon: "error", title: callTitle(args, theme), meta: callMeta(args) }, theme),
		...formatErrorDetail(text, theme).split("\n"),
	];
}

export function createIrcMessageCard(
	card: {
		kind: "incoming" | "autoreply" | "relay";
		from?: string;
		to?: string;
		body?: string;
		replyTo?: string;
		timestamp?: number;
	},
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const from = sanitizeText(card.from?.trim() || "?");
	const title =
		card.kind === "incoming"
			? `Fleet ${uiTheme.nav.back} ${from}`
			: card.kind === "autoreply"
				? `Fleet ${uiTheme.nav.selected} ${sanitizeText(card.to?.trim() || "?")}`
				: `Fleet ${from} ${uiTheme.nav.selected} ${sanitizeText(card.to?.trim() || "?")}`;
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
			if (body.trim()) {
				lines.push(...bodyLines(body, expanded, uiTheme, { indent: "  ", collapsedLines: 3 }));
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}

function renderMessageResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<FleetDetails>,
	args: FleetRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const receipts = details.receipts ?? [];
	const to = sanitizeText(details.to ?? args?.to?.trim() ?? "?");
	const title = `Fleet ${theme.nav.selected} ${to}`;

	if (receipts.length === 0) {
		const text = textContent(result) || (result.isError ? "Send failed." : "Nothing to deliver.");
		return [
			renderStatusLine({ icon: result.isError ? "error" : "warning", title }, theme),
			...(result.isError
				? formatErrorDetail(text, theme).split("\n")
				: [`  ${theme.fg("muted", replaceTabs(text))}`]),
		];
	}

	const accepted = receipts.filter(receipt => receipt.outcome === "delivered" || receipt.outcome === "queued");
	const failedCount = receipts.length - accepted.length;

	const meta: string[] = [];
	if (to === "all") meta.push("broadcast");
	if (receipts.length === 1) {
		const receipt = receipts[0]!;
		meta.push(theme.fg(outcomeColor(receipt.outcome), receipt.outcome));
		if (receipt.effect === "injected") meta.push(theme.fg("warning", "injected/no turn"));
		if (receipt.effect === "wake_requested") meta.push(theme.fg("warning", "wake requested/unconfirmed"));
		if (receipt.revived) meta.push(theme.fg("muted", "session revived"));
	} else {
		if (accepted.length > 0) meta.push(theme.fg("success", `${accepted.length} accepted`));
		if (failedCount > 0) meta.push(theme.fg("error", `${failedCount} failed`));
	}

	const icon = result.isError ? { icon: "error" as const } : { iconOverride: ircGlyph(theme) };
	const lines = [renderStatusLine({ ...icon, title, meta }, theme)];

	const sent = args?.message?.trim();
	if (sent) lines.push(...bodyLines(sent, expanded, theme, { indent: "  ", tone: "dim" }));

	if (receipts.length > 1 || failedCount > 0) {
		lines.push(
			...renderTreeList<IrcDeliveryReceipt>(
				{
					items: receipts,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "recipient",
					renderItem: receipt => {
						const badge = formatBadge(receipt.outcome, outcomeColor(receipt.outcome), theme);
						const effect = receipt.effect
							? ` ${theme.fg("warning", receipt.effect === "injected" ? "injected/no turn" : "wake requested/unconfirmed")}`
							: "";
						const revival = receipt.revived ? ` ${theme.fg("muted", "session revived")}` : "";
						const error =
							(receipt.outcome === "rejected" ||
								receipt.outcome === "dropped" ||
								receipt.outcome === "queued") &&
							receipt.error
								? ` ${theme.fg("error", `${theme.format.dash} ${sanitizeText(receipt.error)}`)}`
								: "";
						return `${theme.fg("toolOutput", sanitizeText(receipt.to))} ${badge}${effect}${revival}${error}`;
					},
				},
				theme,
			),
		);
	}

	return lines;
}

function renderInboxResult(
	details: Partial<FleetDetails>,
	args: FleetRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const messages = details.inbox ?? [];
	if (messages.length === 0) {
		return [renderStatusLine({ iconOverride: ircGlyph(theme), title: "Fleet inbox", meta: ["empty"] }, theme)];
	}
	const meta = [`${messages.length} ${messages.length === 1 ? "message" : "messages"}`];
	if (args?.peek) meta.push("peek");
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "Fleet inbox", meta }, theme);
	const items = renderTreeList<IrcMessage>(
		{
			items: messages,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "message",
			renderItem: msg => {
				const age = messageAge(msg.ts);
				const replyBadge = msg.replyTo ? ` ${formatBadge("reply", "muted", theme)}` : "";
				const head = `${theme.fg("accent", sanitizeText(msg.from))}${age ? ` ${theme.fg("dim", age)}` : ""}${replyBadge}`;
				return [head, ...bodyLines(msg.body, expanded, theme, { collapsedLines: 1 })];
			},
		},
		theme,
	);
	return [header, ...items];
}

function renderListResult(details: Partial<FleetDetails>, expanded: boolean, theme: Theme): string[] {
	const peers = [...(details.peers ?? [])].sort(
		(a, b) =>
			(PEER_STATE_ORDER[`${a.lifecycle}/${a.turnState ?? "idle"}`] ?? 9) -
				(PEER_STATE_ORDER[`${b.lifecycle}/${b.turnState ?? "idle"}`] ?? 9) || b.lastActivity - a.lastActivity,
	);
	if (peers.length === 0) {
		return [renderStatusLine({ icon: "info", title: "Fleet peers", meta: ["no other agents"] }, theme)];
	}
	const counts = new Map<string, number>();
	for (const peer of peers) counts.set(peer.lifecycle, (counts.get(peer.lifecycle) ?? 0) + 1);
	const meta = [...counts].map(([status, count]) => `${count} ${status}`);
	const unreadTotal = peers.reduce((sum, peer) => sum + peer.unread, 0);
	if (unreadTotal > 0) meta.push(theme.fg("warning", `${unreadTotal} unread`));
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "Fleet peers", meta }, theme);
	const items = renderTreeList(
		{
			items: peers,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "peer",
			renderItem: peer => {
				const kindText = peer.parentId
					? `${peer.kind}${theme.sep.dot}of ${sanitizeText(peer.parentId)}`
					: peer.kind;
				const unread = peer.unread > 0 ? ` ${formatBadge(`${peer.unread} unread`, "warning", theme)}` : "";
				const age = messageAge(peer.lastActivity);
				const activity = peer.activity ? ` ${theme.fg("dim", replaceTabs(sanitizeText(peer.activity)))}` : "";
				const name = theme.fg("dim", replaceTabs(sanitizeText(peer.label)));
				return `${peerStatusBadge(peer.lifecycle, peer.turnState, theme)} ${theme.bold(replaceTabs(sanitizeText(peer.id)))} ${name} ${theme.fg("dim", kindText)}${activity}${unread}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			},
		},
		theme,
	);
	return [header, ...items];
}

function buildResultLines(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<FleetDetails>,
	args: FleetRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	switch (details.op ?? args?.op) {
		case "message":
			return renderMessageResult(result, details, args, expanded, theme);
		case "inbox":
			return result.isError
				? renderErrorResult(result, args, theme)
				: renderInboxResult(details, args, expanded, theme);
		case "list":
			return result.isError ? renderErrorResult(result, args, theme) : renderListResult(details, expanded, theme);
		default: {
			const text = textContent(result) || (result.isError ? "Fleet call failed." : "Done.");
			return [
				renderStatusLine({ icon: result.isError ? "error" : "success", title: callTitle(args, theme) }, theme),
				...(result.isError
					? formatErrorDetail(text, theme).split("\n")
					: [`  ${theme.fg("muted", replaceTabs(text))}`]),
			];
		}
	}
}

export function messagingRenderCall(args: FleetRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
	const lines = [
		renderStatusLine({ icon: "pending", title: callTitle(args, uiTheme), meta: callMeta(args) }, uiTheme),
	];
	if (args?.op === "message" && args.message?.trim()) {
		lines.push(...bodyLines(args.message, false, uiTheme, { indent: "  ", tone: "dim", collapsedLines: 1 }));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function messagingRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: FleetDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
	args?: FleetRenderArgs,
): Component {
	const details: Partial<FleetDetails> = result.details ?? {};
	return createCachedComponent(
		() => options.expanded,
		(width, expanded) =>
			buildResultLines(result, details, args, expanded, uiTheme).map(line =>
				truncateToWidth(line, width, Ellipsis.Unicode),
			),
	);
}
