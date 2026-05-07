const DENIED_TOOL_NAMES = new Set([
  "run_shell",
  "shell",
  "exec",
  "execute_command",
  "restore",
  "restore_db",
  "db_restore",
  "db_write",
  "database_write",
  "direct_db_write",
  "migrate_db",
  "git_reset",
  "git_checkout",
  "git_clean",
  "git_force_push",
  "delete_repo",
  "print_secret",
  "show_secret",
  "export_secret",
  "direct_meta_apply",
  "meta_mutation",
  "bypass_approval",
  "disable_policy",
]);

const DANGEROUS_TEXT_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+push\b.*\s--force\b/i,
  /\brestore\b.*\b(db|database|postgres|postgresql)\b/i,
  /\bpg_restore\b/i,
  /\bpsql\b.*\b(delete|drop|truncate|update|insert)\b/i,
  /\bprisma\b.*\b(migrate|db\s+push)\b/i,
  /\b(drop|truncate)\s+table\b/i,
  /\b(print|show|cat|echo|export)\b.*\b(access_token|refresh_token|api[_-]?key|secret)\b/i,
  /\b(meta|facebook)\b.*\b(direct|bypass|without approval|approval bypass)\b/i,
  /DB.*復元/,
  /(トークン|APIキー|シークレット).*(表示|出力|見せて|教えて)/,
  /(承認|approval).*(迂回|無視|スキップ)/i,
];

export interface AgentPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateAgentToolPolicy(
  toolName: string,
  args: Record<string, unknown>
): AgentPolicyDecision {
  const normalizedName = normalizeToken(toolName);
  if (DENIED_TOOL_NAMES.has(normalizedName)) {
    return {
      allowed: false,
      reason: `denied tool: ${toolName}`,
    };
  }
  const text = JSON.stringify({ toolName, args });
  for (const pattern of DANGEROUS_TEXT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        allowed: false,
        reason: `dangerous request matched policy: ${pattern.source}`,
      };
    }
  }
  return { allowed: true };
}

export function isDeniedAgentRequest(input: string): AgentPolicyDecision {
  for (const pattern of DANGEROUS_TEXT_PATTERNS) {
    if (pattern.test(input)) {
      return {
        allowed: false,
        reason: `dangerous request matched policy: ${pattern.source}`,
      };
    }
  }
  return { allowed: true };
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
