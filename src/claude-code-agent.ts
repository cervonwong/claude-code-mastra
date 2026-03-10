import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Agent } from '@mastra/core';
import type { ToolAction } from '@mastra/core';
import { z } from 'zod';
import type { 
  GenerateTextResult, 
  StreamTextResult,
  GenerateObjectResult,
  StreamObjectResult,
  ToolCall,
  ToolResult,
  CoreMessage
} from 'ai';
import type {
  ClaudeCodeAgentOptions,
  MastraResponse,
  MastraStreamChunk,
  SessionInfo,
  ToolsInput
} from './types.js';
import { MessageConverter } from './message-converter.js';
import { SessionManager, validateOptions, formatError } from './utils.js';
import { ToolBridge } from './tool-bridge.js';

export class ClaudeCodeAgent extends Agent {
  // Mastraの基底クラスのメソッドシグネチャと互換性を保つため、anyでオーバーライド
  private sessionManager: SessionManager;
  private messageConverter: MessageConverter;
  private claudeOptions: Required<ClaudeCodeAgentOptions>;
  private _tools: ToolsInput;
  private toolBridge: ToolBridge;

  constructor(config: any & { claudeCodeOptions?: ClaudeCodeAgentOptions; tools?: ToolsInput }) {
    super(config);
    this.sessionManager = new SessionManager();
    this.messageConverter = new MessageConverter();
    this.claudeOptions = validateOptions(config.claudeCodeOptions);
    this._tools = config.tools || {};
    this.toolBridge = new ToolBridge(this._tools);
  }

  async generate(
    messages: string | string[] | any[],
    args?: any
  ): Promise<any> {
    const session = this.sessionManager.createSession();
    const prompt = this.extractPromptFromMessages(messages);
    
    // ツール履歴をクリア
    this.toolBridge.clearHistory();
    
    // オプションをマージ
    const mergedOptions = { ...this.claudeOptions, ...this.extractClaudeOptionsFromArgs(args) };
    
    // Mastraツールがある場合は、Claude Code内蔵ツールを無効化し、Mastraツールのみを使用
    const toolsSystemPrompt = this.toolBridge.generateSystemPrompt();
    if (toolsSystemPrompt) {
      // Claude Code内蔵ツールを無効化
      mergedOptions.disallowedTools = ['Task', 'Bash', 'Read', 'Write', 'Edit', 'LS', 'Glob', 'Grep'];
      
      if (!mergedOptions.systemPrompt) {
        mergedOptions.systemPrompt = toolsSystemPrompt;
      } else if (typeof mergedOptions.systemPrompt === 'string') {
        mergedOptions.systemPrompt = `${mergedOptions.systemPrompt}\n\n${toolsSystemPrompt}`;
      } else if (mergedOptions.systemPrompt?.type === 'preset') {
        const existingAppend = mergedOptions.systemPrompt.append || '';
        mergedOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: existingAppend ? `${existingAppend}\n\n${toolsSystemPrompt}` : toolsSystemPrompt
        };
      }
    }

    try {
      const claudeOptions = this.createClaudeCodeOptions(mergedOptions);
      const sdkMessages: SDKMessage[] = [];
      const startTime = Date.now();

      // ツール実行ループ
      let currentPrompt = prompt;
      let iterationCount = 0;
      const maxIterations = 5; // 無限ループを防ぐ

      console.log('🚀 Debug - Starting tool execution loop, max iterations:', maxIterations);
      console.log('🚀 Debug - Available tools:', Object.keys(this._tools));

      while (iterationCount < maxIterations) {
        console.log(`🔄 Debug - Iteration ${iterationCount + 1}/${maxIterations}`);
        
        const iterationMessages: SDKMessage[] = [];
        await this.collectMessages(currentPrompt, claudeOptions, iterationMessages);
        console.log('📨 Debug - Received messages count:', iterationMessages.length);
        console.log('📨 Debug - Message types:', iterationMessages.map(m => m.type));
        
        sdkMessages.push(...iterationMessages);

        // ツール呼び出しを検出
        // Debug: simplified message logging
        console.log('📨 Debug - Assistant messages:', iterationMessages
          .filter(m => m.type === 'assistant')
          .map((m, i) => `[${i}] ${m.type}`)
        );
        
        const lastMessage = this.getLastAssistantContent(iterationMessages);
        console.log('🔍 Debug - Last assistant message:', lastMessage?.substring(0, 200) + '...');
        
        if (!lastMessage) {
          console.log('❌ Debug - No last message found');
          break;
        }
        
        const toolCall = this.toolBridge.detectToolCall(lastMessage);
        console.log('🔍 Debug - Tool call detected:', toolCall);
        
        if (!toolCall) {
          console.log('❌ Debug - No tool call detected, breaking loop');
          break; // ツール呼び出しがなければ終了
        }

        console.log('✅ Debug - Executing tool:', toolCall.toolName, 'with params:', toolCall.parameters);
        
        // ツールを実行
        const toolResult = await this.toolBridge.executeTool(toolCall.toolName, toolCall.parameters);
        console.log('✅ Debug - Tool execution result:', toolResult);
        
        const resultMessage = this.toolBridge.formatToolResult(toolResult);
        
        currentPrompt = `${resultMessage}\n\nPlease continue with the task using this information.`;
        iterationCount++;
      }

      this.sessionManager.endSession(session.sessionId);
      
      const mastraResponse = this.messageConverter.convertSDKMessageToMastraResponse(
        sdkMessages,
        session.sessionId,
        startTime
      );

      // ツール実行履歴から toolCalls と toolResults を生成
      const toolHistory = this.toolBridge.getExecutionHistory();
      const toolCalls: any[] = [];
      const toolResults: any[] = [];

      toolHistory.forEach(execution => {
        const toolCallId = `call_${execution.timestamp}`;
        
        // ToolCall
        toolCalls.push({
          type: 'tool-call',
          toolCallId,
          toolName: execution.toolName,
          args: execution.input
        });

        // ToolResult
        toolResults.push({
          type: 'tool-result',
          toolCallId,
          toolName: execution.toolName,
          args: execution.input,
          result: execution.output,
          isError: !!execution.error
        });
      });

      return {
        text: mastraResponse.content,
        toolCalls: toolCalls.length > 0 ? toolCalls : [],
        toolResults: toolResults.length > 0 ? toolResults : [],
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        },
        finishReason: 'stop' as const,
        experimental_providerMetadata: {
          sessionId: mastraResponse.metadata?.sessionId || '',
          cost: mastraResponse.metadata?.cost || 0,
          duration: mastraResponse.metadata?.duration || 0
        }
      };

    } catch (error) {
      this.sessionManager.endSession(session.sessionId);
      throw new Error(`Claude Code execution failed: ${formatError(error)}`);
    } finally {
      setTimeout(() => {
        this.sessionManager.cleanupSession(session.sessionId);
      }, 30000);
    }
  }

  async stream(
    messages: string | string[] | any[],
    args?: any
  ): Promise<any> {
    const session = this.sessionManager.createSession();
    const prompt = this.extractPromptFromMessages(messages);
    
    // ツール履歴をクリア
    this.toolBridge.clearHistory();
    
    // オプションをマージ
    const mergedOptions = { ...this.claudeOptions, ...this.extractClaudeOptionsFromArgs(args) };
    
    // Mastraツールがある場合は、Claude Code内蔵ツールを無効化し、Mastraツールのみを使用
    const toolsSystemPrompt = this.toolBridge.generateSystemPrompt();
    if (toolsSystemPrompt) {
      // Claude Code内蔵ツールを無効化
      mergedOptions.disallowedTools = ['Task', 'Bash', 'Read', 'Write', 'Edit', 'LS', 'Glob', 'Grep'];
      
      if (!mergedOptions.systemPrompt) {
        mergedOptions.systemPrompt = toolsSystemPrompt;
      } else if (typeof mergedOptions.systemPrompt === 'string') {
        mergedOptions.systemPrompt = `${mergedOptions.systemPrompt}\n\n${toolsSystemPrompt}`;
      } else if (mergedOptions.systemPrompt?.type === 'preset') {
        const existingAppend = mergedOptions.systemPrompt.append || '';
        mergedOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: existingAppend ? `${existingAppend}\n\n${toolsSystemPrompt}` : toolsSystemPrompt
        };
      }
    }
    
    const chunks: MastraStreamChunk[] = [];
    
    try {
      const claudeOptions = this.createClaudeCodeOptions(mergedOptions);
      
      chunks.push(this.messageConverter.createMetadataChunk(
        { status: 'started', options: mergedOptions },
        session.sessionId
      ));

      // ツール実行ループ（ストリーミング版）
      let currentPrompt = prompt;
      let iterationCount = 0;
      const maxIterations = 5;

      while (iterationCount < maxIterations) {
        const iterationMessages: SDKMessage[] = [];
        const queryIterator = query({ prompt: currentPrompt, options: claudeOptions });

        for await (const message of queryIterator) {
          this.updateSessionFromMessage(session.sessionId, message);
          chunks.push(this.messageConverter.convertSDKMessageToStreamChunk(message));
          iterationMessages.push(message);
        }

        // ツール呼び出しを検出
        const lastMessage = this.getLastAssistantContent(iterationMessages);
        if (!lastMessage) {
          break;
        }
        
        const toolCall = this.toolBridge.detectToolCall(lastMessage);
        if (!toolCall) {
          break; // ツール呼び出しがなければ終了
        }

        // ツールを実行
        const toolResult = await this.toolBridge.executeTool(toolCall.toolName, toolCall.parameters);
        const resultMessage = this.toolBridge.formatToolResult(toolResult);
        
        // ツール実行結果をメタデータチャンクとして追加
        chunks.push(this.messageConverter.createMetadataChunk(
          { toolExecution: { name: toolCall.toolName, result: toolResult.output, error: toolResult.error } },
          session.sessionId
        ));
        
        currentPrompt = `${resultMessage}\n\nPlease continue with the task using this information.`;
        iterationCount++;
      }

      this.sessionManager.endSession(session.sessionId);
      chunks.push(this.messageConverter.createMetadataChunk(
        { status: 'completed' },
        session.sessionId
      ));

    } catch (error) {
      this.sessionManager.endSession(session.sessionId);
      chunks.push(this.messageConverter.createErrorChunk(formatError(error), session.sessionId));
    } finally {
      setTimeout(() => {
        this.sessionManager.cleanupSession(session.sessionId);
      }, 30000);
    }

    // ツール実行履歴から toolCalls と toolResults を生成
    const toolHistory = this.toolBridge.getExecutionHistory();
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    toolHistory.forEach(execution => {
      const toolCallId = `call_${execution.timestamp}`;
      
      // ToolCall
      toolCalls.push({
        type: 'tool-call',
        toolCallId,
        toolName: execution.toolName,
        args: execution.input
      });

      // ToolResult
      toolResults.push({
        type: 'tool-result',
        toolCallId,
        toolName: execution.toolName,
        args: execution.input,
        result: execution.output,
        isError: !!execution.error
      });
    });

    // StreamTextResultを返すために、シンプルなストリームオブジェクトを作成
    return {
      textStream: this.createAsyncIterable(chunks) as any,
      text: this.getTextFromChunks(chunks),
      toolCalls: Promise.resolve(toolCalls.length > 0 ? toolCalls : []),
      toolResults: Promise.resolve(toolResults.length > 0 ? toolResults : []),
      usage: Promise.resolve({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      }),
      finishReason: Promise.resolve('stop' as const),
      experimental_providerMetadata: Promise.resolve({ 
        sessionId: session.sessionId
      })
    };
  }

  private async collectMessages(
    prompt: string,
    claudeOptions: Options,
    messages: SDKMessage[]
  ): Promise<void> {
    for await (const message of query({ prompt, options: claudeOptions })) {
      messages.push(message);
    }
  }

  private createClaudeCodeOptions(options: Required<ClaudeCodeAgentOptions>): Options {
    const claudeOptions: Options = {
      maxTurns: options.maxTurns,
      cwd: options.cwd
    };

    if (options.allowedTools.length > 0) {
      claudeOptions.allowedTools = options.allowedTools;
    }

    if (options.disallowedTools.length > 0) {
      claudeOptions.disallowedTools = options.disallowedTools;
    }

    if (options.permissionMode !== 'default') {
      claudeOptions.permissionMode = options.permissionMode;
    }

    if (options.model) {
      claudeOptions.model = options.model;
    }

    if (options.fallbackModel) {
      claudeOptions.fallbackModel = options.fallbackModel;
    }

    if (options.systemPrompt) {
      claudeOptions.systemPrompt = options.systemPrompt;
    }

    if (options.thinking) {
      claudeOptions.thinking = options.thinking;
    } else if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens > 0) {
      claudeOptions.maxThinkingTokens = options.maxThinkingTokens;
    }

    if (options.effort) {
      claudeOptions.effort = options.effort;
    }

    if (options.mcpServers) {
      claudeOptions.mcpServers = options.mcpServers;
    }

    if (options.settingSources && options.settingSources.length > 0) {
      claudeOptions.settingSources = options.settingSources;
    }

    return claudeOptions;
  }

  private updateSessionFromMessage(sessionId: string, message: SDKMessage): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    if (message.type === 'assistant') {
      this.sessionManager.updateSession(sessionId, {
        totalTurns: session.totalTurns + 1
      });
    }

    if (message.type === 'result') {
      this.sessionManager.updateSession(sessionId, {
        totalCost: message.total_cost_usd,
        isError: message.is_error
      });
    }
  }

  getSessionInfo(sessionId: string): SessionInfo | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  getAllActiveSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const session of this.sessionManager['sessions'].values()) {
      if (session.isActive) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.sessionManager.endSession(sessionId);
  }

  // Claude Code固有のメソッド
  updateClaudeCodeOptions(options: Partial<ClaudeCodeAgentOptions>): void {
    this.claudeOptions = validateOptions({ ...this.claudeOptions, ...options });
  }

  getClaudeCodeOptions(): Required<ClaudeCodeAgentOptions> {
    return { ...this.claudeOptions };
  }

  // Mastra Agent Tools メソッド
  getTools(): ToolsInput {
    return { ...this._tools };
  }

  getToolNames(): string[] {
    return Object.keys(this._tools);
  }

  getToolDescriptions(): Record<string, string> {
    const descriptions: Record<string, string> = {};
    for (const [name, tool] of Object.entries(this._tools)) {
      descriptions[name] = tool.description;
    }
    return descriptions;
  }

  async executeTool(toolName: string, input: any): Promise<any> {
    const tool = this._tools[toolName];
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found`);
    }

    // 入力スキーマの検証
    if (tool.inputSchema) {
      try {
        const validatedInput = tool.inputSchema.parse(input);
        input = validatedInput;
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Invalid input for tool "${toolName}": ${error.message}`);
        }
        throw error;
      }
    }

    // ツールの実行
    if (!tool.execute) {
      throw new Error(`Tool "${toolName}" does not have an execute function`);
    }

    return await tool.execute({ context: input }, {
      toolCallId: `tool_${Date.now()}`,
      messages: []
    });
  }

  addTool(name: string, tool: ToolAction<any, any, any>): void {
    this._tools[name] = tool;
  }

  removeTool(name: string): void {
    delete this._tools[name];
  }

  private getLastAssistantContent(messages: SDKMessage[]): string | null {
    // 最後のアシスタントメッセージの内容を取得
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.type === 'assistant') {
        let content: string | undefined;
        
        // 直接contentフィールドがある場合
        if ('content' in message && typeof message.content === 'string') {
          content = message.content;
        } 
        // message.message.contentの構造の場合
        else if ('message' in message && message.message && typeof message.message === 'object') {
          const innerMessage = message.message as any;
          if ('content' in innerMessage && typeof innerMessage.content === 'string') {
            content = innerMessage.content;
          }
          // content配列の場合
          else if (Array.isArray(innerMessage.content)) {
            content = innerMessage.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text)
              .join(' ');
          }
        }
        
        console.log('🔍 Debug - Extracted content:', content?.substring(0, 200) + '...');
        if (content) return content;
      }
    }
    return null;
  }

  // ヘルパーメソッド
  private generateToolsPrompt(): string {
    const toolNames = this.getToolNames();
    if (toolNames.length === 0) {
      return '';
    }

    const toolDescriptions = toolNames.map(name => {
      const tool = this._tools[name];
      let description = `- ${name}: ${tool.description}`;
      
      // 入力スキーマの情報を追加
      if (tool.inputSchema) {
        try {
          // Zodスキーマから型情報を抽出
          const shape = (tool.inputSchema as any)._def?.shape?.() || {};
          const params = Object.entries(shape).map(([key, value]: [string, any]) => {
            const type = value._def?.typeName?.replace('Zod', '').toLowerCase() || 'unknown';
            const isOptional = value.isOptional?.() || false;
            return `${key}: ${type}${isOptional ? ' (optional)' : ''}`;
          }).join(', ');
          
          if (params) {
            description += ` [Parameters: ${params}]`;
          }
        } catch (e) {
          // スキーマの解析に失敗した場合は無視
        }
      }
      
      return description;
    }).join('\n');

    return `You have access to the following custom tools:\n${toolDescriptions}\n\nWhen you need to use one of these tools, respond with a special format:\n<tool_use>\n<tool_name>TOOL_NAME</tool_name>\n<parameters>\n{\n  "param1": "value1",\n  "param2": "value2"\n}\n</parameters>\n</tool_use>\n\nAfter using a tool, I will provide you with the result and you can continue with the task.`;
  }

  private detectToolCall(messages: SDKMessage[]): { toolName: string; input: any } | null {
    // メッセージからツール呼び出しを検出
    for (const message of messages) {
      if (message && message.type === 'assistant') {
        // SDKAssistantMessageのcontentフィールドを取得
        let content: string | undefined;
        if ('content' in message && typeof message.content === 'string') {
          content = message.content;
        } else if ('message' in message && message.message && typeof message.message === 'object' && 'content' in message.message && typeof message.message.content === 'string') {
          content = message.message.content;
        }
        
        if (!content) continue;
        
        // デバッグ: contentを確認
        if (process.env.DEBUG_TOOLS) {
          console.log('🔍 Checking message for tool calls:', content.substring(0, 200) + '...');
        }
        
        // XMLタグ形式のツール呼び出しを検出
        const toolUseMatch = content.match(/<tool_use>\s*<tool_name>([^<]+)<\/tool_name>\s*<parameters>\s*([\s\S]*?)\s*<\/parameters>\s*<\/tool_use>/i);
        if (toolUseMatch) {
          const toolName = toolUseMatch[1].trim();
          const parametersStr = toolUseMatch[2].trim();
          
          if (process.env.DEBUG_TOOLS) {
            console.log('✅ Tool call detected:', toolName);
            console.log('📄 Parameters:', parametersStr);
          }
          
          try {
            const input = JSON.parse(parametersStr);
            return { toolName, input };
          } catch (e) {
            // JSONパースエラーの場合は空オブジェクトを使用
            if (process.env.DEBUG_TOOLS) {
              console.log('⚠️ JSON parse error, using empty object');
            }
            return { toolName, input: {} };
          }
        }
        
        // 代替形式: "I want to use the X tool with Y parameters"
        const naturalMatch = content.match(/(?:i want to use|let me use|using|use) (?:the )?([\w]+) tool.*?(?:with|parameters?:?)\s*([\{\[].*?[\}\]]|\w+.*)/is);
        if (naturalMatch) {
          const toolName = naturalMatch[1];
          const paramsText = naturalMatch[2];
          
          try {
            const input = JSON.parse(paramsText);
            return { toolName, input };
          } catch (e) {
            // 自然言語からパラメータを抽出する試み
            const params: Record<string, any> = {};
            const tool = this._tools[toolName];
            if (tool && tool.inputSchema) {
              // スキーマに基づいてパラメータを抽出
              const shape = (tool.inputSchema as any)._def?.shape?.() || {};
              for (const key of Object.keys(shape)) {
                const regex = new RegExp(`${key}[:\s]+([^,\s]+)`, 'i');
                const match = paramsText.match(regex);
                if (match) {
                  params[key] = match[1];
                }
              }
            }
            return Object.keys(params).length > 0 ? { toolName, input: params } : null;
          }
        }
      }
    }
    
    return null;
  }
  private extractPromptFromMessages(messages: string | string[] | any[]): string {
    if (typeof messages === 'string') {
      return messages;
    }
    if (Array.isArray(messages)) {
      if (typeof messages[0] === 'string') {
        return (messages as string[]).join('\n');
      }
      return (messages as any[])
        .map(msg => typeof msg.content === 'string' ? msg.content : '')
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  private extractClaudeOptionsFromArgs(args?: any): Partial<ClaudeCodeAgentOptions> {
    if (!args) return {};
    
    return {
      maxTurns: args.maxSteps,
      // argsから他のClaudeCode関連オプションがあれば変換
    };
  }

  private async *createAsyncIterable(chunks: MastraStreamChunk[]): AsyncIterable<string> {
    for (const chunk of chunks) {
      if (chunk.type === 'content' && chunk.data.content) {
        yield chunk.data.content;
      }
    }
  }

  private getTextFromChunks(chunks: MastraStreamChunk[]): Promise<string> {
    const contentChunks = chunks
      .filter(chunk => chunk.type === 'content' && chunk.data.content)
      .map(chunk => chunk.data.content);
    return Promise.resolve(contentChunks.join(''));
  }
}