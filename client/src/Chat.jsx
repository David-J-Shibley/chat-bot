import { useState } from "react";

function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const newMessages = [...messages, { role: "user", content: trimmed }];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);

    // placeholder assistant message to stream into
    setMessages((prev) => [...newMessages, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("http://localhost:4000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

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

        // If Featherless is sending SSE, this will include the raw SSE text.
        // For now we just append everything; we can refine later.
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
            onClick={sendMessage}
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