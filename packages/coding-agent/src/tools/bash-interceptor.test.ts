import { expect, test } from "bun:test";
import { checkBashInterception } from "./bash-interceptor";

test("cat writes and heredocs are not rejected as file reads, even after stderr redirects", () => {
	for (const command of ["cat > out.txt", "cat 2> err.log > out.txt", "cat <<'EOF'\ncontent\nEOF", "cat &> out.txt"]) {
		expect(checkBashInterception(command, ["read"]).block).toBe(false);
	}
});

test("cat that only redirects stderr or duplicates stdout is still a file read", () => {
	for (const command of ["cat 2> err.log file.txt", "cat >&2 file.txt"]) {
		expect(checkBashInterception(command, ["read"]).suggestedTool).toBe("read");
	}
});
