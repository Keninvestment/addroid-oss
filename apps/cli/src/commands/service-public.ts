import { runDown } from "./down.js";
import { runUp } from "./up.js";
import {
  formatServiceStatus,
  getAddroidServiceStatus,
  startAddroidService,
  stopAddroidService,
} from "../lib/service.js";

export async function runStartCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "addroid start — 常駐サービスを起動・修復",
        "",
        "Usage:",
        "  addroid start",
        "  addroid start --foreground [--separate-worker]",
        "",
        "Options:",
        "  --foreground   OS service ではなく、このターミナルで Web UI と worker を起動",
        "  --separate-worker   --foreground と併用し、worker を別プロセスで起動",
        "",
      ].join("\n")
    );
    return 0;
  }
  if (args.includes("--foreground")) {
    return await runUp(args.filter((a) => a !== "--foreground"));
  }
  try {
    const status = await startAddroidService();
    process.stdout.write(["[addroid start]", "", ...formatServiceStatus(status), ""].join("\n"));
    return status.running ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      [
        `[addroid start] 常駐サービスの起動に失敗しました: ${(err as Error).message}`,
        "  前景で確認する場合は `addroid start --foreground` を実行してください。",
        "",
      ].join("\n")
    );
    return 1;
  }
}

export async function runStopCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "addroid stop — 常駐サービスを停止",
        "",
        "Usage:",
        "  addroid stop",
        "  addroid stop --foreground",
        "",
        "Options:",
        "  --foreground   従来の前景起動 pid file を停止",
        "",
      ].join("\n")
    );
    return 0;
  }
  if (args.includes("--foreground")) {
    return await runDown([]);
  }
  try {
    const before = await getAddroidServiceStatus();
    if (!before.installed) {
      return await runDown([]);
    }
    const status = await stopAddroidService();
    process.stdout.write(["[addroid stop]", "", ...formatServiceStatus(status), ""].join("\n"));
    return 0;
  } catch (err) {
    process.stderr.write(`[addroid stop] 常駐サービスの停止に失敗しました: ${(err as Error).message}\n`);
    return 1;
  }
}
