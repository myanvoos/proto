import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

export * from "../../index";

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
