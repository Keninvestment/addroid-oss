# Custom Automation

自然言語のカスタム cron は、標準 preset cron ではなく `scheduled_task_run` の
delayed job として次回 1 回分だけ予約する。実行後に cron 式から次回時刻を計算し、
次の job を再予約する。

## ルール化の方針

ユーザーの依頼が「過去7日で CPA が x 円以下のキャンペーン予算を 20% 上げて」
「効果の良いキャンペーンを複製して」のように広告変更を含む場合、自然文だけで
即時実行しない。作成時に少なくとも次を確定させる。

CLI / Web UI のチャットがメイン動線になる。チャット agent は下記の項目が不足している
場合、`create_scheduled_agent_task` を呼ばずにユーザーへ質問する。実行側の policy でも
同じ確認を行い、LLM が誤って tool を呼んだ場合は登録を拒否する。

| 項目 | 例 | 曖昧なら |
|---|---|---|
| cadence | 毎日9時、毎時 | 質問する |
| lookback window | 過去7日、当日、前日 | 質問する |
| decision time | レポート取得直後、毎朝判断 | cadence に統合して明示 |
| target scope | campaign / adset / ad、対象アカウント | 質問する |
| action | pause、budget +20%、duplicate | proposal-only に倒す |
| execution mode | proposal / auto_execute | 未指定なら proposal |
| limits | 1回あたり最大件数、予算変化上限、cooldown | auto_execute では必須 |

## 実行モード

`proposal` は GitOps PR を作るだけで、Meta へ直接反映しない。

`auto_execute` は明示的に選ばれた場合だけ許可する。初期実装で自動実行できる操作は
既存対象の `PAUSED` への変更に限定する。予算増額、複製、新規作成、ターゲティング変更、
ACTIVE 化、削除は proposal-only とする。

## 安全 gate

auto_execute は以下をすべて満たす場合だけ実行する。

- 最新の read-only Meta / report データで条件を再評価している
- 対象が既存 campaign / adset / ad として解決できる
- 操作が `set_status: PAUSED`
- ユーザーが auto_execute を明示している
- 最大対象件数、cooldown、予算影響上限などの limit を満たす
- 実行前後を `automation_runs` / `automation_actions` / `audit_logs` に記録する

それ以外は PR 作成に倒す。
