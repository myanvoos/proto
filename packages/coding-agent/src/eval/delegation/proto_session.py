"""Explicit session capabilities for ordinary Python 3.9+ programs; no dependencies."""

import base64
import http.client
import json
import math
import os
import re
import uuid
from urllib.parse import urlsplit

_MAX_BYTES = 4 * 1024 * 1024


class CapabilityError(RuntimeError):
    def __init__(self, message, code="transport"):
        super().__init__(message)
        self.code = code


class SessionClient:
    def __init__(self, config, timeout=60):
        url = urlsplit(config.get("url", ""))
        token = config.get("token")
        if (config.get("version") != 1 or url.scheme != "http"
                or url.hostname != "127.0.0.1" or not url.port
                or url.username or url.password or url.query or url.fragment
                or not re.fullmatch(r"/v1/delegation/[a-f0-9-]{36}", url.path)
                or not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token)):
            raise CapabilityError("Invalid session capability configuration", "config")
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise CapabilityError("timeout must be finite and positive", "config")
        self.__host = url.hostname
        self.__port = url.port
        self.__path = url.path.rstrip("/")
        self.__token = token
        self.__timeout = timeout

    @classmethod
    def from_env(cls, timeout=60):
        filename = os.environ.get("PROTO_SESSION_CAPABILITY")
        if not filename:
            raise CapabilityError("No explicitly delegated session capability", "config")
        try:
            with open(filename, "r", encoding="utf-8") as source:
                text = source.read(16385)
            if len(text) > 16384:
                raise ValueError("oversized config")
            return cls(json.loads(text), timeout=timeout)
        except (OSError, ValueError, TypeError, AttributeError):
            raise CapabilityError("Session capability configuration is unavailable", "config") from None

    def __repr__(self):
        return "SessionClient(capability=<redacted>)"

    def _request(self, operation, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(body) > 1024 * 1024:
            raise CapabilityError("Delegation request is too large", "size")
        connection = http.client.HTTPConnection(self.__host, self.__port, timeout=self.__timeout)
        try:
            connection.request("POST", self.__path + "/" + operation, body, {
                "Authorization": "Bearer " + self.__token,
                "Content-Type": "application/json",
            })
            response = connection.getresponse()
            content = response.read(_MAX_BYTES + 1)
            if len(content) > _MAX_BYTES:
                raise CapabilityError("Delegation response is too large", "size")
            try:
                result = json.loads(content)
            except (ValueError, UnicodeError):
                raise CapabilityError("Invalid delegation response", "protocol") from None
            if not isinstance(result, dict) or not result.get("ok"):
                raise CapabilityError(result.get("error", "Delegated request failed") if isinstance(result, dict)
                                      else "Invalid delegation response",
                                      result.get("code", "protocol") if isinstance(result, dict) else "protocol")
            return result.get("value")
        except (OSError, http.client.HTTPException):
            raise CapabilityError("Session capability connection failed", "transport") from None
        finally:
            connection.close()

    def call(self, name, args=None, *, request_id=None):
        """Call exactly one allowed tool; never retries or executes returned code."""
        return self._request("call", {"id": request_id or str(uuid.uuid4()), "name": name, "args": args if args is not None else {}})

    def cancel(self, request_id):
        """Cancel this lease's in-flight request; IDs do not address other leases."""
        return self._request("cancel", {"id": request_id})["cancelled"]

    def completion(self, prompt, *, model=None, system=None, schema=None):
        args = {"prompt": prompt}
        for key, value in (("model", model), ("system", system), ("schema", schema)):
            if value is not None:
                args[key] = value
        value = self.call("__completion__", args)
        return json.loads(value["text"]) if schema is not None else value["text"]

    def publish_artifact(self, value, **options):
        if isinstance(value, (bytes, bytearray, memoryview)):
            options = {**options, "kind": "binary", "encoding": "base64"}
            value = base64.b64encode(value).decode("ascii")
        return self.call("__runtime__", {"kind": "json", **options, "op": "artifact_publish", "value": value})

    def read_artifact(self, ref, **options):
        return self.call("__runtime__", {**options, "op": "artifact_read", "ref": ref})

    def resolve_artifact(self, ref):
        return self.call("__runtime__", {"op": "artifact_resolve", "ref": ref})


def from_env(timeout=60):
    return SessionClient.from_env(timeout=timeout)
