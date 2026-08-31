interface TranscriptLine {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export const ConversationTranscript = ({ lines }: { readonly lines: readonly TranscriptLine[] }) => (
  <div aria-live="polite" className="assistant-transcript">
    {lines.map((line, index) => (
      <p className={`assistant-line assistant-line--${line.role}`} key={`${line.role}-${index}`}>
        <strong>{line.role === 'user' ? '你' : '小厨'}</strong>
        <span>{line.text || '…'}</span>
      </p>
    ))}
  </div>
);
