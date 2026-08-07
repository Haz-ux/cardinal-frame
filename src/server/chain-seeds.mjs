// ─── Seed Chain Templates ─────────────────────────────────────────
// Single source of truth for starter skill chains and tool chains.
// IMPORTANT: step references must resolve against the seeded skill
// library (SEED_SKILLS in routes/seed-skills.mjs) and the tools table
// (registered by aimi/routes at startup). Do not reference skills or
// tools that are not guaranteed to exist.

export const SEED_SKILL_CHAINS = [
  {
    name: 'research-and-summarize',
    description: 'Research a topic and summarize the findings into a concise report',
    steps: [
      { skill_name: 'web-research', name: 'Research', input_mapping: { query: '$input' } },
      { skill_name: 'paper-summarize', name: 'Summarize', input_mapping: { text: '$prev.output' } },
    ],
  },
  {
    name: 'audit-and-report',
    description: 'Run deployment audit checks and generate an actionable report',
    steps: [
      { skill_name: 'deploy-check', name: 'Audit Deploy', input_mapping: { service: '$input' } },
      { skill_name: 'log-analyzer', name: 'Analyze Logs', input_mapping: { path: '$input.path' } },
      { skill_name: 'paper-summarize', name: 'Generate Report', input_mapping: { text: '$prev.output' } },
    ],
  },
  {
    name: 'build-and-deploy',
    description: 'Review repo state, run a code review, verify deployment health, and probe the service',
    steps: [
      { skill_name: 'git-status', name: 'Inspect Repo', input_mapping: { cwd: '$input' } },
      { skill_name: 'code-review', name: 'Review Code', input_mapping: { code: '$prev.output' } },
      { skill_name: 'deploy-check', name: 'Deploy & Check', input_mapping: { service: '$input' } },
      { skill_name: 'health-probe', name: 'Probe Health', input_mapping: { url: '$input.url' } },
    ],
  },
  {
    name: 'monitor-and-respond',
    description: 'Probe a target, analyze its logs, diagnose any issues, and write a status report',
    steps: [
      { skill_name: 'health-probe', name: 'Probe Target', input_mapping: { url: '$input' } },
      { skill_name: 'log-analyzer', name: 'Analyze Logs', input_mapping: { path: '$input.path' } },
      { skill_name: 'debug-assistant', name: 'Diagnose & Respond', input_mapping: { error: '$prev.output' } },
      { skill_name: 'status-report', name: 'Write Report', input_mapping: { activity: '$prev.output' } },
    ],
  },
  {
    name: 'research-to-landing-page',
    description: 'Research a product topic and generate a landing page from the findings',
    steps: [
      { skill_name: 'web-research', name: 'Research Topic', input_mapping: { query: '$input' } },
      { skill_name: 'paper-summarize', name: 'Extract Key Points', input_mapping: { text: '$prev.output' } },
      { skill_name: 'landing-page-generator', name: 'Generate Landing Page', input_mapping: { product: '$prev.output' } },
    ],
  },
  {
    name: 'security-audit-and-report',
    description: 'Scan the network, review hygiene risks, and run a full security audit',
    steps: [
      { skill_name: 'network-device-scan', name: 'Scan Network', input_mapping: { subnet: '$input' } },
      { skill_name: 'network-hygiene-review', name: 'Hygiene Review', input_mapping: { scan: '$prev.output' } },
      { skill_name: 'security-audit', name: 'Security Audit' },
    ],
  },
  {
    name: 'incident-debug-report',
    description: 'Trace an error, scan logs for context, and produce a status report',
    steps: [
      { skill_name: 'debug-trace', name: 'Trace Error', input_mapping: { trace: '$input' } },
      { skill_name: 'log-analyzer', name: 'Scan Logs', input_mapping: { path: '$input.path' } },
      { skill_name: 'status-report', name: 'Write Report', input_mapping: { activity: '$prev.output' } },
    ],
  },
  {
    name: 'feature-to-tests',
    description: 'Build a feature, generate tests for it, and run a code review on the result',
    steps: [
      { skill_name: 'feature-builder', name: 'Build Feature', input_mapping: { description: '$input' } },
      { skill_name: 'test-writer', name: 'Write Tests', input_mapping: { code: '$prev.output' } },
      { skill_name: 'code-review', name: 'Review Output', input_mapping: { code: '$prev.output' } },
    ],
  },
  {
    name: 'landing-page-studio',
    description: 'Plan a landing page, generate a design system, build components, and assemble the page',
    steps: [
      { skill_name: 'task-breakdown', name: 'Plan Sections', input_mapping: { task: '$input' } },
      { skill_name: 'design-system-generator', name: 'Brand Tokens', input_mapping: { brand: '$input' } },
      { skill_name: 'component-generator', name: 'Build Components', input_mapping: { description: '$prev.output' } },
      { skill_name: 'landing-page-generator', name: 'Assemble Page', input_mapping: { product: '$input' } },
    ],
  },
  {
    name: 'shopify-daily-briefing',
    description: 'Pull the Shopify catalog, stock levels, recent orders, and customer insights into a daily brief',
    steps: [
      { skill_name: 'shopify-products', name: 'Catalog Snapshot', input_override: { action: 'list', limit: 50 } },
      { skill_name: 'shopify-inventory', name: 'Stock Check', input_override: { threshold: 5 } },
      { skill_name: 'shopify-orders', name: 'Recent Orders', input_override: { limit: 25 } },
      { skill_name: 'shopify-customer-insights', name: 'Customer Insights', input_override: { limit: 50 } },
    ],
  },
];

export const SEED_TOOL_CHAINS = [
  {
    name: 'system-health-overview',
    description: 'Check system health, list active tasks and agents, and verify MCP servers',
    steps: [
      { tool_name: 'system_status', method: 'GET', endpoint: '/api/health', name: 'Check System Health' },
      { tool_name: 'list_tasks', method: 'GET', endpoint: '/api/tasks', name: 'List Tasks' },
      { tool_name: 'list_agents', method: 'GET', endpoint: '/api/agents', name: 'List Agents' },
      { tool_name: 'list_mcp_servers', method: 'GET', endpoint: '/api/mcp/servers', name: 'List MCP Servers' },
    ],
  },
  {
    name: 'llm-stack-audit',
    description: 'List LLM providers and models, then verify system health',
    steps: [
      { tool_name: 'list_providers', method: 'GET', endpoint: '/api/llm/providers', name: 'List Providers' },
      { tool_name: 'list_models', method: 'GET', endpoint: '/api/llm/models', name: 'List Models' },
      { tool_name: 'system_status', method: 'GET', endpoint: '/api/health', name: 'Verify System Health' },
    ],
  },
  {
    name: 'schedule-and-group-overview',
    description: 'List cron schedules and agent groups, then confirm system status',
    steps: [
      { tool_name: 'list_schedules', method: 'GET', endpoint: '/api/schedules', name: 'List Schedules' },
      { tool_name: 'list_groups', method: 'GET', endpoint: '/api/groups', name: 'List Agent Groups' },
      { tool_name: 'system_status', method: 'GET', endpoint: '/api/health', name: 'System Status' },
    ],
  },
  {
    name: 'agent-delegation',
    description: 'Discover available agents and create a task from the chain input',
    steps: [
      { tool_name: 'list_agents', method: 'GET', endpoint: '/api/agents', name: 'Discover Agents' },
      { tool_name: 'create_task', method: 'POST', endpoint: '/api/tasks', name: 'Create Task', input_mapping: { name: '$input.name', command: '$input.command' } },
    ],
  },
  {
    name: 'research-to-file',
    description: 'Search the web, save the results to disk, and verify the file was written',
    steps: [
      { tool_name: 'web_search', method: 'POST', endpoint: '/api/tools/web-search', name: 'Search Web', input_mapping: { query: '$input' }, input_override: { max_results: 5, search_depth: 'basic' } },
      { tool_name: 'file_write', method: 'POST', endpoint: '/api/tools/file-write', name: 'Save Results', input_mapping: { content: '$prev.output' }, input_override: { path: '/tmp/cardinal-research.json' } },
      { tool_name: 'file_read', method: 'POST', endpoint: '/api/tools/file-read', name: 'Verify File', input_override: { path: '/tmp/cardinal-research.json' } },
    ],
  },
  {
    name: 'command-and-save',
    description: 'Run a shell command and save its output to a file',
    steps: [
      { tool_name: 'bash_exec', method: 'POST', endpoint: '/api/tools/bash', name: 'Run Command', input_mapping: { command: '$input' } },
      { tool_name: 'file_write', method: 'POST', endpoint: '/api/tools/file-write', name: 'Save Output', input_mapping: { content: '$prev.output' }, input_override: { path: '/tmp/cardinal-bash-output.txt' } },
    ],
  },
  {
    name: 'document-extraction',
    description: 'Read a PDF path and extract its text content',
    steps: [
      { tool_name: 'file_read', method: 'POST', endpoint: '/api/tools/file-read', name: 'Read File', input_mapping: { path: '$input' } },
      { tool_name: 'pdf_parse', method: 'POST', endpoint: '/api/tools/pdf-parse', name: 'Extract Text', input_mapping: { path: '$input' } },
    ],
  },
];
