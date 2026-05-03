// AdDroid OSS — `@addroid/llm-provider` barrel.
//
// 各サブモジュール (types / oauth / token-store / codex / mock / stub / factory /
// pricing) を集約し、apps/web / apps/worker / apps/cli から単一エントリで
// 参照できるようにする。新しい I/O を追加する場合はサブモジュール側に閉じ込め、
// 本ファイルからは re-export のみを行う。

export {
  LLMNotImplementedError,
  LLMOAuthStateMismatchError,
  LLMProviderError,
  LLMProviderNotConfiguredError,
  LLMProviderUnauthenticatedError,
  LLMTokenExpiredError,
  type LLMAuthKind,
  type LLMBeginOAuthResult,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMConnectionMeta,
  type LLMEmbedRequest,
  type LLMEmbedResult,
  type LLMImageRequest,
  type LLMImageResult,
  type LLMMessage,
  type LLMProvider,
  type LLMProviderName,
  type LLMRefreshResult,
  type LLMResponseMeta,
  type LLMRole,
  type LLMUsage,
} from "./types.js";

export {
  ADDROID_CODEX_DEFAULT_SCOPES,
  CodexOAuthExchangeError,
  buildCodexAuthorizationUrl,
  deriveCodexExpiresAt,
  deriveS256CodeChallenge,
  exchangeCodexCodeForToken,
  generateCodexOAuthState,
  generatePkceCodeVerifier,
  redactPayloadForError,
  refreshCodexAccessToken,
  type BuildCodexAuthorizationUrlOptions,
  type BuiltCodexAuthorizationUrl,
  type CodexExchangeCodeForTokenOptions,
  type CodexExchangedToken,
  type CodexOAuthClientConfig,
  type CodexRefreshTokenOptions,
} from "./oauth.js";

export {
  InMemoryLLMProviderTokenStore,
  type LLMProviderTokenRecord,
  type LLMProviderTokenStore,
} from "./token-store.js";

export {
  CodexLLMProvider,
  type CodexLLMProviderDeps,
  type CryptoEncryptDecrypt,
} from "./codex.js";

export {
  ApiKeyLLMProvider,
  defaultApiKeyChatUrl,
  type ApiKeyCryptoBoundary,
  type ApiKeyLLMProviderDeps,
  type ApiKeyLLMProviderName,
} from "./api-key.js";

export { MockLLMProvider, type MockLLMProviderOptions } from "./mock.js";

export { StubLLMProvider } from "./stub.js";

export {
  selectLLMProvider,
  type LLMProviderChoice,
  type LLMProviderSelection,
  type SelectLLMProviderOptions,
} from "./factory.js";

export {
  estimateCostUsd,
  lookupModelPricing,
  type ModelPricing,
} from "./pricing.js";

export {
  AI_AGENTS,
  AI_RUN_LINKED_REF_TYPES,
  AI_RUN_PROVIDERS,
  AI_RUN_STATUSES,
  AI_WORKFLOWS,
  AiRunValidationError,
  buildAiRunCreateInput,
  buildAiRunCreateInputFromCompletion,
  sanitizeAiRunPayload,
  type AiAgent,
  type AiRunCreateInputData,
  type AiRunLinkedRefType,
  type AiRunStatus,
  type AiWorkflow,
  type BuildAiRunInputFromCompletionOptions,
  type BuildAiRunInputOptions,
} from "./ai-runs.js";

export {
  ImageProviderError,
  ImageProviderInvalidRequestError,
  ImageProviderNotConfiguredError,
  validateImageGenerateRequest,
  type ImageGenerateRequest,
  type ImageGenerateResponseMeta,
  type ImageGenerateResponseParameters,
  type ImageGenerateResponseQaLinkage,
  type ImageGenerateResult,
  type ImageGeneratedAsset,
  type ImageProvider,
  type ImageProviderName,
  type ImageVariationCondition,
} from "./image-provider.js";

export {
  MockImageProvider,
  MOCK_IMAGE_MODELS,
  type MockImageProviderOptions,
} from "./image-mock.js";

export {
  StubImageProvider,
  type StubImageProviderOptions,
} from "./image-stub.js";

export {
  OpenAIImageProvider,
  type OpenAIImageProviderOptions,
} from "./image-openai.js";

export {
  CodexAppServerImageProvider,
  type CodexAppServerHandle,
  type CodexAppServerImageProviderOptions,
  type CodexAppServerRpcClient,
  type CodexAppServerRpcNotification,
} from "./image-codex.js";

export {
  selectImageProvider,
  type ImageProviderChoice,
  type ImageProviderSelection,
  type SelectImageProviderOptions,
} from "./image-factory.js";

export {
  CreativeStorageInvalidIdError,
  CreativeStorageQaIncompleteError,
  persistCreativeAssets,
  type CreativeStorageAdapter,
  type CreativeStorageQaIncompleteReason,
  type PersistCreativeAssetsLinks,
  type PersistCreativeAssetsOptions,
  type PersistCreativeAssetsResult,
  type PersistedCreativeAsset,
  type PersistedCreativeMetadata,
} from "./creative-storage.js";

export {
  CREATIVE_QA_CHECK_KINDS,
  CREATIVE_QA_FALLBACK_TEXT_ONLY,
  CREATIVE_QA_OUTCOMES,
  CREATIVE_QA_OVERALL_OUTCOMES,
  CREATIVE_QA_SEVERITIES,
  DEFAULT_CREATIVE_QA_POLICY,
  DEFAULT_CREATIVE_QA_SEVERITY,
  evaluateCreativeQa,
  evaluateCreativeQaBatch,
  generateAndQaCreative,
  sanitizeEvidence,
  type BrandTonePolicy,
  type CreativeQaAssetInput,
  type CreativeQaAssetResult,
  type CreativeQaBatchResult,
  type CreativeQaCheckKind,
  type CreativeQaCheckResult,
  type CreativeQaOutcome,
  type CreativeQaOverallOutcome,
  type CreativeQaPolicy,
  type CreativeQaSeverity,
  type DimensionAllowedSize,
  type DimensionPolicy,
  type FormatPolicy,
  type ForbiddenExpressionPolicy,
  type GenerateAndQaCreativeOptions,
  type GenerateAndQaCreativeResult,
  type QualityPolicy,
} from "./creative-qa.js";

export {
  ANALYST_AGENT_SYSTEM_PROMPT,
  AUDIT_AGENT_SYSTEM_PROMPT,
  COPY_AGENT_SYSTEM_PROMPT,
  CREATIVE_QA_AGENT_SYSTEM_PROMPT,
  DANGEROUS_CHANGE_CATEGORIES,
  DEFAULT_ASPECT_RATIO_DIMENSIONS,
  GITOPS_AGENT_SYSTEM_PROMPT,
  IMAGE_PROMPT_AGENT_SYSTEM_PROMPT,
  MEDIA_BUYER_AGENT_SYSTEM_PROMPT,
  STRATEGY_AGENT_SYSTEM_PROMPT,
  buildAnalystAgentPrompt,
  buildAuditAgentPrompt,
  buildCopyAgentPrompt,
  buildCreativeQaAgentPrompt,
  buildGitOpsAgentPrompt,
  buildImagePromptAgentPrompt,
  buildMediaBuyerAgentPrompt,
  buildStrategyAgentPrompt,
  extractJsonFromLlmContent,
  imagePromptVariantsToVariationConditions,
  runAnalystAgent,
  runAuditAgent,
  runCopyAgent,
  runCreativeQaAgent,
  runGitOpsAgent,
  runImagePromptAgent,
  runMediaBuyerAgent,
  runStrategyAgent,
  type AgentRunContext,
  type AgentRunResult,
  type AnalystAgentDecision,
  type AnalystAgentImprovementCandidate,
  type AnalystAgentInput,
  type AnalystAgentMetrics,
  type AnalystAgentOutput,
  type AuditAgentDangerousFinding,
  type AuditAgentDecision,
  type AuditAgentInput,
  type AuditAgentOutput,
  type CopyAgentDecision,
  type CopyAgentInput,
  type CopyAgentOutput,
  type CopyAgentVariant,
  type CreativeQaAgentDecision,
  type CreativeQaAgentInput,
  type CreativeQaAgentOutput,
  type CreativeQaIssue,
  type DangerousChangeCategory,
  type GitOpsAgentDecision,
  type GitOpsAgentFile,
  type GitOpsAgentInput,
  type GitOpsAgentOutput,
  type ImagePromptAgentDecision,
  type ImagePromptAgentInput,
  type ImagePromptAgentOutput,
  type ImagePromptVariant,
  type ImagePromptVariantsToConditionsOptions,
  type MediaBuyerAgentDecision,
  type MediaBuyerAgentInput,
  type MediaBuyerAgentOutput,
  type MediaBuyerProposal,
  type StrategyAgentDecision,
  type StrategyAgentInput,
  type StrategyAgentOutput,
} from "./agents.js";
