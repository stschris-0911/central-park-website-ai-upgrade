type Message = {
  role: "user" | "assistant";
  text: string;
};

type Props = {
  messages: Message[];
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
};

export default function ChatPanel({ messages, input, setInput, onSend }: Props) {
  return (
    <aside className="chat-panel">
      <div className="chat-panel__header">
        <h2>Navigator AI Chat</h2>
        <p>Try “nearest restroom”, “nearest restroom, then Bethesda Terrace, then nearest gate”, “show plan”, or “clear plan”.</p>
      </div>

      <div className="chat-panel__messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`chat-bubble chat-bubble--${msg.role}`}>
            {msg.text}
          </div>
        ))}
      </div>

      <div className="chat-panel__footer">
        <div className="chat-quick-actions">
          <button onClick={() => setInput("nearest restroom")}>nearest restroom</button>
          <button onClick={() => setInput("nearest restroom, then Bethesda Terrace, then nearest gate")}>3-stop trip</button>
          <button onClick={() => setInput("show plan")}>show plan</button>
          <button onClick={() => setInput("clear plan")}>clear plan</button>
        </div>
        <div className="chat-input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            placeholder="Type a destination, a multi-stop trip, or a planning command..."
          />
          <button onClick={onSend}>Send</button>
        </div>
      </div>
    </aside>
  );
}
