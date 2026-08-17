const path = require("path");
const fs = require("fs");

const repoRoot = __dirname;

/** Load .env into process.env so PM2 child inherits keys (PM2 does not read .env by itself). */
function loadDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return {};
  const parsed = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    parsed[key] = val;
  }
  return parsed;
}

const dotenv = loadDotEnv();

module.exports = {
  apps: [
    {
      name: "shaolin",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      output: path.join(repoRoot, "logs/pm2-out.log"),
      error: path.join(repoRoot, "logs/pm2-error.log"),
      env: {
        NODE_ENV: "production",
        ...dotenv,
      },
    },
  ],
};
