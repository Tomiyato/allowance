import ReactMarkdown from "react-markdown";

/** Assistant chat text as safe markdown: no raw HTML, links open in a new tab. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="agent-text md">
      <ReactMarkdown
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
