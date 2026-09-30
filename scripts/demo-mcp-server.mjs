// Demo MCP server over stdio (zero dependencies) — used to test PiCode's
// bundled MCP extension: implements the MCP handshake, tools/list and tools/call.
// Run: node scripts/demo-mcp-server.mjs
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: '原样返回输入文本（演示 MCP 工具）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: '计算两个数字之和（演示 MCP 工具）',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // notification
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo-mcp', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } });
    } else if (name === 'add') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${args.a} + ${args.b} = ${args.a + args.b}` }] } });
    } else {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true } });
    }
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});

process.stderr.write('demo-mcp-server ready\n');
