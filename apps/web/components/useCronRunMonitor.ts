"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type CronMonitorPhase = "idle" | "queued" | "running" | "success" | "failed";

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

const POLL_INTERVAL_MS = 1500;
const RESET_AFTER_TERMINAL_MS = 5000;

export function useCronRunMonitor({
  presetName,
  onTerminal,
}: {
  presetName: string;
  onTerminal?: (state: CronRunMonitorState) => void;
}) {
  const [state, setState] = useState<CronRunMonitorState>(INITIAL_STATE);
  const pollTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const jobIdRef = useRef<string | null>(null);
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
      setState(next);
      terminalRef.current?.(next);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        jobIdRef.current = null;
        setState(INITIAL_STATE);
      }, RESET_AFTER_TERMINAL_MS);
    },
    []
  );

  const fetchStatus = useCallback(async () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    try {
      const res = await fetch(
        `/api/cron/${encodeURIComponent(presetName)}/run-status?jobId=${encodeURIComponent(jobId)}`,
        { cache: "no-store" }
      );
      const body = (await res.json().catch(() => ({}))) as CronRunStatusResponse;
      if (!res.ok || !body.ok) {
        const msg = body.error ?? `HTTP ${res.status}`;
        finish({
          phase: "failed",
          jobId,
          runId: body.runId ?? null,
          errorMessage: msg,
        });
        return;
      }
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
      finish({
        phase: "failed",
        jobId,
        runId: null,
        errorMessage: (err as Error).message,
      });
    }
  }, [finish, presetName]);

  const start = useCallback(
    (jobId: string | null | undefined) => {
      clearTimers();
      if (!jobId) {
        setState(INITIAL_STATE);
        return;
      }
      jobIdRef.current = jobId;
      setState({ phase: "queued", jobId, runId: null, errorMessage: null });
    },
    [clearTimers]
  );

  const reset = useCallback(() => {
    clearTimers();
    jobIdRef.current = null;
    setState(INITIAL_STATE);
  }, [clearTimers]);

  useEffect(() => {
    if (
      !state.jobId ||
      (state.phase !== "queued" && state.phase !== "running")
    ) {
      return undefined;
    }
    const timerId = window.setTimeout(fetchStatus, POLL_INTERVAL_MS);
    pollTimerRef.current = timerId;
    return () => {
      window.clearTimeout(timerId);
      if (pollTimerRef.current === timerId) pollTimerRef.current = null;
    };
  }, [fetchStatus, state.jobId, state.phase]);

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
            : "";

  return { state, isActive, label, start, reset };
}
