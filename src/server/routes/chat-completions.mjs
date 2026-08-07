import express from 'express';
import { PROVIDER_TYPES, buildProviderAuth, buildChatUrl, buildChatPayload } from './llm-helpers.mjs';
import { getModelCost } from './costs.mjs';
import { PERSONAS, applyPersona, DEFAULT_PERSONA, getPersonaDetail, listPersonas, savePersonaOverride, resetPersona, getActivePersonaId, setActivePersonaId } from '../personas.mjs';
import { autoObserve } from '../learn.mjs';

export { autoObserve };

/**
 * Chat completions proxy: routes chat requests to the user's selected
 * LLM provider, streaming SSE back. Includes dual-tier failover and
 * Aimi auto-observation.
 * Dependencies: db, stmts, logger, authMiddleware, apiLimiter, audit, broadcast, randomUUID, fireHook
 * Exports: findFallbackProvider, autoObserve (shared with aimi routes)
 */
export function findFallbackProvider(stmts, excludeProviderId) {
  const allProviders = stmts.providers.getAll.all().filter(p => p.enabled && p.id !== excludeProviderId);
  const local = allProviders.find(p => p.type === 'ollama');
  if (local) {
    const localModels = stmts.models.getByProvider.all(local.id);
    if (localModels.length) {
      const m = localModels[0];
      return { provider: local, modelId: m.model_id, baseUrl: local.base_url || 'http://localhost:11434', isOllama: true };
    }
  }
  for (const p of allProviders) {
    const models = stmts.models.getByProvider.all(p.id);
    if (models.length) {
      const m = models[0];
      const pType = PROVIDER_TYPES[p.type];
      return { provider: p, modelId: m.model_id, baseUrl: p.base_url || pType?.baseUrl || '', isOllama: p.type === 'ollama' };
    }
  }
  return null;
}

export default function chatCompletionsRoutes(ctx) {
  const { db, stmts, logger, authMiddleware, optionalAuth, apiLimiter, audit, broadcast, randomUUID, fireHook } = ctx;
  const router = express.Router();

  router.get('/personas', optionalAuth, (_req, res) => {
    res.json({ personas: listPersonas(stmts), default: getActivePersonaId(db) });
  });

  router.put('/personas/active', authMiddleware, (req, res) => {
    const { id } = req.body || {};
    if (!setActivePersonaId(db, id)) return res.status(400).json({ error: 'Unknown persona' });
    const persona = getPersonaDetail(stmts, id);
    audit('persona.activate', 'persona', id, req.user.id, { name: persona.name });
    broadcast('persona:active', { personaId: id, name: persona.name, color: persona.color });
    broadcast('persona:updated', { personaId: id, name: persona.name, color: persona.color });
    logger.info(`Active persona set to "${persona.name}" (${id})`);
    res.json({ ok: true, active: id, persona });
  });

  router.get('/personas/:id', optionalAuth, (req, res) => {
    if (!PERSONAS[req.params.id]) return res.status(404).json({ error: 'Unknown persona' });
    res.json({ persona: getPersonaDetail(stmts, req.params.id) });
  });

  router.put('/personas/:id', authMiddleware, (req, res) => {
    const id = req.params.id;
    if (!PERSONAS[id]) return res.status(404).json({ error: 'Unknown persona' });
    const { name, tagline, color, system_prompt } = req.body || {};
    const persona = savePersonaOverride(stmts, id, { name, tagline, color, system_prompt });
    audit('persona.update', 'persona', id, req.user.id, { name: persona.name, color: persona.color });
    broadcast('persona:updated', { personaId: id, name: persona.name, color: persona.color });
    logger.info(`Persona "${id}" updated → "${persona.name}"`);
    res.json({ persona });
  });

  router.post('/personas/:id/reset', authMiddleware, (req, res) => {
    const id = req.params.id;
    if (!PERSONAS[id]) return res.status(404).json({ error: 'Unknown persona' });
    const persona = resetPersona(stmts, id);
    audit('persona.reset', 'persona', id, req.user.id, { name: persona.name });
    broadcast('persona:updated', { personaId: id, name: persona.name, color: persona.color });
    logger.info(`Persona "${id}" reset to default "${persona.name}"`);
    res.json({ persona });
  });

  router.post('/chat/completions', authMiddleware, apiLimiter, async (req, res) => {
    let { messages, model, conversation_id, stream = true, persona } = req.body;
    if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });

    let activePersona = null;
    const direct = persona === 'direct' || persona === 'none' || persona === '';
    if (!direct) {
      const applied = applyPersona(stmts, messages, persona || DEFAULT_PERSONA);
      messages = applied.messages;
      activePersona = applied.persona;
      if (activePersona) logger.info(`Chat via persona "${activePersona.name}"`);
    }

    let provider, modelRecord;
    if (model) {
      const candidates = db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').all(model, model);
      for (const m of candidates) {
        const p = stmts.providers.getById.get(m.provider_id);
        if (p && p.enabled && p.api_key && p.api_key.length > 10 && !p.api_key.includes('*')) {
          modelRecord = m; provider = p; break;
        }
      }
      if (!provider && candidates.length > 0) {
        modelRecord = candidates[0];
        provider = stmts.providers.getById.get(modelRecord.provider_id);
      }
    }
    if (!provider) {
      modelRecord = stmts.models.getDefault.get();
      if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
    }
    if (!provider) return res.status(400).json({ error: 'No LLM provider configured. Add a provider with an API key first.' });
    const isOllama = provider.type === 'ollama';
    if (!provider.api_key && !isOllama) return res.status(400).json({ error: `Provider "${provider.name}" has no API key set.` });

    const providerType = PROVIDER_TYPES[provider.type];
    const pType = provider.type;
    const baseUrl = provider.base_url || providerType?.baseUrl || '';
    const modelId = modelRecord?.model_id || model || 'gpt-3.5-turbo';

    if (conversation_id) {
      const lastUserMsg = messages.filter(m => m.role === 'user').pop();
      if (lastUserMsg) {
        const msgId = randomUUID();
        stmts.messages.insert.run(msgId, conversation_id, 'user', lastUserMsg.content, '[]', '[]', null, null, 0, 0);
        db.prepare("UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation_id);
        try { stmts.sessionIndex.insert.run(randomUUID(), 'chat', conversation_id, req.user.id, lastUserMsg.content.slice(0, 100), lastUserMsg.content); } catch {}
      }
    }

    const payload = buildChatPayload(pType, modelId, messages, stream);
    const url = buildChatUrl(baseUrl, pType, modelId, stream);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      try {
        const fetch = globalThis.fetch;
        const { headers, url: chatUrl } = buildProviderAuth(provider, url);
        const resp = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });

        if (!resp.ok) {
          const failoverStatuses = [429, 500, 502, 503, 504];
          if (failoverStatuses.includes(resp.status) || resp.status >= 500) {
            const fallback = findFallbackProvider(stmts, provider.id);
            if (fallback) {
              logger.warn(`Failover: ${provider.name} → ${fallback.provider.name} (${resp.status})`);
              audit('failover', 'provider', provider.id, null, { from: provider.name, to: fallback.provider.name, reason: `HTTP ${resp.status}` });
              stmts.tokenUsage.insert.run(conversation_id || null, modelId, provider.id, 0, 0, 0, 'failover');
              const fbPType = fallback.provider.type;
              const fbUrl = buildChatUrl(fallback.baseUrl, fbPType, fallback.modelId, true);
              const { headers: fbHeaders, url: fbAuthUrl } = buildProviderAuth(fallback.provider, fbUrl);
              const fbPayload = buildChatPayload(fbPType, fallback.modelId, payload.messages || messages, true);
              try {
                const fbResp = await fetch(fbAuthUrl, { method: 'POST', headers: fbHeaders, body: JSON.stringify(fbPayload), signal: AbortSignal.timeout(30000) });
                if (fbResp.ok) {
                  res.setHeader('X-Failover', 'true');
                  res.setHeader('X-Failover-Provider', fallback.provider.name);
                  res.setHeader('X-Failover-Model', fallback.modelId);
                  let fbContent = '';
                  const fbReader = fbResp.body.getReader();
                  const fbDecoder = new TextDecoder();
                  let fbDone = false, fbBuf = '';
                  while (!fbDone) {
                    const { done, value } = await fbReader.read();
                    if (done) { fbDone = true; break; }
                    const text = fbDecoder.decode(value, { stream: true });
                    if (fallback.isOllama) {
                      fbBuf += text;
                      const lines = fbBuf.split('\n'); fbBuf = lines.pop();
                      for (const line of lines) {
                        if (!line.trim()) continue;
                        try { const p = JSON.parse(line); const c = p.message?.content || ''; if (c) { fbContent += c; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`); } if (p.done) res.write('data: [DONE]\n\n'); } catch {}
                      }
                    } else {
                      res.write(Buffer.from(value));
                      const lines = text.split('\n').filter(l => l.startsWith('data: '));
                      for (const line of lines) { const d = line.slice(6).trim(); if (d === '[DONE]') continue; try { const p = JSON.parse(d); if (p.choices?.[0]?.delta?.content) fbContent += p.choices[0].delta.content; } catch {} }
                    }
                  }
                  if (conversation_id && fbContent) { const mId = randomUUID(); const est = Math.ceil(fbContent.length/4); stmts.messages.insert.run(mId, conversation_id, 'assistant', fbContent, '[]', '[]', null, fallback.modelId, 0, est); const cost = getModelCost(fallback.modelId, 0, est); stmts.tokenUsage.insert.run(conversation_id, fallback.modelId, fallback.provider.id, 0, est, cost, 'inference'); }
                  autoObserve(stmts, broadcast, logger, randomUUID, conversation_id, messages, fbContent, fallback.modelId);
                  res.end(); return;
                }
              } catch (fbErr) { logger.error('Fallback also failed:', fbErr.message); }
            }
          }
          const errText = await resp.text();
          res.write(`data: ${JSON.stringify({ error: { message: `LLM API error (${resp.status}): ${errText.slice(0, 500)}` }})}\n\n`);
          res.end(); return;
        }

        let fullContent = '';
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let streamDone = false;
        let ollamaBuffer = '', googleBuffer = '', anthropicBuffer = '';

        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done) { streamDone = true; break; }
          const text = decoder.decode(value, { stream: true });

          if (isOllama) {
            ollamaBuffer += text;
            const lines = ollamaBuffer.split('\n'); ollamaBuffer = lines.pop();
            for (const line of lines) { if (!line.trim()) continue; try { const parsed = JSON.parse(line); const content = parsed.message?.content || ''; if (content) { fullContent += content; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`); } if (parsed.done) res.write('data: [DONE]\n\n'); } catch {} }
          } else if (pType === 'google') {
            googleBuffer += text;
            const lines = googleBuffer.split('\n'); googleBuffer = lines.pop();
            for (const line of lines) { const trimmed = line.trim(); if (!trimmed || trimmed === '[DONE]') continue; try { const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed; if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; } const parsed = JSON.parse(data); const gtext = parsed.candidates?.[0]?.content?.parts?.[0]?.text || ''; if (gtext) { fullContent += gtext; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: gtext }, finish_reason: null }] })}\n\n`); } } catch {} }
          } else if (pType === 'anthropic') {
            anthropicBuffer += text;
            const lines = anthropicBuffer.split('\n'); anthropicBuffer = lines.pop();
            for (const line of lines) { const trimmed = line.trim(); if (trimmed.startsWith('data: ')) { const data = trimmed.slice(6); try { const parsed = JSON.parse(data); if (parsed.type === 'content_block_delta' && parsed.delta?.text) { fullContent += parsed.delta.text; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parsed.delta.text }, finish_reason: null }] })}\n\n`); } else if (parsed.type === 'message_stop') { res.write('data: [DONE]\n\n'); } } catch {} } }
          } else {
            res.write(Buffer.from(value));
            const lines = text.split('\n').filter(l => l.startsWith('data: '));
            for (const line of lines) { const data = line.slice(6).trim(); if (data === '[DONE]') continue; try { const parsed = JSON.parse(data); const delta = parsed.choices?.[0]?.delta?.content; if (delta) fullContent += delta; } catch {} }
          }
        }

        if (conversation_id && fullContent) { const msgId = randomUUID(); const estTokens = Math.ceil(fullContent.length / 4); stmts.messages.insert.run(msgId, conversation_id, 'assistant', fullContent, '[]', '[]', null, modelId, 0, estTokens); const cost = getModelCost(modelId, 0, estTokens); stmts.tokenUsage.insert.run(conversation_id, modelId, provider.id, 0, estTokens, cost, 'inference'); }
        autoObserve(stmts, broadcast, logger, randomUUID, conversation_id, messages, fullContent, modelId);
        res.end();
      } catch (err) {
        logger.error('LLM proxy error:', err);
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        res.end();
      }
    } else {
      try {
        const fetch = globalThis.fetch;
        const { headers: nonStreamHeaders, url: nonStreamUrl } = buildProviderAuth(provider, url);
        const nonStreamPayload = buildChatPayload(pType, modelId, messages, false);
        const resp = await fetch(nonStreamUrl, { method: 'POST', headers: nonStreamHeaders, body: JSON.stringify(nonStreamPayload), signal: AbortSignal.timeout(30000) });
        if (!resp.ok) {
          const failoverStatuses = [429, 500, 502, 503, 504];
          if (failoverStatuses.includes(resp.status) || resp.status >= 500) {
            const fallback = findFallbackProvider(stmts, provider.id);
            if (fallback) {
              logger.warn(`Failover (non-stream): ${provider.name} → ${fallback.provider.name} (${resp.status})`);
              audit('failover', 'provider', provider.id, null, { from: provider.name, to: fallback.provider.name, reason: `HTTP ${resp.status}`, mode: 'non-stream' });
              stmts.tokenUsage.insert.run(conversation_id || null, modelId, provider.id, 0, 0, 0, 'failover');
              const fbPType = fallback.provider.type;
              const fbUrl = buildChatUrl(fallback.baseUrl, fbPType, fallback.modelId, false);
              const { headers: fbHeaders, url: fbAuthUrl } = buildProviderAuth(fallback.provider, fbUrl);
              const fbPayload = buildChatPayload(fbPType, fallback.modelId, payload.messages || messages, false);
              try {
                const fbResp = await fetch(fbAuthUrl, { method: 'POST', headers: fbHeaders, body: JSON.stringify(fbPayload), signal: AbortSignal.timeout(30000) });
                if (fbResp.ok) {
                  const fbData = await fbResp.json();
                  let fbContent;
                  if (fallback.isOllama) fbContent = fbData.message?.content || '';
                  else if (fbPType === 'google') fbContent = fbData.candidates?.[0]?.content?.parts?.[0]?.text || '';
                  else if (fbPType === 'anthropic') fbContent = fbData.content?.[0]?.text || '';
                  else fbContent = fbData.choices?.[0]?.message?.content || '';
                  res.setHeader('X-Failover', 'true');
                  res.setHeader('X-Failover-Provider', fallback.provider.name);
                  if (conversation_id && fbContent) { const mId = randomUUID(); const pT = fbData.usage?.prompt_tokens || 0; const cT = fbData.usage?.completion_tokens || Math.ceil(fbContent.length/4); stmts.messages.insert.run(mId, conversation_id, 'assistant', fbContent, '[]', '[]', null, fallback.modelId, pT, cT); const cost = getModelCost(fallback.modelId, pT, cT); stmts.tokenUsage.insert.run(conversation_id, fallback.modelId, fallback.provider.id, pT, cT, cost, 'inference'); }
                  autoObserve(stmts, broadcast, logger, randomUUID, conversation_id, messages, fbContent, fallback.modelId);
                  if (fallback.isOllama) { res.json({ id: `ollama-fb-${Date.now()}`, object: 'chat.completion', choices: [{ message: { role: 'assistant', content: fbContent }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: fbData.prompt_eval_count || 0, completion_tokens: fbData.eval_count || 0 } }); }
                  else { res.json(fbData); }
                  return;
                }
              } catch (fbErr) { logger.error('Non-stream fallback failed:', fbErr.message); }
            }
          }
          const errData = await resp.text();
          return res.status(502).json({ error: { message: `LLM API error (${resp.status}): ${errData.slice(0, 500)}` } });
        }
        const data = await resp.json();
        if (data.error) return res.status(502).json(data);

        let content;
        if (isOllama) content = data.message?.content || '';
        else if (pType === 'google') content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        else if (pType === 'anthropic') content = data.content?.[0]?.text || '';
        else content = data.choices?.[0]?.message?.content || '';
        if (conversation_id && content) {
          const msgId = randomUUID();
          let pT, cT;
          if (pType === 'google') { pT = data.usageMetadata?.promptTokenCount || 0; cT = data.usageMetadata?.candidatesTokenCount || Math.ceil(content.length/4); }
          else if (pType === 'anthropic') { pT = data.usage?.input_tokens || 0; cT = data.usage?.output_tokens || Math.ceil(content.length/4); }
          else { pT = data.usage?.prompt_tokens || 0; cT = data.usage?.completion_tokens || (isOllama ? data.eval_count : 0) || Math.ceil(content.length/4); }
          stmts.messages.insert.run(msgId, conversation_id, 'assistant', content, '[]', '[]', null, modelId, pT, cT);
          const cost = getModelCost(modelId, pT, cT);
          stmts.tokenUsage.insert.run(conversation_id, modelId, provider.id, pT, cT, cost, 'inference');
        }
        autoObserve(stmts, broadcast, logger, randomUUID, conversation_id, messages, content, modelId);
        fireHook('onChatMessage', { conversationId: conversation_id, role: 'assistant', content, model: modelId, provider: provider?.name });
        if (isOllama) {
          res.json({ id: `ollama-${Date.now()}`, object: 'chat.completion', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: data.prompt_eval_count || 0, completion_tokens: data.eval_count || 0, total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0) } });
        } else if (pType === 'google') {
          res.json({ id: `google-${Date.now()}`, object: 'chat.completion', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: data.usageMetadata?.promptTokenCount || 0, completion_tokens: data.usageMetadata?.candidatesTokenCount || 0 } });
        } else if (pType === 'anthropic') {
          res.json({ id: data.id || `anthropic-${Date.now()}`, object: 'chat.completion', choices: [{ message: { role: 'assistant', content }, finish_reason: data.stop_reason || 'stop', index: 0 }], usage: { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0 } });
        } else { res.json(data); }
      } catch (err) {
        logger.error('LLM proxy error:', err);
        res.status(502).json({ error: { message: err.message } });
      }
    }
  });

  return router;
}
