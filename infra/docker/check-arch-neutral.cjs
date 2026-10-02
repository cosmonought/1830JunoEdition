#!/usr/bin/env node
// infra/docker/check-arch-neutral.cjs -- COST-1.
//
// The game-server image is multi-arch (linux/amd64 for ECS and developers, linux/arm64 for the Graviton single host).
// Its build stage runs on the BUILDER's platform and the runtime stage COPIES the server's production node_modules, so
// those dependencies must contain nothing architecture-specific. This check fails (exit 1) if they ever do:
//   - a production lockfile entry restricted to an os/cpu, with an install script, or with a gyp file;
//   - a compiled addon (*.node) or a binding.gyp anywhere in the installed node_modules.
// Usage: node infra/docker/check-arch-neutral.cjs <package dir containing package-lock.json [and node_modules]>
"use strict";
const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || ".");
const problems = [];
const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
for (const [name, entry] of Object.entries(lock.packages || {})) {
  if (name === "" || entry.dev === true) continue;
  if (entry.os !== undefined || entry.cpu !== undefined) problems.push(`lockfile ${name}: restricted to os/cpu`);
  if (entry.hasInstallScript === true) problems.push(`lockfile ${name}: has an install script`);
  if (entry.gypfile === true) problems.push(`lockfile ${name}: has a gyp file`);
}
const modules = path.join(dir, "node_modules");
const walk = (at) => {
  for (const item of fs.readdirSync(at, { withFileTypes: true })) {
    const full = path.join(at, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) walk(full);
    else if (item.name.endsWith(".node") || item.name === "binding.gyp") problems.push(`native file ${path.relative(dir, full)}`);
  }
};
if (fs.existsSync(modules)) walk(modules);
if (problems.length > 0) {
  console.error(`architecture-specific production dependencies in ${dir}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`production dependencies are architecture-neutral (${dir})`);
