"""Single-threaded CPython fork parent. No site, user imports, or runtime threads here."""
import json
import os
import select
import signal
import socket
import sys


def emit(value):
    print(json.dumps(value), flush=True)


def main():
    if sys.implementation.name != "cpython" or not hasattr(os, "fork"):
        emit({"type": "unsupported"})
        return
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(sys.argv[1])
    os.chmod(sys.argv[1], 0o600)
    listener.listen(32)
    children = set()
    server_pid = os.getpid()
    # Compile only: executing the runner would import asyncio/threading and violate fork safety.
    with open(sys.argv[2], encoding="utf-8") as source:
        runner = compile(source.read(), sys.argv[2], "exec")
    # Trusted standard library only; imports create no threads. Children share these pages COW.
    import ast, asyncio, base64, codecs, contextvars, importlib, inspect, io
    import itertools, locale, math, re, runpy, shlex, subprocess, sysconfig
    import threading, time, tokenize, traceback, types, weakref, pathlib, typing
    if threading.active_count() != 1:
        raise RuntimeError("Forkserver must remain single-threaded")
    emit({"type": "ready", "pid": os.getpid()})
    try:
        while True:
            for pid in tuple(children):
                ended, status = os.waitpid(pid, os.WNOHANG)
                if ended:
                    children.remove(pid)
                    emit({"type": "exit", "pid": pid, "code": os.waitstatus_to_exitcode(status)})
            readable, _, _ = select.select([listener, sys.stdin], [], [], 0.05)
            if sys.stdin in readable and not sys.stdin.buffer.readline():
                break
            if listener not in readable:
                continue
            connection, _ = listener.accept()
            # One bounded launch record, no buffered reader that could consume kernel frames.
            launch = bytearray()
            while not launch.endswith(b"\n") and len(launch) <= 1024 * 1024:
                piece = connection.recv(1)
                if not piece:
                    break
                launch.extend(piece)
            try:
                if len(launch) > 1024 * 1024:
                    raise ValueError("Forkserver launch record too large")
                request = json.loads(launch)
                if threading.active_count() != 1:
                    raise RuntimeError("Forkserver is no longer single-threaded")
                pid = os.fork()
            except Exception as error:
                connection.sendall((json.dumps({"error": str(error)}) + "\n").encode())
                connection.close()
                continue
            if pid:
                children.add(pid)
                connection.close()
                continue
            # Only the child may initialize site hooks, import libraries, or start threads.
            listener.close()
            try:
                os.setsid()
                parent = os.getppid()
                os.environ.clear()
                os.environ.update(request["env"])
                os.chdir(request["cwd"])
                connection.sendall((json.dumps({"pid": os.getpid(), "serverPid": parent}) + "\n").encode())
                os.dup2(connection.fileno(), 0)
                os.dup2(connection.fileno(), 1)
                connection.close()
                sys.stdin = open(0, encoding="utf-8", closefd=False)
                sys.stdout = open(1, "w", encoding="utf-8", buffering=1, closefd=False)
                sys.__stdin__ = sys.stdin
                sys.__stdout__ = sys.stdout
                # Recreate ordinary runtime paths only after fork. -I -S kept the parent sterile.
                sys.path[0:0] = [os.getcwd()] + [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
                import site
                site.main()
                import threading
                import time
                def parent_guard():
                    while os.getppid() == parent:
                        time.sleep(0.1)
                    os.killpg(os.getpgrp(), signal.SIGKILL)
                threading.Thread(target=parent_guard, daemon=True, name="proto-forkserver-owner").start()
                sys.argv = [sys.argv[2]]
                namespace = {"__name__": "__main__", "__file__": sys.argv[0], "__builtins__": __builtins__}
                exec(runner, namespace)
            except SystemExit:
                raise
            except BaseException:
                import traceback
                traceback.print_exc()
                os._exit(1)
            return
    finally:
        if os.getpid() == server_pid:
            listener.close()
            for pid in children:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for pid in children:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
            try:
                os.unlink(sys.argv[1])
            except FileNotFoundError:
                pass



if __name__ == "__main__":
    main()
