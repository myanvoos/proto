import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { convertToLlm } from "../src/session/messages";

const tokenizer = new Tokenizer();

const N = Number(Bun.env.LLM_ASSEMBLY_N ?? 5000);
const WARMUP = 5;
const SAMPLES = 25;

function settledUsage(total: number): Usage {
	return {
		input: total,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function codeBlob(seed: number): string {
	return `\`\`\`typescript\nexport function f${seed}(a: number, b: number): number {\n\treturn a + b + ${seed};\n}\n\`\`\``;
}

function buildHistory(count: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		const ts = 1_700_000_000_000 + i * 1000;
		const kind = i % 3;
		if (kind === 0) {
			messages.push({
				role: "user",
				content: `User turn ${i}: please look at this.\n\n${codeBlob(i)}`,
				timestamp: ts,
			} as AgentMessage);
		} else if (kind === 1) {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "text", text: `Assistant turn ${i}. ${codeBlob(i)}` },
					{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `src/f${i}.ts` } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "bench",
				usage: settledUsage(200 + (i % 50)),
				stopReason: "toolUse",
				timestamp: ts,
			};
			messages.push(assistant as AgentMessage);
		} else {
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: `call-${i - 1}`,
				toolName: "read",
				content: [{ type: "text", text: `Tool result ${i}.\n${codeBlob(i)}\n${codeBlob(i + 1)}` }],
				isError: false,
				timestamp: ts,
			};
			messages.push(toolResult as AgentMessage);
		}
	}
	return messages;
}

interface Stats {
	median: number;
	madNoise: number;
}

function stats(samples: number[]): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const median = sorted[sorted.length >> 1];
	const deviations = sorted.map(x => Math.abs(x - median)).sort((a, b) => a - b);
	const mad = deviations[deviations.length >> 1];

	const madNoise = median === 0 ? 0 : (1.4826 * mad) / median;
	return { median, madNoise };
}

function sample<T>(makeWorkload: () => T, run: (workload: T) => void, batch = 1): Stats {
	for (let i = 0; i < WARMUP; i++) run(makeWorkload());
	const samples: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const workloads: T[] = [];
		for (let b = 0; b < batch; b++) workloads.push(makeWorkload());

		Bun.gc(true);
		const t0 = Bun.nanoseconds();
		for (let b = 0; b < batch; b++) run(workloads[b]);
		samples.push((Bun.nanoseconds() - t0) / 1e6 / batch);
	}
	return stats(samples);
}

console.log(`\nBenchmark: llm-assembly (N=${N}, warmup=${WARMUP}, samples=${SAMPLES})\n`);

const convertFirst = sample(
	() => buildHistory(N),
	history => {
		convertToLlm(history);
	},
	16,
);

const warmConvert = buildHistory(N);
convertToLlm(warmConvert);
convertToLlm(warmConvert);
const convertSteady = sample(
	() => warmConvert,
	history => {
		convertToLlm(history);
	},
);

const growConvert = buildHistory(N);
convertToLlm(growConvert);
let growSeed = N;
const convertGrow = sample(
	() => {
		growConvert.push({
			role: "user",
			content: `User turn ${growSeed}: one more.\n\n${codeBlob(growSeed)}`,
			timestamp: 1_700_000_000_000 + growSeed * 1000,
		} as AgentMessage);
		growSeed++;
		return growConvert;
	},
	history => {
		convertToLlm(history);
	},
);

const estimateFirst = sample(
	() => buildHistory(N),
	history => {
		tokenizer.countMessages(history);
	},
);

const warmEstimate = buildHistory(N);
tokenizer.countMessages(warmEstimate);
const estimateSecond = sample(
	() => warmEstimate,
	history => {
		tokenizer.countMessages(history);
	},
);

function report(label: string, s: Stats): void {
	console.log(
		`  ${label.padEnd(18)} median ${s.median.toFixed(4).padStart(10)} ms   MAD-noise ${(s.madNoise * 100).toFixed(1).padStart(5)}%`,
	);
}

report("convert first", convertFirst);
report("convert steady", convertSteady);
report("convert grow", convertGrow);
report("estimate first", estimateFirst);
report("estimate second", estimateSecond);

const convertSteadySpeedup = convertFirst.median / convertSteady.median;
const convertGrowSpeedup = convertFirst.median / convertGrow.median;
const estimateSpeedup = estimateFirst.median / estimateSecond.median;
console.log(`\n  convert speedup (first / steady):    ${convertSteadySpeedup.toFixed(2)}x`);
console.log(`  convert speedup (first / grow):      ${convertGrowSpeedup.toFixed(2)}x`);
console.log(`  estimate speedup (first / second):   ${estimateSpeedup.toFixed(2)}x`);

const noiseGate = 0.2;
const worstNoise = Math.max(
	convertFirst.madNoise,
	convertSteady.madNoise,
	convertGrow.madNoise,
	estimateFirst.madNoise,
	estimateSecond.madNoise,
);
console.log(`  worst MAD-noise: ${(worstNoise * 100).toFixed(1)}% (gate ${(noiseGate * 100).toFixed(0)}%)\n`);

console.log(`METRIC convert_steady_speedup=${convertSteadySpeedup.toFixed(3)}`);
console.log(`METRIC convert_grow_speedup=${convertGrowSpeedup.toFixed(3)}`);
console.log(`METRIC estimate_speedup=${estimateSpeedup.toFixed(3)}`);
console.log(`METRIC worst_mad_noise=${worstNoise.toFixed(4)}`);

process.exit(0);
