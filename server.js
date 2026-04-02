const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" })
);
const CHAT_TABLE = process.env.CHAT_TABLE || "chat_sessions";
dotenv.config();

const app = express();

const clientBuildPath = path.join(__dirname, "client", "dist");
app.use(express.static(clientBuildPath));

app.use(cors());
app.use(express.json());

const FEATHERLESS_API_KEY = process.env.FEATHERLESS_API_KEY;
const DEFAULT_MODEL =
  process.env.FEATHERLESS_MODEL || "Qwen/Qwen2.5-7B-Instruct";

// Simple in-memory rate limiter per IP
const rateBuckets = new Map();
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

if (!FEATHERLESS_API_KEY) {
  console.error("Missing FEATHERLESS_API_KEY in .env");
  process.exit(1);
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, options } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    // Basic server-side validation
    const lastUser = messages[messages.length - 1];
    const content = typeof lastUser?.content === "string" ? lastUser.content : "";
    if (!content.trim()) {
      return res.status(400).json({ error: "Message cannot be empty." });
    }
    if (content.length > 8000) {
      return res
        .status(400)
        .json({ error: "Message is too long. Please shorten your input." });
    }

    // Rate limiting per IP
    const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfterSeconds);
      return res.status(429).json({
        error: "Rate limit exceeded. Please wait a bit before sending more messages.",
      });
    }

    const model = (options && options.model) || DEFAULT_MODEL;
    const temperature =
      typeof options?.temperature === "number" ? options.temperature : 0.7;
    const maxTokens =
      typeof options?.maxTokens === "number" ? options.maxTokens : 512;
    const personaId = options?.personaId || "general";

    let systemPrompt =
      "You are a helpful, concise AI assistant having a friendly conversation with the user.";
    if (personaId === "coder") {
      systemPrompt =
        "You are a senior software engineer. Give practical, concrete code examples and be concise.";
    } else if (personaId === "writer") {
      systemPrompt =
        "You help the user improve writing with clear suggestions, rewrites, and explanations.";
    }

    const finalMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const featherlessRes = await fetch(
      "https://api.featherless.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${FEATHERLESS_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: finalMessages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
      }
    );

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

    const sessionId = req.headers["x-session-id"] || req.ip || "anonymous";

    await dynamo.send(
      new PutCommand({
        TableName: CHAT_TABLE,
        Item: {
          sessionId,
          createdAt: Date.now().toString(),
          personaId,
          model,
          messages: finalMessages, // or a trimmed subset
        },
      })
    );

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

app.get("/api/history", async (req, res) => {
    const sessionId = req.headers["x-session-id"] || req.ip || "anonymous";
    const result = await dynamo.send(
      new QueryCommand({
        TableName: CHAT_TABLE,
        KeyConditionExpression: "sessionId = :sid",
        ExpressionAttributeValues: { ":sid": sessionId },
        ScanIndexForward: false,
        Limit: 20,
      })
    );
    res.json({ sessions: result.Items || [] });
  });

app.get("/healthz", (req, res) => {
    res.status(200).json({ ok: true });
});

app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});