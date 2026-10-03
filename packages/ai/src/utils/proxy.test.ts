import { describe, expect, it } from "bun:test";
import { withProxyInit } from "./proxy";

describe("withProxyInit", () => {
	it("leaves Unix-socket requests on their socket instead of tunnelling them", () => {
		const init = { method: "POST", unix: "/tmp/proto-broker.sock" };
		expect(withProxyInit("http://broker/v1/blob", init, "http://proxy.example:8080")).toBe(init);
		expect(withProxyInit("http://example.com/", {}, "http://proxy.example:8080")).toMatchObject({
			proxy: "http://proxy.example:8080",
		});
	});
});
