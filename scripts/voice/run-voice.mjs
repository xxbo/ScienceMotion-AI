import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const candidates = process.platform === "win32"
  ? [resolve(root, ".venv/Scripts/python.exe"), "py", "python"]
  : [resolve(root, ".venv/bin/python"), "python3", "python"];

const python = candidates.find((candidate) =>
  candidate.includes("/") || candidate.includes("\\")
    ? existsSync(candidate)
    : true
);

if (!python) {
  throw new Error("Python 3 was not found. Create a virtual environment and install requirements-voice.txt.");
}

const result = spawnSync(
  python,
  [resolve(root, "scripts/voice/generate_narration.py")],
  { cwd: root, stdio: "inherit", env: process.env }
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
