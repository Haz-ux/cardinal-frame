// ─── Seed Skill Library (30 built-in skills) ─────────────────────
// Auto-extracted from server.mjs — 30 built-in skills for the seed library
export const SEED_SKILLS = [
  // DevOps
  {
    name: 'deploy-check',
    description: 'Check deployment status and health of services',
    category: 'devops',
    trigger: 'deploy,deployment,status check',
    confidence: 0.7,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      try {
        const ps = execSync('ps aux --sort=-%mem | head -10', { timeout: 5000, encoding: 'utf-8' });
        const disks = execSync('df -h', { timeout: 5000, encoding: 'utf-8' });
        return { processes: ps, disk_usage: disks, status: 'healthy' };
      } catch (e) { return { error: e.message, status: 'check_failed' }; }
    }`,
  },
  {
    name: 'log-analyzer',
    description: 'Analyze log files for errors and patterns',
    category: 'devops',
    trigger: 'log,logs,error log,analyze log',
    confidence: 0.6,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      // execSync is injected by the skill runtime
      const logPath = input.path || input;
      try {
        const cmd = 'tail -100 ' + logPath;
        const logs = execSync(cmd, { timeout: 5000, encoding: 'utf-8' });
        const errors = logs.split('\\n').filter(l => /error|ERROR|Error/.test(l));
        const llmResult = await llmCall([
          { role: 'system', content: 'Analyze these log errors and suggest fixes. Be concise.' },
          { role: 'user', content: 'Errors found:\\n' + errors.join('\\n').slice(0, 2000) }
        ]);
        return { total_lines: logs.split('\\n').length, error_count: errors.length, analysis: llmResult.content };
      } catch (e) { return { error: e.message }; }
    `,
  },
  {
    name: 'health-probe',
    description: 'Probe a URL for health check response',
    category: 'devops',
    trigger: 'health check,probe,ping url',
    confidence: 0.7,
    parameters: { type: 'script' },
    handler: `async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url) return { error: 'url required' };
      const start = Date.now();
      try {
        const resp = await fetch(url, { timeout: 10000 });
        return { url, status: resp.status, ok: resp.ok, response_time_ms: Date.now() - start };
      } catch (e) { return { url, error: e.message, response_time_ms: Date.now() - start }; }
    }`,
  },
  // Development
  {
    name: 'code-review',
    description: 'Review code using LLM analysis. Pass code as input.',
    category: 'development',
    trigger: 'review,code review,review code',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a senior code reviewer. Review the provided code for:
- Bugs and potential issues
- Security vulnerabilities
- Performance improvements
- Code style and best practices

Be concise. Use bullet points. Rate severity as CRITICAL/WARN/INFO.`,
  },
  {
    name: 'refactor-suggest',
    description: 'Suggest refactoring improvements for code',
    category: 'development',
    trigger: 'refactor,refactor code,clean up code',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a refactoring expert. Analyze the provided code and suggest:
1. Extract method opportunities
2. Simplification candidates
3. Dead code removal
4. Better naming

Be concise. Show before/after snippets where relevant.`,
  },
  {
    name: 'debug-trace',
    description: 'Help debug an error by analyzing the stack trace',
    category: 'development',
    trigger: 'debug,stack trace,error trace,bug',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a debugging expert. Analyze the error/stack trace and:
1. Identify the root cause
2. List the call chain
3. Suggest a fix with code
4. Note any related edge cases

Be concise and direct.`,
  },
  // Research
  {
    name: 'web-research',
    description: 'Search the web and summarize findings',
    category: 'research',
    trigger: 'search,research,look up,find information',
    confidence: 0.6,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const query = typeof input === 'string' ? input : input.query;
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!tavilyKey) return { error: 'Tavily API key not configured' };
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5 })
      });
      const data = await resp.json();
      const results = (data.results || []).map(r => r.title + ': ' + r.url);
      const summary = await llmCall([
        { role: 'system', content: 'Summarize these search results concisely.' },
        { role: 'user', content: results.join('\\n') }
      ]);
      return { query, results: data.results || [], summary: summary.content };
    `,
  },
  {
    name: 'paper-summarize',
    description: 'Summarize a research paper or long text',
    category: 'research',
    trigger: 'summarize paper,summarize research,abstract',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a research assistant. Summarize the provided text as:
1. One-paragraph executive summary
2. Key findings (bullet points)
3. Methodology notes
4. Relevance to software engineering

Be concise.`,
  },
  {
    name: 'fact-check',
    description: 'Fact-check a claim using web search',
    category: 'research',
    trigger: 'fact check,verify,is this true',
    confidence: 0.6,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const claim = typeof input === 'string' ? input : input.claim;
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!tavilyKey) return { error: 'Tavily API key not configured' };
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query: claim, max_results: 3 })
      });
      const data = await resp.json();
      const analysis = await llmCall([
        { role: 'system', content: 'Fact-check this claim based on search results. Rate as TRUE/PARTIALLY_TRUE/FALSE/UNVERIFIABLE.' },
        { role: 'user', content: 'Claim: ' + claim + '\\n\\nResults: ' + JSON.stringify(data.results || []).slice(0, 2000) }
      ]);
      return { claim, verdict: analysis.content, sources: (data.results || []).map(r => r.url) };
    `,
  },
  // Productivity
  {
    name: 'task-breakdown',
    description: 'Break down a complex task into smaller steps',
    category: 'productivity',
    trigger: 'break down,task breakdown,split task,decompose',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a project manager. Break down the described task into:
1. Ordered steps (numbered)
2. Estimated complexity per step (S/M/L)
3. Dependencies between steps
4. Potential blockers

Be concise. Max 10 steps.`,
  },
  {
    name: 'status-report',
    description: 'Generate a status report from recent activity',
    category: 'productivity',
    trigger: 'status report,progress report,standup',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a team lead. Generate a daily status report:
1. What was accomplished (bullet points)
2. What's in progress
3. Blockers/risks
4. Plan for next period

Format as a concise email-ready report.`,
  },
  {
    name: 'meeting-notes',
    description: 'Format meeting notes from raw transcript or points',
    category: 'productivity',
    trigger: 'meeting notes,minutes,meeting summary',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a meeting scribe. Format the raw notes into:
1. Attendees (if mentioned)
2. Key decisions
3. Action items (with owners if mentioned)
4. Next steps

Be concise. Use markdown.`,
  },
  // Data
  {
    name: 'sql-query',
    description: 'Generate SQL query from natural language description',
    category: 'data',
    trigger: 'sql,sql query,database query,write sql',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a SQL expert. Generate a SQL query based on the natural language request.
Rules:
- Use standard SQL (SQLite-compatible)
- Add comments explaining each CTE or complex join
- Include LIMIT 100 by default
- Return ONLY the SQL in a code block`,
  },
  {
    name: 'data-profile',
    description: 'Profile a dataset — describe its structure',
    category: 'data',
    trigger: 'data profile,describe data,dataset analysis',
    confidence: 0.6,
    parameters: { type: 'template' },
    handler: `template:You are a data analyst. Analyze the provided data and report:
1. Structure (rows, columns, types)
2. Missing values
3. Statistical summary
4. Anomalies/outliers
5. Suggested visualizations

Be concise.`,
  },
  // AI
  {
    name: 'prompt-optimize',
    description: 'Optimize an LLM prompt for better results',
    category: 'ai',
    trigger: 'optimize prompt,prompt improvement,better prompt',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a prompt engineering expert. Improve the given prompt:
1. Identify weaknesses
2. Provide the optimized version
3. Explain key changes
4. Suggest edge cases to test

Return the optimized prompt in a code block.`,
  },
  {
    name: 'model-compare',
    description: 'Compare LLM models for a given use case',
    category: 'ai',
    trigger: 'compare models,model comparison,which model',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are an AI model expert. Compare models for the described use case:
1. Recommend top 3 models
2. Compare on: context length, cost, speed, quality
3. Note any caveats
4. Suggest a fallback model

Be concise. Use a comparison table format.`,
  },
  // System
  {
    name: 'disk-check',
    description: 'Check disk usage and find large files',
    category: 'system',
    trigger: 'disk usage,disk space,storage check,large files',
    confidence: 0.7,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      try {
        const df = execSync('df -h', { timeout: 5000, encoding: 'utf-8' });
        const big = execSync('find / -type f -size +100M 2>/dev/null | head -20', { timeout: 10000, encoding: 'utf-8' });
        return { disk_usage: df, large_files: big };
      } catch (e) { return { error: e.message }; }
    }`,
  },
  {
    name: 'port-scan',
    description: 'Scan for open ports on localhost',
    category: 'system',
    trigger: 'port scan,open ports,what ports',
    confidence: 0.6,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      try {
        const ports = execSync('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', { timeout: 5000, encoding: 'utf-8' });
        return { open_ports: ports };
      } catch (e) { return { error: e.message }; }
    }`,
  },
  {
    name: 'git-status',
    description: 'Show git status, recent commits, and branch info',
    category: 'system',
    trigger: 'git status,git log,git branch',
    confidence: 0.8,
    parameters: { type: 'script' },
    handler: `async (input) => {
      const cwd = typeof input === 'string' ? input : (input.cwd || '/home/haz');
      const result = {};
      try { result.status = execSync('git status --short', { timeout: 5000, cwd, encoding: 'utf-8' }) || 'clean'; } catch { result.status = 'git not available or not a repo'; }
      try { result.recent_commits = execSync('git log --oneline -5', { timeout: 5000, cwd, encoding: 'utf-8' }); } catch { result.recent_commits = ''; }
      try { result.branch = execSync('git branch --show-current', { timeout: 5000, cwd, encoding: 'utf-8' }).trim() || 'unknown'; } catch { result.branch = 'unknown'; }
      return result;
    }`,
  },
  {
    name: 'process-kill',
    description: 'Find and optionally kill a process by name',
    category: 'system',
    trigger: 'kill process,find process,process info',
    confidence: 0.5,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      const name = typeof input === 'string' ? input : input.name;
      if (!name) return { error: 'process name required' };
      try {
        const ps = execSync('pgrep -a ' + name, { timeout: 5000, encoding: 'utf-8' });
        return { processes: ps, killed: false, note: 'Set kill=true to terminate' };
      } catch (e) { return { error: 'No processes found', name }; }
    }`,
  },
  // ── Shopify ──────────────────────────────────────────────────
  {
    name: 'shopify-products',
    description: 'List, search, or get details of Shopify products via Admin API',
    category: 'shopify',
    trigger: 'shopify products,list products,product catalog,shop products',
    confidence: 0.8,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN env vars.' };
      const action = input.action || 'list';
      const lim = input.limit || 50;
      const url = 'https://' + domain + '/admin/api/2024-01/products.json?limit=' + lim;
      const resp = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!resp.ok) {
        const err = await resp.text();
        return { error: 'Shopify API error (' + resp.status + '): ' + err.slice(0, 300) };
      }
      const data = await resp.json();
      const products = (data.products || []).map(p => ({
        id: p.id, title: p.title, vendor: p.vendor,
        status: p.status, variants: (p.variants || []).length,
        price: p.variants?.[0]?.price || null,
        inventory: p.variants?.reduce((s, v) => s + (v.inventory_quantity || 0), 0) || 0,
        tags: p.tags, image: p.image?.src || null,
      }));
      return { count: products.length, products };
    `,
  },
  {
    name: 'shopify-orders',
    description: 'List recent Shopify orders with customer and fulfillment info',
    category: 'shopify',
    trigger: 'shopify orders,recent orders,order history,fulfillment status',
    confidence: 0.8,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured.' };
      const lim = input.limit || 25;
      const status = input.status || 'any';
      const url = 'https://' + domain + '/admin/api/2024-01/orders.json?limit=' + lim + '&status=' + status;
      const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!resp.ok) { const e = await resp.text(); return { error: 'Shopify API (' + resp.status + '): ' + e.slice(0, 300) }; }
      const data = await resp.json();
      const orders = (data.orders || []).map(o => ({
        id: o.id, name: o.name, email: o.email,
        total_price: o.total_price, currency: o.currency,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status || 'unfulfilled',
        created_at: o.created_at,
        items: (o.line_items || []).map(li => ({ title: li.title, qty: li.quantity, price: li.price })),
        customer: o.customer ? { name: o.customer.first_name + ' ' + o.customer.last_name, email: o.customer.email } : null,
      }));
      const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
      return { count: orders.length, total_revenue: totalRevenue.toFixed(2), currency: orders[0]?.currency || 'USD', orders };
    `,
  },
  {
    name: 'shopify-inventory',
    description: 'Check inventory levels across locations and flag low-stock items',
    category: 'shopify',
    trigger: 'shopify inventory,stock levels,low stock,inventory check',
    confidence: 0.8,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured.' };
      const threshold = input.threshold || 5;
      // Get inventory items
      const invResp = await fetch('https://' + domain + '/admin/api/2024-01/inventory_items.json?limit=250', {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!invResp.ok) { const e = await invResp.text(); return { error: 'Shopify API (' + invResp.status + '): ' + e.slice(0, 300) }; }
      const invData = await invResp.json();
      const items = (invData.inventory_items || []).map(i => ({
        id: i.id, sku: i.sku, tracked: i.tracked,
        cost: i.cost || null, country: i.country_code_of_origin || null,
      }));
      // Get inventory levels
      const lvlResp = await fetch('https://' + domain + '/admin/api/2024-01/inventory_levels.json?limit=250', {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const lvlData = await lvlResp.ok ? await lvlResp.json() : { inventory_levels: [] };
      const levels = lvlData.inventory_levels || [];
      const lowStock = levels.filter(l => l.available < threshold).map(l => ({
        inventory_item_id: l.inventory_item_id,
        location_id: l.location_id,
        available: l.available,
      }));
      return { total_items: items.length, total_locations: levels.length, low_stock_count: lowStock.length, threshold, low_stock: lowStock, items };
    `,
  },
  {
    name: 'shopify-customer-insights',
    description: 'Analyze customer data — top customers, order frequency, revenue per customer',
    category: 'shopify',
    trigger: 'shopify customers,customer insights,top customers,customer analysis',
    confidence: 0.7,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured.' };
      const lim = input.limit || 50;
      const resp = await fetch('https://' + domain + '/admin/api/2024-01/customers.json?limit=' + lim, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!resp.ok) { const e = await resp.text(); return { error: 'Shopify API (' + resp.status + '): ' + e.slice(0, 300) }; }
      const data = await resp.json();
      const customers = (data.customers || []).map(c => ({
        id: c.id, name: c.first_name + ' ' + c.last_name, email: c.email,
        orders_count: c.orders_count, total_spent: parseFloat(c.total_spent),
        avg_order_value: c.orders_count > 0 ? (parseFloat(c.total_spent) / c.orders_count).toFixed(2) : '0',
        state: c.default_address?.province || null, country: c.default_address?.country || null,
        created_at: c.created_at, last_order: c.last_order_name || null,
      }));
      const topByRevenue = [...customers].sort((a, b) => b.total_spent - a.total_spent).slice(0, 10);
      const topByOrders = [...customers].sort((a, b) => b.orders_count - a.orders_count).slice(0, 10);
      const totalRev = customers.reduce((s, c) => s + c.total_spent, 0);
      // LLM summary
      const summary = await llmCall([
        { role: 'system', content: 'Analyze this customer data and provide: 1) Key insights 2) Top 3 customer segments 3) Recommendations. Be concise.' },
        { role: 'user', content: 'Customers: ' + JSON.stringify({ total: customers.length, total_revenue: totalRev.toFixed(2), top_by_revenue: topByRevenue.slice(0, 5), top_by_orders: topByOrders.slice(0, 5) }).slice(0, 3000) }
      ]);
      return { total_customers: customers.length, total_revenue: totalRev.toFixed(2), top_by_revenue: topByRevenue, top_by_orders: topByOrders, analysis: summary.content };
    `,
  },
  // ── Web Design ───────────────────────────────────────────────
  {
    name: 'landing-page-generator',
    description: 'Generate a complete responsive landing page HTML with cyberpunk or custom styling',
    category: 'web-design',
    trigger: 'landing page,generate landing,create landing page,web page design',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const product = typeof input === 'string' ? input : (input.product || input.description || 'a SaaS product');
      const style = input.style || 'cyberpunk';
      const cta = input.cta || 'Get Started';
      const result = await llmCall([
          { role: 'system', content: 'You are an expert web designer. Generate a complete, single-file HTML landing page. Include inline CSS and minimal JS for interactivity. Style: ' + style + '. Product: ' + product + '. CTA button: ' + cta + '. Requirements: 1) Hero section with headline + subhead + CTA 2) Features grid (3-4 cards) 3) Social proof / testimonials 4) Pricing table 5) Final CTA + footer. Use CSS variables, modern flexbox/grid, responsive breakpoints, smooth animations. Return ONLY the HTML in a single code block.' },
          { role: 'user', content: 'Generate a ' + style + ' landing page for: ' + product }
        ]);
      return { html: result.content, style, product };
    `,
  },
  {
    name: 'design-system-generator',
    description: 'Generate a complete design system — colors, typography, spacing, components',
    category: 'web-design',
    trigger: 'design system,generate design tokens,color palette,typography system',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const brand = typeof input === 'string' ? input : (input.brand || input.name || 'Brand');
      const baseColor = input.baseColor || input.color || '#00f0ff';
      const result = await llmCall([
          { role: 'system', content: 'You are a design systems expert. Generate a complete design system as JSON tokens. Include: 1) Color palette (primary, secondary, accent, neutral with 50-900 shades) 2) Typography (font sizes, weights, line heights, font family) 3) Spacing scale (4px base) 4) Border radius 5) Shadows 6) Component tokens (buttons, cards, inputs) 7) Dark + light mode variants. Base color: ' + baseColor + '. Brand: ' + brand + '. Return as a JSON object in a code block.' },
          { role: 'user', content: 'Create a design system for ' + brand + ' with base color ' + baseColor }
        ]);
      return { tokens: result.content, brand, baseColor };
    `,
  },
  {
    name: 'responsive-layout-builder',
    description: 'Generate responsive CSS layout from a description — flexbox/grid with breakpoints',
    category: 'web-design',
    trigger: 'responsive layout,css grid,css layout,build layout,responsive design',
    confidence: 0.7,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.layout || 'a dashboard sidebar + main content area');
      const result = await llmCall([
          { role: 'system', content: 'You are a CSS layout expert. Generate responsive CSS + minimal HTML for the described layout. Requirements: 1) Use CSS Grid or Flexbox 2) Mobile-first responsive breakpoints 3) Accessible 4) Return HTML + CSS in a single code block. Keep it production-ready.' },
          { role: 'user', content: 'Layout: ' + desc }
        ]);
      return { html: result.content, description: desc };
    `,
  },
  {
    name: 'component-generator',
    description: 'Generate a React or vanilla JS UI component from a description',
    category: 'web-design',
    trigger: 'generate component,react component,ui component,build component',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.component || 'a card component');
      const framework = input.framework || 'react';
      const result = await llmCall([
          { role: 'system', content: 'You are a frontend expert. Generate a ' + framework + ' component for the described UI. Requirements: 1) Props-driven 2) Accessible (ARIA) 3) Responsive 4) Inline styles or Tailwind classes 5) TypeScript types if React. Return the component in a single code block. Include all sub-components inline.' },
          { role: 'user', content: 'Component: ' + desc + ' | Framework: ' + framework }
        ]);
      return { code: result.content, framework, description: desc };
    `,
  },
  // ── Coding ───────────────────────────────────────────────────
  {
    name: 'feature-builder',
    description: 'Generate full-stack feature code — API endpoint + DB schema + frontend component',
    category: 'coding',
    trigger: 'build feature,full stack feature,implement feature,create feature',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.feature || 'a user settings page');
      const stack = input.stack || 'express+react+sqlite';
      const result = await llmCall([
          { role: 'system', content: 'You are a full-stack engineer. Generate complete code for the described feature using: ' + stack + '. Provide: 1) Database schema (SQL) 2) API endpoint (server code) 3) Frontend component 4) Brief integration notes. Return each part in separate code blocks with labels.' },
          { role: 'user', content: 'Feature: ' + desc + ' | Stack: ' + stack }
        ]);
      return { code: result.content, feature: desc, stack };
    `,
  },
  {
    name: 'api-endpoint-generator',
    description: 'Generate a REST API endpoint with validation, error handling, and tests',
    category: 'coding',
    trigger: 'api endpoint,generate api,rest endpoint,create route',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.endpoint || 'POST /api/users - create a user');
      const framework = input.framework || 'express';
      const result = await llmCall([
          { role: 'system', content: 'You are an API designer. Generate a production-ready ' + framework + ' endpoint for: ' + desc + '. Include: 1) Route handler 2) Input validation (Zod or Joi) 3) Error handling 4) Rate limiting 5) Unit test. Return in code blocks.' },
          { role: 'user', content: 'Endpoint: ' + desc + ' | Framework: ' + framework }
        ]);
      return { code: result.content, endpoint: desc, framework };
    `,
  },
  {
    name: 'schema-designer',
    description: 'Design a database schema from a description — tables, relations, indexes, migrations',
    category: 'coding',
    trigger: 'database schema,db schema,schema design,design database,table design',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.schema || 'a blog with users, posts, and comments');
      const dbType = input.database || input.db || 'sqlite';
      const result = await llmCall([
          { role: 'system', content: 'You are a database architect. Design a ' + dbType + ' schema for: ' + desc + '. Provide: 1) CREATE TABLE statements 2) Indexes 3) Foreign key constraints 4) Seed data 5) Migration script. Return in SQL code blocks.' },
          { role: 'user', content: 'Schema: ' + desc + ' | Database: ' + dbType }
        ]);
      return { sql: result.content, schema: desc, database: dbType };
    `,
  },
  {
    name: 'test-writer',
    description: 'Generate unit tests for a function or component — edge cases included',
    category: 'coding',
    trigger: 'write tests,generate tests,test suite,unit tests,test coverage',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const code = typeof input === 'string' ? input : (input.code || input.function || input.component || '');
      if (!code) return { error: 'Code to test is required. Pass the function/component as input.' };
      const framework = input.framework || 'vitest';
      const result = await llmCall([
          { role: 'system', content: 'You are a test engineer. Write comprehensive ' + framework + ' tests for the provided code. Include: 1) Happy path tests 2) Edge cases 3) Error cases 4) Mocking if needed. Return only the test file in a code block.' },
          { role: 'user', content: 'Code to test:\\n\\n' + code.slice(0, 4000) }
        ]);
      return { tests: result.content, framework };
    `,
  },
  {
    name: 'code-refactor',
    description: 'Refactor code for readability, performance, or pattern compliance',
    category: 'coding',
    trigger: 'refactor code,clean code,improve code,code quality',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const code = typeof input === 'string' ? input : (input.code || '');
      if (!code) return { error: 'Code to refactor is required.' };
      const target = input.goal || input.pattern || 'readability';
      const result = await llmCall([
          { role: 'system', content: 'You are a senior engineer. Refactor the provided code focusing on: ' + target + '. Requirements: 1) Preserve behavior 2) Explain each change 3) Show before/after 4) Note any new edge cases. Return the refactored code in a code block, then bullet-point explanations.' },
          { role: 'user', content: 'Code:\\n\\n' + code.slice(0, 4000) }
        ]);
      return { refactored: result.content, goal: target };
    `,
  },
  {
    name: 'debug-assistant',
    description: 'Analyze an error or stack trace and suggest a fix with code',
    category: 'coding',
    trigger: 'debug error,fix bug,stack trace,debug help,runtime error',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const error = typeof input === 'string' ? input : (input.error || input.trace || '');
      const context = input.context || input.code || '';
      if (!error && !context) return { error: 'Provide an error message or code to debug.' };
      const result = await llmCall([
          { role: 'system', content: 'You are a debugging expert. Analyze the error and code context. Provide: 1) Root cause 2) Fix with code 3) Why the fix works 4) Prevention tips. Be concise.' },
          { role: 'user', content: (error ? 'Error:\\n' + error + '\\n\\n' : '') + (context ? 'Code context:\\n' + context.slice(0, 3000) : '') }
        ]);
      return { analysis: result.content };
    `,
  },
];
