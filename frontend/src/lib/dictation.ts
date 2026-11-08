import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { useSettings } from "./settings";
import { getMax } from "./max";

/** The slice of the browser's speech recognition this app uses. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const recognitionClass = (): (new () => Recognition) | undefined => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

/** Decodes a recording and re-encodes it as 16 kHz mono 16-bit WAV (what the server's speech model reads). */
async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  void ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, v: string) => { for (let i = 0; i < v.length; i++) out.setUint8(o + i, v.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVEfmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([out], { type: "audio/wav" });
}

const joinText = (a: string, b: string) => [a.trimEnd(), b.trim()].filter(Boolean).join(" ");

/**
 * Dictation into a text field: words appear as they are recognised, after whatever was already typed.
 * `get` reads the field's current text when recording starts; `set` writes the combined text.
 */
export function useDictation(get: () => string, set: (text: string) => void) {
  const settings = useSettings();
  const rec = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const server = getMax().hub; // hosted version: record here, recognise on the server (the browser's own recogniser is unreliable)
  const media = useRef<MediaRecorder | null>(null);
  const supported = server ? !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" : !!recognitionClass();

  useEffect(() => () => { rec.current?.stop(); media.current?.stop(); }, []);

  const toggleServer = useCallback(async () => {
    if (media.current) { media.current.stop(); return; }
    setError("");
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return setError(t("Разрешите доступ к микрофону")); }
    const base = get();
    const chunks: Blob[] = [];
    const mr = new MediaRecorder(stream);
    media.current = mr;
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((x) => x.stop());
      media.current = null;
      setListening(false);
      setTranscribing(true);
      try {
        if (!chunks.length) return;
        const wav = await toWav(new Blob(chunks, { type: mr.mimeType }));
        const token = getMax().token;
        const r = await fetch(`/hub/transcribe?lang=${settings.language === "en" ? "en" : "ru"}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: wav });
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error?.message || "ошибка сервера");
        if (data.text) set(joinText(base, data.text));
        else setError(t("Речь не распознана"));
      } catch (e) { setError(t("Не удалось распознать речь: {0}", [e instanceof Error ? e.message : String(e)])); }
      setTranscribing(false);
    };
    mr.start();
    setListening(true);
  }, [get, set, settings.language]);

  const toggle = useCallback(() => {
    if (server) { if (!transcribing) void toggleServer(); return; }
    if (rec.current) return rec.current.stop();
    const Class = recognitionClass();
    if (!Class) return setError(t("Голосовой ввод здесь недоступен"));
    const base = get();
    const r = new Class();
    r.lang = settings.language === "en" ? "en-US" : "ru-RU";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let spoken = "";
      for (let i = 0; i < e.results.length; i++) spoken += e.results[i][0].transcript;
      set(joinText(base, spoken));
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(e.error === "not-allowed" || e.error === "service-not-allowed" ? t("Разрешите доступ к микрофону") : t("Не удалось распознать речь: {0}", [e.error]));
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    setError("");
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
    }
  }, [get, set, settings.language, server, toggleServer, transcribing]);

  return { supported, listening, transcribing, error, toggle };
}
