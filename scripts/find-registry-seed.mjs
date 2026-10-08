// Find where the nodes registry rows were seeded (node-ikaris style IDs).
// Not in server.mjs, not in routes — check all src for the seed call.
import { execSync } from 'child_process';

// search_files equivalent via rg on the repo
const out = execSync("/usr/bin/grep -rn 'node-ikaris\\|registerNode(' src/ --include='*.mjs' | head -20", { cwd: '/home/haz/cardinal-frame/cardinal-frame', encoding: 'utf8' });
console.log(out);
