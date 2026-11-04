import type * as net from "node:net";

/** One controlling terminal per process incarnation; observation never owns the process. */
export class TerminalAttachments {
	readonly #leases = new Map<string, { id: string; socket: net.Socket }>();

	attach(processId: string, socket: net.Socket): string {
		const id = crypto.randomUUID();
		this.#leases.set(processId, { id, socket });
		return id;
	}

	assert(processId: string, leaseId: string | undefined, socket: net.Socket): void {
		const lease = this.#leases.get(processId);
		if (!lease || lease.id !== leaseId || lease.socket !== socket) {
			throw new Error("Terminal attachment was replaced or disconnected; reattach before sending input");
		}
	}

	assertInput(processId: string, leaseId: string | undefined, socket: net.Socket): void {
		if (leaseId !== undefined || this.#leases.has(processId)) this.assert(processId, leaseId, socket);
	}

	detach(processId: string, leaseId: string, socket: net.Socket): void {
		this.assert(processId, leaseId, socket);
		this.#leases.delete(processId);
	}

	disconnect(socket: net.Socket): void {
		for (const [processId, lease] of this.#leases) {
			if (lease.socket === socket) this.#leases.delete(processId);
		}
	}

	forget(processId: string): void {
		this.#leases.delete(processId);
	}
}
