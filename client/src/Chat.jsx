import { useEffect, useMemo, useState } from "react";

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
];

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

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 800,
        background: "#020617",
        borderRadius: 24,
        padding: 24,
        boxShadow: "0 24px 60px rgba(15,23,42,0.8)",
        border: "1px solid rgba(148,163,184,0.3)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Featherless Chat</h1>
          <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>
            Streaming responses from your Node server in real time.
          </p>
        </div>
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

      {sessions.length > 0 && (
        <div
          style={{
            marginTop: 4,
            padding: "6px 10px",
            borderRadius: 12,
            background: "rgba(15,23,42,0.9)",
            border: "1px solid rgba(55,65,81,0.9)",
            fontSize: 11,
            color: "#e5e7eb",
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 4,
            }}
          >
            <span style={{ fontWeight: 500 }}>Recent chats</span>
            <span style={{ color: "#9ca3af" }}>
              {sessions.length > 3 ? `Last ${sessions.length}` : ""}
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
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
                  onClick={() => {
                    if (msgs.length) {
                      // Drop leading system prompts if present
                      const withoutSystem = msgs.filter(
                        (m) => m.role !== "system"
                      );
                      setMessages(withoutSystem.length ? withoutSystem : msgs);
                    }
                  }}
                  style={{
                    border: "none",
                    borderRadius: 999,
                    padding: "3px 8px",
                    background: "rgba(31,41,55,0.9)",
                    color: "#e5e7eb",
                    cursor: "pointer",
                    fontSize: 11,
                    maxWidth: "100%",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                    overflow: "hidden",
                  }}
                  title={firstUser?.content || "Chat"}
                >
                  {created && <span style={{ color: "#9ca3af" }}>{created} · </span>}
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
          gap: 12,
          alignItems: "center",
          fontSize: 12,
          color: "#e5e7eb",
        }}
      >
        <div>
          <span style={{ marginRight: 4 }}>Persona:</span>
          <select
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
            style={{
              background: "#020617",
              color: "#e5e7eb",
              borderRadius: 999,
              border: "1px solid rgba(55,65,81,0.9)",
              padding: "3px 8px",
              fontSize: 12,
            }}
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
          <span style={{ marginRight: 4 }}>Model:</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              background: "#020617",
              color: "#e5e7eb",
              borderRadius: 999,
              border: "1px solid rgba(55,65,81,0.9)",
              padding: "3px 8px",
              fontSize: 12,
              minWidth: 200,
            }}
            disabled={isStreaming}
          />
        </div>
        <div>
          <span style={{ marginRight: 4 }}>Temp:</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="1.5"
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value) || 0)}
            style={{
              width: 60,
              background: "#020617",
              color: "#e5e7eb",
              borderRadius: 999,
              border: "1px solid rgba(55,65,81,0.9)",
              padding: "3px 8px",
              fontSize: 12,
            }}
            disabled={isStreaming}
          />
        </div>
        <div>
          <span style={{ marginRight: 4 }}>Max tokens:</span>
          <input
            type="number"
            min="64"
            max="4096"
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value) || 0)}
            style={{
              width: 80,
              background: "#020617",
              color: "#e5e7eb",
              borderRadius: 999,
              border: "1px solid rgba(55,65,81,0.9)",
              padding: "3px 8px",
              fontSize: 12,
            }}
            disabled={isStreaming}
          />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              newSessionId();
              setMessages([]);
              setInput("");
              setError(null);
            }}
            disabled={isStreaming}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid rgba(59,130,246,0.7)",
              background: "transparent",
              color: "#bfdbfe",
              fontSize: 11,
              cursor: isStreaming ? "not-allowed" : "pointer",
            }}
          >
            New chat
          </button>
          <button
            onClick={clearChat}
            disabled={messages.length === 0 || isStreaming}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid rgba(239,68,68,0.6)",
              background: "transparent",
              color: "#fecaca",
              fontSize: 11,
              cursor:
                messages.length === 0 || isStreaming
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            Clear chat
          </button>
        </div>
      </div>
      <input
        type="file"
        accept=".txt,.md,.markdown"
        onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            setInput((prev) => `${prev}\n\n[Context from ${file.name}]\n${text}`);
        }}
        />
      <div
        style={{
          flex: 1,
          minHeight: 280,
          maxHeight: 420,
          overflowY: "auto",
          padding: 12,
          borderRadius: 16,
          background:
            "radial-gradient(circle at top left, #1e293b, #020617 65%)",
          border: "1px solid rgba(55,65,81,0.8)",
        }}
      >
        {messages.length === 0 && (
          <p style={{ fontSize: 13, color: "#9ca3af" }}>
            Ask anything to start a conversation with Featherless. Press Enter
            to send, Shift+Enter for a newline.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 8,
              display: "flex",
              justifyContent:
                m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "8px 12px",
                borderRadius: 16,
                fontSize: 14,
                whiteSpace: "pre-wrap",
                background:
                  m.role === "user"
                    ? "linear-gradient(135deg, #4f46e5, #6366f1)"
                    : "rgba(15,23,42,0.9)",
                color: "#e5e7eb",
                border:
                  m.role === "user"
                    ? "none"
                    : "1px solid rgba(55,65,81,0.9)",
              }}
            >
              {m.content || (m.role === "assistant" && isStreaming
                ? "…"
                : "")}
            </div>
            {m.content && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  marginLeft: 6,
                }}
              >
                <button
                  onClick={() => copyMessage(m.content)}
                  style={{
                    border: "none",
                    borderRadius: 999,
                    padding: "2px 6px",
                    fontSize: 10,
                    background: "rgba(31,41,55,0.9)",
                    color: "#e5e7eb",
                    cursor: "pointer",
                  }}
                >
                  Copy
                </button>
                {i === messages.length - 1 && m.role === "assistant" && (
                  <button
                    onClick={regenerateLast}
                    disabled={isStreaming}
                    style={{
                      border: "none",
                      borderRadius: 999,
                      padding: "2px 6px",
                      fontSize: 10,
                      background: "rgba(37,99,235,0.9)",
                      color: "#e5e7eb",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                    }}
                  >
                    Regenerate
                  </button>
                )}
                {i === messages.length - 1 && m.role === "user" && (
                  <button
                    onClick={editLastAndResend}
                    disabled={isStreaming}
                    style={{
                      border: "none",
                      borderRadius: 999,
                      padding: "2px 6px",
                      fontSize: 10,
                      background: "rgba(56,189,248,0.9)",
                      color: "#0f172a",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                    }}
                  >
                    Edit & resend
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder="Type your message here..."
          style={{
            width: "100%",
            resize: "none",
            borderRadius: 14,
            padding: "10px 12px",
            border: "1px solid rgba(55,65,81,0.9)",
            outline: "none",
            fontSize: 14,
            backgroundColor: "#020617",
            color: "#e5e7eb",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <small style={{ color: "#6b7280", fontSize: 11 }}>
            Enter to send • Shift+Enter for newline
          </small>
          <button
            onClick={() => sendMessage()}
            disabled={isStreaming || !input.trim()}
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              border: "none",
              cursor:
                isStreaming || !input.trim() ? "not-allowed" : "pointer",
              fontSize: 13,
              fontWeight: 500,
              background:
                isStreaming || !input.trim()
                  ? "rgba(55,65,81,0.9)"
                  : "linear-gradient(135deg, #22c55e, #16a34a)",
              color: "#0f172a",
              opacity: isStreaming || !input.trim() ? 0.7 : 1,
            }}
          >
            {isStreaming ? "Streaming..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Chat;