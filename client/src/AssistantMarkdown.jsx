import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import "./AssistantMarkdown.css";

function markdownComponents() {
  return {
    a({ href, children, ...props }) {
      const isSafe =
        href &&
        (href.startsWith("https://") ||
          href.startsWith("http://") ||
          href.startsWith("mailto:"));
      if (!isSafe) {
        return <span>{children}</span>;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          {...props}
        >
          {children}
        </a>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    code({ inline, className, children }) {
      const codeString = String(children).replace(/\n$/, "");
      if (inline) {
        return <code className="inline-code">{children}</code>;
      }

      const match = /language-(\w+)/.exec(className || "");
      const language = match ? match[1] : "text";

      return (
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          PreTag="div"
          className="syntax-block"
          customStyle={{
            margin: 0,
            borderRadius: 10,
            padding: "12px 14px",
            fontSize: 12,
            lineHeight: 1.45,
          }}
          codeTagProps={{
            style: {
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            },
          }}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    },
  };
}

export default function AssistantMarkdown({ content }) {
  if (!content) return null;

  return (
    <div className="assistant-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents()}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
