// argv: a b  -> endlessly exchange the two directory entries (three renames)
import { renameSync } from 'node:fs';
const [a, b] = process.argv.slice(2); const t = a + '.swp';
for (;;) { try { renameSync(a, t); renameSync(b, a); renameSync(t, b); } catch {} }
