import {
  formatServiceStatus,
  getAddroidServiceStatus,
  installAddroidService,
  startAddroidService,
  stopAddroidService,
  uninstallAddroidService,
} from "../lib/service.js";

export async function runServiceCommand(args: string[]): Promise<number> {
  const [actionRaw] = args;
  const action = actionRaw?.trim().toLowerCase();
  if (!action || action === "--help" || action === "-h" || action === "help") {
    printServiceHelp();
    return 0;
  }

  try {
    if (action === "install") {
      const status = await installAddroidService();
      printStatus("installed", status);
      return status.installed ? 0 : 1;
    }
    if (action === "start") {
      const status = await startAddroidService();
      printStatus("started", status);
      return status.running ? 0 : 1;
    }
    if (action === "restart") {
      const status = await startAddroidService();
      printStatus("restarted", status);
      return status.running ? 0 : 1;
    }
    if (action === "stop") {
      const status = await stopAddroidService();
      printStatus("stopped", status);
      return 0;
    }
    if (action === "uninstall") {
      const status = await uninstallAddroidService();
      printStatus("uninstalled", status);
      return status.installed ? 1 : 0;
    }
    if (action === "status") {
      const status = await getAddroidServiceStatus();
      printStatus("status", status);
      return status.detail && !status.installed ? 1 : 0;
    }
    process.stderr.write(`[addroid service] 未対応の操作: ${actionRaw}\n`);
    printServiceHelp();
    return 2;
  } catch (err) {
    process.stderr.write(`[addroid service] ${(err as Error).message}\n`);
    return 1;
  }
}

function printStatus(label: string, status: Awaited<ReturnType<typeof getAddroidServiceStatus>>): void {
  process.stdout.write(["[addroid service]", "", `  action        : ${label}`, ...formatServiceStatus(status), ""].join("\n"));
}

function printServiceHelp(): void {
  process.stdout.write(
    [
      "addroid service — 常駐サービスを管理",
      "",
      "Usage:",
      "  addroid service status",
      "  addroid service install",
      "  addroid service start",
      "  addroid service restart",
      "  addroid service stop",
      "  addroid service uninstall",
      "",
      "Notes:",
      "  - macOS は LaunchAgent、Linux / WSL2 は systemd user service を使います。",
      "  - 通常は `addroid init` 後に自動インストールされます。",
      "  - 前景でデバッグ起動する場合は `addroid up` を使ってください。",
      "",
    ].join("\n")
  );
}
