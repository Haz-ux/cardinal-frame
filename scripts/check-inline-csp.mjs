// Check if the production build has any inline <script> or inline style
// attributes — if not, 'unsafe-inline' can be dropped from CSP for prod.
import { readFileSync } from 'fs';

const html = readFileSync('/home/haz/cardinal-frame/cardinal-frame/client/dist/index.html', 'utf8');

// Inline scripts: <script> without src=
const inlineScripts = (html.match(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/g) || []);
console.log('inline <script> blocks:', inlineScripts.length);
inlineScripts.forEach(s => console.log('  ' + s.slice(0, 120)));

// Inline style attributes: style="..."
const inlineStyles = (html.match(/style="/g) || []).length;
console.log('inline style= attributes:', inlineStyles);

// Inline <style> blocks
const styleBlocks = (html.match(/<style[\s\S]*?<\/style>/g) || []);
console.log('inline <style> blocks:', styleBlocks.length);

// CSS file: check for inline-relevant content (CSS can't violate script-src)
console.log('\nVerdict:', (inlineScripts.length === 0 && inlineStyles === 0 && styleBlocks.length === 0)
  ? 'NO inline code in prod build — unsafe-inline droppable for scriptSrc (styleSrc may keep it for libs that set style= at runtime)'
  : 'inline code present — keep unsafe-inline or add nonces');
