import { useSheetDrag } from "../lib/useSheetDrag";

type Message = {
  role: "user" | "assistant";
  text: string;
};

type Props = {
  messages: Message[];
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  onQuickCommand: (value: string) => void;
};

export default function ChatPanel({ messages, input, setInput, onSend, onQuickCommand }: Props) {
  const sheet = useSheetDrag("Navigator", "peek");
  const recentMessages = messages.slice(-4);
  const showContent = !sheet.isPeek;

  return (
    <aside
      className={`chat-panel chat-panel--${sheet.level}`}
      {...sheet.sheetProps}
      aria-label="Navigator assistant"
    >
      <button type="button" className="chat-panel__handle sheet-handle" {...sheet.handleProps}>
        <span aria-hidden="true" />
      </button>

      <div className="chat-panel__header">
        <h2>Navigator</h2>
      </div>

      {showContent && <div className="chat-panel__messages" aria-live="polite" aria-relevant="additions text">
        {recentMessages.map((msg, idx) => (
          <div key={idx} className={`chat-bubble chat-bubble--${msg.role}`}>
            {msg.text}
          </div>
        ))}
      </div>}

      {showContent && <div className="chat-panel__footer">
        <div className="chat-quick-actions" aria-label="Common requests">
          <button type="button" onClick={() => onQuickCommand("nearest restroom")}>
            Restroom
          </button>
          <button type="button" onClick={() => onQuickCommand("nearest gate")}>
            Gate
          </button>
          <button type="button" onClick={() => onQuickCommand("show plan")}>
            Plan
          </button>
          <button type="button" onClick={() => onQuickCommand("clear plan")}>
            Clear
          </button>
        </div>
        <div className="chat-input-row">
          <label className="sr-only" htmlFor="assistant-input">
            Ask the navigator
          </label>
          <input
            id="assistant-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            placeholder="Ask for a place"
            autoComplete="off"
            enterKeyHint="send"
          />
          <button type="button" onClick={onSend}>
            Send
          </button>
        </div>
      </div>}
    </aside>
  );
}
