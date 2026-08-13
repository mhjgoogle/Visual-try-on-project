// Runs the REAL frontend compiler so the Python mirror can be compared against
// it rather than against a recorded string (TASK-075 acceptance #7).
//
// Consumed by tests/test_motv_skillpkg_task075.py. It reads the same context
// the snapshot fixture uses, so both sides are held to one input.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillsPath = process.argv[2] ?? join(here, "..", "..", "src", "workflow", "skills.js");
const { SKILLS, compilePrompt } = await import(pathToFileURL(skillsPath).href);

const snapshot = JSON.parse(
  readFileSync(join(here, "skill-prompt-snapshots.json"), "utf8"),
);
const out = {};
for (const skill of SKILLS) out[skill.skillId] = compilePrompt(skill, snapshot.context);
process.stdout.write(JSON.stringify(out));
