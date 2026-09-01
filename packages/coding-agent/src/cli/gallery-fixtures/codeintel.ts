import type { GalleryFixture } from "./types";

export const codeintelFixtures: Record<string, GalleryFixture> = {
	debug: {
		label: "Debug",
		streamingArgs: {
			action: "stack_trace",
		},
		args: {
			action: "stack_trace",
			levels: 20,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Stack trace:",
						"- #1000 validate_token @ app/server.py:42:14",
						"- #1001 authenticate @ app/server.py:88:9",
						"- #1002 handle_request @ app/router.py:153:20",
						"- #1003 dispatch @ app/router.py:97:5",
						"- #1004 <module> @ app/server.py:212:1",
					].join("\n"),
				},
			],
			details: {
				action: "stack_trace",
				success: true,
				snapshot: {
					id: "dbg-1",
					adapter: "debugpy",
					cwd: "/Users/dev/project",
					program: "./app/server.py",
					status: "stopped",
					launchedAt: "2026-06-06T14:21:08.412Z",
					lastUsedAt: "2026-06-06T14:22:55.901Z",
					threadId: 1,
					frameId: 1000,
					stopReason: "breakpoint",
					stopDescription: "breakpoint 2",
					frameName: "validate_token",
					instructionPointerReference: "0x00000001000034a8",
					source: { name: "server.py", path: "app/server.py" },
					line: 42,
					column: 14,
					breakpointFiles: 1,
					breakpointCount: 2,
					functionBreakpointCount: 0,
					outputBytes: 248,
					outputTruncated: false,
					needsConfigurationDone: false,
				},
				stackFrames: [
					{
						id: 1000,
						name: "validate_token",
						source: { name: "server.py", path: "app/server.py" },
						line: 42,
						column: 14,
					},
					{
						id: 1001,
						name: "authenticate",
						source: { name: "server.py", path: "app/server.py" },
						line: 88,
						column: 9,
					},
					{
						id: 1002,
						name: "handle_request",
						source: { name: "router.py", path: "app/router.py" },
						line: 153,
						column: 20,
					},
					{
						id: 1003,
						name: "dispatch",
						source: { name: "router.py", path: "app/router.py" },
						line: 97,
						column: 5,
					},
					{
						id: 1004,
						name: "<module>",
						source: { name: "server.py", path: "app/server.py" },
						line: 212,
						column: 1,
					},
				],
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "No active debug session. Launch or attach first.",
				},
			],
			isError: true,
			details: {
				action: "stack_trace",
				success: false,
			},
		},
	},
};
