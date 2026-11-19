#!/usr/bin/env node
// tool-risk-classifier.js — Phase 4 Batch 3.
// Classify a tool call into one of {read, write, exec, network, unknown}.
// Classification only — no enforcement. Library + CLI.
//
// Library:
//   const { classify } = require('./tool-risk-classifier.js')
//   classify({ tool_name: 'Edit', tool_input: { ... } }) // → { class: 'write', reasons: [...] }
//
// CLI:
//   node scripts/tool-risk-classifier.js --tool <name> [--input <json>] [--json]
//   echo '{"tool_name":"Bash","tool_input":{...}}' | node scripts/tool-risk-classifier.js --stdin
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const { isDisabled } = require('./is-disabled.js');
const { parseArgs } = require('./_lib.js');
const { redactString } = require('./redact.js');

const READ_TOOLS = new Set([
  'Read', 'Grep', 'Glob',
  'NotebookRead',
  'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'TaskGet', 'TaskList', 'TaskOutput',
  'ToolSearch'
]);

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit',
  'MultiEdit',
  'functions.apply_patch', 'apply_patch'
]);

const EXEC_TOOLS = new Set([
  'Bash', 'PowerShell',
  'Agent', 'Skill',
  'TaskCreate', 'TaskUpdate', 'TaskStop',
  'EnterWorktree', 'ExitWorktree',
  'EnterPlanMode', 'ExitPlanMode',
  'ScheduleWakeup',
  'mcp__ide__executeCode',
  'functions.shell_command', 'shell_command',
  'multi_tool_use.parallel'
]);

const NETWORK_TOOLS = new Set([
  'WebFetch', 'WebSearch',
  'CronCreate', 'CronDelete', 'CronList',
  'RemoteTrigger', 'PushNotification',
  'SendUserFile',
  'web.run'
]);

const NETWORK_MCP_PREFIXES = [
  'mcp__claude_ai_',
  'mcp__github__',
  'mcp__slack__',
  'mcp__supabase__',
  'mcp__linear__',
  'mcp__gmail__',
  'mcp__google_drive__',
  'mcp__tavily__',
  'mcp__obsidian__'
];

function normalizeName(call) {
  if (!call || typeof call !== 'object') return '';
  const candidates = [call.tool_name, call.tool, call.name, call.recipient_name];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

function classify(call) {
  const name = normalizeName(call);
  const input = (call && call.tool_input) || {};
  const reasons = [];

  if (READ_TOOLS.has(name))    { reasons.push(`read-tool-set:${name}`);    return { class: 'read',    reasons }; }
  if (WRITE_TOOLS.has(name))   { reasons.push(`write-tool-set:${name}`);   return { class: 'write',   reasons }; }
  if (EXEC_TOOLS.has(name))    { reasons.push(`exec-tool-set:${name}`);    return { class: 'exec',    reasons }; }
  if (NETWORK_TOOLS.has(name)) { reasons.push(`network-tool-set:${name}`); return { class: 'network', reasons }; }

  // MCP tools: ide subset = exec, everything else = network (remote service call).
  if (name.startsWith('mcp__')) {
    if (name.startsWith('mcp__ide__')) { reasons.push(`mcp-ide:${name}`); return { class: 'exec', reasons }; }
    for (const p of NETWORK_MCP_PREFIXES) {
      if (name.startsWith(p)) { reasons.push(`mcp-network-prefix:${p}`); return { class: 'network', reasons }; }
    }
    reasons.push(`mcp-default-network:${name}`);
    return { class: 'network', reasons };
  }

  // Shape-based fallbacks for unknown tools.
  if (typeof input.command === 'string') { reasons.push('shape:command-string'); return { class: 'exec', reasons }; }
  if (typeof input.url === 'string')     { reasons.push('shape:url'); return { class: 'network', reasons }; }
  if (typeof input.file_path === 'string' && (input.content !== undefined || input.new_string !== undefined)) {
    reasons.push('shape:write-fields'); return { class: 'write', reasons };
  }
  if (typeof input.file_path === 'string') { reasons.push('shape:file_path-only'); return { class: 'read', reasons }; }

  reasons.push('unknown-tool');
  return { class: 'unknown', reasons };
}

function readStdin() {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => buf += c);
    process.stdin.on('end', () => resolve(buf));
  });
}

async function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  let call;
  if (args.stdin) {
    const raw = await readStdin();
    try { call = JSON.parse(raw); }
    catch (e) { console.error('error: --stdin requires JSON tool call: ' + e.message); process.exit(2); }
  } else {
    if (!args.tool) { console.error('error: --tool <name> required (or --stdin)'); process.exit(2); }
    let input = {};
    if (args.input) {
      try { input = JSON.parse(args.input); }
      catch (e) { console.error('error: --input must be JSON: ' + e.message); process.exit(2); }
    }
    call = { tool_name: args.tool, tool_input: input };
  }

  const result = classify(call);
  result.tool_name = normalizeName(call);
  // Redact any reason strings that may carry tool name fragments (defensive).
  result.reasons = (result.reasons || []).map(r => redactString(String(r)));

  if (args.json !== false) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`${result.tool_name} → ${result.class}\n`);
    for (const r of result.reasons) process.stdout.write(`  ${r}\n`);
  }
  process.exit(0);
}

module.exports = { classify, normalizeName, READ_TOOLS, WRITE_TOOLS, EXEC_TOOLS, NETWORK_TOOLS, NETWORK_MCP_PREFIXES };

if (require.main === module) main();
