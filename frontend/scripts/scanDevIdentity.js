#!/usr/bin/env node
// frontend/scripts/scanDevIdentity.js
//
// LIVE-2B (LIVE-2 §4.8 item 5): FAIL IF A PRODUCTION BUNDLE CONTAINS THE DEVELOPMENT CLAIM PARAMETER.
//
//   node scripts/scanDevIdentity.js [buildDir]        (default: ./build)
//
// The client names the development claim only inside a branch guarded by REACT_APP_DEV_IDENTITY === "1", which a
// production build folds to `if (false)` and the minifier deletes. This scans every emitted .js/.html/.map file for
// the string and exits 1 naming the files that carry it -- run it on every build that is not a development-identity
// build. (A bundle built WITH REACT_APP_DEV_IDENTITY=1 is expected to contain it; never deploy one.)

const fs = require("fs");
const path = require("path");

const NEEDLE = ["dev", "claim"].join("_");

function findDevIdentity(buildDir) {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(js|html|map|json)$/.test(name) && fs.readFileSync(full, "utf8").includes(NEEDLE)) hits.push(path.relative(buildDir, full));
    }
  };
  walk(buildDir);
  return hits.sort();
}

/** LIVE-2E: every source map in the bundle. A production bundle has none (`.env.production` turns them off): a map
 *  is the original source, and it carried the development-identity branch's text after the minifier had deleted the
 *  code (the LIVE-2D artifact gate). A map is therefore a failure of its own, whatever it contains. */
function findSourceMaps(buildDir) {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.map$/.test(name)) hits.push(path.relative(buildDir, full));
    }
  };
  walk(buildDir);
  return hits.sort();
}

module.exports = { findDevIdentity, findSourceMaps };

if (require.main === module) {
  /* `npm run build` runs this after the build with no argument: the build directory is CRA's (`BUILD_PATH`, else
     ./build), so a relocated build is scanned where it actually is. */
  const buildDir = path.resolve(process.argv[2] || process.env.BUILD_PATH || path.join(__dirname, "..", "build"));
  if (!fs.existsSync(buildDir)) {
    console.error(`scanDevIdentity: no build at ${buildDir}`);
    process.exit(2);
  }
  const hits = findDevIdentity(buildDir);
  if (hits.length > 0) {
    console.error(`scanDevIdentity: the development claim is in this bundle -- it must not be deployed:\n  ${hits.join("\n  ")}`);
    process.exit(1);
  }
  const maps = findSourceMaps(buildDir);
  if (maps.length > 0) {
    console.error(
      `scanDevIdentity: this bundle carries source maps -- a production bundle must not (frontend/.env.production sets ` +
        `GENERATE_SOURCEMAP=false):\n  ${maps.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`scanDevIdentity: ${buildDir} carries no development claim and no source maps`);
}
