// SCRIPTED stand-in model (tests only): lets the REAL Codex CLI and OpenCode binaries run end to end without a vendor account, so their
// argv, events and isolation can be checked in CI. It writes hello.txt through whatever write tool the CLI offers. Never used at runtime.
// Scripted mock model server for recording Codex CLI / OpenCode transcripts.
// Speaks OpenAI Responses API (/v1/responses, SSE) and Chat Completions (/v1/chat/completions, SSE).
// Usage: MOCK_PORT=18080 MOCK_MODE=ok|http500|stream_error MOCK_LOG=/path/dir node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.MOCK_PORT || 18080);
const MODE = process.env.MOCK_MODE || 'ok';
const LOGDIR = process.env.MOCK_LOG || fs.mkdtempSync(path.join(os.tmpdir(), 'mock-log-'));
fs.mkdirSync(LOGDIR, { recursive: true });
let reqNo = 0;

const FILE = 'hello.txt';
const CONTENT = 'hi there';
const FINAL = process.env.MOCK_PREFER === 'mcp' ? 'The omni server answered: pong: hello.' : 'Created hello.txt containing "hi there".';

function log(name, data) {
  fs.writeFileSync(path.join(LOGDIR, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

// ---------- decide which tool call to emit, from the tools the CLI advertised ----------
function toolNames(tools = []) {
  return tools.map((t) => t.name || t.function?.name).filter(Boolean);
}

function planToolCall(tools = [], cwd) {
  const names = toolNames(tools);
  const byName = (n) => tools.find((t) => (t.name || t.function?.name) === n);
  if (process.env.MOCK_PREFER === 'mcp') {
    const nm = names.find((x) => /ping/.test(x));
    if (nm) return { kind: 'function', name: nm, args: { msg: 'hello' } };
  }
  // OpenCode style
  if (names.includes('write') && process.env.MOCK_PREFER !== 'shell') {
    const t = byName('write');
    const props = (t.parameters || t.function?.parameters || {}).properties || {};
    const args = {};
    const pathKey = Object.keys(props).find((k) => /path/i.test(k)) || 'filePath';
    args[pathKey] = cwd ? path.join(cwd, FILE) : FILE;
    args.content = CONTENT;
    return { kind: 'function', name: 'write', args };
  }
  // Codex style: apply_patch (freeform custom tool or function tool)
  const ap = process.env.MOCK_PREFER === 'shell' ? null : byName('apply_patch');
  const patch = `*** Begin Patch\n*** Add File: ${FILE}\n+${CONTENT}\n*** End Patch\n`;
  if (ap) {
    if (ap.type === 'custom') return { kind: 'custom', name: 'apply_patch', input: patch };
    return { kind: 'function', name: 'apply_patch', args: { input: patch } };
  }
  for (const n of ['exec_command', 'shell', 'shell_command', 'bash']) {
    const t = byName(n);
    if (!t) continue;
    const props = (t.parameters || t.function?.parameters || {}).properties || {};
    const cmd = `printf 'hi there\\n' > ${FILE}`;
    if (props.cmd) return { kind: 'function', name: n, args: { cmd } };
    if (props.command && (props.command.type === 'array')) return { kind: 'function', name: n, args: { command: ['bash', '-lc', cmd] } };
    return { kind: 'function', name: n, args: { command: cmd, description: 'Write hello.txt' } };
  }
  return null;
}

function cwdFromText(s) {
  const m = s.match(/<cwd>([^<]+)<\/cwd>/) || s.match(/Working directory: (\S+)/);
  return m ? m[1].trim() : undefined;
}

// ---------- Responses API ----------
function isToolFollowup(body) {
  const items = Array.isArray(body.input) ? body.input : [];
  return items.some((i) => /_call_output$/.test(i.type || ''));
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

function handleResponses(body, res, n) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const rid = `resp_mock_${n}`;
  const usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1230 };
  sse(res, 'response.created', { response: { id: rid, object: 'response', status: 'in_progress', model: body.model, output: [] } });
  if (MODE === 'stream_error') {
    sse(res, 'response.failed', { response: { id: rid, status: 'failed', error: { code: 'server_error', message: 'Mock upstream exploded (scripted failure)' } } });
    res.end();
    return;
  }
  let item;
  let followup = isToolFollowup(body);
  let forcedCall = null;
  if (process.env.MOCK_PREFER === 'mcp') {
    const items = Array.isArray(body.input) ? body.input : [];
    const outs = items.filter((i) => /_output$/.test(i.type || ''));
    const last = outs[outs.length - 1];
    if (!last) forcedCall = { kind: 'tool_search', args: { query: 'ping omni', limit: 8 } };
    else if (last.type === 'tool_search_output') {
      // walk for the ping tool and its namespace
      let found = null;
      const walk = (o, ns) => { if (!o || typeof o !== 'object' || found) return; if (Array.isArray(o)) return o.forEach((x) => walk(x, ns));
        if (typeof o.name === 'string' && /ping/.test(o.name) && (o.parameters || o.type === 'function')) { found = { name: o.name, namespace: ns }; return; }
        const nextNs = o.type === 'namespace' ? o.name : ns; for (const v of Object.values(o)) walk(v, nextNs); };
      walk(last, undefined);
      forcedCall = found ? { kind: 'function', name: found.name, namespace: found.namespace, args: { msg: 'hello' } } : null;
      followup = !found;
    }
  }
  const out = [];
  let oi = 0;
  if (process.env.MOCK_REASONING === '1' && !followup) {
    const rtext = '**Planning file creation**\n\nI will add hello.txt with the requested content.';
    const ritem = { type: 'reasoning', id: `rs_${n}`, summary: [{ type: 'summary_text', text: rtext }], encrypted_content: 'bW9jaw==' };
    sse(res, 'response.output_item.added', { output_index: oi, item: { ...ritem, summary: [] } });
    sse(res, 'response.reasoning_summary_part.added', { output_index: oi, item_id: ritem.id, summary_index: 0, part: { type: 'summary_text', text: '' } });
    sse(res, 'response.reasoning_summary_text.delta', { output_index: oi, item_id: ritem.id, summary_index: 0, delta: rtext });
    sse(res, 'response.reasoning_summary_text.done', { output_index: oi, item_id: ritem.id, summary_index: 0, text: rtext });
    sse(res, 'response.reasoning_summary_part.done', { output_index: oi, item_id: ritem.id, summary_index: 0, part: { type: 'summary_text', text: rtext } });
    sse(res, 'response.output_item.done', { output_index: oi, item: ritem });
    out.push(ritem);
    oi++;
  }
  const call = forcedCall || (followup ? null : planToolCall(body.tools, cwdFromText(JSON.stringify(body.input || ''))));
  if (call && call.kind === 'tool_search') {
    item = { type: 'tool_search_call', id: `tsc_${n}`, call_id: `call_mock_${n}`, execution: 'client', arguments: call.args, status: 'completed' };
    sse(res, 'response.output_item.added', { output_index: oi, item: { ...item, status: 'in_progress' } });
    sse(res, 'response.output_item.done', { output_index: oi, item });
  } else if (call && call.kind === 'custom') {
    item = { type: 'custom_tool_call', id: `ctc_${n}`, call_id: `call_mock_${n}`, name: call.name, input: call.input, status: 'completed' };
    sse(res, 'response.output_item.added', { output_index: oi, item: { ...item, input: '', status: 'in_progress' } });
    sse(res, 'response.custom_tool_call_input.delta', { output_index: oi, item_id: item.id, delta: call.input });
    sse(res, 'response.custom_tool_call_input.done', { output_index: oi, item_id: item.id, input: call.input });
    sse(res, 'response.output_item.done', { output_index: oi, item });
  } else if (call) {
    const args = JSON.stringify(call.args);
    item = { type: 'function_call', id: `fc_${n}`, call_id: `call_mock_${n}`, name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}), arguments: args, status: 'completed' };
    sse(res, 'response.output_item.added', { output_index: oi, item: { ...item, arguments: '', status: 'in_progress' } });
    sse(res, 'response.function_call_arguments.delta', { output_index: oi, item_id: item.id, delta: args });
    sse(res, 'response.function_call_arguments.done', { output_index: oi, item_id: item.id, arguments: args });
    sse(res, 'response.output_item.done', { output_index: oi, item });
  } else {
    const text = FINAL;
    item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    sse(res, 'response.output_item.added', { output_index: oi, item: { ...item, content: [], status: 'in_progress' } });
    sse(res, 'response.content_part.added', { output_index: oi, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '' } });
    for (const chunk of [text.slice(0, 10), text.slice(10)]) sse(res, 'response.output_text.delta', { output_index: oi, item_id: item.id, content_index: 0, delta: chunk });
    sse(res, 'response.output_text.done', { output_index: oi, item_id: item.id, content_index: 0, text });
    sse(res, 'response.content_part.done', { output_index: oi, item_id: item.id, content_index: 0, part: { type: 'output_text', text } });
    sse(res, 'response.output_item.done', { output_index: oi, item });
  }
  sse(res, 'response.completed', { response: { id: rid, object: 'response', status: 'completed', model: body.model, output: [...out, item], usage } });
  res.end();
}

// ---------- Chat Completions ----------
function handleChat(body, res, n) {
  const msgs = body.messages || [];
  const followup = msgs.some((m) => m.role === 'tool');
  const stream = body.stream !== false;
  const id = `chatcmpl_mock_${n}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 };
  const sysText = msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const call = followup ? null : planToolCall(body.tools, cwdFromText(sysText));
  if (MODE === 'stream_error') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error: { message: 'Mock upstream exploded (scripted failure)', type: 'server_error', code: 'server_error' } })}\n\n`);
    res.end();
    return;
  }
  if (!stream) {
    const message = call
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call_mock_${n}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { role: 'assistant', content: FINAL };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finish_reason = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
  chunk({ role: 'assistant', content: '' });
  if (process.env.MOCK_REASONING === '1' && call) {
    chunk({ reasoning_content: 'Planning file creation: ' });
    chunk({ reasoning_content: 'I will write hello.txt with the requested content.' });
  }
  if (call) {
    const args = JSON.stringify(call.args);
    chunk({ tool_calls: [{ index: 0, id: `call_mock_${n}`, type: 'function', function: { name: call.name, arguments: '' } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] });
    chunk({}, 'tool_calls');
  } else {
    chunk({ content: FINAL.slice(0, 10) });
    chunk({ content: FINAL.slice(10) });
    chunk({}, 'stop');
  }
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const n = ++reqNo;
    const tag = String(n).padStart(3, '0');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _raw: raw.slice(0, 2000) }; }
    log(`${tag}-${req.method}-${req.url.replace(/[^a-z0-9]+/gi, '_')}.json`, { method: req.method, url: req.url, headers: { ...req.headers, authorization: req.headers.authorization ? '<redacted>' : undefined }, body });
    process.stderr.write(`[mock] #${n} ${req.method} ${req.url} mode=${MODE}\n`);
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && /\/models$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }));
      return;
    }
    if (MODE === 'http401' && req.method === 'POST') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided (scripted 401)', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      return;
    }
    if (MODE === 'http500' && req.method === 'POST') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Mock internal server error (scripted HTTP 500)', type: 'server_error', code: 'internal_error' } }));
      return;
    }
    if (req.method === 'POST' && /\/responses$/.test(url)) return handleResponses(body, res, n);
    if (req.method === 'POST' && /\/chat\/completions$/.test(url)) return handleChat(body, res, n);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }));
  });
});
server.listen(PORT, '127.0.0.1', () => process.stderr.write(`[mock] listening on 127.0.0.1:${PORT} mode=${MODE} log=${LOGDIR}\n`));
