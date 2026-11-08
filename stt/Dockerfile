FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 HF_HOME=/models
RUN pip install --no-cache-dir faster-whisper==1.1.1 requests 'onnx-asr[cpu,hub]'
RUN python -c "import onnx_asr; onnx_asr.load_model('gigaam-v2-ctc', quantization='int8')" && python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"
COPY server.py /app/server.py
ENV HF_HUB_OFFLINE=1
CMD ["python", "/app/server.py"]
