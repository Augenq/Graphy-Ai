"""Tiny speech-to-text sidecar: POST /transcribe?lang=ru with a WAV body -> {"text": "..."}. faster-whisper, CPU, int8."""
import io, json, os, threading, wave
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

THREADS = int(os.environ.get("STT_THREADS", "1"))
# STT_RU=gigaam: far better Russian, but ~600 MB of RAM (needs a 2 GB host). Default: Whisper-base, ~100 MB.
import importlib
GIGAAM = os.environ.get("STT_RU", "whisper") == "gigaam"
RU = importlib.import_module("onnx_asr").load_model("gigaam-v2-ctc", quantization="int8") if GIGAAM else None
_EN = None
def en_model():
    global _EN
    if _EN is None:
        from faster_whisper import WhisperModel
        _EN = WhisperModel(os.environ.get("STT_MODEL", "base"), device="cpu", compute_type="int8", cpu_threads=THREADS)
    return _EN
if not GIGAAM: en_model()
LOCK = threading.Lock()  # one transcription at a time: the host has a single core

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self): self._send(200, {"ok": True})
    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/transcribe": return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        if not 0 < n <= 12 * 1024 * 1024: return self._send(413, {"error": "bad size"})
        with wave.open(io.BytesIO(self.rfile.read(n))) as w:  # the client always sends 16 kHz mono 16-bit PCM
            if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2: return self._send(400, {"error": "need 16 kHz mono 16-bit wav"})
            audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        lang = parse_qs(u.query).get("lang", ["ru"])[0]
        try:
            with LOCK:
                if lang == "en" or not GIGAAM:
                    segs, _ = en_model().transcribe(audio, language=lang if lang in ("ru", "en") else None, beam_size=1, vad_filter=True, condition_on_previous_text=False)
                    text = " ".join(s.text.strip() for s in segs).strip()
                else:  # GigaAM takes up to ~25 s at a time: cut longer recordings into 20 s pieces
                    step = 16000 * 20
                    parts = [audio[i:i + step] for i in range(0, len(audio), step) if len(audio[i:i + step]) > 1600]
                    text = " ".join(str(RU.recognize(p, sample_rate=16000)).strip() for p in parts).strip()
            self._send(200, {"text": text})
        except Exception as e:
            self._send(500, {"error": str(e)[:200]})

ThreadingHTTPServer(("0.0.0.0", 8000), H).serve_forever()
