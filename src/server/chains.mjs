// ─── Skill & Tool Chain Execution Engine ─────────────────────────
// Chains are linear pipelines where each step's output feeds the next.
// Input mapping syntax:
//   "$prev.output"  — previous step's full output
//   "$prev.field"  — field from previous step's output
//   "$step[N].output" / "$step[N].field" — specific step reference
//   "$input"       — the initial chain input
//   literal values — passed through as-is

/**
 * Resolve a mapping reference like "$prev.output" or "$step[2].title" against step results.
 * @param {string} ref  - The reference string
 * @param {array}  stepResults - Array of { input, output } for each completed step
 * @param {*}      chainInput - The original input to the chain
 * @returns{*} resolved value or the original ref if it's a literal
 */
export function resolveMapping(ref, stepResults, chainInput) {
  if (typeof ref !== 'string') return ref;
  if (!ref.startsWith('$')) return ref;

  // $input — chain's initial input
  if (ref === '$input') return chainInput;
  if (ref.startsWith('$input.')) {
    const field = ref.slice('$input.'.length);
    return typeof chainInput === 'object' && chainInput ? chainInput[field] : undefined;
  }

  // $prev — previous step (last in stepResults)
  if (ref === '$prev.output') {
    const prev = stepResults[stepResults.length - 1];
    return prev ? prev.output : undefined;
  }
  if (ref.startsWith('$prev.')) {
    const field = ref.slice('$prev.'.length);
    const prev = stepResults[stepResults.length - 1];
    if (!prev) return undefined;
    if (field === 'output') return prev.output;
    return typeof prev.output === 'object' && prev.output ? prev.output[field] : undefined;
  }

  // $step[N] — specific step by index
  const stepMatch = ref.match(/^\$step\[(\d+)\]\.(.+)$/);
  if (stepMatch) {
    const idx = parseInt(stepMatch[1], 10);
    const field = stepMatch[2];
    const step = stepResults[idx];
    if (!step) return undefined;
    if (field === 'output') return step.output;
    return typeof step.output === 'object' && step.output ? step.output[field] : undefined;
  }

  // $step[N].output (exact)
  const stepOutputMatch = ref.match(/^\$step\[(\d+)\]\.output$/);
  if (stepOutputMatch) {
    const idx = parseInt(stepOutputMatch[1], 10);
    return stepResults[idx]?.output;
  }

  return ref; // literal string that happens to start with $
}

/**
 * Build the input object for a chain step by resolving all mapping references.
 * @param {object} step - The chain step definition
 * @param {array}  stepResults - Completed step results so far
 * @param {*}      chainInput - Original chain input
 * @returns {object} resolved input for the step
 */
export function resolveStepInput(step, stepResults, chainInput) {
  const input = {};

  // Start with input_mapping (references to previous steps)
  if (step.input_mapping) {
    for (const [key, ref] of Object.entries(step.input_mapping)) {
      input[key] = resolveMapping(ref, stepResults, chainInput);
    }
  }

  // Apply input_override (literal values that take precedence)
  if (step.input_override) {
    for (const [key, val] of Object.entries(step.input_override)) {
      input[key] = val;
    }
  }

  // If no mappings, fall back to prev output passthrough
  if (Object.keys(input).length === 0 && stepResults.length > 0) {
    const prev = stepResults[stepResults.length - 1];
    return prev.output;
  }

  // If still empty and this is step 0, use chain input
  if (Object.keys(input).length === 0 && stepResults.length === 0) {
    return chainInput;
  }

  return input;
}

/**
 * Execute a skill chain step by step.
 * @param {object} chain - { steps: [...], name }
 * @param {*}      input  - Initial input to the chain
 * @param {function} executeSkillFn - async (skill, input) => result
 * @param {function} broadcastFn - optional (type, payload) => void for WS updates
 * @returns {object} { ok, results, error, step_failed }
 */
export async function executeSkillChain(chain, input, executeSkillFn, broadcastFn = null, governance = null) {
  const steps = typeof chain.steps === 'string' ? JSON.parse(chain.steps) : chain.steps;
  const stepResults = [];
  const startTime = Date.now();
  const { checkPermission, auditLog, persona } = governance || {};

  if (broadcastFn) broadcastFn('chain:step:start', { chainName: chain.name, stepIndex: 0, totalSteps: steps.length });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = Date.now();
    const stepName = step.name || step.skill_name || `Step ${i + 1}`;

    // ─── Governance: permission check before execution ───
    if (checkPermission && persona) {
      const action = `skill:${step.skill_name || step.name || 'unnamed'}`;
      const perm = checkPermission(persona, action, step);
      auditLog?.(action, { chain: chain.name, step: stepName, allowed: perm.allowed });
      if (!perm.allowed) {
        const stepResult = {
          stepIndex: i, stepName, ok: false,
          error: `Governance: ${perm.reason}`,
          duration_ms: Date.now() - stepStart,
          governance_denied: true,
        };
        stepResults.push(stepResult);
        if (broadcastFn) broadcastFn('chain:step:governance_denied', {
          chainName: chain.name, stepIndex: i, stepName, reason: perm.reason,
        });
        if (!step.continue_on_error) {
          return { ok: false, error: `Step ${i + 1} denied by governance: ${perm.reason}`, step_failed: i, results: stepResults, duration_ms: Date.now() - startTime };
        }
        continue;
      }
    }

    try {
      const resolvedInput = resolveStepInput(step, stepResults, input);

      if (broadcastFn) broadcastFn('chain:step:running', {
        chainName: chain.name,
        stepIndex: i,
        stepName,
        input: typeof resolvedInput === 'string' ? resolvedInput.slice(0, 200) : '(object)',
      });

      // Execute the skill — caller provides the skill object
      const result = await executeSkillFn(step, resolvedInput);

      const stepResult = {
        stepIndex: i,
        stepName,
        input: resolvedInput,
        output: result.output ?? result,
        ok: result.ok ?? true,
        duration_ms: Date.now() - stepStart,
        error: result.error || null,
      };

      stepResults.push(stepResult);

      if (broadcastFn) broadcastFn('chain:step:done', {
        chainName: chain.name,
        stepIndex: i,
        ok: stepResult.ok,
        duration_ms: stepResult.duration_ms,
      });

      // Stop chain on step failure unless step.continue_on_error is set
      if (!stepResult.ok && !step.continue_on_error) {
        if (broadcastFn) broadcastFn('chain:failed', {
          chainName: chain.name,
          stepIndex: i,
          error: stepResult.error,
        });
        return {
          ok: false,
          error: `Step ${i + 1} (${stepResult.stepName}) failed: ${stepResult.error}`,
          step_failed: i,
          results: stepResults,
          duration_ms: Date.now() - startTime,
        };
      }
    } catch (err) {
      stepResults.push({
        stepIndex: i,
        stepName: step.skill_name || step.name || `Step ${i + 1}`,
        ok: false,
        error: err.message,
        duration_ms: Date.now() - stepStart,
      });

      if (broadcastFn) broadcastFn('chain:failed', {
        chainName: chain.name,
        stepIndex: i,
        error: err.message,
      });

      if (!step.continue_on_error) {
        return {
          ok: false,
          error: `Step ${i + 1} threw: ${err.message}`,
          step_failed: i,
          results: stepResults,
          duration_ms: Date.now() - startTime,
        };
      }
    }
  }

  if (broadcastFn) broadcastFn('chain:complete', {
    chainName: chain.name,
    totalSteps: steps.length,
    duration_ms: Date.now() - startTime,
  });

  return {
    ok: true,
    results: stepResults,
    final_output: stepResults.length > 0 ? stepResults[stepResults.length - 1].output : null,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Execute a tool chain — each step calls an API endpoint and passes results forward.
 * @param {object} chain - { steps: [...], name }
 * @param {*}      input  - Initial input
 * @param {function} callToolFn - async (step, resolvedInput) => result
 * @param {function} broadcastFn - optional WS broadcaster
 */
export async function executeToolChain(chain, input, callToolFn, broadcastFn = null, governance = null) {
  const steps = typeof chain.steps === 'string' ? JSON.parse(chain.steps) : chain.steps;
  const stepResults = [];
  const startTime = Date.now();
  const { checkPermission, auditLog, persona } = governance || {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = Date.now();
    const stepName = step.name || step.tool_name || `Step ${i + 1}`;

    // ─── Governance: permission check before execution ───
    if (checkPermission && persona) {
      const action = `tool:${step.tool_name || step.name || 'unnamed'}`;
      const perm = checkPermission(persona, action, step);
      auditLog?.(action, { chain: chain.name, step: stepName, allowed: perm.allowed });
      if (!perm.allowed) {
        stepResults.push({
          stepIndex: i, stepName, ok: false,
          error: `Governance: ${perm.reason}`,
          duration_ms: Date.now() - stepStart,
          governance_denied: true,
        });
        if (broadcastFn) broadcastFn('chain:tool:governance_denied', {
          chainName: chain.name, stepIndex: i, stepName, reason: perm.reason,
        });
        if (!step.continue_on_error) {
          return { ok: false, error: `Tool step ${i + 1} denied by governance: ${perm.reason}`, step_failed: i, results: stepResults, duration_ms: Date.now() - startTime };
        }
        continue;
      }
    }

    try {
      const resolvedInput = resolveStepInput(step, stepResults, input);

      if (broadcastFn) broadcastFn('chain:tool:running', {
        chainName: chain.name,
        stepIndex: i,
        stepName,
      });

      const result = await callToolFn(step, resolvedInput);

      const stepResult = {
        stepIndex: i,
        stepName,
        input: resolvedInput,
        output: result,
        ok: !result?.error,
        duration_ms: Date.now() - stepStart,
        error: result?.error || null,
      };

      stepResults.push(stepResult);

      if (broadcastFn) broadcastFn('chain:tool:done', {
        chainName: chain.name,
        stepIndex: i,
        ok: stepResult.ok,
        duration_ms: stepResult.duration_ms,
      });

      if (!stepResult.ok && !step.continue_on_error) {
        return {
          ok: false,
          error: `Tool step ${i + 1} (${stepResult.stepName}) failed: ${stepResult.error}`,
          step_failed: i,
          results: stepResults,
          duration_ms: Date.now() - startTime,
        };
      }
    } catch (err) {
      stepResults.push({
        stepIndex: i,
        stepName: step.tool_name || step.name || `Step ${i + 1}`,
        ok: false,
        error: err.message,
        duration_ms: Date.now() - stepStart,
      });

      if (!step.continue_on_error) {
        return {
          ok: false,
          error: `Tool step ${i + 1} threw: ${err.message}`,
          step_failed: i,
          results: stepResults,
          duration_ms: Date.now() - startTime,
        };
      }
    }
  }

  return {
    ok: true,
    results: stepResults,
    final_output: stepResults.length > 0 ? stepResults[stepResults.length - 1].output : null,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Build the LLM system prompt for Aimi to understand chain-building intent.
 * Aimi sees all available skills/tools and maps user's natural language request
 * to a structured chain definition with correct input mappings.
 */
export function buildChainIntentPrompt(type, availableSkills, availableTools) {
  const isSkill = type === 'skill';

  const skillList = availableSkills.map(s =>
    `- ${s.name}: ${s.description || '(no description)'} [category: ${s.category || 'general'}]`
  ).join('\n');

  const toolList = availableTools.map(t =>
    `- ${t.name}: ${t.description || '(no description)'} (${t.method} ${t.endpoint})`
  ).join('\n');

  return `You are Aimi, the AI system operator for Cardinal Frame. The user wants to create a ${isSkill ? 'skill' : 'tool'} chain — a linear pipeline where the output of each step feeds as input to the next.

## Available ${isSkill ? 'Skills' : 'Tools'}
${isSkill ? skillList : toolList}

## Input Mapping Syntax
When connecting steps, use these references in the "input_mapping" field:
- "$prev.output" — pass the entire output of the previous step
- "$prev.fieldName" — pass a specific field from previous step's output object
- "$step[N].output" — pass output of step at index N (0-based)
- "$step[N].fieldName" — pass a field from step N's output
- "$input" — pass the original chain input

Use "input_override" for literal fixed values (e.g., { "limit": 5 }).

## Chain Step Format
Each step must be a JSON object:
${isSkill ? `{
  "skill_name": "exact-skill-name",
  "name": "short descriptive step name (e.g. \"Check System Health\")",
  "input_mapping": { "param": "$prev.output" },
  "input_override": { "fixed_param": "value" },
  "continue_on_error": false
}` : `{
  "tool_name": "exact tool name",
  "method": "GET or POST",
  "endpoint": "/api/...",
  "name": "short descriptive step name (e.g. \"Check System Health\")",
  "input_mapping": { "param": "$prev.field" },
  "input_override": {},
  "continue_on_error": false
}`}

## Rules
1. Only use ${isSkill ? 'skills' : 'tools'} from the list above — use exact names
2. Think about data flow: what does each step output, and what does the next step need?
3. Use "input_mapping" to connect outputs to inputs between steps
4. Use "input_override" for fixed parameters (limits, options, etc.)
5. Keep chains to max 6 steps — be focused
6. Set "continue_on_error: true" only if a step is optional/safe to skip
7. If the user's request maps to a single step, create a 1-step chain

Respond as JSON only:
{
  "name": "a name that says what the chain does (2-5 words, kebab-case, e.g. \"daily-status-report\")",
  "description": "What this chain does",
  "steps": [ ... ]
}

## Naming
The "name" MUST describe what the chain actually does. Never use placeholder or example names like "chain-name-kebab-case", "new-chain", or "my-chain" — the name must identify the real function.`;
}
