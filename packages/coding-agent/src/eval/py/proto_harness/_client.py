"""Authenticated requests to the host that owns this shell run."""
import os


class HarnessError(RuntimeError):
    def __init__(self, message, code="request"):
        super().__init__(message)
        self.code = code


def detect(info):
    """Best-effort tiny startup handshake; load no helper, SSL, or HTTP libraries."""
    import json
    import socket

    endpoint = os.environ.get("PI_PYTHON_HARNESS_URL", "")
    token = os.environ.get("PI_PYTHON_HARNESS_TOKEN", "")
    prefix = "http://127.0.0.1:"
    port, separator, tail = endpoint.removeprefix(prefix).partition("/")
    if (not endpoint.startswith(prefix) or not separator or tail != "request"
            or not port.isascii() or not port.isdigit() or not 0 < int(port) < 65536
            or len(token) != 72 or any(char not in "abcdef0123456789-" for char in token)):
        return
    body = json.dumps({"name": "_detect", "args": info}, ensure_ascii=True).encode("ascii")
    if len(body) > 16384:
        return
    headers = ("POST /request HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + token
               + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body))
               + "\r\nConnection: close\r\n\r\n").encode("ascii")
    with socket.create_connection(("127.0.0.1", int(port)), timeout=0.25) as connection:
        connection.sendall(headers + body)
        connection.recv(4096)


def request(name, args):
    return _request(name, args)


def request_stream(name, args):
    return _request(name, args, stream=True)


def _request(name, args, stream=False):
    transport = globals().get("_transport")
    if callable(transport):
        try:
            return transport(name, args)
        except HarnessError:
            raise
        except Exception as error:
            raise HarnessError(str(error)) from error
    import http.client
    import json
    from urllib.parse import urlsplit

    url = os.environ.get("PI_PYTHON_HARNESS_URL", "")
    token = os.environ.get("PI_PYTHON_HARNESS_TOKEN", "")
    if not url or not token:
        raise HarnessError("No active Python harness capability; run inside the agent shell", "authentication")
    endpoint = urlsplit(url)
    if (endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path != "/request"):
        raise HarnessError("Invalid Python harness endpoint", "authentication")
    payload = json.dumps({"name": name, "args": args, "cwd": os.getcwd(), "stream": stream}, ensure_ascii=True).encode("ascii")
    limit = (96 if name in ("store.get_graph", "store.put_graph") else 8) * 1024 * 1024
    if len(payload) > limit:
        raise HarnessError("Python harness request exceeds byte limit", "limit")
    connection = http.client.HTTPConnection("127.0.0.1", endpoint.port, timeout=None)
    try:
        connection.request("POST", endpoint.path, payload, {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        })
        response = connection.getresponse()
        if stream and response.status == 200:
            import base64
            import sys
            total = 0
            while True:
                raw = response.readline(8 * 1024 * 1024 + 1)
                total += len(raw)
                if len(raw) > 8 * 1024 * 1024 or total > 128 * 1024 * 1024:
                    raise HarnessError("Python harness stream exceeds byte limit", "limit")
                if not raw:
                    raise HarnessError("Python harness stream ended without a result", "protocol")
                frame = json.loads(raw)
                if "stream" in frame:
                    if frame["stream"] not in ("stdout", "stderr"):
                        raise HarnessError("Invalid Python harness stream", "protocol")
                    target = sys.stdout if frame["stream"] == "stdout" else sys.stderr
                    content = base64.b64decode(frame["data"], validate=True)
                    target.buffer.write(content)
                    target.buffer.flush()
                elif "error" in frame:
                    error = frame["error"]
                    raise HarnessError(error["message"], error.get("code", "request"))
                elif "value" in frame:
                    return frame["value"]
                else:
                    raise HarnessError("Invalid Python harness stream", "protocol")
        raw = response.read(limit + 1)
        if len(raw) > limit:
            raise HarnessError("Python harness response exceeds byte limit", "limit")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise HarnessError("Invalid Python harness response", "protocol") from error
        if not isinstance(result, dict):
            raise HarnessError("Invalid Python harness response", "protocol")
        if "error" in result:
            error = result["error"]
            raise HarnessError(error["message"], error.get("code", "request"))
        if response.status != 200 or "value" not in result:
            raise HarnessError("Invalid Python harness response", "protocol")
        return result["value"]
    except (OSError, http.client.HTTPException) as error:
        raise HarnessError("Python harness capability is unavailable or revoked: " + str(error), "authentication") from error
    finally:
        connection.close()
