import { Snowflake } from "@oh-my-pi/pi-utils";
import type { MCPRequestIdFormat } from "./types";

export class RequestIdAllocator {
	#previousNumeric = 0;

	next(format: MCPRequestIdFormat | undefined): string | number {
		return format === "string" ? Snowflake.next() : ++this.#previousNumeric;
	}
}
