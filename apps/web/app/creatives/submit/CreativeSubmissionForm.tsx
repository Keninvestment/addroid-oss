"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

interface AccountOption {
  key: string;
  displayName: string;
}

interface SubmitResult {
  prNumber: number;
  htmlUrl: string;
  planSummary: string;
}

export function CreativeSubmissionForm({ accounts }: { accounts: AccountOption[] }) {
  const [mode, setMode] = useState<"existing_adset" | "new_adset" | "new_campaign">("existing_adset");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData(event.currentTarget);
    if (mode === "existing_adset") {
      form.delete("campaignName");
      form.delete("adsetName");
      form.delete("objective");
      form.delete("dailyBudget");
      form.delete("countries");
      form.delete("optimizationGoal");
      form.delete("billingEvent");
    } else if (mode === "new_adset") {
      form.delete("campaignName");
      form.delete("objective");
      form.delete("adsetId");
    } else {
      form.delete("campaignId");
      form.delete("adsetId");
    }
    try {
      const res = await fetch("/api/creatives/submit", {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        result?: SubmitResult;
      };
      if (!res.ok || !body.ok || !body.result) {
        throw new Error(body.error ?? "クリエイティブ入稿 PR を作成できませんでした。");
      }
      setResult(body.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="creative-submit" onSubmit={onSubmit}>
      <div className="form-grid">
        <label>
          <span>広告アカウント</span>
          <select name="accountKey" defaultValue={accounts[0]?.key ?? ""} required>
            {accounts.map((account) => (
              <option key={account.key} value={account.key}>
                {account.displayName || account.key}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>クリエイティブ名</span>
          <input name="creativeName" placeholder="spring-sale-square" required />
        </label>
        <label>
          <span>広告名</span>
          <input name="adName" placeholder="春セール広告 A" required />
        </label>
        <label>
          <span>CTA</span>
          <select name="callToAction" defaultValue="LEARN_MORE">
            <option value="LEARN_MORE">詳しく見る</option>
            <option value="SHOP_NOW">購入する</option>
            <option value="SIGN_UP">登録する</option>
            <option value="DOWNLOAD">ダウンロード</option>
            <option value="CONTACT_US">問い合わせ</option>
            <option value="SUBSCRIBE">購読する</option>
            <option value="APPLY_NOW">申し込む</option>
            <option value="GET_QUOTE">見積もり</option>
          </select>
        </label>
        <label>
          <span>遷移先URL</span>
          <input name="linkUrl" type="url" placeholder="https://example.com/lp" />
        </label>
        <label>
          <span>見出し</span>
          <input name="headline" placeholder="今だけの限定オファー" />
        </label>
        <label className="form-grid__wide">
          <span>本文</span>
          <textarea name="primaryText" rows={4} placeholder="広告本文を入力" />
        </label>
        <label className="form-grid__wide">
          <span>生成プロンプト</span>
          <textarea name="prompt" rows={4} placeholder="画像生成したい場合の指示。素材を添付する場合も補足として使えます。" />
        </label>
        <label>
          <span>素材</span>
          <input name="media" type="file" accept="image/*,video/*" multiple />
        </label>
        <label>
          <span>素材種別</span>
          <select name="mediaType" defaultValue="image">
            <option value="image">画像</option>
            <option value="video">動画</option>
            <option value="carousel">カルーセル</option>
            <option value="text">テキストのみ</option>
          </select>
        </label>
        <label className="checkbox-row">
          <input name="generateImage" type="checkbox" />
          <span>添付素材がない場合は画像生成を試す</span>
        </label>
      </div>

      <div className="segmented">
        <button type="button" data-active={mode === "existing_adset"} onClick={() => setMode("existing_adset")}>
          広告作成
        </button>
        <button type="button" data-active={mode === "new_adset"} onClick={() => setMode("new_adset")}>
          広告セット作成
        </button>
        <button type="button" data-active={mode === "new_campaign"} onClick={() => setMode("new_campaign")}>
          キャンペーン作成
        </button>
      </div>

      {mode === "existing_adset" ? (
        <div className="form-grid">
          <label>
            <span>Campaign ID</span>
            <input name="campaignId" placeholder="campaign id in brand.yaml" required={mode === "existing_adset"} />
          </label>
          <label>
            <span>Adset ID</span>
            <input name="adsetId" placeholder="adset id in brand.yaml" required={mode === "existing_adset"} />
          </label>
        </div>
      ) : mode === "new_adset" ? (
        <div className="form-grid">
          <label>
            <span>Campaign ID</span>
            <input name="campaignId" placeholder="campaign id in brand.yaml" required={mode === "new_adset"} />
          </label>
          <label>
            <span>広告セット名</span>
            <input name="adsetName" placeholder="JP 25-44" required={mode === "new_adset"} />
          </label>
          <label>
            <span>日予算（アカウント通貨）</span>
            <input name="dailyBudget" type="number" min="1" step="1" />
          </label>
          <label>
            <span>最適化</span>
            <select name="optimizationGoal" defaultValue="LINK_CLICKS" required={mode === "new_adset"}>
              <option value="LINK_CLICKS">リンククリック</option>
              <option value="LANDING_PAGE_VIEWS">ランディングページビュー</option>
              <option value="OFFSITE_CONVERSIONS">コンバージョン</option>
              <option value="REACH">リーチ</option>
              <option value="IMPRESSIONS">インプレッション</option>
              <option value="LEAD_GENERATION">リード</option>
            </select>
          </label>
          <label>
            <span>課金</span>
            <select name="billingEvent" defaultValue="IMPRESSIONS" required={mode === "new_adset"}>
              <option value="IMPRESSIONS">インプレッション</option>
              <option value="LINK_CLICKS">リンククリック</option>
              <option value="CLICKS">クリック</option>
            </select>
          </label>
          <label>
            <span>国</span>
            <input name="countries" placeholder="JP,US" />
          </label>
        </div>
      ) : (
        <div className="form-grid">
          <label>
            <span>キャンペーン名</span>
            <input name="campaignName" placeholder="春の新規獲得" required={mode === "new_campaign"} />
          </label>
          <label>
            <span>広告セット名</span>
            <input name="adsetName" placeholder="JP 25-44" required={mode === "new_campaign"} />
          </label>
          <label>
            <span>目的</span>
            <select name="objective" defaultValue="OUTCOME_TRAFFIC">
              <option value="OUTCOME_TRAFFIC">トラフィック</option>
              <option value="OUTCOME_AWARENESS">認知</option>
              <option value="OUTCOME_ENGAGEMENT">エンゲージメント</option>
              <option value="OUTCOME_LEADS">リード</option>
              <option value="OUTCOME_APP_PROMOTION">アプリ</option>
              <option value="OUTCOME_SALES">売上</option>
            </select>
          </label>
          <label>
            <span>日予算（アカウント通貨）</span>
            <input name="dailyBudget" type="number" min="1" step="1" required={mode === "new_campaign"} />
          </label>
          <label>
            <span>最適化</span>
            <select name="optimizationGoal" defaultValue="LINK_CLICKS" required={mode === "new_campaign"}>
              <option value="LINK_CLICKS">リンククリック</option>
              <option value="LANDING_PAGE_VIEWS">ランディングページビュー</option>
              <option value="OFFSITE_CONVERSIONS">コンバージョン</option>
              <option value="REACH">リーチ</option>
              <option value="IMPRESSIONS">インプレッション</option>
              <option value="LEAD_GENERATION">リード</option>
            </select>
          </label>
          <label>
            <span>課金</span>
            <select name="billingEvent" defaultValue="IMPRESSIONS" required={mode === "new_campaign"}>
              <option value="IMPRESSIONS">インプレッション</option>
              <option value="LINK_CLICKS">リンククリック</option>
              <option value="CLICKS">クリック</option>
            </select>
          </label>
          <label>
            <span>国</span>
            <input name="countries" placeholder="JP,US" />
          </label>
        </div>
      )}

      <label className="creative-submit__rationale">
        <span>補足</span>
        <textarea name="rationale" rows={3} placeholder="この広告を作る理由や確認してほしい点" />
      </label>

      <div className="creative-submit__actions">
        <button className="btn btn--primary" type="submit" disabled={busy || accounts.length === 0}>
          {busy ? "作成中..." : "PRを作成"}
        </button>
        <Link className="btn" href="/plans">
          入稿前チェック
        </Link>
      </div>

      {error ? <p className="form-message form-message--error">{error}</p> : null}
      {result ? (
        <p className="form-message form-message--ok">
          PR #{result.prNumber} を作成しました。dry-run: {result.planSummary}{" "}
          <a href={result.htmlUrl} target="_blank" rel="noreferrer">
            GitHubで確認
          </a>
        </p>
      ) : null}
    </form>
  );
}
