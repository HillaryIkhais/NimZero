import { writeFileSync } from 'node:fs'

// Marks build/.pipeline as CommonJS so `require()` works even though the
// project root package.json declares "type": "module".
writeFileSync('build/.pipeline/package.json', JSON.stringify({ type: 'commonjs' }) + '\n')