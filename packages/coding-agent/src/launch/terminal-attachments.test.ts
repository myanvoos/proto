import { describe, expect, test } from "bun:test";
import * as net from "node:net";
import { TerminalAttachments } from "./terminal-attachments";

describe("terminal attachment authority", () => {
	test("latest attachment revokes the old token and a stolen token cannot control from another socket", () => {
		const attachments = new TerminalAttachments();
		const first = new net.Socket();
		const second = new net.Socket();
		try {
			const old = attachments.attach("process", first);
			attachments.assertInput("process", old, first);
			expect(() => attachments.assertInput("process", undefined, second)).toThrow("reattach");
			expect(() => attachments.assert("process", old, second)).toThrow("reattach");
			const current = attachments.attach("process", second);
			expect(() => attachments.assert("process", old, first)).toThrow("reattach");
			expect(() => attachments.detach("process", old, first)).toThrow("reattach");
			attachments.disconnect(first);
			attachments.assertInput("process", current, second);
			attachments.detach("process", current, second);
			expect(() => attachments.assert("process", current, second)).toThrow("reattach");
		} finally {
			first.destroy();
			second.destroy();
		}
	});

	test("disconnect retires only that socket's authority and process incarnations remain independent", () => {
		const attachments = new TerminalAttachments();
		const first = new net.Socket();
		const second = new net.Socket();
		try {
			const old = attachments.attach("old-incarnation", first);
			const other = attachments.attach("other-process", second);
			attachments.disconnect(first);
			expect(() => attachments.assertInput("old-incarnation", old, first)).toThrow("reattach");
			attachments.assertInput("other-process", other, second);
			const revived = attachments.attach("new-incarnation", first);
			attachments.forget("old-incarnation");
			attachments.assert("new-incarnation", revived, first);
			attachments.forget("new-incarnation");
			expect(() => attachments.assert("new-incarnation", revived, first)).toThrow("reattach");
			attachments.detach("other-process", other, second);
			expect(() => attachments.assert("other-process", other, second)).toThrow("reattach");
		} finally {
			first.destroy();
			second.destroy();
		}
	});
});
