#!/usr/bin/env node
// Unit tests for check-langgraph-plan.js. Plain assert, zero deps, exit 0/1.
'use strict';
const assert = require('assert');
const h = require('../scripts/check-langgraph-plan.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('FAIL  ' + name + ' :: ' + e.message); }
}

// ---------- boundary scan ----------

t('provider token hit, plan source', () => {
  const hits = h.scanBoundary('We add a ChatOpenAI node to the graph.', 'plan');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].category, 'provider');
  assert.strictEqual(hits[0].negated, false);
});

t('negation guard: NOT before token -> negated:true', () => {
  const hits = h.scanBoundary('We will NOT call the LLM provider in this phase.', 'plan');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].negated, true);
});

t('negation in a DIFFERENT sentence does not negate', () => {
  const hits = h.scanBoundary('We do not change tests. The node uses ChatAnthropic.', 'plan');
  const prov = hits.find(x => x.category === 'provider');
  assert.ok(prov);
  assert.strictEqual(prov.negated, false);
});

t('persistence + prisma + network + secrets banks all fire', () => {
  const text = 'Add a checkpointer with MemorySaver. Run prisma migrate. Call fetch("https://x"). Read process.env.OPENAI_API_KEY.';
  const cats = new Set(h.scanBoundary(text, 'plan').map(x => x.category));
  for (const c of ['persistence', 'prisma', 'network', 'secrets']) assert.ok(cats.has(c), 'missing ' + c);
});

// ---------- graph extraction ----------

const LINEAR = `
const g = new StateGraph(S)
  .addNode("a", fa)
  .addNode("b", fb)
  .addEdge(START, "a")
  .addEdge("a", "b")
  .addEdge("b", END);`;

t('literal nodes + edges extracted', () => {
  const g = h.extractGraph(LINEAR);
  assert.deepStrictEqual(g.nodes.sort(), ['a', 'b']);
  assert.strictEqual(g.edges.length, 3);
  assert.strictEqual(g.parseLimited, false);
});

t('reachability: clean linear graph has no findings', () => {
  const g = h.extractGraph(LINEAR);
  const r = h.reachability(g.nodes, g.edges);
  assert.deepStrictEqual(r.unreachable, []);
  assert.deepStrictEqual(r.no_path_to_end, []);
  assert.strictEqual(r.missing_end, false);
});

t('unreachable node detected', () => {
  const code = LINEAR + '\ng.addNode("orphan", fo);';
  const g = h.extractGraph(code);
  const r = h.reachability(g.nodes, g.edges);
  assert.deepStrictEqual(r.unreachable, ['orphan']);
});

t('missing END edge -> missing_end + all nodes flagged', () => {
  const code = `g.addNode("a", fa).addNode("b", fb).addEdge(START, "a").addEdge("a", "b");`;
  const g = h.extractGraph(code);
  const r = h.reachability(g.nodes, g.edges);
  assert.strictEqual(r.missing_end, true);
  assert.deepStrictEqual(r.no_path_to_end.sort(), ['a', 'b']);
});

t('conditional edges with literal mapping become edges', () => {
  const code = `g.addNode("a", fa).addNode("b", fb).addEdge(START, "a")
    .addConditionalEdges("a", route, { go: "b", stop: END }).addEdge("b", END);`;
  const g = h.extractGraph(code);
  assert.strictEqual(g.parseLimited, false);
  assert.ok(g.edges.some(e => e.from === 'a' && e.to === 'b' && e.conditional));
});

t('dynamic wiring -> parse_limited, reachability suppressed in analyze()', () => {
  const code = `for (const n of names) g.addNode(n, fns[n]); g.addEdge(START, names[0]);`;
  const res = h.analyze({ plan_text: 'wire nodes dynamically from config '.repeat(8), cited: [{ path: 'x.ts', content: code }] });
  assert.strictEqual(res.parse_limited, true);
  assert.strictEqual(res.graph.reachability_suppressed, true);
  assert.deepStrictEqual(res.graph.unreachable, []);
});

// ---------- analyze-level contracts ----------

t('mismatch: plan claims offline, cited file imports provider', () => {
  const res = h.analyze({
    plan_text: 'This change is fixture-only and offline. We extend the fixture graph with one node. '.repeat(3),
    cited: [{ path: 'g.ts', content: 'import { ChatAnthropic } from "@langchain/anthropic";\n' + LINEAR }]
  });
  assert.ok(res.mismatches.length >= 1);
});

t('no mismatch when offline claim holds (clean cited file)', () => {
  const res = h.analyze({
    plan_text: 'This change is fixture-only and offline. We extend the fixture graph with one node. '.repeat(3),
    cited: [{ path: 'g.ts', content: LINEAR }]
  });
  assert.strictEqual(res.mismatches.length, 0);
});

t('thin input flagged (short, nothing cited)', () => {
  const res = h.analyze({ plan_text: 'improve the graph somehow', cited: [] });
  assert.strictEqual(res.thin_input, true);
});

t('state shape: StateGraph without Annotation.Root reported', () => {
  const res = h.analyze({ plan_text: 'extend graph state with a field for routing decisions '.repeat(5), cited: [{ path: 'g.ts', content: LINEAR }] });
  assert.strictEqual(res.state_shape.stategraph_present, true);
  assert.strictEqual(res.state_shape.annotation_root_present, false);
});

t('analyze never throws on garbage input', () => {
  const res = h.analyze({ plan_text: null, cited: [{ path: null, content: undefined }] });
  assert.ok(res && typeof res === 'object');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
