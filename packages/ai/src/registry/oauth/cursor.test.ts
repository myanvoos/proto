import { afterEach, expect, test, vi } from "bun:test";
import { fetchCursorAccountEmail, loginCursorHook, refreshCursorHook, refreshCursorToken } from "./cursor";

const profileUrl = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe";
function accessToken(sub = "github|42"): string {
	return `header.${btoa(JSON.stringify({ sub, exp: 2_000_000_000 }))}.signature`;
}
afterEach(() => vi.restoreAllMocks());

test("renewal uses Cursor OAuth grant and preserves or rotates the session refresh token", async () => {
	let rotate = false;
	const abort = new AbortController();
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				expect(String(input)).toBe("https://api2.cursor.sh/oauth/token");
				expect(JSON.parse(String(init?.body))).toEqual({
					grant_type: "refresh_token",
					client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
					refresh_token: "session",
				});
				expect(init?.signal).toBe(abort.signal);
				return Response.json({ access_token: accessToken(), ...(rotate ? { refresh_token: "rotated" } : {}) });
			},
			{ preconnect: fetch.preconnect },
		),
	);
	expect((await refreshCursorToken("session", abort.signal)).refresh).toBe("session");
	rotate = true;
	expect((await refreshCursorToken("session", abort.signal)).refresh).toBe("rotated");
});

test("ended Cursor sessions fail as invalid grants instead of storing an empty access token", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "", shouldLogout: true }));
	await expect(refreshCursorToken("ended")).rejects.toThrow("invalid_grant");
});

test("profile email matches the full bearer subject for GitHub logins and rejects another account", async () => {
	for (const subject of ["github|42", "github|43"]) {
		const email = await fetchCursorAccountEmail(accessToken(), async (input, init) => {
			expect(String(input)).toBe(profileUrl);
			expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accessToken()}`);
			return Response.json({ authId: subject, email: " dev@example.com " });
		});
		expect(email).toBe(subject === "github|42" ? "dev@example.com" : undefined);
	}
});

test("login captures email with the controller fetch and a bounded signal", async () => {
	vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ accessToken: accessToken(), refreshToken: "session" }),
	);
	const abort = new AbortController();
	const credentials = await loginCursorHook({
		signal: abort.signal,
		fetch: async (input, init) => {
			expect(String(input)).toBe(profileUrl);
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return Response.json({ authId: "github|42", email: "dev@example.com" });
		},
	});
	expect(credentials.email).toBe("dev@example.com");
});

test("a timed-out profile lookup keeps renewed credentials usable", async () => {
	const deadline = new AbortController();
	vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				if (String(input) !== profileUrl) return Response.json({ access_token: accessToken() });
				deadline.abort();
				throw deadline.signal.reason;
			},
			{ preconnect: fetch.preconnect },
		),
	);
	const credentials = await refreshCursorHook({ access: "old", refresh: "session", expires: 0 });
	expect(credentials.access).toBe(accessToken());
	expect(credentials.refresh).toBe("session");
});
