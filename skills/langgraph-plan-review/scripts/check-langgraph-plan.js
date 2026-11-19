#!/usr/bin/env node
// skills/langgraph-plan-review/scripts/check-langgraph-plan.js
// Deterministic, read-only helper for the langgraph-plan-review skillpack (#2).
// Scans a LangGraph/LangChain plan (+ optionally cited code files) for
// execution-boundary tokens, extracts literal graph wiring, and reports
// topology/state findings. Mutates nothing. No network. Never executes a graph.
//
// Honesty contracts:
//   - dynamic wiring (non-literal addNode/addEdge args) -> parse_limited: true,
//     reachability verdicts suppressed rather than fabricated
//   - boundary hits inside a negated clause ("we will NOT call OpenAI") are
//     reported with negated: true, never silently dropped
//   - plan claims offline/fixture-only + cited file has a live boundary hit
//     -> mismatches[]
//
// Library:  const h = require('./check-langgraph-plan.js')
//           h.analyze({ plan_text, plan_ref, cited: [{path, content}] }) -> result
// CLI:      node check-langgraph-plan.js <plan.md> [--cited <file> ...]
//           (prints JSON, exit 0; kill switch DISABLED/HARNESSKIT_DISABLED -> no-op exit 0)
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// HARNESS_ROOT seam (Batch 3-impl): resolve the harness root (used to locate is-disabled.js)
// from env, else legacy <harness-root>. Must be inline — it bootstraps the require path below.
const HARNESSKIT_ROOT = process.env.HARNESS_ROOT || process.env.HARNESSKIT_ROOT || path.join(os.homedir(), '.harnesskit');
const { isDisabled } = require(path.join(HARNESSKIT_ROOT, 'scripts', 'is-disabled.js'));

// ---------- boundary banks (category -> regex) ----------

const BOUNDARY_BANKS = {
  provider: /(ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|@langchain\/(?:openai|anthropic|google|community)|@anthropic-ai\/sdk|new\s+OpenAI\s*\(|openai\.chat|anthropic\.messages|\bprovider\s+calls?\b|call\s+the\s+(?:llm|model|provider)|\bllm\s+calls?\b)/i,
  persistence: /(checkpointer|MemorySaver|PostgresSaver|SqliteSaver|RedisSaver|persist(?:ence)?\s+(?:layer|state|graph)|save\s+state\s+to\s+(?:db|database|disk))/i,
  prisma: /(\bprisma\b|PrismaClient|schema\.prisma|\b(?:db|database|data)\s+migrations?\b|prisma\s+migrate)/i,
  network: /(\bfetch\s*\(|\baxios\b|http\.request|wss?:\/\/|websocket|XMLHttpRequest|\bcurl\s+http)/i,
  secrets: /(process\.env\.[A-Z0-9_]+|\bAPI[_-]?KEYS?\b|OPENAI_API_KEY|ANTHROPIC_API_KEY|\.env\b|\bsecret\s+key\b)/i
};

const NEGATION = /\b(not|never|no|none|without|forbidden|prohibit(?:ed|s)?|avoid(?:s|ed)?|won'?t|will\s+not|must\s+not|do(?:es)?\s+not|don'?t|reject(?:s|ed)?)\b/i;

const OFFLINE_CLAIM = /\b(fixture-?only|offline|no\s+providers?|no\s+network|fully\s+deterministic|no\s+external\s+calls?)\b/i;

// ---------- helpers ----------

function sentences(text) {
  // newline counts as a sentence boundary so list items are judged independently
  return String(text).split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim());
}

// A hit is negated when a negation token appears before the matched token
// inside the same sentence ("we will NOT call OpenAI").
function scanBoundary(text, source) {
  const hits = [];
  for (const sentence of sentences(text)) {
    for (const [category, re] of Object.entries(BOUNDARY_BANKS)) {
      const m = sentence.match(re);
      if (!m) continue;
      const before = sentence.slice(0, m.index);
      hits.push({
        category,
        token: m[0].slice(0, 60),
        source,
        negated: NEGATION.test(before),
        context: sentence.trim().slice(0, 160)
      });
    }
  }
  return hits;
}

// ---------- graph extraction (literal wiring only) ----------

const RE_NODE = /\.addNode\s*\(\s*["'`]([\w-]+)["'`]/g;
const RE_EDGE = /\.addEdge\s*\(\s*(START|["'`][\w-]+["'`])\s*,\s*(END|["'`][\w-]+["'`])\s*\)/g;
const RE_COND = /\.addConditionalEdges\s*\(\s*(START|["'`][\w-]+["'`])/g;
const RE_DYNAMIC = /\.add(?:Node|Edge|ConditionalEdges)\s*\(\s*(?!START\b|END\b|["'`])/;

function lit(token) {
  if (token === 'START' || token === 'END') return token;
  return token.slice(1, -1);
}

function extractGraph(content) {
  const nodes = new Set();
  const edges = [];
  const condSources = [];
  let parseLimited = false;
  const reasons = [];

  let m;
  while ((m = RE_NODE.exec(content)) !== null) nodes.add(m[1]);
  while ((m = RE_EDGE.exec(content)) !== null) edges.push({ from: lit(m[1]), to: lit(m[2]) });
  while ((m = RE_COND.exec(content)) !== null) {
    const src = lit(m[1]);
    condSources.push(src);
    // literal targets inside the mapping object directly following the call
    const tail = content.slice(m.index, m.index + 400);
    const targets = [...tail.matchAll(/:\s*["'`]([\w-]+)["'`]|:\s*(END)\b/g)]
      .map(t => t[1] || t[2]).filter(Boolean);
    if (targets.length) {
      for (const t of targets) edges.push({ from: src, to: t, conditional: true });
    } else {
      parseLimited = true;
      reasons.push(`conditional edges from "${src}" have no literal target mapping`);
    }
  }
  if (RE_DYNAMIC.test(content)) {
    parseLimited = true;
    reasons.push('dynamic (non-literal) addNode/addEdge/addConditionalEdges argument');
  }
  return { nodes: [...nodes], edges, condSources, parseLimited, reasons };
}

function reachability(nodes, edges) {
  const fwd = new Map(), rev = new Map();
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  for (const e of edges) { add(fwd, e.from, e.to); add(rev, e.to, e.from); }
  const bfs = (start, map) => {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      for (const n of map.get(q.shift()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    return seen;
  };
  const fromStart = bfs('START', fwd);
  const toEnd = bfs('END', rev);
  const hasEndEdge = edges.some(e => e.to === 'END');
  return {
    unreachable: nodes.filter(n => !fromStart.has(n)),
    no_path_to_end: hasEndEdge ? nodes.filter(n => !toEnd.has(n)) : [...nodes],
    missing_end: !hasEndEdge
  };
}

// ---------- state shape ----------

function stateShape(citedContents) {
  const joined = citedContents.join('\n');
  const usesStateGraph = /\bStateGraph\b/.test(joined);
  return {
    stategraph_present: usesStateGraph,
    annotation_root_present: /Annotation\.Root\s*\(/.test(joined),
    reducer_present: /\breducer\s*:/.test(joined),
    any_typed_state: /:\s*any\b/.test(joined)
  };
}

// ---------- main analysis ----------

function analyze(input) {
  const planText = String((input && input.plan_text) || '');
  const cited = (input && input.cited) || [];

  const boundaryHits = scanBoundary(planText, 'plan');
  const citedContents = [];
  let graph = { nodes: [], edges: [], condSources: [], parseLimited: false, reasons: [] };

  for (const c of cited) {
    const content = String(c.content || '');
    citedContents.push(content);
    boundaryHits.push(...scanBoundary(content, 'file:' + (c.path || 'unnamed')));
    const g = extractGraph(content);
    graph.nodes.push(...g.nodes.filter(n => !graph.nodes.includes(n)));
    graph.edges.push(...g.edges);
    graph.condSources.push(...g.condSources);
    graph.parseLimited = graph.parseLimited || g.parseLimited;
    graph.reasons.push(...g.reasons);
  }

  // honesty: with dynamic wiring present, never claim reachability findings
  const topo = graph.parseLimited
    ? { unreachable: [], no_path_to_end: [], missing_end: false, suppressed: true }
    : (graph.nodes.length ? { ...reachability(graph.nodes, graph.edges), suppressed: false }
                          : { unreachable: [], no_path_to_end: [], missing_end: false, suppressed: false });

  // plan-vs-code mismatch: non-negated offline claim in plan + live boundary hit in a cited file
  const offlineClaimed = sentences(planText).some(s => OFFLINE_CLAIM.test(s) && !NEGATION.test(s.split(OFFLINE_CLAIM.exec(s)[0])[0] || ''));
  const liveFileHits = boundaryHits.filter(h =>
    h.source.startsWith('file:') && !h.negated &&
    ['provider', 'persistence', 'network'].includes(h.category));
  const mismatches = (offlineClaimed && liveFileHits.length)
    ? liveFileHits.map(h => ({ claim: 'plan claims offline/fixture-only', contradiction: h }))
    : [];

  const inputSignals = {
    chars: planText.length,
    lines: planText.split(/\r?\n/).filter(l => l.trim()).length,
    cited_count: cited.length,
    graph_terms: /\b(langgraph|langchain|stategraph|addnode|addedge|node|edge|graph)\b/i.test(planText)
  };

  const summary = {};
  for (const h of boundaryHits) {
    summary[h.category] = summary[h.category] || { total: 0, negated: 0 };
    summary[h.category].total++;
    if (h.negated) summary[h.category].negated++;
  }

  return {
    schema_version: 1,
    plan_ref: (input && input.plan_ref) || null,
    boundary_hits: boundaryHits,
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      unreachable: topo.unreachable,
      no_path_to_end: topo.no_path_to_end,
      missing_end: topo.missing_end,
      reachability_suppressed: topo.suppressed,
      conditional_sources: graph.condSources
    },
    parse_limited: graph.parseLimited,
    parse_limited_reasons: graph.reasons,
    state_shape: cited.length ? stateShape(citedContents) : null,
    mismatches,
    input_signals: inputSignals,
    thin_input: inputSignals.chars < 200 && inputSignals.cited_count === 0,
    boundary_summary: summary
  };
}

module.exports = { analyze, scanBoundary, extractGraph, reachability, BOUNDARY_BANKS };

// ---------- CLI ----------

if (require.main === module) {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ disabled: true, reason: dis.reason })); process.exit(0); }
  const args = process.argv.slice(2);
  const planPath = args.find(a => !a.startsWith('--'));
  if (!planPath) { console.error('usage: check-langgraph-plan.js <plan.md> [--cited <file> ...]'); process.exit(1); }
  const cited = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cited' && args[i + 1]) {
      try { cited.push({ path: args[i + 1], content: fs.readFileSync(args[i + 1], 'utf8') }); }
      catch { cited.push({ path: args[i + 1], content: '', read_error: true }); }
      i++;
    }
  }
  let planText = '';
  try { planText = fs.readFileSync(planPath, 'utf8'); }
  catch (e) { console.error('cannot read plan: ' + e.message); process.exit(1); }
  console.log(JSON.stringify(analyze({ plan_text: planText, plan_ref: planPath, cited }), null, 2));
  process.exit(0);
}
