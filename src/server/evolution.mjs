// ─── Skill Evolution Engine ─────────────────────────────────
// Handles auto-skill authoring, chain-to-skill promotion, and
// tracking skill lineage through generations.

import crypto from 'crypto';

/**
 * Build the LLM prompt for distilling a source into a skill.
 * Source-agnostic: works with conversations, directories, URLs, or notes.
 *
 * @param {string} sourceType - 'conversation' | 'directory' | 'url' | 'notes'
 * @param {string} sourceContent - the gathered text to feed the LLM
 */
export function buildDistillPrompt(sourceType, sourceContent) {
  const headerLabel = sourceType === 'conversation'
    ? '## Conversation History'
    : '## Source Material';

  return `You are Aimi, analyzing ${sourceType === 'conversation' ? 'a user conversation' : 'source material'} to auto-author a reusable skill for Cardinal Frame.

${headerLabel}
${sourceContent}

## Task
Based on this ${sourceType === 'conversation' ? 'conversation' : 'material'}, create a reusable skill that can handle similar requests in the future.
The skill should be a JavaScript function body (no function wrapper) that receives \`input\` and returns a result.

Available in the skill context:
- input: the user's input (string or object)
- llmCall(messages, model): async function to call the LLM
- fetch(url, opts): fetch API
- JSON, console, setTimeout, secrets (env vars)

Respond as JSON:
{
  "name": "skill-name-kebab-case",
  "description": "What this skill does",
  "category": "general|coding|research|automation|web|data",
  "handler_type": "script|hybrid|template",
  "handler": "the handler code or template string",
  "parameters": {},
  "trigger": "comma,separated,trigger,words",
  "confidence": 0.0-1.0
}

## Handler Types
- "script": Pure JS function body. Receives input, returns output. No LLM access.
- "hybrid:": Can call llmCall(), fetch(), execSync (allowlisted). More powerful.
- "template:": An LLM system prompt template. The user's input becomes the user message.

## Rules
1. Keep handlers short — under 50 lines
2. Use "hybrid:" prefix for handlers that need LLM calls
3. Use "template:" for simple prompt-based skills
4. Include good triggers — keywords that would match this skill in natural language
5. Set confidence based on how clearly the pattern emerged (0.5-0.9)`;
}

/**
 * Build the LLM prompt for evaluating if a chain should be promoted to a skill.
 */
export function buildEvolutionPrompt(chain, executionHistory) {
  const runs = executionHistory.map(r =>
    `Run ${r.ok ? '✓' : '✗'} ${r.duration_ms}ms — output: ${(typeof r.final_output === 'string' ? r.final_output : JSON.stringify(r.final_output || '')).slice(0, 200)}`
  ).join('\n');

  const steps = chain.steps.map((s, i) =>
    `Step ${i + 1}: ${s.skill_name || s.tool_name} — ${JSON.stringify(s.input_mapping || {})}`
  ).join('\n');

  return `You are Aimi, evaluating whether a skill chain should be promoted to a single evolved skill.

## Chain: ${chain.name}
${chain.description}

## Steps
${steps}

## Recent Execution History (${executionHistory.length} runs, ${executionHistory.filter(r => r.ok).length} successful)
${runs}

## Task
Analyze whether this chain is stable enough to be promoted into a single bundled skill.
A bundled skill runs all the chain's steps internally as a single skill call.

Respond as JSON:
{
  "should_promote": true/false,
  "reason": "Why or why not",
  "skill_name": "evolved-skill-name",
  "skill_description": "What the evolved skill does",
  "handler_type": "hybrid",
  "handler": "The hybrid handler code that replicates the chain's logic as a single skill function",
  "confidence": 0.0-1.0
}

## Rules
1. Only promote if success rate >= 80% and at least 3 runs
2. The handler should replicate the chain's data flow internally
3. Keep it under 80 lines
4. Use llmCall() for any LLM steps
5. The handler receives input and should return the final output`;
}

/**
 * Security scanner for external skills (from skill hub).
 * Checks for dangerous patterns in handler code.
 */
export function scanSkillHandler(handlerCode, skillName) {
  const issues = [];
  const code = handlerCode || '';

  // Dangerous patterns — covers direct, bracket-access, and concat-obfuscation variants
  const dangerPatterns = [
    { pattern: /require\s*\(\s*['"]child_process['"]\s*\)|import\s+.*child_process|child_process/, severity: 'critical', msg: 'Direct child_process access' },
    { pattern: /require\s*\(\s*['"]fs['"]\s*\)|import\s+fs|\bfs\b\s*[\[.]/, severity: 'high', msg: 'Direct filesystem access' },
    { pattern: /require\s*\(\s*['"]net['"]\s*\)|require\s*\(\s*['"]http['"]\s*\)|require\s*\(\s*['"]https['"]\s*\)|\bnet\b\s*[\[.]|\bhttps?\b\s*[\[.]/, severity: 'high', msg: 'Direct network module access' },
    { pattern: /require\s*\(\s*['"]crypto['"]\s*\)|\bcrypto\b\s*[\[.]/, severity: 'medium', msg: 'Crypto module access' },
    { pattern: /\beval\b\s*[\s(]|new\s+Function\s*\(|\bglobalThis\b\s*\[\s*['"]eval['"]/, severity: 'critical', msg: 'Dynamic code evaluation (eval/Function)' },
    // Catch bracket-access and concat bypasses: x["eval"], x["ev"+"al"], globalThis["eval"]
    { pattern: /\[\s*['"]eval['"]|['"]eval['"]\s*\]|['"]ev['"]\s*\+\s*['"]al['"]/, severity: 'critical', msg: 'Obfuscated eval access' },
    { pattern: /\[\s*['"]exec['"]|['"]exec['"]\s*\]|['"]ex['"]\s*\+\s*['"]ec['"]/, severity: 'high', msg: 'Obfuscated exec access' },
    { pattern: /\.exec\s*\(|\.execSync\s*\(|\[\s*['"]execSync['"]|['"]execSync['"]\s*\]/, severity: 'high', msg: 'Shell execution — verify allowlist' },
    { pattern: /process\s*\[\s*['"]env['"]|process\.env/i, severity: 'medium', msg: 'Direct process.env access (should use secrets param)' },
    { pattern: /process\s*\[\s*['"]exit['"]|process\.exit/i, severity: 'critical', msg: 'Can kill the process' },
    { pattern: /__proto__|\.constructor\s*\[|\[\s*['"]constructor['"]|prototype\s*\[/, severity: 'critical', msg: 'Prototype pollution risk' },
    { pattern: /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/, severity: 'high', msg: 'Infinite loop risk' },
    { pattern: /setInterval\s*\(\s*[^,]+,\s*0\s*\)/, severity: 'medium', msg: 'Zero-delay interval (resource exhaustion)' },
    // Catch dynamic require with variable args
    { pattern: /require\s*\(\s*[^'"]/, severity: 'high', msg: 'Dynamic require (non-literal argument)' },
  ];

  for (const check of dangerPatterns) {
    if (check.pattern.test(code)) {
      issues.push({ severity: check.severity, message: check.msg, pattern: check.pattern.source });
    }
  }

  // Check for obfuscated code
  const longStrings = code.match(/['"`][^\s'"`]{200,}['"`]/g);
  if (longStrings) {
    issues.push({ severity: 'high', message: 'Contains unusually long string literals (possible obfuscation)' });
  }

  // Determine overall verdict
  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const highCount = issues.filter(i => i.severity === 'high').length;
  const mediumCount = issues.filter(i => i.severity === 'medium').length;

  let verdict = 'passed';
  if (criticalCount > 0) verdict = 'blocked';
  else if (highCount > 0) verdict = 'failed';

  // Trust score: 1.0 for clean, reduce for each severity tier
  let trustScore = 1.0;
  if (criticalCount > 0) trustScore = 0.0;
  else if (highCount > 0) trustScore = 0.3;
  else if (mediumCount > 0) trustScore = 0.6;

  return {
    skill_name: skillName,
    verdict,
    issues,
    trust_score: trustScore,
    scanned_at: new Date().toISOString(),
  };
}

/**
 * Evaluate chain execution history and decide if promotion is warranted.
 * Returns null if not ready, or an evolution recommendation.
 */
export function shouldEvolveChain(chain, executionHistory) {
  const runs = executionHistory || [];
  const successCount = runs.filter(r => r.ok).length;
  const totalCount = runs.length;

  if (totalCount < 3) return { ready: false, reason: `Need 3+ runs, have ${totalCount}` };
  if (successCount / totalCount < 0.8) return { ready: false, reason: `Success rate ${(successCount/totalCount*100).toFixed(0)}% < 80%` };

  return {
    ready: true,
    success_rate: successCount / totalCount,
    total_runs: totalCount,
  };
}
