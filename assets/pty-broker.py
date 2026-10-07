#!/usr/bin/env python3
"""Run a shell inside a real pseudo-terminal, detached from Raycast.

Raycast extensions can only talk to child processes over pipes, which makes
programs think they're not in a terminal. This broker opens a pty, runs the
shell in it, and bridges it to files in a session directory so the session
outlives the Raycast window:

  <dir>/in    FIFO; bytes written here are typed into the terminal
  <dir>/out   append-only transcript of everything the terminal prints
  <dir>/pid   broker pid while the session is alive
  <dir>/exit  shell exit code, written when the session ends
  <dir>/size  "cols rows"; rewrite it and send SIGUSR1 to resize the terminal
  <dir>/tty   the terminal device, e.g. /dev/ttys012 (for finding the foreground job)
  <dir>/child the shell's pid (for finding its working directory)

usage: pty-broker.py <dir> <cols> <rows> <cwd> <shell> [args...]
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

MAX_OUT = 2 * 1024 * 1024  # rotate the transcript past this size
KEEP_OUT = 256 * 1024  # ...keeping this much of the tail


def main():
    session_dir, cols, rows, cwd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    argv = sys.argv[5:]
    in_path = os.path.join(session_dir, "in")
    out_path = os.path.join(session_dir, "out")

    def write(name, value):
        with open(os.path.join(session_dir, name), "w") as f:
            f.write(value)

    write("size", f"{cols} {rows}")
    pid, master = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        write("tty", os.ttyname(0))
        try:
            os.chdir(cwd)
        except OSError:
            pass
        os.execvp(argv[0], argv)

    # O_RDWR keeps the FIFO open even when no writer is attached, so we never see EOF.
    fifo = os.open(in_path, os.O_RDWR | os.O_NONBLOCK)
    out = open(out_path, "ab", buffering=0)

    write("pid", str(os.getpid()))
    write("child", str(pid))

    def hangup(*_):
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    def resize(*_):
        try:
            with open(os.path.join(session_dir, "size")) as f:
                c, r = (int(v) for v in f.read().split())
            # The kernel sends SIGWINCH to the foreground job for us.
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        except (OSError, ValueError):
            pass

    signal.signal(signal.SIGTERM, hangup)
    signal.signal(signal.SIGHUP, hangup)
    signal.signal(signal.SIGUSR1, resize)

    while True:
        try:
            ready, _, _ = select.select([master, fifo], [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno == errno.EIO:  # shell exited, slave side closed
                    break
                raise
            if not data:
                break
            out.write(data)
            if out.tell() > MAX_OUT:
                out.close()
                with open(out_path, "rb") as f:
                    f.seek(-KEEP_OUT, os.SEEK_END)
                    tail = f.read()
                with open(out_path, "wb") as f:
                    f.write(tail)
                out = open(out_path, "ab", buffering=0)
        if fifo in ready:
            try:
                data = os.read(fifo, 65536)
            except BlockingIOError:
                data = b""
            if data:
                os.write(master, data)

    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    write("exit", str(code))
    try:
        os.unlink(os.path.join(session_dir, "pid"))
    except FileNotFoundError:
        pass


if __name__ == "__main__":
    main()
