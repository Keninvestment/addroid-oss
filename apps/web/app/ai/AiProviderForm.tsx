"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "../../components/ui/Toast";

type Provider = "openai" | "anthropic";

interface ApiResponse {
  ok?: boolean;
  error?: string;
  provider?: string;
  removed?: number;
}

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.5",
  anthropic: "claude-opus-4-7",
};

export function AiProviderForm() {
  const router = useRouter();
  const toast = useToast();
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODELS.openai);
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);

  function changeProvider(next: Provider) {
    setProvider(next);
    setModel(DEFAULT_MODELS[next]);
    setBaseUrl("");
  }

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ai/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey, model, baseUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      setApiKey("");
      toast.push({
        variant: "success",
        title: `${provider} を接続しました`,
        description: "API key は暗号化して保存しました。",
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "AI Provider を接続できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ai/provider", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.push({
        variant: "success",
        title: `${provider} を切断しました`,
        description: `${body.removed ?? 0} 件の credential を削除しました。`,
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "AI Provider を切断できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="toolbar" onSubmit={save} aria-label="AI Provider 接続">
      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="ai-provider">
          Provider
        </label>
        <select
          id="ai-provider"
          className="form-select"
          value={provider}
          onChange={(ev) => changeProvider(ev.target.value as Provider)}
          disabled={busy}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>
      <div className="toolbar__field" style={{ minWidth: "18rem" }}>
        <label className="toolbar__label" htmlFor="ai-api-key">
          API key
        </label>
        <input
          id="ai-api-key"
          className="form-input"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(ev) => setApiKey(ev.target.value)}
          disabled={busy}
          placeholder={provider === "openai" ? "sk-..." : "sk-ant-..."}
        />
      </div>
      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="ai-model">
          Model
        </label>
        <input
          id="ai-model"
          className="form-input"
          value={model}
          onChange={(ev) => setModel(ev.target.value)}
          disabled={busy}
        />
      </div>
      <div className="toolbar__field" style={{ minWidth: "18rem" }}>
        <label className="toolbar__label" htmlFor="ai-base-url">
          Endpoint
        </label>
        <input
          id="ai-base-url"
          className="form-input"
          value={baseUrl}
          onChange={(ev) => setBaseUrl(ev.target.value)}
          disabled={busy}
          placeholder="既定値を使う"
        />
      </div>
      <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !apiKey.trim()}>
        {busy ? "保存中…" : "接続"}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={disconnect} disabled={busy}>
        切断
      </button>
      <a className="btn btn--ghost btn--sm" href="/api/oauth/codex/begin">
        Codex 接続
      </a>
    </form>
  );
}
