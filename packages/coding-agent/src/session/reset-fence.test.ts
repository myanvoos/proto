import { expect, test } from "bun:test";
import type { ResetCreditAccountStatus } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { checkCodexBalance, readResetMarker, withResetFence } from "./reset-fence";

test("separate reset processes serialize and the second sees the first marker instead of consuming twice", async () => {
	using temp = TempDir.createSync("proto-reset-fence-");
	const modulePath = `${import.meta.dir}/reset-fence.ts`;
	const script = `
		import { withResetFence } from ${JSON.stringify(modulePath)};
		const outcome = await withResetFence(${JSON.stringify(temp.join("account"))},
			async marker => marker.state,
			async marked => {
				await marked(async () => { await Bun.sleep(25); return { ok: true, code: "reset" }; });
				return "spent";
			});
		console.log(outcome);
	`;
	const children = [0, 1].map(() =>
		Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" }),
	);
	const results = await Promise.all(
		children.map(async child => {
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code, stderr).toBe(0);
			return stdout.trim();
		}),
	);
	expect(results.sort()).toEqual(["reset", "spent"]);
});

test("an ambiguous consume retains a pending marker while a confirmed no-op releases the fence", async () => {
	using temp = TempDir.createSync("proto-reset-fence-outcomes-");
	const pending = temp.join("pending");
	await expect(
		withResetFence(
			pending,
			async () => "recent",
			async marked => {
				await marked(async () => {
					throw new Error("connection dropped after send");
				});
				return "spent";
			},
		),
	).rejects.toThrow("connection dropped");
	expect((await readResetMarker(pending)).state).toBe("pending");
	const empty = temp.join("empty");
	await withResetFence(
		empty,
		async () => {},
		async marked => {
			await marked(async () => ({ ok: false, code: "nothing_to_reset" }));
		},
	);
	expect((await readResetMarker(empty)).state).toBe("");
	let spent = false;
	await withResetFence(
		empty,
		async () => {},
		async marked => {
			await marked(async () => {
				spent = true;
				return { ok: true, code: "reset" };
			});
		},
	);
	expect(spent).toBe(true);
});

test("Codex balance rechecks distinguish stale offers, empty balances, and unavailable listings", () => {
	const status: ResetCreditAccountStatus = {
		provider: "openai-codex",
		credentialId: 1,
		active: true,
		availableCount: 1,
		credits: [],
	};
	expect(checkCodexBalance([status], 1, 2)).toBe("spent");
	expect(checkCodexBalance([{ ...status, availableCount: 0 }], 1, undefined)).toBe("no_credit");
	expect(checkCodexBalance([{ ...status, error: "offline" }], 1, undefined)).toBe("credit_list_failed");
});
