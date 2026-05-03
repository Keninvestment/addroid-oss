// AdDroid OSS — StubLLMProvider.
//
// OAuth client / 暗号化境界が未設定のときに使う最小実装。
// すべての書き込み操作が `LLMProviderNotConfiguredError` を投げ、UI / runtime 側で
// 「設定が未完了」を検知して /ai の setup 導線へ誘導する。

import {
  LLMNotImplementedError,
  LLMProviderNotConfiguredError,
  type LLMAuthKind,
  type LLMBeginOAuthResult,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMConnectionMeta,
  type LLMEmbedRequest,
  type LLMEmbedResult,
  type LLMImageRequest,
  type LLMImageResult,
  type LLMProvider,
  type LLMProviderName,
  type LLMRefreshResult,
} from "./types.js";

export class StubLLMProvider implements LLMProvider {
  readonly name: LLMProviderName;
  readonly authKind: LLMAuthKind = "none";
  readonly defaultModel: string;

  constructor(name: LLMProviderName = "codex", defaultModel = "gpt-4.1") {
    this.name = name;
    this.defaultModel = defaultModel;
  }

  async beginOAuth(): Promise<LLMBeginOAuthResult> {
    throw new LLMProviderNotConfiguredError(this.name, "beginOAuth");
  }
  async completeOAuth(): Promise<LLMConnectionMeta> {
    throw new LLMProviderNotConfiguredError(this.name, "completeOAuth");
  }
  async refreshToken(): Promise<LLMRefreshResult> {
    throw new LLMProviderNotConfiguredError(this.name, "refreshToken");
  }
  async disconnect(): Promise<boolean> {
    return false;
  }
  async getConnection(): Promise<LLMConnectionMeta | null> {
    return null;
  }
  async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    throw new LLMProviderNotConfiguredError(this.name, "complete");
  }
  async generateImage(_req: LLMImageRequest): Promise<LLMImageResult> {
    throw new LLMNotImplementedError(this.name, "generateImage");
  }
  async embed(_req: LLMEmbedRequest): Promise<LLMEmbedResult> {
    throw new LLMNotImplementedError(this.name, "embed");
  }
}
