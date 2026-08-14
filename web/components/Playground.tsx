'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiErrorMessage,
  createExecution,
  fetchEngine,
  fetchExecution,
  fetchLanguages,
} from '@/lib/api';
import { draftKey, editorLanguage } from '@/lib/languages';
import { isTerminal, type EngineInfo, type Execution, type LanguageInfo } from '@/lib/types';
import { useAuth } from './AuthProvider';
import { CodeEditorPane } from './CodeEditorPane';
import { OutputConsole } from './OutputConsole';
import { DEFAULT_RUN_CONFIG, RunSettings, type RunConfig } from './RunSettings';
import { SplitPane } from './SplitPane';

const DEFAULT_LANGUAGE_ID = 71; // Python 3
const POLL_INTERVAL_MS = 700;

function EngineBanner({ engine }: { engine: EngineInfo | null }) {
  if (!engine) return null;

  const tone = engine.healthy
    ? 'text-slate-500 dark:text-slate-400'
    : 'text-red-600 dark:text-red-400';

  return (
    <span className={`hidden truncate text-xs md:inline ${tone}`}>
      engine <span className="font-mono">{engine.kind}</span>
      {engine.endpoint && <span className="font-mono"> · {engine.endpoint}</span>}
      {engine.usesCallback && ' · webhook'}
      {!engine.healthy && ' · UNREACHABLE'}
    </span>
  );
}

export function Playground() {
  const { user } = useAuth();

  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [languageId, setLanguageId] = useState(DEFAULT_LANGUAGE_ID);
  const [code, setCode] = useState('');
  const [config, setConfig] = useState<RunConfig>(DEFAULT_RUN_CONFIG);

  const [execution, setExecution] = useState<Execution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchLanguages()
      .then(setLanguages)
      .catch(() => setLanguages([{ id: DEFAULT_LANGUAGE_ID, name: 'Python (3.8.1)', ext: 'py' }]));
    fetchEngine().then(setEngine).catch(() => setEngine(null));
  }, []);

  // Restore the draft for whichever language is selected, falling back to that
  // language's starter script.
  useEffect(() => {
    const saved = window.localStorage.getItem(draftKey(languageId));
    setCode(saved ?? editorLanguage(languageId).starter);
  }, [languageId]);

  useEffect(() => {
    if (code) window.localStorage.setItem(draftKey(languageId), code);
  }, [code, languageId]);

  // Stop polling when the component goes away, otherwise a finished run keeps
  // a timer alive against an unmounted tree.
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const poll = useCallback((id: string) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);

    pollTimer.current = setTimeout(async () => {
      try {
        const next = await fetchExecution(id);
        setExecution(next);

        if (isTerminal(next.status)) {
          setBusy(false);
          return;
        }
        poll(id);
      } catch (err) {
        setError(apiErrorMessage(err));
        setBusy(false);
      }
    }, POLL_INTERVAL_MS);
  }, []);

  async function run() {
    if (!user) {
      setError('Sign in to run code.');
      return;
    }

    setBusy(true);
    setError(null);
    setExecution(null);

    try {
      const queued = await createExecution({
        code,
        languageId,
        stdin: config.stdin || undefined,
        additionalFiles: config.additionalFiles ?? undefined,
        timeLimit: config.timeLimit ?? undefined,
        // The API takes kilobytes; the field is in MB because nobody thinks in KB.
        memoryLimit: config.memoryLimitMb ? config.memoryLimitMb * 1024 : undefined,
      });

      setExecution(queued);
      poll(queued.id);
    } catch (err) {
      setError(apiErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 dark:border-slate-800 dark:bg-slate-950">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Execution Playground
        </span>
        <EngineBanner engine={engine} />
      </div>

      <div className="min-h-0 flex-1">
        <SplitPane
          direction="horizontal"
          initial={58}
          first={
            <CodeEditorPane
              code={code}
              languageId={languageId}
              languages={languages}
              running={busy}
              onCodeChange={setCode}
              onLanguageChange={setLanguageId}
              onReset={() => setCode(editorLanguage(languageId).starter)}
              onRun={() => void run()}
            />
          }
          second={
            <SplitPane
              direction="vertical"
              initial={42}
              first={<RunSettings config={config} onChange={setConfig} />}
              second={<OutputConsole execution={execution} error={error} busy={busy} />}
            />
          }
        />
      </div>
    </div>
  );
}
