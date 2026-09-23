import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import type {
	ResponseFileSearchToolCall,
	ResponseFunctionWebSearch,
} from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { obfuscateMessages, obfuscateNativeReplay } from "./message-transform";
import { SecretObfuscator } from "./obfuscator";

describe("native replay secret obfuscation", () => {
	it("scrubs native plaintext and tool data without rewriting encrypted or structural fields", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
		]);
		const stale = obfuscator.obfuscate("OTHERSECRET");
		const image = { type: "input_image", image_url: `data:image/png;base64,${stale}`, detail: "auto" };
		const file = { type: "input_file", file_id: stale, file_data: stale };
		const compactionItem = { type: "compaction_summary", summary: stale, encrypted_content: stale };
		const items: Array<Record<string, unknown>> = [
			{ type: "message", role: "user", id: stale, content: [{ type: "input_text", text: stale }, image, file] },
			{
				type: "message",
				role: "assistant",
				phase: "final_answer",
				content: [
					{ type: "output_text", text: stale, annotations: [{ type: "file_citation", file_id: stale }] },
					{ type: "refusal", refusal: stale },
				],
			},
			{
				type: "reasoning",
				id: stale,
				encrypted_content: stale,
				summary: [{ type: "summary_text", text: stale }],
				content: [{ type: "reasoning_text", text: stale }],
			},
			{
				type: "function_call",
				call_id: stale,
				name: stale,
				arguments: JSON.stringify({ nested: [stale], [stale]: 1 }),
				encrypted_function_args: [],
			},
			{ type: "function_call", call_id: "structured", name: "search", arguments: { nested: { query: stale } } },
			{ type: "function_call_output", call_id: stale, output: [{ type: "input_text", text: stale }, image, file] },
			{ type: "custom_tool_call", call_id: stale, name: "apply_patch", input: stale },
			{ type: "custom_tool_call_output", call_id: stale, output: stale },
			{
				type: "function_call",
				call_id: "encrypted",
				name: "collaborate",
				arguments: stale,
				encrypted_function_args: [stale],
			},
			{
				type: "shell_call_output",
				call_id: "shell",
				output: [{ stdout: stale, stderr: stale, outcome: { type: "exit", exit_code: 1 } }],
			},
			{
				type: "computer_call",
				call_id: "computer",
				actions: [
					{ type: "type", text: stale },
					{ type: "keypress", keys: ["ENTER"] },
				],
			},
			compactionItem,
		];
		const original = {
			providerPayload: { type: "openaiResponsesHistory" as const, provider: "openai-codex", dt: true, items },
			preserveData: {
				openaiRemoteCompaction: { provider: "openai-codex", replacementHistory: items, compactionItem },
				extension: { text: stale },
			},
		};
		const collisions = new Set(["tok_abc123"]);
		const redacted = obfuscator.obfuscate(stale, collisions);
		expect(redacted).not.toContain("TOKABC123_");
		const scrubbed = obfuscateNativeReplay(obfuscator, original, collisions);
		expect(scrubbed.providerPayload.items).toEqual([
			{ ...items[0], content: [{ type: "input_text", text: redacted }, image, file] },
			{
				...items[1],
				content: [
					{ type: "output_text", text: redacted, annotations: [{ type: "file_citation", file_id: stale }] },
					{ type: "refusal", refusal: redacted },
				],
			},
			{
				...items[2],
				summary: [{ type: "summary_text", text: redacted }],
				content: [{ type: "reasoning_text", text: redacted }],
			},
			{ ...items[3], arguments: JSON.stringify({ nested: [redacted], [stale]: 1 }) },
			{ ...items[4], arguments: { nested: { query: redacted } } },
			{ ...items[5], output: [{ type: "input_text", text: redacted }, image, file] },
			{ ...items[6], input: redacted },
			{ ...items[7], output: redacted },
			items[8],
			{ ...items[9], output: [{ stdout: redacted, stderr: redacted, outcome: { type: "exit", exit_code: 1 } }] },
			{
				...items[10],
				actions: [
					{ type: "type", text: redacted },
					{ type: "keypress", keys: ["ENTER"] },
				],
			},
			{ ...compactionItem, summary: redacted },
		]);
		expect(scrubbed.preserveData.openaiRemoteCompaction.replacementHistory).toBe(scrubbed.providerPayload.items);
		expect(scrubbed.preserveData.openaiRemoteCompaction.compactionItem).toEqual({
			...compactionItem,
			summary: redacted,
		});
		expect(scrubbed.preserveData.extension).toBe(original.preserveData.extension);
		expect(original.providerPayload.items[6]?.input).toBe(stale);
		expect(original.preserveData.openaiRemoteCompaction.compactionItem.summary).toBe(stale);
		expect(obfuscateNativeReplay(obfuscator, scrubbed, collisions)).toBe(scrubbed);
		expect(obfuscateNativeReplay(new SecretObfuscator([]), original, collisions)).toBe(original);
		const detached = { ...original, preserveData: structuredClone(original.preserveData) };
		const detachedScrubbed = obfuscateNativeReplay(obfuscator, detached, collisions);
		expect(detachedScrubbed.preserveData.openaiRemoteCompaction.replacementHistory).toEqual(
			scrubbed.providerPayload.items,
		);
	});

	const fileSearch = { type: "file_search_call" as const, id: "fs-search", status: "completed" as const, queries: [] };
	const webSearch = { type: "web_search_call" as const, id: "ws-search", status: "completed" as const };
	const searchCollisionCases: Array<{
		name: string;
		item: ResponseFileSearchToolCall | ResponseFunctionWebSearch;
	}> = [
		{ name: "file queries", item: { ...fileSearch, queries: ["tok_abc123"] } },
		{
			name: "file result attributes",
			item: { ...fileSearch, results: [{ attributes: { label: "tok_abc123", count: 3, enabled: true } }] },
		},
		{ name: "web queries", item: { ...webSearch, action: { type: "search", queries: ["tok_abc123"] } } },
		{
			name: "web source URL",
			item: {
				...webSearch,
				action: { type: "search", sources: [{ type: "url", url: "https://example.test/tok_abc123" }] },
			},
		},
		{
			name: "web find pattern",
			item: {
				...webSearch,
				action: { type: "find_in_page", url: "https://example.test", pattern: "tok_abc123" },
			},
		},
	];
	it.each(searchCollisionCases)(
		"collects a collision appearing only in $name before rewriting earlier history",
		({ item }) => {
			const obfuscator = new SecretObfuscator([
				{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace", replacement: "[hidden]" },
			]);
			const stale = obfuscator.obfuscate("remember OTHERSECRET");
			expect(stale).toContain("TOKABC123_");
			const opaque = { type: "compaction", encrypted_content: "tok_abc123 TOKABC123_" };
			const messages: Message[] = [
				{ role: "user", content: stale, timestamp: 1 },
				{
					role: "developer",
					attribution: "agent",
					content: "native replay",
					timestamp: 2,
					providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [{ ...item }, opaque] },
				},
			];
			const snapshot = structuredClone(messages);
			const scrubbed = obfuscateMessages(obfuscator, messages);
			const prompt = scrubbed[0]!;
			if (prompt.role !== "user" || typeof prompt.content !== "string") throw new Error("Missing earlier prompt");
			expect(prompt.content).not.toContain("TOKABC123_");
			expect(obfuscator.deobfuscate(prompt.content)).toBe("remember OTHERSECRET");
			const replay = scrubbed[1]!;
			if (replay.role !== "developer" || replay.providerPayload?.type !== "openaiResponsesHistory")
				throw new Error("Missing native search replay");
			expect(JSON.stringify(replay.providerPayload.items[0])).not.toContain("tok_abc123");
			expect(JSON.stringify(replay.providerPayload.items[0])).toContain("[hidden]");
			expect(replay.providerPayload.items[1]).toBe(opaque);
			expect(messages).toEqual(snapshot);
			expect(obfuscateMessages(obfuscator, scrubbed)).toBe(scrubbed);
		},
	);

	it("collects native collisions present only in the detached next-compaction source", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace", replacement: "[hidden]" },
		]);
		const stale = obfuscator.obfuscate("remember OTHERSECRET");
		const opaque = { type: "compaction", encrypted_content: "opaque TOKABC123_" };
		const replay = {
			role: "developer" as const,
			attribution: "agent" as const,
			content: "native replay",
			timestamp: 2,
			providerPayload: { type: "openaiResponsesHistory" as const, provider: "openai", items: [opaque] },
			preserveData: {
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [
						{
							...webSearch,
							action: { type: "find_in_page", pattern: "tok_abc123", url: "https://example.test" },
						},
						opaque,
					],
					compactionItem: opaque,
				},
			},
		};
		const messages: Message[] = [{ role: "user", content: stale, timestamp: 1 }, replay];
		const snapshot = structuredClone(messages);
		const scrubbed = obfuscateMessages(obfuscator, messages);
		expect(JSON.stringify(scrubbed[0])).not.toContain("TOKABC123_");
		expect(obfuscator.deobfuscate(JSON.stringify(scrubbed[0]))).toContain("remember OTHERSECRET");
		const scrubbedReplay = scrubbed[1] as typeof replay;
		expect(scrubbedReplay.providerPayload).toBe(replay.providerPayload);
		expect(scrubbedReplay.preserveData.openaiRemoteCompaction.replacementHistory[0]).toMatchObject({
			action: { type: "find_in_page", pattern: "[hidden]", url: "https://example.test" },
		});
		expect(scrubbedReplay.preserveData.openaiRemoteCompaction.compactionItem).toBe(opaque);
		expect(messages).toEqual(snapshot);
		expect(obfuscateMessages(obfuscator, scrubbed)).toBe(scrubbed);
	});

	it("collects collisions from decoded native arguments but never from opaque replay bytes", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
		]);
		const opaque = { type: "compaction", encrypted_content: "tok_abc123", id: "tok_abc123" };
		const messages: Message[] = [
			{ role: "user", content: "OTHERSECRET", timestamp: 1 },
			{
				role: "developer",
				attribution: "agent",
				content: "native replay",
				timestamp: 2,
				providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [opaque] },
			},
		];
		const first = obfuscateMessages(obfuscator, messages);
		expect(JSON.stringify(first[0])).toContain("TOKABC123_");
		const replay = first[1]!;
		if (replay.role !== "developer" || replay.providerPayload?.type !== "openaiResponsesHistory")
			throw new Error("Missing native replay");
		const argumentItem = {
			type: "function_call",
			call_id: "call",
			name: "read",
			arguments: '{"token":"tok_abc\\u003123"}',
		};
		const next = obfuscateMessages(obfuscator, [
			first[0]!,
			{ ...replay, providerPayload: { ...replay.providerPayload, items: [argumentItem, opaque] } },
		]);
		expect(JSON.stringify(next[0])).not.toContain("TOKABC123_");
		const nextReplay = next[1]!;
		if (nextReplay.role !== "developer" || nextReplay.providerPayload?.type !== "openaiResponsesHistory")
			throw new Error("Missing native replay");
		expect(JSON.parse(nextReplay.providerPayload.items[0]?.arguments as string).token).not.toBe("tok_abc123");
		expect(nextReplay.providerPayload.items[1]).toBe(opaque);
		expect(obfuscateMessages(obfuscator, next)).toBe(next);
	});
});
