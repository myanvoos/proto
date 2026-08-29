import { prompt } from "@oh-my-pi/pi-utils";
import prelude from "../prompts/tools/kernel-prelude.md" with { type: "text" };

prompt.registerPartial("kernel-prelude", prelude);
