// AdDroid OSS — ops template を Git tree object に変換するヘルパ。
//
// 純粋関数として切り出しておき、Octokit adapter とテストの双方で再利用する。
// ops-template の `OpsTemplateFile[]` を、`POST /repos/{owner}/{repo}/git/trees`
// が要求する tree entry 配列に変換する。

import { buildOpsTemplate, type OpsTemplateFile } from "@addroid/ops-template";
import type { BootstrapOpsRepoInput } from "./types.js";

export interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  content: string;
}

export function buildTemplateFiles(input: BootstrapOpsRepoInput): OpsTemplateFile[] {
  return buildOpsTemplate({
    workspaceSlug: input.workspaceSlug,
    workspaceDisplayName: input.workspaceDisplayName,
    initialAccountKey: input.initialAccountKey,
    initialAccountDisplayName: input.initialAccountDisplayName,
  });
}

export function templateFilesToTreeEntries(files: OpsTemplateFile[]): TreeEntry[] {
  return files.map((f) => ({
    path: f.path,
    mode: "100644",
    type: "blob",
    content: f.content,
  }));
}
