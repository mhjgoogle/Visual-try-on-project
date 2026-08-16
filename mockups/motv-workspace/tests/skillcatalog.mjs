// Install the builtin catalog for tests.
//
// The BROWSER cannot read a filesystem, which is why the backend is the loader
// and the page consumes `GET /api/skills` (TASK-075 §1.0). Node can, so tests
// read the same packages the backend reads instead of carrying a fixture copy —
// a fixture would be the third definition of each capability.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const BUILTIN = join(REPO, "product-skills", "builtin");

/** The same payload shape `GET /api/skills` serves. */
export function builtinCatalogPayload() {
  const shared = JSON.parse(
    readFileSync(join(REPO, "product-skills", "skill-inputs.json"), "utf8"),
  );
  const skills = readdirSync(BUILTIN, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(BUILTIN, d.name);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const { skillVersion, ...rest } = manifest;
      return {
        ...rest,
        // the package speaks `skillVersion` because a Run RECORD does; the
        // in-memory object keeps `version`, exactly as the backend maps it
        version: skillVersion,
        instruction: readFileSync(join(dir, "prompt.md"), "utf8")
          .replace(/\r\n/g, "\n")
          .replace(/\n+$/, ""),
        outputSchema: JSON.parse(readFileSync(join(dir, "output.schema.json"), "utf8")),
        deprecated: Boolean(manifest.deprecated),
        // the backend stamps WHICH of the three sources a package came from; these
        // really are the builtin ones, so saying so keeps the fixture the same
        // shape as `GET /api/skills` rather than a shape only the tests see
        source: "builtin",
      };
    })
    .sort((a, b) => (a.skillId < b.skillId ? -1 : 1));
  return {
    skills: skills.filter((s) => !s.deprecated),
    // resolvable, never listed (ADR-0067 决策 5)
    deprecated: skills.filter((s) => s.deprecated),
    inputs: shared.inputs,
    shotScopedInputs: shared.shotScopedInputs,
  };
}

/** Install it into `skills.js`, the way `app.js` does at boot. */
export function installBuiltinCatalog(skills) {
  return skills.installCatalog(builtinCatalogPayload());
}
