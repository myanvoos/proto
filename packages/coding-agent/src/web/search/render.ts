import type { Component } from "@oh-my-pi/pi-tui";
import { Markdown, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { getMarkdownTheme, type Theme } from "../../modes/theme/theme";
import {
	formatAge,
	formatCount,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getDomain,
	PREVIEW_LIMITS,
	replaceTabs,
	truncateToWidth,
} from "../../tools/render-utils";
import { renderStatusLine, renderTreeList, urlHyperlink } from "../../tui";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../../tui/output-block";
import { getSearchProviderLabel } from "./provider";
import { mergeSearchReferences, type SearchConstraintApplication, type SearchResponse } from "./types";

const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function renderFallbackText(contentText: string, expanded: boolean, theme: Theme): Component {
	const lines = sanitizeText(contentText)
		.split("\n")
		.filter(line => line.trim());
	const maxLines = expanded ? lines.length : 6;
	const displayLines = lines.slice(0, maxLines).map(line => truncateToWidth(line.trim(), 110));
	const remaining = lines.length - displayLines.length;

	const headerIcon = formatStatusIcon("warning", theme);
	const expandHint = formatExpandHint(theme, expanded, remaining > 0);
	let text = `${headerIcon} ${theme.fg("dim", "Response")}${expandHint}`;

	if (displayLines.length === 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "No response data")}`;
		return new Text(text, 0, 0);
	}

	for (let i = 0; i < displayLines.length; i++) {
		const isLast = i === displayLines.length - 1 && remaining === 0;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("dim", displayLines[i])}`;
	}

	if (!expanded && remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, "line"))}`;
	}

	return new Text(text, 0, 0);
}

export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

export function stripSearchReferenceSections(answer: string): string {
	const lines = answer.split("\n");
	const kept: string[] = [];
	let skipping = false;
	let fenceMarker: string | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		// CommonMark: fences open with up to three spaces of indentation and
		// close only with a same-character run at least as long as the opener
		// followed by nothing but whitespace.
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			const rest = fenceMatch[2] ?? "";
			if (fenceMarker === undefined) {
				fenceMarker = marker;
			} else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length && rest.trim() === "") {
				fenceMarker = undefined;
			}
			if (!skipping) kept.push(line);
			continue;
		}
		const heading = fenceMarker === undefined && /^#{1,6}\s+(sources|citations)(?:\s*[:(].*)?\s*$/i.test(trimmed);
		if (heading) {
			skipping = true;
			continue;
		}
		if (skipping && fenceMarker === undefined && /^#{1,6}\s+\S/.test(trimmed)) skipping = false;
		if (!skipping) kept.push(line);
	}
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function formatSearchResultCount(sourceCount: number, requestedResultCount?: number): string {
	const count = formatCount("source", sourceCount);
	return requestedResultCount !== undefined && sourceCount < requestedResultCount
		? `${count} (provider returned ${sourceCount} of ${requestedResultCount} requested)`
		: count;
}

function formatConstraintApplication(application: SearchConstraintApplication): string {
	if (application.mode === "native") {
		return `${application.operator} (native${application.detail ? ` ${application.detail}` : ""})`;
	}
	if (application.mode === "unsupported") return `${application.operator} (unsupported→relaxed)`;
	return `${application.operator} (post-filtered)`;
}

export function formatConstraintLine(applications: readonly SearchConstraintApplication[]): string | undefined {
	if (applications.length === 0) return undefined;
	const relaxed = applications
		.filter(application => application.mode !== "unsupported" && application.relaxed)
		.map(application => `relaxed ${application.operator}, no results matched`);
	const suffix = relaxed.length > 0 ? `; ${relaxed.join("; ")}` : "";
	return `Constraints: ${applications.map(formatConstraintApplication).join(", ")}${suffix}`;
}

function renderSearchErrorPanel(message: string, providerLabel: string | undefined, theme: Theme): Component {
	const header = renderStatusLine({ icon: "error", title: "Web Search", description: providerLabel }, theme);
	const body = theme.fg("error", `Error: ${replaceTabs(message)}`);
	const outputBlock = new CachedOutputBlock();
	return markFramedBlockComponent({
		render(width: number): readonly string[] {
			return outputBlock.render({ header, state: "error", sections: [{ lines: [body] }], width }, theme);
		},
		invalidate() {
			outputBlock.invalidate();
		},
	});
}

export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;

	if (details?.error) {
		const errorProvider = details.response?.provider;
		const errorProviderLabel =
			errorProvider && errorProvider !== "none" ? getSearchProviderLabel(errorProvider) : undefined;
		return renderSearchErrorPanel(sanitizeText(details.error), errorProviderLabel, theme);
	}

	const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
	const rawResponse = details?.response;
	if (!rawResponse) {
		return renderFallbackText(rawText, options.expanded, theme);
	}

	const response = mergeSearchReferences(rawResponse);
	const sources = Array.isArray(response.sources) ? response.sources : [];
	const sourceCount = sources.length;
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const provider = response.provider;

	const hasReferences = sources.length > 0 || (response.citations?.length ?? 0) > 0;
	const answerText =
		typeof response.answer === "string"
			? hasReferences
				? stripSearchReferenceSections(response.answer)
				: response.answer.trim()
			: "";
	const contentText = answerText || rawText;

	const providerLabel = provider !== "none" ? getSearchProviderLabel(provider) : "None";
	const rawQuery = args?.query ?? searchQueries[0];
	const queryPreview = rawQuery ? truncateToWidth(sanitizeText(rawQuery), 80) : undefined;
	// An answer with zero sources is still a successful call; only missing
	// renderable content warrants the warning treatment.
	const success = sourceCount > 0 || Boolean(contentText.trim());
	const header = renderStatusLine(
		success
			? {
					iconOverride: theme.styledSymbol("tool.webSearch", "accent"),
					title: "Web Search",
					description: providerLabel,
					meta: [formatSearchResultCount(sourceCount, response.requestedResultCount)],
				}
			: {
					icon: "warning",
					title: "Web Search",
					description: providerLabel,
					meta: [formatSearchResultCount(sourceCount, response.requestedResultCount)],
				},
		theme,
	);

	const authShort =
		response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API" : response.authMode;
	let providerInfo = response.model ? `${sanitizeText(response.model)} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const metaLines: string[] = [`${theme.fg("muted", "Provider:")} ${theme.fg("text", providerInfo)}`];
	const constraintLine = response.constraintApplications
		? formatConstraintLine(response.constraintApplications)
		: undefined;
	if (constraintLine) metaLines.push(theme.fg("muted", sanitizeText(constraintLine)));
	if (response.usage) {
		const usageParts: string[] = [];
		if (response.usage.inputTokens !== undefined) usageParts.push(`in ${response.usage.inputTokens}`);
		if (response.usage.outputTokens !== undefined) usageParts.push(`out ${response.usage.outputTokens}`);
		if (response.usage.totalTokens !== undefined) usageParts.push(`total ${response.usage.totalTokens}`);
		if (response.usage.searchRequests !== undefined) usageParts.push(`search ${response.usage.searchRequests}`);
		if (usageParts.length > 0)
			metaLines.push(`${theme.fg("muted", "Usage:")} ${theme.fg("text", usageParts.join(theme.sep.dot))}`);
	}

	const answerMarkdown = contentText ? new Markdown(contentText, 0, 0, getMarkdownTheme()) : undefined;
	const outputBlock = new CachedOutputBlock();

	return markFramedBlockComponent({
		render(width: number): readonly string[] {
			const { expanded } = options;

			const answerWidth = outputBlockContentWidth(width);
			const renderedAnswer = answerMarkdown ? answerMarkdown.render(answerWidth) : [];
			let answerLines: readonly string[];
			if (renderedAnswer.length === 0) {
				answerLines = [theme.fg("muted", "No answer text returned")];
			} else if (args?.maxAnswerLines !== undefined && !expanded) {
				const capped = renderedAnswer.slice(0, args.maxAnswerLines);
				const remaining = renderedAnswer.length - capped.length;
				if (remaining > 0) {
					capped.push(theme.fg("muted", formatMoreItems(remaining, "line")));
				}
				answerLines = capped;
			} else {
				answerLines = renderedAnswer;
			}

			const sourceTree = renderTreeList(
				{
					items: sources,
					expanded,
					maxCollapsed: MAX_COLLAPSED_ITEMS,
					itemType: "source",
					renderItem: src => {
						const rawTitle =
							typeof src.title === "string" && src.title.trim()
								? src.title
								: typeof src.url === "string" && src.url.trim()
									? src.url
									: "Untitled";
						const titleText = sanitizeText(rawTitle);
						const url = typeof src.url === "string" ? src.url : "";
						const domain = url ? getDomain(url) : "";
						const age =
							formatAge(src.ageSeconds) ||
							(typeof src.publishedDate === "string" ? sanitizeText(src.publishedDate) : "");
						const metaParts: string[] = [];
						if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
						if (age) metaParts.push(theme.fg("muted", age));
						const metaSep = theme.fg("dim", theme.sep.dot);
						const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";

						const lineBudget = Math.max(24, width - 6);
						const titleBudget = Math.max(12, lineBudget - Bun.stringWidth(metaSuffix));
						const title = theme.fg("accent", truncateToWidth(titleText, titleBudget));
						const linkedTitle = url ? urlHyperlink(url, title) : title;
						return [`${linkedTitle}${metaSuffix}`];
					},
				},
				theme,
			);

			return outputBlock.render(
				{
					header,
					state: success ? "success" : "warning",
					sections: [
						...(queryPreview
							? [
									{
										lines: [`${theme.fg("muted", "Query:")} ${theme.fg("text", queryPreview)}`],
									},
								]
							: []),
						{
							label: theme.fg("toolTitle", "Answer"),
							lines: answerLines,
						},
						{
							label: theme.fg("toolTitle", "Sources"),
							lines: sourceTree.length > 0 ? sourceTree : [theme.fg("muted", "No sources returned")],
						},
						{ label: theme.fg("toolTitle", "Metadata"), lines: metaLines },
					],
					width,
				},
				theme,
			);
		},
		invalidate() {
			outputBlock.invalidate();
		},
	});
}

export function renderSearchCall(
	args: { query?: string; [key: string]: unknown },
	_options: RenderResultOptions,
	theme: Theme,
): Component {
	const query = truncateToWidth(sanitizeText(args.query ?? ""), 80);
	const text = renderStatusLine({ icon: "pending", title: "Web Search", description: query }, theme);
	return new Text(text, 0, 0);
}

export const webSearchToolRenderer = {
	renderCall: renderSearchCall,
	renderResult: renderSearchResult,
	mergeCallAndResult: true,
};
