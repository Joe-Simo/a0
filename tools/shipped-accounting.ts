/**
 * What an agent really pays and reads on the two shipped paths, counted from the real files
 * (o200k_base, js-tiktoken, the counting of tools/dense-tokens.ts):
 *
 *   (a) MCP client:  the tool list the server serves (src/mcp.ts, read over the SDK client), the
 *                    server instructions, and the guide only if the server surfaces it
 *   (b) skill:       skills/a0/SKILL.md (front matter always listed, body when the skill fires),
 *                    skills/a0/references/primer.txt (read before writing A0), edit-protocol.md
 *                    (read on a rejection); the plugin's slash commands are read when invoked
 *
 * Per call is the tokens that sit in the model's input on every call of a session; per session is
 * the cache-adjusted charge of the ablation (1.25x on the first call of a one-task session, 0.17x
 * per task of a 10-task session, 0.05x on later calls and in an unbounded session).
 *
 *   node dist/tools/shipped-accounting.js [--out=results/shipped-accounting.json]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { writeReport } from './scrub-results.js';
import { renderTools, served } from './shipped-tool-text.js';

const enc = getEncoding('o200k_base');
const tokens = (s: string): number => enc.encode(s).length;
const read = (p: string): string => readFileSync(p, 'utf8');
const out =
  process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'results/shipped-accounting.json';

const skill = read('skills/a0/SKILL.md');
const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
const frontMatter = front?.[0] ?? '';
const skillBody = skill.slice(frontMatter.length);
const primer = read('skills/a0/references/primer.txt');
const editProtocol = read('skills/a0/references/edit-protocol.md');
const guideDense = read('MODEL_GUIDE.dense.txt');
const guideLong = read('MODEL_GUIDE.txt');
const ablationPrimer = read('experiments/primers/MODEL_GUIDE.rules-merged.txt');
const commands = readdirSync('plugin/commands').map((f) => ({
  file: `plugin/commands/${f}`,
  o200k: tokens(read(join('plugin/commands', f))),
}));

const s = await served();
const toolList = renderTools(s.tools);
const toolDescriptions = s.tools.map((t) => t.description).join('\n');
const perTool = s.tools.map((t) => ({
  name: t.name,
  o200k: tokens(renderTools([t])),
  descriptionO200k: tokens(t.description),
}));
const guideSurfaced =
  s.instructions !== undefined ||
  'resources' in s.capabilities ||
  'prompts' in s.capabilities ||
  s.tools.some((t) => /MODEL_GUIDE|primer/i.test(t.description));

const mcp = {
  toolListO200k: tokens(toolList),
  toolListRawJsonO200k: tokens(JSON.stringify(s.tools)),
  toolListRawJsonIndentedO200k: tokens(JSON.stringify(s.tools, null, 2)),
  toolDescriptionsO200k: tokens(toolDescriptions),
  perTool,
  serverInstructionsO200k: s.instructions === undefined ? 0 : tokens(s.instructions),
  capabilities: Object.keys(s.capabilities).sort(),
  guideSurfacedByServer: guideSurfaced,
};
const guide = tokens(primer);
const skillFront = tokens(frontMatter);
const skillBodyT = tokens(skillBody);
const edit = tokens(editProtocol);

const charge = (perCall: number): Record<string, number> => ({
  coldTask: Math.round(perCall * 1.25 * 10) / 10,
  tenTaskSessionPerTask: Math.round(perCall * 0.17 * 10) / 10,
  laterCall: Math.round(perCall * 0.05 * 10) / 10,
});

const paths = {
  mcpOnly: { perCallO200k: mcp.toolListO200k + mcp.serverInstructionsO200k },
  skillOnly: { perCallO200k: skillBodyT + guide, listedAlwaysO200k: skillFront },
  skillPlusMcp: {
    perCallO200k: skillBodyT + guide + mcp.toolListO200k + mcp.serverInstructionsO200k,
    listedAlwaysO200k: skillFront,
  },
  skillPlusMcpAfterRejection: {
    perCallO200k: skillBodyT + guide + edit + mcp.toolListO200k + mcp.serverInstructionsO200k,
  },
};

await writeReport(out, {
  tokenizer:
    'o200k_base (js-tiktoken); not the tokenizer of Claude, as in every token count of this repository',
  files: {
    'skills/a0/SKILL.md': {
      bytes: Buffer.byteLength(skill),
      o200k: tokens(skill),
      frontMatterO200k: skillFront,
      bodyO200k: skillBodyT,
    },
    'skills/a0/references/primer.txt (= MODEL_GUIDE.min.txt)': {
      bytes: Buffer.byteLength(primer),
      o200k: guide,
    },
    'skills/a0/references/edit-protocol.md': {
      bytes: Buffer.byteLength(editProtocol),
      o200k: edit,
    },
    'experiments/primers/MODEL_GUIDE.rules-merged.txt (edit-only, the ablation text)': {
      o200k: tokens(ablationPrimer),
    },
    'MODEL_GUIDE.dense.txt (dense view primer, not shipped through a skill)': {
      o200k: tokens(guideDense),
    },
    'MODEL_GUIDE.txt (long guide, site and llms.txt only)': { o200k: tokens(guideLong) },
    'plugin/commands (read when a slash command runs)': commands,
  },
  mcp,
  paths: Object.fromEntries(
    Object.entries(paths).map(([k, v]) => [k, { ...v, ...charge(v.perCallO200k) }]),
  ),
  notes: [
    'The tool list is counted as the JSON a client sends (name, description, input schema) read from the running server; a client that renders tools another way sends a different count.',
    'The server serves no instructions, no resources and no prompts: the language guide reaches a model only through the skill (or a copy a user pastes), so an MCP-only client reads the tool text and nothing else about the language.',
    'A model that has the skill and the server reads both texts on every call: the guide (the language and, in its EDIT section, the edit-reply form) and the tool list (which repeats the reply form and adds the diagnostic fields).',
  ],
});
process.stdout.write(
  `${JSON.stringify(paths, null, 1)}\nmcp tool list ${mcp.toolListO200k} tokens\n`,
);
