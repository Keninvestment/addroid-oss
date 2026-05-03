// AdDroid OSS — `@addroid/meta-adapter` barrel.

export {
  MetaAdapterNotImplementedError,
  MetaAdapterUnauthenticatedError,
  MetaOAuthStateMismatchError,
  MetaTokenExpiredError,
  type MetaAccessTokenLease,
  type MetaAdAccount,
  type MetaAdapter,
  type MetaBeginOAuthResult,
  type MetaBusiness,
  type MetaOAuthConnection,
  type MetaRefreshResult,
  type MetaTokenProvider,
} from "./types.js";

export { StubMetaAdapter } from "./stub.js";
export { MockMetaAdapter, type MockMetaAdapterOptions } from "./mock.js";
export {
  RealMetaAdapter,
  type CryptoEncryptDecrypt,
  type RealMetaAdapterDeps,
} from "./real.js";
export {
  ADDROID_META_REQUIRED_SCOPES,
  META_AUTHORIZE_URL,
  META_GRAPH_API_VERSION,
  META_TOKEN_URL,
  MetaOAuthExchangeError,
  buildAppAccessToken,
  buildMetaAuthorizationUrl,
  debugToken,
  deriveExpiresAt,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  generateMetaOAuthState,
  type DebugTokenOptions,
  type MetaDebugTokenInfo,
  type MetaExchangeCodeForTokenOptions,
  type MetaExchangeForLongLivedTokenOptions,
  type MetaExchangedToken,
  type MetaOAuthClientConfig,
} from "./oauth.js";
export {
  MetaApiError,
  fetchAdAccounts,
  fetchBusinesses,
  fetchMeProfile,
  type FetchAccountsOptions,
  type MetaMeProfile,
} from "./api.js";
export {
  InMemoryMetaTokenStore,
  type MetaOAuthTokenRecord,
  type MetaOAuthTokenStore,
} from "./token-store.js";
export {
  MetaInsightsCache,
  buildInsightsCacheKey,
  type InsightsCacheGetOptions,
  type MetaInsightsCacheOptions,
} from "./insights-cache.js";
export {
  selectMetaAdapter,
  type MetaAdapterChoice,
  type MetaAdapterSelection,
  type SelectMetaAdapterOptions,
} from "./factory.js";
export {
  MockMetaSandbox,
  SandboxValidationError,
  deriveExternalId,
  type MetaObjectStatus,
  type MockMetaSandboxOptions,
  type SandboxAd,
  type SandboxAdSet,
  type SandboxApplyResult,
  type SandboxBudget,
  type SandboxCampaign,
  type SandboxCreative,
  type SandboxInsights,
  type SandboxInsightsResource,
  type SandboxResource,
  type SandboxValidationCode,
  type SandboxVerb,
} from "./sandbox.js";
export {
  META_CLI_SUPPORTED_OPERATIONS,
  MetaCliBinaryNotConfiguredError,
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliUnsupportedOperationError,
  MetaCliVersionUnverifiedError,
  classifyExit,
  isSupportedMetaCliOperation,
  parseSemver,
  parseThrottleHeaders,
  recommendActionForExit,
  redactArgv,
  redactEnvForLog,
  redactSecrets,
  semverGte,
  toExecutionLogInput,
  type ChildProcess,
  type MetaCliExecutionLogInput,
  type MetaCliExecutionResult,
  type MetaCliExitClass,
  type MetaCliInvocation,
  type MetaCliOperationCheckResult,
  type MetaCliRecommendedAction,
  type MetaCliRunnerOptions,
  type MetaCliTokenLoader,
  type MetaCliVersionInfo,
  type MetaCliVersionVerification,
  type MetaThrottleHeaders,
  type SupportedMetaCliOperation,
} from "./cli-runner.js";
