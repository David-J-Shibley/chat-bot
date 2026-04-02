import { useEffect, useMemo, useRef, useState } from "react";

const LOCAL_STORAGE_KEY = "chat-bot-messages-v1";
const SESSION_KEY = "chat-bot-session-id";

function getSessionId() {
  if (typeof window === "undefined") return "anonymous";
  let id = window.localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    try {
      window.localStorage.setItem(SESSION_KEY, id);
    } catch {
      // ignore
    }
  }
  return id;
}

function newSessionId() {
  if (typeof window === "undefined") return "anonymous";
  const id = crypto.randomUUID();
  try {
    window.localStorage.setItem(SESSION_KEY, id);
  } catch {
    // ignore
  }
  return id;
}

const PERSONAS = [
  {
    id: "general",
    label: "General assistant",
    systemPrompt:
      "You are a helpful, concise AI assistant having a friendly conversation with the user.",
  },
  {
    id: "coder",
    label: "Coding helper",
    systemPrompt:
      "You are a senior software engineer. Give practical, concrete code examples and be concise.",
  },
  {
    id: "writer",
    label: "Writing coach",
    systemPrompt:
      "You help the user improve writing with clear suggestions, rewrites, and explanations.",
  },
  {
    id: "medical",
    label: "Health information",
    systemPrompt:
      "You are a careful health-information assistant. Explain medical concepts, terminology, and general wellness in plain language. You are not a doctor and cannot diagnose, prescribe medications, or replace in-person care. Do not give personalized treatment plans; encourage the user to discuss decisions with a qualified clinician. If symptoms could be serious or an emergency, say so clearly and tell them to seek urgent or emergency medical care. When unsure, say you are unsure and suggest professional evaluation.",
  },
];

// Maps to model temperature (0.1–1.0); labels describe answer style, not jargon.
const PRECISION_CHOICES = [
  { value: 0.1, label: "Maximum precision — very focused, consistent" },
  { value: 0.2, label: "Very high precision" },
  { value: 0.3, label: "High precision" },
  { value: 0.4, label: "Mostly precise" },
  { value: 0.5, label: "Balanced" },
  { value: 0.6, label: "Slightly more flexible" },
  { value: 0.7, label: "Flexible — good default" },
  { value: 0.8, label: "More varied wording" },
  { value: 0.9, label: "High variety" },
  { value: 1.0, label: "Maximum variety — more exploratory" },
];

/** Suggested model when using the health-information persona (OpenAI-compatible id). */
const SUGGESTED_MEDICAL_MODEL = "m42-health/Llama3-Med42-8B";

function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [personaId, setPersonaId] = useState(PERSONAS[0].id);
  const [model, setModel] = useState("Qwen/Qwen2.5-7B-Instruct");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(512);
  const [lastRequest, setLastRequest] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const [medicalModelHintDismissed, setMedicalModelHintDismissed] =
    useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (personaId === "medical") {
      setMedicalModelHintDismissed(false);
    }
  }, [personaId]);

  useEffect(() => {
    if (!PRECISION_CHOICES.some((c) => c.value === temperature)) {
      setTemperature(0.7);
    }
  }, [temperature]);

  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/history", {
        headers: { "X-Session-Id": getSessionId() },
      });
      const data = await res.json();
      setSessions(data.sessions || []);
    };
    load();
  }, []);

  // Listen for PWA install prompt event
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setInstallPromptEvent(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  // Load initial history from localStorage
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setMessages(parsed);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Persist history whenever it changes
  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // ignore
    }
  }, [messages]);

  const currentPersona = useMemo(
    () => PERSONAS.find((p) => p.id === personaId) || PERSONAS[0],
    [personaId]
  );

  const clearChat = () => {
    setMessages([]);
    setInput("");
    setIsStreaming(false);
    setError(null);
    try {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const sendMessage = async (overrideInput) => {
    setError(null);
    const rawValue = overrideInput !== undefined ? overrideInput : input;
    const raw =
      typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    const trimmed = raw.trim();
    if (!trimmed || isStreaming) return;
    if (trimmed.length > 8000) {
      setError("Your message is too long. Please shorten it.");
      return;
    }

    const newMessages = [...messages, { role: "user", content: trimmed }];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);

    // placeholder assistant message to stream into
    setMessages((prev) => [...newMessages, { role: "assistant", content: "" }]);

    const requestPayload = {
      messages: newMessages,
      options: {
        personaId: currentPersona.id,
        model,
        temperature,
        maxTokens,
      },
    };
    setLastRequest(requestPayload);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": getSessionId(),
        },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        let message = "Something went wrong. Please try again.";
        try {
          const data = await response.json();
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
          // ignore
        }
        setError(message);
        return;
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        assistantText += chunk;

        setMessages((prev) => {
          const updated = [...prev];
          const lastIndex = updated.length - 1;
          if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
            updated[lastIndex] = {
              ...updated[lastIndex],
              content: assistantText,
            };
          }
          return updated;
        });
      }
    } catch (err) {
      console.error("Streaming error", err);
      setError("Network error while streaming. Please try again.");
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const retryLast = () => {
    if (!lastRequest || isStreaming) return;
    // Remove last placeholder assistant if present
    setMessages((prev) => {
      if (prev.length && prev[prev.length - 1].role === "assistant" && !prev[prev.length - 1].content) {
        return prev.slice(0, -1);
      }
      return prev;
    });
    // Re-run using the stored payload
    setInput("");
    setIsStreaming(false);
    sendMessage(lastRequest.messages[lastRequest.messages.length - 1].content);
  };

  const copyMessage = async (content) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // ignore
    }
  };

  const regenerateLast = () => {
    if (isStreaming) return;
    const lastUserIndex = [...messages]
      .map((m, i) => ({ ...m, i }))
      .filter((m) => m.role === "user")
      .map((m) => m.i)
      .pop();
    if (lastUserIndex === undefined) return;

    const baseMessages = messages.slice(0, lastUserIndex + 1);
    setMessages(baseMessages);
    const lastUser = baseMessages[baseMessages.length - 1];
    if (!lastUser) return;
    sendMessage(lastUser.content);
  };

  const editLastAndResend = () => {
    if (isStreaming) return;
    const lastUserIndex = [...messages]
      .map((m, i) => ({ ...m, i }))
      .filter((m) => m.role === "user")
      .map((m) => m.i)
      .pop();
    if (lastUserIndex === undefined) return;
    const lastUser = messages[lastUserIndex];
    setMessages(messages.slice(0, lastUserIndex));
    setInput(lastUser.content);
  };

  const fieldLabel = {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: "#94a3b8",
    letterSpacing: "0.02em",
    marginBottom: 6,
    textTransform: "uppercase",
  };
  const fieldControl = {
    width: "100%",
    boxSizing: "border-box",
    background: "#0f172a",
    color: "#e5e7eb",
    borderRadius: 10,
    border: "1px solid rgba(71,85,105,0.9)",
    padding: "8px 10px",
    fontSize: 13,
    outline: "none",
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 880,
        background: "#020617",
        borderRadius: 24,
        padding: 20,
        boxShadow: "0 24px 60px rgba(15,23,42,0.8)",
        border: "1px solid rgba(148,163,184,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          paddingBottom: 12,
          borderBottom: "1px solid rgba(51,65,85,0.6)",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Goblin Chat</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#94a3b8", lineHeight: 1.4 }}>
            Replies stream in as they are generated.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {installPromptEvent && (
            <button
              onClick={async () => {
                const ev = installPromptEvent;
                setInstallPromptEvent(null);
                try {
                  await ev.prompt();
                  await ev.userChoice;
                } catch {
                  // ignore
                }
              }}
              style={{
                fontSize: 11,
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid rgba(56,189,248,0.7)",
                background: "rgba(8,47,73,0.9)",
                color: "#e0f2fe",
                cursor: "pointer",
              }}
            >
              Install app
            </button>
          )}
          <span
            style={{
              fontSize: 11,
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid rgba(34,197,94,0.3)",
              color: "#bbf7d0",
              background: "rgba(22,163,74,0.2)",
            }}
          >
            {isStreaming ? "Generating..." : "Idle"}
          </span>
        </div>
      </header>

      {error && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 12px",
            borderRadius: 10,
            background: "rgba(248,113,113,0.15)",
            border: "1px solid rgba(248,113,113,0.5)",
            color: "#fecaca",
            fontSize: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>{error}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {lastRequest && (
              <button
                onClick={retryLast}
                disabled={isStreaming}
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "3px 8px",
                  fontSize: 11,
                  background: "rgba(248,250,252,0.1)",
                  color: "#fecaca",
                  cursor: isStreaming ? "not-allowed" : "pointer",
                }}
              >
                Try again
              </button>
            )}
            <button
              onClick={() => setError(null)}
              style={{
                border: "none",
                borderRadius: 999,
                padding: "3px 8px",
                fontSize: 11,
                background: "transparent",
                color: "#fecaca",
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {personaId === "medical" && !medicalModelHintDismissed && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: 4,
            padding: "10px 12px",
            borderRadius: 12,
            background: "rgba(14,116,144,0.2)",
            border: "1px solid rgba(34,211,238,0.45)",
            color: "#e0f2fe",
            fontSize: 12,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ flex: "1 1 220px", lineHeight: 1.45 }}>
            <strong>Health information mode:</strong> answers are more reliable
            when you use a medical-tuned model. Try{" "}
            <code
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 6,
                background: "rgba(15,23,42,0.6)",
              }}
            >
              {SUGGESTED_MEDICAL_MODEL}
            </code>{" "}
            (or another health-focused model your API supports) in{" "}
            <strong>Model</strong> below.
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setModel(SUGGESTED_MEDICAL_MODEL);
                setMedicalModelHintDismissed(true);
              }}
              disabled={isStreaming}
              style={{
                border: "none",
                borderRadius: 999,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 500,
                background: "linear-gradient(135deg, #22d3ee, #06b6d4)",
                color: "#0f172a",
                cursor: isStreaming ? "not-allowed" : "pointer",
                opacity: isStreaming ? 0.6 : 1,
              }}
            >
              Use suggested model
            </button>
            <button
              type="button"
              onClick={() => setMedicalModelHintDismissed(true)}
              style={{
                border: "1px solid rgba(148,163,184,0.5)",
                borderRadius: 999,
                padding: "6px 12px",
                fontSize: 12,
                background: "transparent",
                color: "#e2e8f0",
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {sessions.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 12,
            background: "rgba(15,23,42,0.75)",
            border: "1px solid rgba(51,65,85,0.7)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#94a3b8",
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Recent chats
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              overflowX: "auto",
              paddingBottom: 2,
              WebkitOverflowScrolling: "touch",
            }}
          >
            {sessions.map((s, idx) => {
              const msgs = Array.isArray(s.messages) ? s.messages : [];
              const firstUser = msgs.find((m) => m.role === "user");
              const preview =
                typeof firstUser?.content === "string"
                  ? firstUser.content.slice(0, 40)
                  : "Chat";
              const created =
                typeof s.createdAt === "number"
                  ? new Date(s.createdAt).toLocaleTimeString()
                  : "";
              return (
                <button
                  key={`${s.sessionId || "s"}-${s.createdAt || idx}`}
                  type="button"
                  onClick={() => {
                    if (msgs.length) {
                      const withoutSystem = msgs.filter(
                        (m) => m.role !== "system"
                      );
                      setMessages(withoutSystem.length ? withoutSystem : msgs);
                    }
                  }}
                  style={{
                    flex: "0 0 auto",
                    border: "1px solid rgba(71,85,105,0.9)",
                    borderRadius: 10,
                    padding: "6px 10px",
                    background: "rgba(30,41,59,0.9)",
                    color: "#e5e7eb",
                    cursor: "pointer",
                    fontSize: 12,
                    maxWidth: 200,
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                    overflow: "hidden",
                    textAlign: "left",
                  }}
                  title={firstUser?.content || "Chat"}
                >
                  {created && <span style={{ color: "#64748b" }}>{created} · </span>}
                  {preview}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12, color: "#64748b" }}>Conversation</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              newSessionId();
              setMessages([]);
              setInput("");
              setError(null);
            }}
            disabled={isStreaming}
            style={{
              padding: "6px 12px",
              borderRadius: 10,
              border: "1px solid rgba(59,130,246,0.45)",
              background: "rgba(30,58,138,0.25)",
              color: "#bfdbfe",
              fontSize: 12,
              fontWeight: 500,
              cursor: isStreaming ? "not-allowed" : "pointer",
              opacity: isStreaming ? 0.5 : 1,
            }}
          >
            New chat
          </button>
          <button
            type="button"
            onClick={clearChat}
            disabled={messages.length === 0 || isStreaming}
            style={{
              padding: "6px 12px",
              borderRadius: 10,
              border: "1px solid rgba(248,113,113,0.35)",
              background: "rgba(127,29,29,0.2)",
              color: "#fecaca",
              fontSize: 12,
              fontWeight: 500,
              cursor:
                messages.length === 0 || isStreaming
                  ? "not-allowed"
                  : "pointer",
              opacity:
                messages.length === 0 || isStreaming ? 0.45 : 1,
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <section
        style={{
          padding: 14,
          borderRadius: 14,
          background: "rgba(15,23,42,0.6)",
          border: "1px solid rgba(51,65,85,0.75)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#94a3b8",
            marginBottom: 12,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Model &amp; behavior
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 14,
          }}
        >
          <div>
            <label style={fieldLabel}>Persona</label>
            <select
              value={personaId}
              onChange={(e) => setPersonaId(e.target.value)}
              style={{ ...fieldControl, cursor: isStreaming ? "not-allowed" : "pointer" }}
              disabled={isStreaming}
            >
              {PERSONAS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={fieldLabel}>Max tokens</label>
            <input
              type="number"
              min="64"
              max="4096"
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value) || 0)}
              style={fieldControl}
              disabled={isStreaming}
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={fieldLabel}>Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{
                ...fieldControl,
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
              }}
              disabled={isStreaming}
              placeholder="provider/model-id"
              autoComplete="off"
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={fieldLabel}>Answer style</label>
            <select
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              style={{ ...fieldControl, cursor: isStreaming ? "not-allowed" : "pointer" }}
              disabled={isStreaming}
            >
              {PRECISION_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
      <div
        style={{
          flex: 1,
          minHeight: 260,
          maxHeight: 440,
          overflowY: "auto",
          padding: 14,
          borderRadius: 16,
          background: "linear-gradient(165deg, #0f172a 0%, #020617 100%)",
          border: "1px solid rgba(51,65,85,0.75)",
        }}
      >
        {messages.length === 0 && (
          <p style={{ fontSize: 13, color: "#94a3b8", margin: 0, lineHeight: 1.5 }}>
            Ask anything to get started. <strong>Enter</strong> sends,{" "}
            <strong>Shift+Enter</strong> adds a new line.
          </p>
        )}
        {messages.map((m, i) => {
          const bubbleFooterBtn = {
            border: "none",
            borderRadius: 8,
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
            background: "rgba(15,23,42,0.5)",
            color: "#cbd5e1",
          };
          return (
            <div
              key={i}
              style={{
                marginBottom: 12,
                display: "flex",
                justifyContent:
                  m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  maxWidth: "min(100%, 520px)",
                  borderRadius: 16,
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background:
                    m.role === "user"
                      ? "linear-gradient(135deg, #4f46e5, #6366f1)"
                      : "rgba(30,41,59,0.95)",
                  color: "#e5e7eb",
                  border:
                    m.role === "user"
                      ? "none"
                      : "1px solid rgba(71,85,105,0.8)",
                  boxShadow:
                    m.role === "user"
                      ? "0 4px 14px rgba(79,70,229,0.25)"
                      : "0 2px 8px rgba(0,0,0,0.2)",
                  overflow: "hidden",
                }}
              >
                <div style={{ padding: "10px 14px" }}>
                  {m.content || (m.role === "assistant" && isStreaming
                    ? "…"
                    : "")}
                </div>
                {m.content && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                      gap: 6,
                      padding: "6px 10px",
                      borderTop:
                        m.role === "user"
                          ? "1px solid rgba(255,255,255,0.12)"
                          : "1px solid rgba(51,65,85,0.9)",
                      background:
                        m.role === "user"
                          ? "rgba(0,0,0,0.08)"
                          : "rgba(15,23,42,0.5)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => copyMessage(m.content)}
                      style={bubbleFooterBtn}
                    >
                      Copy
                    </button>
                    {i === messages.length - 1 && m.role === "assistant" && (
                      <button
                        type="button"
                        onClick={regenerateLast}
                        disabled={isStreaming}
                        style={{
                          ...bubbleFooterBtn,
                          background: "rgba(37,99,235,0.35)",
                          color: "#e0e7ff",
                          cursor: isStreaming ? "not-allowed" : "pointer",
                          opacity: isStreaming ? 0.5 : 1,
                        }}
                      >
                        Regenerate
                      </button>
                    )}
                    {i === messages.length - 1 && m.role === "user" && (
                      <button
                        type="button"
                        onClick={editLastAndResend}
                        disabled={isStreaming}
                        style={{
                          ...bubbleFooterBtn,
                          background: "rgba(14,165,233,0.25)",
                          color: "#e0f2fe",
                          cursor: isStreaming ? "not-allowed" : "pointer",
                          opacity: isStreaming ? 0.5 : 1,
                        }}
                      >
                        Edit &amp; resend
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          paddingTop: 4,
          borderTop: "1px solid rgba(51,65,85,0.5)",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            setInput(
              (prev) => `${prev}\n\n[Context from ${file.name}]\n${text}`
            );
            e.target.value = "";
          }}
        />
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder="Type your message…"
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            minHeight: 88,
            borderRadius: 14,
            padding: "12px 14px",
            border: "1px solid rgba(71,85,105,0.9)",
            outline: "none",
            fontSize: 15,
            lineHeight: 1.45,
            fontFamily: "inherit",
            backgroundColor: "#0f172a",
            color: "#e5e7eb",
          }}
        />
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              style={{
                padding: "6px 12px",
                borderRadius: 10,
                border: "1px solid rgba(100,116,139,0.6)",
                background: "rgba(30,41,59,0.8)",
                color: "#cbd5e1",
                fontSize: 12,
                cursor: isStreaming ? "not-allowed" : "pointer",
                opacity: isStreaming ? 0.5 : 1,
              }}
            >
              Attach .txt / .md
            </button>
            <small style={{ color: "#64748b", fontSize: 11 }}>
              Enter to send · Shift+Enter new line
            </small>
          </div>
          <button
            type="button"
            onClick={() => sendMessage()}
            disabled={isStreaming || !input.trim()}
            style={{
              padding: "10px 22px",
              borderRadius: 12,
              border: "none",
              cursor:
                isStreaming || !input.trim() ? "not-allowed" : "pointer",
              fontSize: 14,
              fontWeight: 600,
              background:
                isStreaming || !input.trim()
                  ? "rgba(51,65,85,0.9)"
                  : "linear-gradient(135deg, #22c55e, #16a34a)",
              color: "#0f172a",
              opacity: isStreaming || !input.trim() ? 0.65 : 1,
            }}
          >
            {isStreaming ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Chat;