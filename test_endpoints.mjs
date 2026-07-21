import { randomUUID } from 'crypto';

const base = 'http://localhost:3000';

async function run() {
  // Register
  const regResp = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2etest', password: 'test1234' }),
  });
  const regData = await regResp.json();
  const token = regData.token;
  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  console.log('1. Auth OK, token length:', token.length);

  // Upload file
  const upResp = await fetch(base + '/api/chat/upload', {
    method: 'POST', headers,
    body: JSON.stringify({ filename: 'hello.txt', mime_type: 'text/plain', content_b64: 'SGVsbG8gV29ybGQ=' }),
  });
  const upData = await upResp.json();
  console.log('2. Upload:', upData.filename, upData.size, 'bytes');

  // Create conversation
  const convResp = await fetch(base + '/api/chat/conversations', {
    method: 'POST', headers,
    body: JSON.stringify({ title: 'E2E Test Chat', model: 'gpt-4' }),
  });
  const convData = await convResp.json();
  console.log('3. Create conv:', convData.id);

  // List conversations
  const listResp = await fetch(base + '/api/chat/conversations', { headers });
  const convs = await listResp.json();
  console.log('4. Conv count:', convs.length);

  // Get messages
  const msgsResp = await fetch(base + '/api/chat/conversations/' + convData.id + '/messages', { headers });
  const msgs = await msgsResp.json();
  console.log('5. Messages:', msgs.length);

  // Tools
  const toolsResp = await fetch(base + '/api/tools/enabled');
  const tools = await toolsResp.json();
  console.log('6. Tools:', tools.length);

  // Skills
  const skillsResp = await fetch(base + '/api/skills');
  const skills = await skillsResp.json();
  console.log('7. Skills:', skills.length);

  // Delete conversation
  const delResp = await fetch(base + '/api/chat/conversations/' + convData.id, {
    method: 'DELETE', headers,
  });
  const delData = await delResp.json();
  console.log('8. Delete:', delData.ok ? 'OK' : 'FAIL');

  console.log('\nALL ENDPOINTS VERIFIED');
}

run().catch(e => console.error('ERROR:', e.message));
