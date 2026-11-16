#!/usr/bin/env python3
"""GLiClass sidecar per pi-telegram-bridge.

Un solo endpoint, un solo modello in memoria, nessuna dipendenza oltre a gliclass,
torch e transformers. Il ponte chiama `POST /classify` a ogni messaggio solo se il
lessico deterministico non ha gia' deciso (vedi src/voiceIntent.ts).

Perche' un sidecar e non il modello dentro node: il ponte resta senza dipendenze e
senza build step, e questo processo lo si tiene sulla macchina che puo' permetterselo
(Pi 5 con base, portatile con GPU con large). Se non c'e', il ponte funziona lo
stesso con le sole frasi.

Uso:
    python server.py --model base --port 8197
    python server.py --model large --host 0.0.0.0 --port 8197

    curl -s -X POST http://127.0.0.1:8197/classify \
         -d '{"text":"rispondi con un vocale"}' | jq

Modelli: `base` (187M, ~750 MB, ~160 ms/frase su i5) e `large` (439M, ~1.75 GB,
~540 ms). Entrambi zero-shot, nessun addestramento, nessun VRAM obbligatorio.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HYPOTHESIS = "the user asks to receive the answer as a voice message"

PRESETS = {
    "base": "knowledgator/gliclass-base-v3.0",
    "large": "knowledgator/gliclass-large-v3.0",
}


def build(model: str, device: str):
    try:
        from gliclass import GLiClassModel, ZeroShotClassificationPipeline
        from transformers import AutoTokenizer
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "manca il pacchetto '" + str(exc.name) + "'. Installa con: "
            "python -m pip install gliclass 'transformers>=4.48' torch "
            "oppure, se le librerie stanno altrove, passa --deps <cartella>"
        ) from exc

    model_id = PRESETS.get(model, model)
    started = time.perf_counter()
    gm = GLiClassModel.from_pretrained(model_id).to(device)
    tok = AutoTokenizer.from_pretrained(model_id)
    pipe = ZeroShotClassificationPipeline(gm, tok, classification_type="multi-label",
                                          device=device)
    load_s = round(time.perf_counter() - started, 1)
    # GLiClass carica il modello con softmax a singola etichetta: il punteggio utile
    # e' quello multi-label (sigmoid), quindi premise = messaggio, hypothesis = frase.
    return pipe, {"model": model, "model_id": model_id, "device": device, "load_sec": load_s}


def score(pipe, text: str) -> float:
    out = pipe(text, [HYPOTHESIS], threshold=0.0)[0]
    return float(out[0]["score"]) if out else 0.0


class Handler(BaseHTTPRequestHandler):
    pipe = None
    meta: dict = {}

    def log_message(self, fmt: str, *args) -> None:  # silenzio: logghiamo noi
        return

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, code: int, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _openapi(self) -> dict:
        """Specifica scritta a mano: il sidecar usa http.server, non ha FastAPI.

        Resta una sola verita' — questo dict — e due pagine che la leggono (Swagger UI
        e ReDoc) caricate da CDN. Se la macchina e' offline le pagine non si disegnano,
        ma /openapi.json resta leggibile come JSON.
        """
        model = self.meta.get("model", "large")
        return {
            "openapi": "3.1.0",
            "info": {
                "title": "GLiClass voice-intent sidecar",
                "version": "1.1.0",
                "description": ("Decide se un messaggio chiede una risposta vocale. "
                                "Un modello zero-shot in memoria, nessuna dipendenza "
                                "oltre a gliclass/torch/transformers. Il ponte "
                                "(pi-telegram-bridge) lo chiama solo quando il lessico "
                                "deterministico non ha gia' deciso."),
            },
            "servers": [{"url": "http://127.0.0.1:8197", "description": "locale"},
                        {"url": "http://192.168.50.129:8197", "description": "LAN"},
                        {"url": "http://100.64.192.51:8197", "description": "tailnet"}],
            "paths": {
                "/health": {"get": {
                    "summary": "Stato del sidecar e del modello",
                    "responses": {"200": {"description": "ok", "content": {"application/json": {
                        "example": {"ok": True, "hypothesis": HYPOTHESIS, "model": model,
                                    "model_id": PRESETS.get(model, model), "device": "cpu",
                                    "load_sec": 4.3}}}}}}},
                "/classify": {"post": {
                    "summary": "Punteggio 'voce' per un testo",
                    "requestBody": {"required": True, "content": {"application/json": {
                        "schema": {"type": "object", "required": ["text"], "properties": {
                            "text": {"type": "string"}, "input": {"type": "string",
                                     "description": "alias di text"}}}}}},
                    "responses": {"200": {"description": "punteggio 0..1",
                        "content": {"application/json": {"example": {
                            "voice": 0.9987, "ms": 658, "model": model}}}},
                        "400": {"description": "text vuoto o JSON non valido"}}}},
                "/v1/models": {"get": {"summary": "Elenco modelli (compatibilita' OpenAI)",
                    "responses": {"200": {"description": "ok"}}}},
                "/v1/chat/completions": {"post": {
                    "summary": "Stesso modello, contratto OpenAI: risponde VOICE o TEXT",
                    "requestBody": {"required": True, "content": {"application/json": {
                        "schema": {"type": "object", "properties": {
                            "model": {"type": "string"},
                            "messages": {"type": "array", "items": {"type": "object"}}}}}}},
                    "responses": {"200": {"description": "chat.completion con voice_intent.score"}}}},
            },
        }

    SWAGGER_UI = """<!doctype html><html><head><meta charset="utf-8">
<title>GLiClass sidecar — API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head><body><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
SwaggerUIBundle({url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true,
                 tryItOutEnabled: true});
</script></body></html>"""

    REDOC = """<!doctype html><html><head><meta charset="utf-8">
<title>GLiClass sidecar — reference</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body><redoc spec-url="/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
</body></html>"""

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "hypothesis": HYPOTHESIS, **self.meta})
        elif self.path == "/openapi.json":
            self._send(200, self._openapi())
        elif self.path in ("/docs", "/docs/"):
            self._send_html(200, self.SWAGGER_UI)
        elif self.path in ("/redoc", "/redoc/"):
            self._send_html(200, self.REDOC)
        elif self.path == "/v1/models":
            self._send(200, {"object": "list",
                             "data": [{"id": self.meta.get("model", "gliclass"),
                                       "object": "model"}]})
        else:
            self._send(404, {"error": "usa GET /health, /openapi.json, /docs, /redoc, "
                                      "/v1/models o POST /classify, /v1/chat/completions"})

    def _openai_chat(self) -> None:
        """Stesso modello, contratto OpenAI: risponde una parola, VOICE o TEXT.

        Serve a due cose: fa funzionare il provider `openai` del ponte anche contro
        questo sidecar (utile per misurare il percorso senza un gateway), e rende
        confrontabili le latenze con un qualsiasi endpoint standard.
        """
        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) if length else b"{}")
            messages = payload.get("messages") or []
            text = ""
            for msg in messages:
                if isinstance(msg, dict) and msg.get("role") == "user":
                    text = str(msg.get("content") or "")
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": {"message": "JSON non valido"}})
            return
        text = text.strip()
        if not text:
            self._send(400, {"error": {"message": "nessun messaggio utente"}})
            return
        started = time.perf_counter()
        try:
            voice = score(self.pipe, text)
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": {"message": str(exc)[:200]}})
            return
        self._send(200, {
            "id": "chatcmpl-" + str(int(time.time() * 1000)),
            "object": "chat.completion",
            "created": int(time.time()),
            "model": payload.get("model") or self.meta.get("model"),
            "choices": [{"index": 0, "finish_reason": "stop",
                          "message": {"role": "assistant",
                                      "content": "VOICE" if voice >= 0.5 else "TEXT"}}],
            "usage": {"prompt_tokens": len(text.split()), "completion_tokens": 1,
                      "total_tokens": len(text.split()) + 1},
            "voice_intent": {"score": round(voice, 4),
                             "ms": round((time.perf_counter() - started) * 1000)},
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/v1/chat/completions":
            self._openai_chat()
            return
        if self.path != "/classify":
            self._send(404, {"error": "endpoint sconosciuto"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "JSON non valido"})
            return
        text = str(payload.get("text") or payload.get("input") or "").strip()
        if not text:
            self._send(400, {"error": "text vuoto"})
            return
        started = time.perf_counter()
        try:
            voice = score(self.pipe, text)
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": str(exc)[:200]})
            return
        self._send(200, {"voice": round(voice, 4), "ms": round((time.perf_counter() - started) * 1000),
                         "model": self.meta.get("model")})


def main() -> int:
    ap = argparse.ArgumentParser(description="GLiClass sidecar per il voice trigger")
    ap.add_argument("--model", default=os.environ.get("GLICLASS_MODEL", "base"),
                    help="base | large | id HuggingFace | percorso locale")
    ap.add_argument("--host", default=os.environ.get("GLICLASS_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("GLICLASS_PORT", "8197")))
    ap.add_argument("--device", default=os.environ.get("GLICLASS_DEVICE", "cpu"),
                    help="cpu | cuda")
    ap.add_argument("--deps", default=os.environ.get("GLICLASS_DEPS", ""),
                    help="cartella extra da mettere in sys.path (install --target)")
    args = ap.parse_args()

    if args.deps:
        sys.path.insert(0, args.deps)

    print(f"carico {args.model} su {args.device} ...", flush=True)
    pipe, meta = build(args.model, args.device)
    Handler.pipe = pipe
    Handler.meta = meta
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"pronto: http://{args.host}:{args.port} (modello {meta['model_id']}, "
          f"caricato in {meta['load_sec']}s)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstop", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
