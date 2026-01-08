#!/usr/bin/env node
/**
 * Test MCP client to verify the proxy works correctly
 * Simulates how Claude Code communicates with the proxy
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

const proxy = spawn('node', ['dist/bin/cli.js', 'serve'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let messageId = 1;

// Handle stderr (connection logs)
const rl = createInterface({ input: proxy.stderr });
rl.on('line', (line) => {
  console.error('[PROXY]', line);
});

// Handle stdout (MCP responses)
const responseReader = createInterface({ input: proxy.stdout });
responseReader.on('line', (line) => {
  console.log('[RESPONSE]', line);
  try {
    const response = JSON.parse(line);
    console.log(JSON.stringify(response, null, 2));
  } catch (e) {
    // Not JSON, ignore
  }
});

function sendRequest(method, params = {}) {
  const request = {
    jsonrpc: '2.0',
    id: messageId++,
    method,
    params
  };
  console.log('[REQUEST]', JSON.stringify(request));
  proxy.stdin.write(JSON.stringify(request) + '\n');
}

// Wait for proxy to start
setTimeout(() => {
  console.log('\n=== Testing tools/list ===');
  sendRequest('tools/list');
}, 2000);

setTimeout(() => {
  console.log('\n=== Testing get_workflow ===');
  sendRequest('tools/call', {
    name: 'get_workflow',
    arguments: { name: 'feature' }
  });
}, 4000);

setTimeout(() => {
  console.log('\n=== Cleanup ===');
  proxy.kill();
  process.exit(0);
}, 8000);

proxy.on('exit', (code) => {
  console.log(`Proxy exited with code ${code}`);
});
