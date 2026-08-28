import { agenticFixtures } from "./agentic";
import { codeintelFixtures } from "./codeintel";
import { editFixtures } from "./edit";
import { fsFixtures } from "./fs";
import { interactionFixtures } from "./interaction";
import { miscFixtures } from "./misc";
import { shellFixtures } from "./shell";
import { statusLineFixtures } from "./status-line";
import { webFixtures } from "./web";

export * from "./types";

export const galleryFixtures = {
	...interactionFixtures,
	...shellFixtures,
	...fsFixtures,
	...editFixtures,
	...agenticFixtures,
	...webFixtures,
	...codeintelFixtures,
	...statusLineFixtures,
	...miscFixtures,
};
