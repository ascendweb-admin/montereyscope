"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useChatTurnEngine as useRuntime,
  type ChatEngine,
  type ChatEngineOptions,
} from "./chat-engine";
import { dismissTask, updateTask } from "@/components/background/task-store";

class Session {
  engine: ChatEngine | null = null;
  ready: Promise<void>;
  resolve!: () => void;
  listeners = new Set<() => void>();
  host: symbol | null = null;
  constructor(
    public id: string,
    public options: ChatEngineOptions,
  ) {
    this.ready = new Promise<void>((done) => {
      this.resolve = done;
    });
  }
  publish(engine: ChatEngine) {
    this.engine = engine;
    this.resolve();
    for (const listener of this.listeners) listener();
  }
  attach(options: ChatEngineOptions, owner: symbol) {
    this.setOptions(options);
    this.host = owner;
  }
  detach(owner: symbol) {
    if (this.host === owner) this.host = null;
  }
  setOptions(options: ChatEngineOptions) {
    const preserve =
      this.engine?.generating ||
      (this.engine?.threadId !== null && this.engine?.threadId !== undefined);
    this.options = preserve
      ? { ...options, scope: this.options.scope, scopeSources: this.options.scopeSources }
      : options;
  }
  updateOptions(options: ChatEngineOptions, owner: symbol) {
    if (this.host === owner) this.setOptions(options);
  }
}
class ChatSessions {
  sessions = new Map<string, Session>();
  views = new Map<string, string>();
  remember(view: string, id: string) {
    this.views.set(view, id);
  }
  listeners = new Set<() => void>();
  snapshot: Session[] = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  ensure(id: string, options: ChatEngineOptions): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session = new Session(id, options);
    this.sessions.set(id, session);
    this.refresh();
    return session;
  }
  refresh() {
    this.snapshot = [...this.sessions.values()];
    for (const listener of this.listeners) listener();
  }
  forgetThread(id: number) {
    const session = this.findThread(id);
    if (!session || session.engine?.generating) return;
    this.sessions.delete(session.id);
    for (const [view, selected] of this.views) if (selected === session.id) this.views.delete(view);
    dismissTask(`chat:${session.id}`);
    this.refresh();
  }
  findThread(id: number) {
    return [...this.sessions.values()].find((session) => session.engine?.threadId === id);
  }
}
const Context = createContext<ChatSessions | null>(null);
const noScroll = { current: null };

function SessionRunner({ session }: { session: Session }) {
  // Read current host callbacks at event time; detached hosts must never rewrite another page's URL.
  const engine = useRuntime({
    ...session.options,
    scrollerRef: session.host ? session.options.scrollerRef : noScroll,
    onThreadCreated: (id) => {
      if (session.host) session.options.onThreadCreated?.(id);
    },
    onTurnComplete: () => {
      if (session.host) session.options.onTurnComplete?.();
    },
    showToast: (message, tone) => {
      if (session.host) session.options.showToast?.(message, tone);
    },
  });
  useLayoutEffect(() => {
    session.publish(engine);
  }, [engine, session]);
  const hadTurn = useRef(false);
  useEffect(() => {
    if (engine.generating) hadTurn.current = true;
    if (!hadTurn.current) return;
    updateTask({
      key: `chat:${session.id}`,
      label: "Chat answer",
      href: engine.threadId ? `/chat?thread=${engine.threadId}` : "/chat",
      status: engine.generating
        ? "running"
        : engine.turnError
          ? "failed"
          : engine.messages.findLast((message) => message.role === "assistant")?.interrupted
            ? "stopped"
            : "done",
      message: engine.turnError?.message,
      cancel: engine.generating ? engine.stop : undefined,
    });
  }, [
    engine.generating,
    engine.threadId,
    engine.turnError,
    engine.messages,
    engine.stop,
    session.id,
  ]);
  return null;
}
export function BackgroundChatProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new ChatSessions());
  const sessions = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <Context.Provider value={store}>
      {sessions.map((session) => (
        <SessionRunner key={session.id} session={session} />
      ))}
      {children}
    </Context.Provider>
  );
}
const idle: ChatEngine = {
  messages: [],
  selectedSources: [],
  threadId: null,
  draft: "",
  setDraft: () => {},
  turnPhase: "idle",
  turnError: null,
  notices: [],
  mode: "deep",
  selectMode: () => {},
  turnMode: "deep",
  generating: false,
  canSend: false,
  send: () => {},
  retryLast: () => {},
  stop: () => {},
  openThread: async () => false,
  startNewChat: () => {},
  loadingThreadId: null,
  reportPending: false,
  generateReport: async () => false,
  atBottom: true,
  handleScroll: () => {},
  jumpToLatest: () => {},
  handleSubmit: (event) => event.preventDefault(),
  handleComposerKeyDown: () => {},
  showEmptyConversation: true,
};

/** Attach a page to a shell-owned engine; switching or unmounting only detaches the view. */
export function useBackgroundChat(
  options: ChatEngineOptions & { viewKey?: string },
): ChatEngine & { forgetThread: (id: number) => void } {
  const store = useContext(Context);
  if (!store) throw new Error("BackgroundChatProvider is required");
  const initialId = useId();
  const scopeViewKey = JSON.stringify(
    options.scopeSources?.length
      ? options.scopeSources
      : options.scope.map((id) => ({ kind: "video", id })),
  );
  const viewKey = options.viewKey ?? scopeViewKey;
  const hasInitialScope = options.scope.length > 0 || (options.scopeSources?.length ?? 0) > 0;
  const [id, setId] = useState(
    () => store.views.get(options.viewKey && hasInitialScope ? scopeViewKey : viewKey) ?? initialId,
  );
  const latest = useRef(options);
  const owner = useRef(Symbol("chat-view"));
  const freshCounter = useRef(0);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const sessions = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const session = sessions.find((entry) => entry.id === id);
  const scopeKey = JSON.stringify(options.scope);
  const sourcesKey = JSON.stringify(options.scopeSources);
  useEffect(() => {
    const target = store.ensure(id, latest.current);
    target.attach(latest.current, owner.current);
    store.remember(viewKey, id);
    // Notify the provider only when input changes, never for engine output.
    store.refresh();
    const token = owner.current;
    return () => {
      target.detach(token);
    };
  }, [store, id, scopeKey, sourcesKey, viewKey]);
  useLayoutEffect(() => {
    session?.updateOptions(options, owner.current);
  });
  const engine = useSyncExternalStore(
    (listener) => {
      if (!session) return store.subscribe(listener);
      session.listeners.add(listener);
      return () => {
        session.listeners.delete(listener);
      };
    },
    () => session?.engine ?? idle,
    () => idle,
  );
  return {
    ...engine,
    forgetThread: (threadId) => store.forgetThread(threadId),
    openThread: async (threadId) => {
      const target =
        store.findThread(threadId) ??
        store.ensure(`${initialId}:thread:${threadId}`, latest.current);
      await target.ready;
      const opened =
        target.engine?.threadId === threadId || (await target.engine!.openThread(threadId));
      if (opened) setId(target.id);
      return opened;
    },
    startNewChat: () => {
      freshCounter.current += 1;
      setId(`${initialId}:new:${freshCounter.current}`);
    },
  };
}
