// Copies the one layout file (docs/layout.md at the repo root) into this package, so that a packed
// or installed copy of the server carries it. The copy is git-ignored; never edit it.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(here, "../../../docs/layout.md"), join(here, "../layout.md"));
