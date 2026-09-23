import { describe, expect, it, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import { LoginDialogComponent } from "./login-dialog";

initThemeSync();

function plain(rows: readonly string[]): string {
	return rows.map(row => Bun.stripANSI(row)).join("\n");
}

describe("LoginDialogComponent prompts", () => {
	it("keeps prior answers above the next prompt in multi-step logins", async () => {
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "perplexity", vi.fn());
		const email = dialog.showPrompt({ message: "Email address" });
		dialog.pasteText("user@example.com");
		dialog.handleInput("\n");
		await expect(email).resolves.toBe("user@example.com");

		const code = dialog.showPrompt({ message: "Verification code" });
		const rendered = plain(dialog.render(120));
		expect(rendered.indexOf("user@example.com")).toBeGreaterThan(rendered.indexOf("Email address"));
		expect(rendered.indexOf("Verification code")).toBeGreaterThan(rendered.indexOf("user@example.com"));
		dialog.pasteText("123456");
		dialog.handleInput("\n");
		await expect(code).resolves.toBe("123456");
	});

	it("submits exact secret values without rendering or recovering them in later prompts", async () => {
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "openrouter", vi.fn());
		for (const nextPrompt of [
			() => dialog.showPrompt({ message: "Account label" }),
			() => dialog.showManualInput("Authorization code"),
		]) {
			const secretValue = crypto.randomUUID();
			const secret = dialog.showPrompt({ message: "Consumer key", secret: true });
			dialog.pasteText(secretValue);
			expect(dialog.render(120).join("\n")).not.toContain(secretValue);
			dialog.handleInput("\x15"); // Kill the line so the secret sits in the undo and kill histories.
			dialog.handleInput("\x19");
			dialog.handleInput("\n");
			await expect(secret).resolves.toBe(secretValue);
			expect(dialog.render(120).join("\n")).not.toContain(secretValue);

			const next = nextPrompt();
			dialog.handleInput("\x1f"); // Undo twice, then yank: neither may restore the previous secret.
			dialog.handleInput("\x1f");
			dialog.handleInput("\x19");
			dialog.pasteText("visible label");
			const rendered = dialog.render(120).join("\n");
			expect(rendered).not.toContain(secretValue);
			expect(plain([rendered])).toContain("visible label");
			dialog.handleInput("\n");
			await expect(next).resolves.toBe("visible label");
		}
	});
});
