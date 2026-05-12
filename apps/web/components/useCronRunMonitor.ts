"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type CronMonitorPhase =
  | "idle"
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "timeout";

interface CronRunStatusResponse {
  ok?: boolean;
  state?: "queued" | "running" | "success" | "failed";
  runId?: string | null;
  errorMessage?: string | null;
  error?: string;
}

interface CronRunMonitorState {
  phase: CronMonitorPhase;
  jobId: string | null;
  runId: string | null;
  errorMessage: string | null;
}

const INITIAL_STATE: CronRunMonitorState = {
  phase: "idle",
  jobId: null,
  runId: null,
  errorMessage: null,
};

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STATUS_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_MAX_STATUS_FAILURES = 3;
const RESET_AFTER_TERMINAL_MS = 5000;

export function useCronRunMonitor({
  presetName,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  statusRequestTimeoutMs = DEFAULT_STATUS_REQUEST_TIMEOUT_MS,
  maxStatusFailures = DEFAULT_MAX_STATUS_FAILURES,
  onTerminal,
}: {
  presetName: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  statusRequestTimeoutMs?: number;
  maxStatusFailures?: number;
  onTerminal?: (state: CronRunMonitorState) => void;
}) {
  const [state, setState] = useState<CronRunMonitorState>(INITIAL_STATE);
  const pollTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const statusFailuresRef = useRef(0);
  const terminalRef = useRef(onTerminal);

  useEffect(() => {
    terminalRef.current = onTerminal;
  }, [onTerminal]);

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const finish = useCallback(
    (next: CronRunMonitorState) => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setState(next);
      terminalRef.current?.(next);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        jobIdRef.current = null;
        startedAtRef.current = null;
        statusFailuresRef.current = 0;
        setState(INITIAL_STATE);
      }, RESET_AFTER_TERMINAL_MS);
    },
    []
  );

  const failOrRetry = useCallback(
    (jobId: string, runId: string | null, message: string) => {
      statusFailuresRef.current += 1;
      if (statusFailuresRef.current < maxStatusFailures) {
        setState((current) => {
          if (current.jobId !== jobId) return current;
          return {
            ...current,
            errorMessage: `状態確認を再試行しています (${statusFailuresRef.current}/${maxStatusFailures - 1}): ${message}`,
          };
        });
        return;
      }
      finish({
        phase: "failed",
        jobId,
        runId,
        errorMessage: message,
      });
    },
    [finish, maxStatusFailures]
  );

  const fetchStatus = useCallback(async () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    const startedAt = startedAtRef.current;
    if (startedAt !== null && Date.now() - startedAt >= timeoutMs) {
      finish({
        phase: "timeout",
        jobId,
        runId: state.runId,
        errorMessage:
          "時間がかかっているため画面上の確認を停止しました。処理はバックグラウンドで継続している可能性があります。実行履歴を確認してください。",
      });
      return;
    }
    try {
      const controller = new AbortController();
      const requestTimer = window.setTimeout(
        () => controller.abort(),
        statusRequestTimeoutMs
      );
      let res: Response;
      try {
        res = await fetch(
          `/api/cron/${encodeURIComponent(presetName)}/run-status?jobId=${encodeURIComponent(jobId)}`,
          { cache: "no-store", signal: controller.signal }
        );
      } finally {
        window.clearTimeout(requestTimer);
      }
      const body = (await res.json().catch(() => ({}))) as CronRunStatusResponse;
      if (!res.ok || !body.ok) {
        const msg = body.error ?? `HTTP ${res.status}`;
        failOrRetry(jobId, body.runId ?? null, msg);
        return;
      }
      statusFailuresRef.current = 0;
      const next: CronRunMonitorState = {
        phase: body.state ?? "queued",
        jobId,
        runId: body.runId ?? null,
        errorMessage: body.errorMessage ?? null,
      };
      if (next.phase === "success" || next.phase === "failed") {
        finish(next);
        return;
      }
      setState(next);
    } catch (err) {
      failOrRetry(jobId, null, (err as Error).message);
    }
  }, [
    failOrRetry,
    finish,
    presetName,
    state.runId,
    statusRequestTimeoutMs,
    timeoutMs,
  ]);

  const start = useCallback(
    (jobId: string | null | undefined) => {
      clearTimers();
      if (!jobId) {
        jobIdRef.current = null;
        startedAtRef.current = null;
        statusFailuresRef.current = 0;
        setState(INITIAL_STATE);
        return;
      }
      jobIdRef.current = jobId;
      startedAtRef.current = Date.now();
      statusFailuresRef.current = 0;
      setState({ phase: "queued", jobId, runId: null, errorMessage: null });
    },
    [clearTimers]
  );

  const reset = useCallback(() => {
    clearTimers();
    jobIdRef.current = null;
    startedAtRef.current = null;
    statusFailuresRef.current = 0;
    setState(INITIAL_STATE);
  }, [clearTimers]);

  useEffect(() => {
    if (
      !state.jobId ||
      (state.phase !== "queued" && state.phase !== "running")
    ) {
      return undefined;
    }
    const timerId = window.setTimeout(fetchStatus, pollIntervalMs);
    pollTimerRef.current = timerId;
    return () => {
      window.clearTimeout(timerId);
      if (pollTimerRef.current === timerId) pollTimerRef.current = null;
    };
  }, [fetchStatus, pollIntervalMs, state]);

  useEffect(() => clearTimers, [clearTimers]);

  const isActive = state.phase === "queued" || state.phase === "running";
  const label =
    state.phase === "queued"
      ? "実行待ち"
      : state.phase === "running"
        ? "実行中"
        : state.phase === "success"
          ? "完了"
          : state.phase === "failed"
            ? "失敗"
            : state.phase === "timeout"
              ? "確認中断"
              : "";

  return { state, isActive, label, start, reset };
}
