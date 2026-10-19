// SCRIPTED stand-in model (tests only): lets the REAL Gemini CLI and Aider binaries run end to end without a vendor account. Never used at runtime.
// Scripted mock model server for recording real CLI transcripts.
// Usage: node mock.mjs <port> <mode> <logdir>
//   mode: gemini | gemini-error | openai-whole | openai-diff | openai-error
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [, , portArg, mode, logdir] = process.argv;
const port = Number(portArg);
fs.mkdirSync(logdir, { recursive: true });
let n = 0;

function log(req, body) {
  n += 1;
  const f = path.join(logdir, `req-${String(n).padStart(3, '0')}.json`);
  fs.writeFileSync(f, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: tryJson(body) }, null, 2));
}
function tryJson(s) { try { return JSON.parse(s); } catch { return s; } }

function hasFunctionResponse(body) {
  const contents = body?.contents ?? [];
  return contents.some((c) => (c.parts ?? []).some((p) => p.functionResponse));
}
function lastUserText(body) {
  const contents = body?.contents ?? [];
  const last = contents[contents.length - 1];
  return (last?.parts ?? []).map((p) => p.text ?? '').join('');
}
function pickWriteTool(body) {
  const decls = (body?.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
  const names = decls.map((d) => d.name);
  return names.includes('write_file') ? 'write_file' : names.find((x) => /write/i.test(x)) ?? 'write_file';
}
const usage = { promptTokenCount: 1200, candidatesTokenCount: 20, totalTokenCount: 1220 };

function geminiChunks(body, url) {
  const isMain = Array.isArray(body?.tools) && body.tools.length > 0;
  if (!isMain) {
    // Auxiliary calls (routing classifier, next-speaker check, summaries, etc.)
    const sys = JSON.stringify(body?.systemInstruction ?? body?.generationConfig ?? '').slice(0, 4000);
    let text = 'ok';
    if (/next_speaker|next speaker/i.test(sys + JSON.stringify(body?.contents ?? '').slice(-4000))) {
      text = JSON.stringify({ reasoning: 'The model finished its turn.', next_speaker: 'user' });
    } else if (body?.generationConfig?.responseJsonSchema?.properties?.complexity_score) {
      text = JSON.stringify({ complexity_reasoning: 'Single explicit file write.', complexity_score: 10 });
    } else if (/complexity|router|classif/i.test(sys)) {
      text = JSON.stringify({ reasoning: 'simple', model_choice: 'flash' });
    }
    return [{ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' }];
  }
  if (mode === 'gemini-safety') {
    return [{ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY', index: 0, safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }] }], usageMetadata: usage, modelVersion: 'mock-gemini' }];
  }
  if (mode === 'gemini-empty') {
    return [{ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' }];
  }
  if (mode === 'gemini-text') {
    return [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello from the scripted model.' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' }];
  }
  if (!hasFunctionResponse(body)) {
    const tool = pickWriteTool(body);
    return [
      { candidates: [{ content: { role: 'model', parts: [{ text: '**Planning the write**\n\nThe user wants a single file; I will use write_file.', thought: true }] }, index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' },
      { candidates: [{ content: { role: 'model', parts: [{ text: "I'll create hello.txt now." }] }, index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' },
      mode === 'gemini-mcp' ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: (body.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).map((d) => d.name).find((x) => x.startsWith('mcp_')) ?? 'mcp_missing', args: { text: 'hello from mock' } } }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' } :
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: tool, args: { file_path: mode === 'gemini-toolerr' ? '/etc/omniforge-mock/hello.txt' : path.join(process.env.MOCK_PROJECT_DIR ?? '.', 'hello.txt'), content: 'hi there' } } }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' },
    ];
  }
  return [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Created `hello.txt` ' }] }, index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'containing `hi there`.' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' },
  ];
}

function handleGemini(req, res, body) {
  const url = req.url;
  if (mode === 'gemini-error') {
    res.writeHead(Number(process.env.MOCK_STATUS ?? 500), { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 500, message: 'Mock internal error (scripted)', status: 'INTERNAL' } }));
    return;
  }
  if (/:countTokens/.test(url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ totalTokens: 100 })); return; }
  if (/:embedContent|:batchEmbedContents/.test(url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ embedding: { values: [0, 0, 0] } })); return; }
  const chunks = geminiChunks(body, url);
  if (/:streamGenerateContent/.test(url)) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
    res.end();
    return;
  }
  if (/:generateContent/.test(url)) {
    // merge chunks into one response
    const parts = chunks.flatMap((c) => c.candidates[0].content.parts);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-gemini' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 404, message: 'mock: unknown path ' + url, status: 'NOT_FOUND' } }));
}

function openaiReply(body) {
  const msgs = body?.messages ?? [];
  const sys = msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  if (mode === 'openai-shell') {
    return 'I will create the file.\n\nhello.txt\n```\n<<<<<<< SEARCH\n=======\nhi there\n>>>>>>> REPLACE\n```\n\nYou can verify with:\n\n```bash\ntouch ' + (process.env.MOCK_PROJECT_DIR ?? '.') + '/model-suggested-shell-ran.marker\n```\n';
  }
  if (mode === 'openai-diff-edit') {
    return 'I will update the greeting.\n\nhello.txt\n```\n<<<<<<< SEARCH\nhello world\n=======\nhi there\n>>>>>>> REPLACE\n```\n\nUpdated hello.txt to contain hi there.';
  }
  if (mode === 'openai-diff-bad') {
    return 'I will update the greeting.\n\nhello.txt\n```\n<<<<<<< SEARCH\nthis text does not exist\n=======\nhi there\n>>>>>>> REPLACE\n```\n';
  }
  if (mode === 'openai-diff') {
    return 'I will create the file.\n\nhello.txt\n```\n<<<<<<< SEARCH\n=======\nhi there\n>>>>>>> REPLACE\n```\n\nCreated hello.txt containing hi there.';
  }
  // whole-file format
  return 'I will create the file.\n\nhello.txt\n```\nhi there\n```\n\nCreated hello.txt containing hi there.';
}

function handleOpenAI(req, res, body) {
  if (mode === 'openai-error') {
    res.writeHead(Number(process.env.MOCK_STATUS ?? 500), { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Mock internal error (scripted)', type: 'server_error', code: 'internal_error' } }));
    return;
  }
  if (req.method === 'GET' && /\/models/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model', owned_by: 'mock' }] }));
    return;
  }
  if (!/chat\/completions/.test(req.url)) { res.writeHead(404); res.end('{}'); return; }
  const text = openaiReply(body);
  const id = 'chatcmpl-mock' + n;
  const created = Math.floor(Date.now() / 1000);
  const u = { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 };
  if (body?.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const pieces = text.match(/[\s\S]{1,12}/g);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
    for (const p of pieces) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'mock', choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: u })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id, object: 'chat.completion', created, model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: u }));
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    log(req, body);
    const parsed = tryJson(body);
    try {
      if (mode.startsWith('gemini')) handleGemini(req, res, parsed);
      else handleOpenAI(req, res, parsed);
    } catch (e) {
      res.writeHead(599); res.end(String(e));
    }
  });
}).listen(port, '127.0.0.1', () => console.error(`mock ${mode} on ${port}`));
