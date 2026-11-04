import SERIALIZATION from "./proto_harness/_serialization.py" with { type: "text" };
import VENDOR_INIT from "./proto_harness/_vendor/__init__.py" with { type: "text" };
import CLOUDPICKLE_INIT from "./proto_harness/_vendor/cloudpickle/__init__.py" with { type: "text" };
import CLOUDPICKLE from "./proto_harness/_vendor/cloudpickle/cloudpickle.py" with { type: "text" };
import LICENSE from "./proto_harness/_vendor/cloudpickle/LICENSE.txt" with { type: "text" };
import STORE from "./proto_harness/store.py" with { type: "text" };

/** Static imports remain bundled in compiled hosts and staged on remote targets. */
export const PYTHON_SERIALIZATION_ASSETS: Readonly<Record<string, string>> = {
	"proto_harness/_serialization.py": SERIALIZATION,
	"proto_harness/store.py": STORE,
	"proto_harness/_vendor/__init__.py": VENDOR_INIT,
	"proto_harness/_vendor/cloudpickle/__init__.py": CLOUDPICKLE_INIT,
	"proto_harness/_vendor/cloudpickle/cloudpickle.py": CLOUDPICKLE,
	"proto_harness/_vendor/cloudpickle/LICENSE.txt": LICENSE,
};
