import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
};

export function MarkdownSummary({ children }: { children: string }) {
  return (
    <div className="typeset min-w-0 break-words p-7">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children.trim() ? children : "No summary was provided."}
      </Markdown>
    </div>
  );
}
