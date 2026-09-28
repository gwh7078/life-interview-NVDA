import re


def sanitize_text(value: str) -> str:
    value = re.sub(
        r"(?i)((?:authorization|proxy-authorization)[\"']?\s*[:=]\s*[\"']?Bearer\s+|Bearer\s+)([^\s\"',;&}]+)",
        lambda match: match.group(1) + "[REDACTED]",
        value,
    )
    value = re.sub(
        r"(?i)\b((?:[a-z0-9]+[_-])*?(?:api[_-]?key|token|password|secret))([\"']?\s*[=:]\s*)([\"'])(.*?)\3",
        lambda match: match.group(1) + match.group(2) + match.group(3)
        + "[REDACTED]" + match.group(3),
        value,
    )
    value = re.sub(
        r"(?i)\b((?:[a-z0-9]+[_-])*?(?:api[_-]?key|token|password|secret))([\"']?\s*[=:]\s*)([^\s,;&\"'}`]+)",
        lambda match: match.group(1) + match.group(2) + "[REDACTED]",
        value,
    )
    return re.sub(r"(?i)\b(?:nvapi-|sk-)[A-Za-z0-9_-]+\b", "[REDACTED]", value)
