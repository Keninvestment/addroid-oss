// AdDroid OSS — StubImageProvider (the current implementation).
//
// 画像生成 Provider が **何も設定されていない** 環境で `selectImageProvider`
// が返す既定の Provider。`generateImage` は必ず
// `ImageProviderNotConfiguredError` を投げる。
//
// 上位レイヤ (worker / improvement_pr hop) はこの error を catch して
// **prompt-only に縮退** する。Image Generation は the current implementation 原則 21 で
// 「完全に任意」と明記されているため、stub は失敗ではなく benign idle 状態。

import {
  ImageProviderNotConfiguredError,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageProvider,
  type ImageProviderName,
} from "./image-provider.js";

export interface StubImageProviderOptions {
  /**
   * UI 表示・factory の reason 用 provider 名。既定 "openai"。実際には何も
   * 接続されていないため `enabled=false`。
   */
  name?: ImageProviderName;
  /** UI が "未設定 / default model" を表示するための文字列。 */
  defaultModel?: string;
}

export class StubImageProvider implements ImageProvider {
  readonly name: ImageProviderName;
  readonly defaultModel: string;
  readonly enabled = false;

  constructor(opts: StubImageProviderOptions = {}) {
    this.name = opts.name ?? "openai";
    this.defaultModel = opts.defaultModel ?? "gpt-image-1";
  }

  async generateImage(_req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    throw new ImageProviderNotConfiguredError(this.name, "generateImage");
  }
}
