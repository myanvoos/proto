"""Agent output selection through the authenticated host read protocol."""
from __future__ import annotations

import json
import re
from . import fs
from .helpers import _emit_status, tool


def _read_output(path):
    try:
        result = tool.read({"path": path})
    except RuntimeError as error:
        if re.search(r"(?:^|\n)(?:Error: )?Not found:", str(error)):
            raise FileNotFoundError(str(error)) from error
        raise
    if isinstance(result, str):
        return {"text": result}
    if not isinstance(result, dict) or not isinstance(result.get("text"), str):
        raise RuntimeError("Unexpected host read response for " + path)
    if result.get("hasError"):
        if re.search(r"(?:^|\n)(?:Error: )?Not found:", result["text"]):
            raise FileNotFoundError(result["text"])
        raise RuntimeError(result["text"])
    return result


def _output_source(output_id):
    protocol = "agent://" + output_id
    located = _read_output(protocol + ":raw:1-1")
    resolved = located.get("details", {}).get("resolvedPath")
    published = None
    if isinstance(resolved, str):
        try:
            published = fs.read_text(resolved)
        except RuntimeError as error:
            if "ENOENT" not in str(error) and "No such file" not in str(error):
                raise
        if published is not None:
            prefix = published.split("\n", 1)[0][:100]
            matches = located["text"].startswith(prefix) if prefix else located["text"] == ""
            if matches:
                return resolved, published, published
    return protocol, _read_output(protocol)["text"], published


def output(
    *ids: object,
    format: str = "raw",
    query: str | None = None,
    offset: int | None = None,
    limit: int | None = None,
) -> str | dict | list[dict]:
    """Read agent/task output by ID. This does not read bash artifacts.

    Args:
        *ids: Output IDs to read (e.g., ``'scout_0'``, ``'reviewer_1'``).
            IDs are coerced with ``str()`` so numbered IDs are accepted.
        format: ``'raw'`` (default) returns text as stored; ``'stripped'``
            removes ANSI color escapes; ``'json'`` returns metadata and
            content in a dictionary (or a list for multiple IDs).
        query: jq-style query on the output parsed as JSON (for example,
            ``'.endpoints[0].file'``). ``query`` is exclusive with
            ``offset``/``limit``.
        offset: Line number to start reading from (1-indexed).
        limit: Maximum number of lines to read.

    Returns:
        Single ID: str (``format='raw'``/``'stripped'``) or dict
        (``format='json'``). Multiple IDs: a list of dictionaries.

    Examples:
        output('scout_0')  # Read as raw text
        output('reviewer_0', format='json')  # Read with metadata
        output('scout_0', query='.files[0]')  # Extract a JSON field
        output('scout_0', offset=10, limit=20)  # Lines 10-29
        output('scout_0', 'reviewer_1')  # Read multiple outputs
    """
    if format not in ("raw", "json", "stripped"):
        _emit_status("output", error=f"Invalid format: {format!r}")
        raise ValueError(
            f"Invalid output format {format!r}; expected one of: raw, json, stripped"
        )
    output_ids = tuple(str(output_id) for output_id in ids)
    if not output_ids:
        _emit_status("output", error="No IDs provided")
        raise ValueError("At least one output ID is required")

    if query is not None and (offset is not None or limit is not None):
        _emit_status("output", error="query cannot be combined with offset/limit")
        raise ValueError("query cannot be combined with offset/limit")

    results: list[dict] = []
    not_found: list[str] = []
    missing_details: list[str] = []

    for output_id in output_ids:
        if re.fullmatch(r"artifact://\d+", output_id):
            not_found.append(output_id)
            missing_details.append("Use the host read tool for bash artifacts.")
            continue
        try:
            output_path, raw_content, published = _output_source(output_id)
        except FileNotFoundError as error:
            not_found.append(output_id)
            missing_details.append(str(error))
            continue
        raw_lines = raw_content.splitlines()
        total_lines = len(raw_lines)

        selected_content = raw_content
        range_info: dict | None = None

        if query:
            try:
                json_value = json.loads(published if published is not None else raw_content)
            except json.JSONDecodeError as e:
                _emit_status("output", id=output_id, error=f"Not valid JSON: {e}")
                raise ValueError(f"Output {output_id} is not valid JSON: {e}")

            result_value = _apply_query(json_value, query)
            try:
                selected_content = (
                    json.dumps(result_value, indent=2)
                    if result_value is not None
                    else "null"
                )
            except (TypeError, ValueError):
                selected_content = str(result_value)

        elif offset is not None or limit is not None:
            start_line = max(1, offset or 1)
            if start_line > total_lines:
                _emit_status(
                    "output",
                    id=output_id,
                    error=f"Offset {start_line} beyond end ({total_lines} lines)",
                )
                raise ValueError(
                    f"Offset {start_line} is beyond end of output ({total_lines} lines) for {output_id}"
                )

            effective_limit = (
                limit if limit is not None else total_lines - start_line + 1
            )
            end_line = min(total_lines, start_line + effective_limit - 1)
            selected_lines = raw_lines[start_line - 1 : end_line]
            selected_content = "\n".join(selected_lines)
            range_info = {
                "start_line": start_line,
                "end_line": end_line,
                "total_lines": total_lines,
            }

        if format == "stripped":
            selected_content = re.sub(r"\x1b\[[0-9;]*m", "", selected_content)

        if format == "json":
            result_data = {
                "id": output_id,
                "path": str(output_path),
                "line_count": total_lines
                if not query
                else len(selected_content.splitlines()),
                "char_count": len(raw_content)
                if not query
                else len(selected_content),
                "content": selected_content,
            }
            if range_info:
                result_data["range"] = range_info
            if query:
                result_data["query"] = query
            results.append(result_data)
        else:
            results.append({"id": output_id, "content": selected_content})

    if not_found:
        error_msg = (
            f"Agent/task output not found: {', '.join(not_found)}. "
            "output() reads an agent/task output id such as 'scout_0', not bash artifacts."
        )
        artifact_ids = [
            output_id
            for output_id in not_found
            if output_id.isdigit() or re.fullmatch(r"artifact://\d+", output_id)
        ]
        if artifact_ids:
            references = []
            for output_id in artifact_ids:
                artifact_number = output_id.removeprefix("artifact://")
                references.append(
                    f"read artifact://{artifact_number}:A-B or "
                    f'tool.read({{"path": "artifact://{artifact_number}:A-B"}})'
                )
            error_msg += " For bash artifact numbers, use " + "; ".join(references) + " instead."
        error_msg += "\n\n" + "\n".join(missing_details)
        _emit_status("output", not_found=not_found)
        raise FileNotFoundError(error_msg)

    if len(output_ids) == 1:
        if format == "json":
            _emit_status("output", id=output_ids[0], chars=results[0]["char_count"])
            return results[0]
        _emit_status("output", id=output_ids[0], chars=len(results[0]["content"]))
        return results[0]["content"]

    if format == "json":
        total_chars = sum(r["char_count"] for r in results)
        _emit_status("output", count=len(results), total_chars=total_chars)
        return results

    combined_output: list[dict] = []
    for r in results:
        combined_output.append({"id": r["id"], "content": r["content"]})
    total_chars = sum(len(r["content"]) for r in combined_output)
    _emit_status("output", count=len(combined_output), total_chars=total_chars)
    return combined_output

def _apply_query(data: object, query: str) -> object:
    """Apply jq-like query to data. Supports .key, [index], and chaining."""
    if not query:
        return data

    query = query.strip()
    if query.startswith("."):
        query = query[1:]
    if not query:
        return data

    tokens = []
    current_token = ""
    i = 0
    while i < len(query):
        ch = query[i]
        if ch == ".":
            if current_token:
                tokens.append(("key", current_token))
                current_token = ""
        elif ch == "[":
            if current_token:
                tokens.append(("key", current_token))
                current_token = ""
            j = i + 1
            while j < len(query) and query[j] != "]":
                j += 1
            bracket_content = query[i + 1 : j]
            if bracket_content.startswith('"') and bracket_content.endswith('"'):
                tokens.append(("key", bracket_content[1:-1]))
            else:
                tokens.append(("index", int(bracket_content)))
            i = j
        else:
            current_token += ch
        i += 1
    if current_token:
        tokens.append(("key", current_token))

    current = data
    for token_type, value in tokens:
        if token_type == "index":
            if not isinstance(current, list) or value >= len(current):
                return None
            current = current[value]
        elif token_type == "key":
            if not isinstance(current, dict) or value not in current:
                return None
            current = current[value]

    return current

