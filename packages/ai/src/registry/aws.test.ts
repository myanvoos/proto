import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

test("AWS credential availability observes shared-file edits and profile changes after a cached probe", async () => {
	using dir = TempDir.createSync("@proto-aws-probe-");
	const credentials = path.join(dir.path(), "credentials");
	const code = String.raw`import { hasAwsCredentialSource } from ${JSON.stringify(path.join(import.meta.dir, "aws.ts"))};
		const observed = [hasAwsCredentialSource()];
		await Bun.write(process.env.AWS_SHARED_CREDENTIALS_FILE, "[default]\naws_access_key_id = test\naws_secret_access_key = test-secret\n");
		observed.push(hasAwsCredentialSource());
		process.env.AWS_PROFILE = "missing";
		observed.push(hasAwsCredentialSource());
		delete process.env.AWS_PROFILE;
		observed.push(hasAwsCredentialSource());
		await Bun.write(process.env.AWS_SHARED_CREDENTIALS_FILE, "");
		observed.push(hasAwsCredentialSource());
		process.stdout.write(JSON.stringify(observed));`;
	const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AWS_")));
	const result = await $`${process.execPath} -e ${code}`
		.env({
			...environment,
			AWS_EC2_METADATA_DISABLED: "true",
			AWS_SHARED_CREDENTIALS_FILE: credentials,
			AWS_CONFIG_FILE: path.join(dir.path(), "config"),
		})
		.quiet()
		.nothrow();
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.text())).toEqual([false, true, false, true, false]);
});
