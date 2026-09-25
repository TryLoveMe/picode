// PiCode E2E mock LLM — speaks the Anthropic Messages SSE protocol (api:
// "anthropic-messages" in pi models.json). First request asks to read
// hello.txt; the follow-up (with tool result) returns a rich markdown answer.
import http from 'node:http';

export function startMockLlm(port = 8712) {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      }).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
      const last = parsed.messages?.[parsed.messages.length - 1];
      const hasToolResult = Array.isArray(last?.content)
        ? last.content.some((b) => b.type === 'tool_result')
        : false;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: 'mock-1', usage: { input_tokens: 120, output_tokens: 1 } } });
      if (hasToolResult) {
        const text = [
          '已读取 `hello.txt`，内容是 **hello from picode-e2e**。',
          '',
          '## 小结',
          '',
          '- 文件存在且可读',
          '- 内容共 1 行',
          '',
          '```js',
          'console.log("hello from picode-e2e");',
          '```',
        ].join('\n');
        // stream the text in small chunks to exercise delta rendering
        const words = text.match(/[\s\S]{1,24}/g) || [];
        let idx = 0;
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const w of words) {
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } });
        }
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 87 } });
        send('message_stop', { type: 'message_stop' });
        void idx;
      } else {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '用户想让我读取 hello.txt，调用 read 工具。' } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'read', input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'hello.txt' }) } });
        send('content_block_stop', { type: 'content_block_stop', index: 1 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } });
        send('message_stop', { type: 'message_stop' });
      }
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
