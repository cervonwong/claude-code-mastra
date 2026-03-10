import type { ToolAction } from '@mastra/core';

export type ToolsInput = Record<string, ToolAction<any, any, any>>;

/**
 * Thinking configuration for extended thinking behavior.
 */
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' };

/**
 * System prompt configuration.
 * - `string` - Use a custom system prompt
 * - `{ type: 'preset', preset: 'claude_code', append?: string }` - Use Claude Code's default system prompt with optional appended instructions
 */
export type SystemPromptConfig = string | { type: 'preset'; preset: 'claude_code'; append?: string };

/**
 * Setting source for controlling which filesystem settings to load.
 */
export type SettingSource = 'user' | 'project' | 'local';

export interface ClaudeCodeAgentOptions {
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
  cwd?: string;
  timeout?: number;
  model?: string;
  fallbackModel?: string;
  systemPrompt?: SystemPromptConfig;
  thinking?: ThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  /**
   * @deprecated Use `thinking` instead.
   */
  maxThinkingTokens?: number;
  mcpServers?: Record<string, McpServerConfig>;
  settingSources?: SettingSource[];
}

// Claude Agent SDKのMCPサーバー設定型を再定義
export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface MastraResponse {
  content: string;
  metadata?: {
    sessionId?: string;
    cost?: number;
    duration?: number;
    totalTurns?: number;
    isError?: boolean;
  };
}

export interface MastraStreamChunk {
  type: 'content' | 'metadata' | 'error' | 'complete';
  data: any;
}

export interface SessionInfo {
  sessionId: string;
  startTime: number;
  totalCost: number;
  totalTurns: number;
  isActive: boolean;
  isError?: boolean;
}

export interface ErrorDetails {
  code: string;
  message: string;
  originalError?: any;
}