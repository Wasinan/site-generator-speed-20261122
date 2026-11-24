// Driver: reads every case from /input/cases.json (or $MAKEFUN_INPUT_DIR),
// answers each one with run() from solve.js, and writes the answers in
// order to /output/answers.json (or $MAKEFUN_OUTPUT_DIR). Runs on Node 22,
// which executes this TypeScript as it stands. Incremental marking is
// switched off before solve.js loads, as the house baseline runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; input: unknown };

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as Case[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
