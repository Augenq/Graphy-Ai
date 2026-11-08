import openai from '../assets/providers/openai.svg';
import claude from '../assets/providers/claude.svg';
import deepseek from '../assets/providers/deepseek.svg';
import kimi from '../assets/providers/kimi.png';
import glm from '../assets/providers/glm.svg';
import grok from '../assets/providers/grok.svg';
import mimo from '../assets/providers/xiaomimimo.svg';
import qwen from '../assets/providers/qwen-color.svg';
import gemini from '../assets/providers/gemini-color.svg';
import gemma from '../assets/providers/gemma-color.svg';
import mistral from '../assets/providers/mistral-color.svg';
import meta from '../assets/providers/meta-color.svg';
import cohere from '../assets/providers/cohere-color.svg';
import perplexity from '../assets/providers/perplexity-color.svg';
import nvidia from '../assets/providers/nvidia-color.svg';
import microsoft from '../assets/providers/microsoft-color.svg';
import minimax from '../assets/providers/minimax-color.svg';
import baichuan from '../assets/providers/baichuan-color.svg';
import openrouter from '../assets/providers/openrouter.svg';
import groq from '../assets/providers/groq.svg';
import together from '../assets/providers/together-color.svg';
import ollama from '../assets/providers/ollama.svg';
import lmstudio from '../assets/providers/lmstudio.svg';
import llamacpp from '../assets/providers/llamacpp.svg';
import vllm from '../assets/providers/vllm-color.svg';
import sglang from '../assets/providers/sglang.webp';
import localai from '../assets/providers/localai.webp';
import google from '../assets/providers/google-color.svg';
import anthropic from '../assets/providers/anthropic.svg';
import xai from '../assets/providers/xai.svg';
import type { ModelInfo } from '../lib/remote';

const brands: [RegExp, string][] = [
  [/qwen|qwq/i, qwen], [/gemma/i, gemma], [/gemini|google/i, gemini],
  [/mistral|mixtral|codestral|devstral|ministral/i, mistral], [/meta[-/ ]|llama/i, meta],
  [/cohere|command-r/i, cohere], [/perplexity|sonar/i, perplexity], [/nvidia|nemotron/i, nvidia],
  [/microsoft|(?:^|[ /])phi[- /0-9]/i, microsoft], [/minimax/i, minimax], [/baichuan/i, baichuan],
  [/openai|codex|gpt[- /]|o[134](?:[- /]|$)/i, openai], [/anthropic|claude/i, claude],
  [/deepseek/i, deepseek], [/moonshot|kimi/i, kimi], [/zai|z\.ai|glm/i, glm],
  [/xai|x\.ai|grok/i, grok], [/mimo|xiaomi/i, mimo],
];
const gateways: [RegExp, string][] = [
  [/^openai(?:-codex)?$/i, openai], [/^anthropic$/i, anthropic], [/^google$/i, google],
  [/^xai$/i, xai], [/^deepseek$/i, deepseek], [/^mistral$/i, mistral],
  [/^openrouter$/i, openrouter], [/^groq$/i, groq], [/^together$/i, together],
  [/^ollama$/i, ollama], [/^lm[ -]?studio$/i, lmstudio], [/^llama\.cpp$/i, llamacpp],
  [/^vllm$/i, vllm], [/^sglang$/i, sglang], [/^localai$/i, localai],
];
export function getProvider(provider: string): { src?: string; letter: string } {
  const src = gateways.find(([pattern]) => pattern.test(provider))?.[1] ?? brands.find(([pattern]) => pattern.test(provider))?.[1];
  return { src, letter: (provider || '?').charAt(0).toUpperCase() };
}
export function ModelIcon({ model, provider }: { model?: ModelInfo; provider?: string }) {
  // Identify the model before its gateway: Qwen served through OpenRouter is still Qwen.
  const identity = model ? `${model.id} ${model.name}` : '';
  const gateway = provider ?? model?.provider ?? '';
  const src = brands.find(([pattern]) => pattern.test(identity))?.[1]
    ?? gateways.find(([pattern]) => pattern.test(gateway))?.[1]
    ?? brands.find(([pattern]) => pattern.test(gateway))?.[1];
  return src ? <img className={`model-icon${(src === openai || src === openrouter || src === groq || src === ollama || src === grok || src === mimo || src === xai || src === anthropic || src === llamacpp || src === lmstudio) ? " model-icon-openai" : ""}${src === sglang ? " model-icon-sglang" : ""}`} src={src} alt="" aria-hidden="true" draggable={false} />
    : <span className="model-icon model-icon-fallback" aria-hidden="true">{(provider || model?.provider || '?').charAt(0).toUpperCase()}</span>;
}
