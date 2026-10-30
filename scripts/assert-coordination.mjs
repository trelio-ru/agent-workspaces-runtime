import {assertPush} from './git-coordinator.mjs';
try { assertPush(process.cwd(), process.argv[2], process.argv[3] ?? ''); }
catch (error) { console.error(error.message); process.exitCode = 1; }
