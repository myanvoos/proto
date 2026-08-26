/**
 * Extension-facing surface for the `@oh-my-pi/pi-coding-agent` package root.
 *
 * Identical to the canonical barrel except for `AuthStorage`: the modern
 * factory is async and requires a database path, while provider extensions
 * call `AuthStorage.create().get(...)` synchronously during module
 * initialization (issue #5879). This module retains a synchronous facade over
 * the same credential store; every other export forwards unchanged.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

export * from "../../index";

/**
 * Synchronous auth storage surface for extensions.
 *
 * Modern PROTO auth storage is asynchronous, while extensions call
 * `AuthStorage.create().get()` during module initialization. The facade opens
 * the shared agent database per call, so credentials written by the host stay
 * visible and credential writes from the extension land in the same store.
 */
export class AuthStorage {
	constructor() {
		fs.mkdirSync(path.dirname(getAgentDbPath()), { recursive: true, mode: 0o700 });
	}

	static create(): AuthStorage {
		return new AuthStorage();
	}

	get(provider: string): AuthCredential | undefined {
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath()));
		try {
			return store.listAuthCredentials(provider)[0]?.credential;
		} finally {
			store.close();
		}
	}

	set(provider: string, credential: AuthCredential): void {
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath()));
		try {
			store.upsertAuthCredentialForProvider(provider, credential);
		} finally {
			store.close();
		}
	}
}
