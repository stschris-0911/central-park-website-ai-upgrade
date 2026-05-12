type SpeakOptions = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
};

export function canSpeak(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

export function stopSpeaking() {
  if (canSpeak()) {
    window.speechSynthesis.cancel();
  }
}

export function speakText(text: string, options: SpeakOptions = {}) {
  const message = text.trim();
  if (!message || !canSpeak()) return;

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = "en-US";
  utterance.rate = 0.92;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onstart = () => options.onStart?.();
  utterance.onend = () => options.onEnd?.();
  utterance.onerror = () => options.onError?.();

  window.speechSynthesis.speak(utterance);
}
