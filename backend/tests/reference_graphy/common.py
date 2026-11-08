"""Small validators and naming helpers shared by the terminal app and the local server."""

import math
from urllib.parse import urlsplit


def identifier(model):
    return f"{model['provider']}/{model['id']}"


def endpoint_url(url):
    parsed = urlsplit(url)
    _ = parsed.port  # Validate numeric port and range, even if the hostname is well formed.
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Use an HTTP(S) base URL without embedded credentials, query or fragment")
    return url.rstrip("/")


def validate_metadata(values):
    allowed = {"context", "max_output", "vision", "tools", "thinking_levels", "reasoning", "cost", "sampling", "strict_tools"}
    if not isinstance(values, dict) or set(values) - allowed:
        raise ValueError("Unsupported model metadata fields")
    for key in ("context", "max_output"):
        if key in values and (type(values[key]) is not int or values[key] <= 0):
            raise ValueError(f"{key} must be a positive integer")
    for key in ("vision", "tools", "reasoning", "strict_tools"):
        if key in values and type(values[key]) is not bool:
            raise ValueError(f"{key} must be true or false")
    if "thinking_levels" in values:
        levels = values["thinking_levels"]
        valid = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
        if (
            not isinstance(levels, list)
            or not levels
            or any(not isinstance(x, str) or x not in valid for x in levels)
        ):
            raise ValueError("thinking_levels must be a nonempty list of supported levels")
    if values.get("cost") is not None:
        cost = values["cost"]
        if (
            not isinstance(cost, dict)
            or not cost
            or set(cost) - {"input", "output", "cache_read", "cache_write"}
        ):
            raise ValueError("cost must contain valid USD-per-million token rates")
        if any(type(x) not in (int, float) or not math.isfinite(x) or x < 0 for x in cost.values()):
            raise ValueError("cost rates must be finite nonnegative numbers")
    if "sampling" in values and not isinstance(values["sampling"], dict):
        raise ValueError("sampling must be an object")
