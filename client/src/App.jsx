import Chat from "./Chat.jsx";

function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0f172a, #1e293b)",
        color: "#e5e7eb",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div style={{ display: "flex" }}>
        <aside style={{ width: 240, ... }}>
          {sessions.map((s) => (
            <button
              key={s.createdAt}
              onClick={() => setMessages(s.messages || [])}
              /* style omitted for brevity */
            >
              {new Date(s.createdAt).toLocaleTimeString()} – {s.messages?.[1]?.content?.slice(0, 24) || "Chat"}
            </button>
          ))}
        </aside>
        <main style={{ flex: 1 }}>
          <Chat />
        </main>
      </div>
    </div>
  );
}

export default App;