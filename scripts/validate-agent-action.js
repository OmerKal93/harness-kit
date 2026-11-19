#!/usr/bin/env node
// validate-agent-action.js — Phase 5 Batch 2.
// Validates a persona-scoped action against config/agent-identity-registry.json.
// Closed-by-default: tool/path/bash must explicitly allow; deny wins on conflicts.
// Classification only — never executes the action, never modifies state.
//
// Library:
//   const { validate, listPersonas, loadRegistry } = require('./validate-agent-action.js')
//   validate({ persona: "ce-correctness-reviewer", action: { tool: "Edit", file_path: "src/x.ts" } })
//     → { allowed: false, reason: "tool-deny:Edit", advisory: true, persona_id: "..." }
//
// CLI:
//   node scripts/validate-agent-action.js --persona <id> --tool <name> [--file <path>] [--bash <cmd>] [--json]
//
// Exit codes: 0 allowed, 1 denied. Honors kill switch (exit 0 silently).
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, globMatch } = require('./_lib.js');
const { redactString } = require('./redact.js');

const REGISTRY_PATH = path.join(harnessRoot(), 'config', 'agent-identity-registry.json');
let _registryCache = null;

function loadRegistry(injected) {
  if (injected) return injected;
  if (_registryCache) return _registryCache;
  try {
    _registryCache = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    _registryCache = { schema_version: 1, personas: [], scope_families: {}, _load_error: e.message };
  }
  return _registryCache;
}

function listPersonas(injected) {
  const reg = loadRegistry(injected);
  return (reg.personas || []).map(p => ({ id: p.id, category: p.category, scope_family: p.scope_family || null }));
}

function resolveScope(persona, reg) {
  if (persona.scope && typeof persona.scope === 'object') return persona.scope;
  if (persona.scope_family && reg.scope_families && reg.scope_families[persona.scope_family]) {
    return reg.scope_families[persona.scope_family];
  }
  return null;
}

function findPersona(personaId, reg) {
  if (!personaId || typeof personaId !== 'string') return null;
  return (reg.personas || []).find(p => p.id === personaId) || null;
}

function patternMatches(patterns, value) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const p of patterns) {
    try {
      const re = new RegExp(p);
      if (re.test(value)) return true;
    } catch { /* skip bad pattern */ }
  }
  return false;
}

const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

function checkAction(scope, action) {
  const tool = action && action.tool;
  if (!tool || typeof tool !== 'string') {
    return { allowed: false, reason: 'missing-tool' };
  }
  // Network gate first — network-bearing tool with network_allowed=false is fastest deny.
  if (NETWORK_TOOLS.has(tool) && scope.network_allowed === false) {
    return { allowed: false, reason: 'network-deny:' + tool };
  }
  // Tool deny wins.
  if (Array.isArray(scope.tools_deny) && scope.tools_deny.includes(tool)) {
    return { allowed: false, reason: 'tool-deny:' + tool };
  }
  // Tool allow-list is authoritative.
  if (Array.isArray(scope.tools_allow) && !scope.tools_allow.includes(tool)) {
    return { allowed: false, reason: 'tool-not-allowed:' + tool };
  }
  // Path gating when file_path provided.
  const filePath = action.file_path;
  if (filePath && typeof filePath === 'string') {
    if (Array.isArray(scope.paths_deny_globs)) {
      for (const g of scope.paths_deny_globs) {
        if (globMatch(g, filePath)) {
          return { allowed: false, reason: 'path-deny:' + g };
        }
      }
    }
    if (Array.isArray(scope.paths_allow_globs) && scope.paths_allow_globs.length > 0) {
      let inAllow = false;
      for (const g of scope.paths_allow_globs) {
        if (globMatch(g, filePath)) { inAllow = true; break; }
      }
      if (!inAllow) {
        return { allowed: false, reason: 'path-not-allowed' };
      }
    }
  }
  // Bash gating when bash_command provided.
  if (tool === 'Bash') {
    const cmd = action.bash_command;
    if (typeof cmd !== 'string' || cmd.length === 0) {
      return { allowed: false, reason: 'bash-missing' };
    }
    if (patternMatches(scope.bash_deny_patterns, cmd)) {
      return { allowed: false, reason: 'bash-deny' };
    }
    if (!patternMatches(scope.bash_allow_patterns, cmd)) {
      return { allowed: false, reason: 'bash-not-allowed' };
    }
  }
  return { allowed: true };
}

function validate(input, injectedRegistry) {
  if (!input || typeof input !== 'object') {
    return { allowed: false, reason: 'invalid-input', advisory: true, persona_id: null };
  }
  const reg = loadRegistry(injectedRegistry);
  const personaId = input.persona;
  const persona = findPersona(personaId, reg);
  if (!persona) {
    return {
      allowed: false,
      reason: 'unknown-persona',
      advisory: true,
      persona_id: personaId || null
    };
  }
  const scope = resolveScope(persona, reg);
  if (!scope) {
    return {
      allowed: false,
      reason: 'no-scope-resolved',
      advisory: true,
      persona_id: persona.id
    };
  }
  const result = checkAction(scope, input.action || {});
  return {
    allowed: result.allowed,
    reason: result.reason || null,
    escalation_required: false,
    advisory: true,
    persona_id: persona.id
  };
}

function redactAction(action) {
  if (!action || typeof action !== 'object') return null;
  const out = {};
  if (typeof action.tool === 'string') out.tool = action.tool;
  if (typeof action.file_path === 'string') out.file_path = redactString(action.file_path);
  if (typeof action.bash_command === 'string') out.bash_command = redactString(action.bash_command);
  return out;
}

function redactResult(result, action) {
  const out = {
    allowed: result.allowed,
    advisory: true,
    persona_id: result.persona_id || null
  };
  if (result.reason) out.reason = redactString(result.reason);
  if (typeof result.escalation_required === 'boolean') out.escalation_required = result.escalation_required;
  if (action) out.action = redactAction(action);
  return out;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args.persona || args.persona === true) {
    console.error('error: --persona <id> required');
    process.exit(2);
  }
  if (!args.tool || args.tool === true) {
    console.error('error: --tool <name> required');
    process.exit(2);
  }
  const action = { tool: String(args.tool) };
  if (typeof args.file === 'string') action.file_path = args.file;
  if (typeof args.bash === 'string') action.bash_command = args.bash;

  const result = validate({ persona: String(args.persona), action });
  const redacted = redactResult(result, action);

  if (args.json !== false) {
    process.stdout.write(JSON.stringify(redacted, null, 2) + '\n');
  } else {
    if (result.allowed) {
      process.stdout.write(`ALLOWED: ${result.persona_id} → ${action.tool}\n`);
    } else {
      process.stdout.write(`DENIED: ${result.persona_id || '(unknown)'} → ${action.tool} — ${result.reason}\n`);
    }
  }
  process.exit(result.allowed ? 0 : 1);
}

module.exports = { validate, listPersonas, loadRegistry };

if (require.main === module) main();
