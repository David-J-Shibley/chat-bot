const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const app = express();

const clientBuildPath = path.join(__dirname, "client", "dist");
app.use(express.static(clientBuildPath));

app.use(cors());
app.use(express.json());

const FEATHERLESS_API_KEY = process.env.FEATHERLESS_API_KEY;
const FEATHERLESS_MODEL = process.env.FEATHERLESS_MODEL || "gQwen/Qwen2.5-7B-Instruct";

if (!FEATHERLESS_API_KEY) {
  console.error("Missing FEATHERLESS_API_KEY in .env");
  process.exit(1);
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    const featherlessRes = await fetch("https://api.featherless.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FEATHERLESS_API_KEY}`,
      },
      body: JSON.stringify({
        model: FEATHERLESS_MODEL,
        messages,
        stream: true,
      }),
    });

    if (!featherlessRes.ok || !featherlessRes.body) {
      const text = await featherlessRes.text().catch(() => "");
      return res.status(500).json({
        error: "Featherless request failed",
        details: text,
      });
    }

    // Stream plain text chunks back to the browser
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const reader = featherlessRes.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Process complete lines in the SSE buffer
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trimEnd();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.startsWith("data:")) {
          continue;
        }

        const dataPart = line.slice("data:".length).trim();
        if (!dataPart || dataPart === "[DONE]") {
          continue;
        }

        try {
          const payload = JSON.parse(dataPart);
          if (Array.isArray(payload.choices)) {
            for (const choice of payload.choices) {
              const delta = choice.delta || {};
              if (typeof delta.content === "string" && delta.content.length > 0) {
                // Write just the assistant text to the client
                res.write(delta.content);
              }
            }
          }
        } catch (e) {
          // Ignore malformed JSON lines
        }
      }
    }

    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Server error" });
    } else {
      res.end();
    }
  }
});

app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});