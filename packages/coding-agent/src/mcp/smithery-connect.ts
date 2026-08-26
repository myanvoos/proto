export class SmitheryConnectError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryConnectError";
		this.status = status;
	}
}

type SmitheryConnectionStatus =
	| { state: "connected" }
	| { state: "auth_required"; authorizationUrl?: string }
	| { state: "error"; message: string }
	| { state: string; [key: string]: unknown };

export type SmitheryConnection = {
	connectionId: string;
	mcpUrl: string;
	name: string;
	status?: SmitheryConnectionStatus;
	createdAt?: string;
};
