import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = __dirname;

export function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}
