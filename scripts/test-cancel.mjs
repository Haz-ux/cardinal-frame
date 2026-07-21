async function go() {
  const BASE = 'http://localhost:3000/api';
  const regH = { 'Content-Type': 'application/json' };
  const reg = await (await fetch(BASE+'/auth/register', {method:'POST',headers:regH,body:JSON.stringify({username:'testcancel2',password:'test1234'})})).json();
  console.log('Register:', reg.token ? 'ok' : reg.error);
  const tok = reg.token;
  const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+tok };
  
  // Use a long-running allowed command
  const tRes = await fetch(BASE+'/tasks', {method:'POST',headers:h,body:JSON.stringify({name:'cancel-test',command:'node -e "setTimeout(()=>{},60000)"'})});
  const t = await tRes.json();
  console.log('Create task:', tRes.status, 'id:', t.id, 'error:', t.error);
  
  const eRes = await fetch(BASE+'/tasks/'+t.id+'/execute', {method:'PATCH',headers:h});
  const e = await eRes.json();
  console.log('Execute:', eRes.status, 'body:', JSON.stringify(e).slice(0,200));
  
  await new Promise(r=>setTimeout(r,500));
  
  const cRes = await fetch(BASE+'/tasks/'+t.id+'/cancel', {method:'PATCH',headers:h});
  const c = await cRes.json();
  console.log('Cancel:', cRes.status, 'body:', JSON.stringify(c).slice(0,200));
  
  const rRes = await fetch(BASE+'/tasks/'+t.id+'/retry', {method:'POST',headers:h});
  const r2 = await rRes.json();
  console.log('Retry:', rRes.status, 'body:', JSON.stringify(r2).slice(0,200));
}
go().catch(e=>console.error(e));
