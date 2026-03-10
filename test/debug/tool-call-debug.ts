import { ClaudeCodeAgent } from '../../src/claude-code-agent.js';
import { z } from 'zod';
import type { ToolAction } from '@mastra/core';

// デバッグ用のテストスクリプト
async function debugToolCalls() {
  console.log('🔍 Debugging tool calls...\n');

  // エコーツール
  const echoTool: ToolAction = {
    description: 'Echo a message',
    inputSchema: z.object({
      message: z.string()
    }),
    execute: async ({ context }) => {
      console.log('🔧 ECHO TOOL EXECUTED:', context.message);
      return { echoed: context.message };
    }
  };

  // エージェントを作成
  const agent = new ClaudeCodeAgent({
    name: 'debug-agent',
    instructions: 'You are a test agent with access to an echo tool.',
    model: 'claude-sonnet-4-5',
    tools: {
      echo: echoTool
    },
    claudeCodeOptions: {
      maxTurns: 1
    }
  });

  try {
    console.log('📝 Calling generate...');
    const result = await agent.generate('Use the echo tool to echo "Hello from tool!"');
    
    console.log('\n📊 Result:');
    console.log('- text:', result.text);
    console.log('- toolCalls:', result.toolCalls);
    console.log('- usage:', result.usage);
    console.log('- finishReason:', result.finishReason);
    console.log('- experimental_providerMetadata:', result.experimental_providerMetadata);
    
    // ツールブリッジの履歴を確認
    const toolBridge = (agent as any).toolBridge;
    const history = toolBridge.getExecutionHistory();
    console.log('\n🗂️ Tool execution history:', history);

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// デバッグを実行
debugToolCalls().then(() => {
  console.log('\n✅ Debug completed');
}).catch(error => {
  console.error('❌ Debug failed:', error);
});