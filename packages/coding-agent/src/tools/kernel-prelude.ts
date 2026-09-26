import { prompt } from "@oh-my-pi/pi-utils";
import prelude from "../prompts/tools/kernel-prelude.md" with { type: "text" };

// The standalone `{{> kernel-prelude}}` line supplies the final newline; the file's own
// would add a second blank line, and the formatter drops blank-line runs entirely.
prompt.registerPartial("kernel-prelude", prelude.trimEnd());
