#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadScenarioFile } from '../node_modules/@cutcode/ai-tester/dist/scenario/loader.js';
import { createSandbox } from '../node_modules/@cutcode/ai-tester/dist/sandbox/worktree.js';
import { evaluateAssertions } from '../node_modules/@cutcode/ai-tester/dist/assertions/index.js';
import { advanceReview, runReview, WORKFLOW_VERSION } from '../skills/aif-review/references/check-workflow.mjs';
import { ToolReplay, argsHash, replayKey } from './lib/tool-replay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillDir = path.join(root, 'skills/aif-review');
const casesPath = path.join(skillDir, 'tests/_replay/cases.json');
const fixture = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceHash = file => hash(fs.readFileSync(path.join(root, file)));
const helper = path.join(skillDir, 'references/pr-source.mjs').replaceAll('\\', '/');
const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(helper, '<references>/pr-source.mjs'));
const report = {
  schema_version: 1, mode: 'replay-only', inference: false, live_tools: false,
  runtime: { name: 'review-replay', version: WORKFLOW_VERSION, node: process.version,
    ai_tester: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@cutcode/ai-tester/package.json'))).version,
    workflow_sha256: sourceHash('skills/aif-review/references/check-workflow.mjs'),
    replay_sha256: sourceHash('scripts/lib/tool-replay.mjs'), runner_sha256: sourceHash('scripts/test-review-check.mjs') },
  skill: { name: 'aif-review', package_version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
    sources: Object.fromEntries(['SKILL.md', 'references/CHECK-MODE.md', 'references/VALIDATOR.md', 'references/SEVERITY.md', 'references/pr-source.mjs']
      .map(file => [file, sourceHash(`skills/aif-review/${file}`)])) },
  recordings_sha256: hash(fs.readFileSync(casesPath)), cases: [], checks: [],
};
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); report.checks.push({ name, pass: true }); }
  catch (error) { failed += 1; report.checks.push({ name, pass: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
};

await check('all former spec-only scenarios have recordings', () => {
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.workflow_version, WORKFLOW_VERSION);
  const specs = fs.readdirSync(path.join(skillDir, 'tests')).filter(file => file.endsWith('.spec.yaml')).sort();
  assert(specs.length > 0, 'No scenarios discovered');
  for (const file of specs) assert(fixture.cases.some(test => test.scenario_file === file), `Unexecuted scenario: ${file}`);
  assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /check-workflow\.mjs run/);
});

const scenarios = new Map();
for (const name of new Set(fixture.cases.map(test => test.scenario_file))) {
  const loaded = await loadScenarioFile(path.join(skillDir, 'tests', name));
  assert.equal(loaded.scenario.runner.runtime, 'review-replay', 'Recorded scenarios must not select a live runtime');
  // Use ai-tester's actual fixture setup: files_staged really are written and
  // staged. Git here is local fixture setup, never a live replay fallback.
  const sandbox = await createSandbox(loaded.scenario.scenario, loaded.scenario.fixtures);
  try {
    const diff = execFileSync('git', ['diff', '--cached'], { cwd: sandbox.path, encoding: 'utf8', windowsHide: true });
    assert(diff.length > 0, 'files_staged did not produce a staged diff');
    scenarios.set(name, { ...loaded, diff, sandboxPath: sandbox.path,
      sha256: hash(fs.readFileSync(loaded.filePath)) });
  } finally { await sandbox.cleanup(); }
}

for (const test of fixture.cases) {
  const record = { id: test.id, scenario: test.scenario_file, scenario_sha256: scenarios.get(test.scenario_file).sha256 };
  report.cases.push(record);
  try {
    const replay = new ToolReplay(test.records, { normalize });
    const loaded = scenarios.get(test.scenario_file);
    const stagedRecord = test.records.find(call => call.tool === 'Bash' && typeof call.response === 'string' && call.response.startsWith('diff --git'));
    if (stagedRecord) assert.equal(stagedRecord.response, loaded.diff, 'Recorded Git diff drifted from the staged YAML fixtures');
    const journal = { request: test.request, responses: [] };
    let step;
    // Execute the same public host entrypoint used by the skill, rather than
    // constructing the final output or calling the parser directly.
    for (let turn = 0; turn < 20; turn += 1) {
      step = await advanceReview(journal);
      if (step.done) break;
      const { tool, args } = step.next;
      journal.responses.push({ ...step.next, response: await replay.call(tool, args) });
    }
    assert(step?.done, 'Host protocol exhausted its turn budget');
    replay.assertConsumed();
    const result = step.result;
    const drafted = replay.calls.find(call => call.tool === 'Reviewer').response.review;
    if (result.counters === null) assert.deepEqual(result.review.items, drafted.items, 'Validator failure changed original findings');
    const trace = {
      finalOutput: result.output, runner: { sandboxPath: loaded.sandboxPath },
      toolCallSummary: { unansweredQuestions: 0 },
      turns: replay.calls.map(call => ({ toolCalls: [{ name: call.tool, input: call.args,
        resultContent: JSON.stringify(call.response), resultIsError: false }] })),
    };
    const assertions = test.original_assertions ? evaluateAssertions(loaded.scenario.assertions, trace) : [];
    assert(assertions.every(item => item.pass), JSON.stringify(assertions.filter(item => !item.pass)));
    assert.equal(result.gate.status, test.expected.status);
    assert.equal(result.gate.blocking, result.gate.status === 'fail');
    assert.equal(result.gate.suggested_next.command, test.expected.command);
    assert.deepEqual(result.counters, test.expected.counters);
    assert.equal(result.gate.blockers.filter(item => item.id === 'review-validation-failed').length, test.expected.validation_failed ? 1 : 0);
    const established = result.review.items.filter(item => item.section === 'critical' && !/\(confidence: (?:low|medium)\)\s*$/.test(item.text));
    const gateBlockers = (result.review.context_gates ?? []).filter(item => item.status === 'fail');
    assert.deepEqual(result.gate.blockers.filter(item => item.id !== 'review-validation-failed').map(item => item.summary),
      [...established.map(item => item.text), ...gateBlockers.map(item => item.text)], 'Final blockers do not match surviving confirmed findings/context gates');
    assert.deepEqual(result.review.questions, drafted.questions, 'Validation changed non-actionable questions');
    assert.deepEqual(result.review.positive_notes, drafted.positive_notes, 'Validation changed positive notes');
    if (result.gate.status !== 'fail') assert.deepEqual(result.gate.blockers, []);
    assert.equal(replay.calls.filter(call => call.tool === 'Task').length, test.expected.dispatches ?? 1);
    const task = replay.calls.find(call => call.tool === 'Task');
    if (task) {
      assert(task.args.prompt.includes(fs.readFileSync(path.join(skillDir, 'references/SEVERITY.md'), 'utf8')), 'Severity rules were not inlined verbatim');
      const sourceCall = replay.calls[0];
      const diff = typeof sourceCall.response === 'string' ? sourceCall.response : sourceCall.response.diff.text;
      assert(task.args.prompt.includes(diff), 'Exact reviewed diff was lost');
      if (test.request.repository) {
        const reviewerCall = replay.calls.find(call => call.tool === 'Reviewer');
        assert.equal(reviewerCall.args.project_context, test.request.working_directory, 'PR reviewer lost its working directory');
        assert(!JSON.stringify(reviewerCall.args).includes(test.request.project_context), 'Local project context reached PR reviewer');
        assert(!task.args.prompt.includes(test.request.project_context), 'Local project context reached PR validator');
        const context = task.args.prompt.match(/^## Project context\r?\n([\s\S]*?)^## Reviewed diff\r?\n/m)?.[1].trim();
        assert.equal(context, test.expected.validator_context ?? test.request.working_directory,
          'PR validator did not receive the working directory and exact pinned context');
        if (test.expected.pinned_context) {
          assert.equal(reviewerCall.response.project_context, test.expected.pinned_context);
          const description = reviewerCall.response.source.files.find(file => file.path === '.ai-factory/DESCRIPTION.md');
          assert.equal(description.commit_sha, reviewerCall.args.source.head_sha);
          assert.equal(description.content, test.expected.pinned_context, 'Pinned description differs from its recorded source');
        }
      }
    }
    for (const text of test.expected.contains ?? []) assert(result.output.includes(text), `Missing output: ${text}`);
    for (const text of test.expected.absent ?? []) assert(!result.output.includes(text), `Unexpected output: ${text}`);
    for (const text of test.expected.preserved ?? []) assert(result.review.items.some(item => item.text === text), `Original finding changed: ${text}`);
    assert(!result.gate.blockers.some(item => /\(confidence: (?:low|medium)\)/.test(item.summary) && item.id !== 'review-validation-failed'));
    const fences = [...result.output.matchAll(/^```aif-gate-result\n([\s\S]*?)\n```$/gm)];
    assert.equal(fences.length, 1);
    assert(result.output.endsWith(fences[0][0]), 'Gate is not last');
    assert.deepEqual(JSON.parse(fences[0][1]), result.gate);
    record.pass = true;
    record.assertions = assertions;
    record.calls = replay.calls;
    record.output = result.output;
    record.gate = result.gate;
    console.log(`PASS ${test.id}`);
  } catch (error) {
    failed += 1; record.pass = false; record.error = error.message;
    console.error(`FAIL ${test.id}: ${error.message}`);
  }
}

await check('sequential keys keep identical pending/done calls distinct', async () => {
  const args = { task_id: 'validator-1' };
  const replay = new ToolReplay([
    { call_id: 1, tool: 'TaskStatus', args_sha256: argsHash(args), response: { outcome: 'pending' } },
    { call_id: 2, tool: 'TaskStatus', args_sha256: argsHash(args), response: { outcome: 'success', text: 'done' } },
  ]);
  assert.equal((await replay.call('TaskStatus', args)).outcome, 'pending');
  assert.equal((await replay.call('TaskStatus', args)).text, 'done');
  replay.assertConsumed();
  assert.notEqual(replay.calls[0].key, replay.calls[1].key);
});
await check('missing records fail loudly through the workflow', async () => {
  const test = fixture.cases[0];
  const replay = new ToolReplay(test.records.slice(0, 2), { normalize });
  await assert.rejects(runReview(test.request, replay.call.bind(replay)), /Missing replay record: 3:Task:/);
});
await check('wrong arguments and unused records are errors', async () => {
  const replay = new ToolReplay([{ call_id: 1, tool: 'Bash', args_sha256: argsHash({ command: 'git status' }), response: '' }]);
  await assert.rejects(replay.call('Bash', { command: 'git diff' }), /Missing replay record/);
  assert.throws(() => replay.assertConsumed(), /Unused replay records/);
  assert.throws(() => new ToolReplay([...fixture.cases[0].records, fixture.cases[0].records[0]]), /Duplicate replay record/);
  assert.equal(replayKey(1, 'X', { a: 1, b: 2 }), replayKey(1, 'X', { b: 2, a: 1 }));
});
await check('host rejects responses bound to a different call', async () => {
  const test = fixture.cases[0];
  await assert.rejects(advanceReview({ request: test.request,
    responses: [{ call_id: 1, tool: 'Bash', args: { command: 'git status' }, response: '' }] }), /does not match request 1/);
});
await check('PR working_directory is required before source tools run', async () => {
  const test = fixture.cases.find(test => test.id === 'pr-drop-all-fresh');
  for (const working_directory of [undefined, '', '   ', 42]) {
    let calls = 0;
    await assert.rejects(runReview({ ...test.request, working_directory }, async () => {
      calls += 1;
      throw new Error('Unexpected source tool before working-directory validation');
    }), /PR working_directory must be a non-empty string/);
    assert.equal(calls, 0);
  }
});
await check('PR reviewer must explicitly return pinned context or an empty excerpt', async () => {
  const test = fixture.cases.find(test => test.id === 'pr-drop-all-fresh');
  for (const project_context of [undefined, null, {}, 42]) {
    let validatorCalls = 0;
    await assert.rejects(runReview(test.request, async tool => {
      if (tool === 'Bash') return structuredClone(test.records[0].response);
      if (tool === 'Reviewer') return { ...structuredClone(test.records[1].response), project_context };
      validatorCalls += 1;
      throw new Error('Unexpected validator before project-context validation');
    }), /PR reviewer project_context must be a string/);
    assert.equal(validatorCalls, 0);
  }
});
await check('CLI executes the same complete journal and returns the same gate', async () => {
  const test = fixture.cases[0];
  const replay = new ToolReplay(test.records, { normalize });
  const journal = { request: test.request, responses: [] };
  let step;
  do {
    step = await advanceReview(journal);
    if (!step.done) journal.responses.push({ ...step.next, response: await replay.call(step.next.tool, step.next.args) });
  } while (!step.done);
  const helperPath = path.join(skillDir, 'references/check-workflow.mjs');
  const result = JSON.parse(execFileSync(process.execPath, [helperPath, 'run'], {
    input: JSON.stringify(journal), encoding: 'utf8', windowsHide: true,
  }));
  assert.deepEqual(result, step);
  assert.throws(() => execFileSync(process.execPath, [helperPath, 'run'], {
    input: '{', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  }));
});
await check('flat workflow installation resolves its real skill entrypoint', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-review-flat-'));
  try {
    fs.cpSync(path.join(skillDir, 'references'), path.join(sandbox, 'references'), { recursive: true });
    fs.copyFileSync(path.join(skillDir, 'SKILL.md'), path.join(sandbox, 'aif-review.md'));
    const journal = { request: fixture.cases[0].request, responses: [{ call_id: 1, tool: 'Bash',
      args: { command: 'git diff --cached' }, response: 'recorded diff' }] };
    const result = JSON.parse(execFileSync(process.execPath, [path.join(sandbox, 'references/check-workflow.mjs'), 'run'], {
      input: JSON.stringify(journal), encoding: 'utf8', windowsHide: true,
    }));
    assert.equal(result.next.tool, 'Reviewer');
    assert.equal(result.next.args.skill, fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});
await check('skill and runtime sources stayed unchanged during replay', () => {
  for (const [file, sha256] of Object.entries(report.skill.sources)) assert.equal(sourceHash(`skills/aif-review/${file}`), sha256, `Source changed during run: ${file}`);
  assert.equal(sourceHash('skills/aif-review/references/check-workflow.mjs'), report.runtime.workflow_sha256);
  assert.equal(sourceHash('scripts/lib/tool-replay.mjs'), report.runtime.replay_sha256);
});

report.pass = failed === 0;
const reportIndex = process.argv.indexOf('--report');
if (reportIndex >= 0) assert(process.argv[reportIndex + 1], '--report requires an output path');
const outputPath = reportIndex >= 0 ? path.resolve(process.argv[reportIndex + 1])
  : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aif-review-replay-')), 'report.json');
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.cases.filter(test => test.pass).length}/${report.cases.length} replay scenarios; ${report.checks.length} harness checks. Report: ${outputPath}`);
process.exitCode = failed ? 1 : 0;
