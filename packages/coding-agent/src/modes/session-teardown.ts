import { logger, type postmortem } from "@oh-my-pi/pi-utils";

interface SessionTeardownDeps {
	getDraftText: () => string;

	beginDispose: () => void;

	saveDraft: (text: string) => Promise<void>;

	disposeSession: (reason?: postmortem.Reason) => Promise<void>;
}

export type SessionTeardown = (reason?: postmortem.Reason) => Promise<void>;

export function createSessionTeardown(deps: SessionTeardownDeps): SessionTeardown {
	let pending: Promise<void> | undefined;
	const run = async (reason?: postmortem.Reason): Promise<void> => {
		const draftText = deps.getDraftText();
		deps.beginDispose();
		try {
			await deps.saveDraft(draftText);
		} catch (err) {
			logger.warn("Failed to save session draft during teardown", { error: String(err) });
		}
		await deps.disposeSession(reason);
	};
	return (reason?: postmortem.Reason) => {
		if (!pending) pending = run(reason);
		return pending;
	};
}
