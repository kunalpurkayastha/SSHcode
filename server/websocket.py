"""Just enough RFC 6455 for the terminal channel: text and binary messages
both ways, fragmentation, ping/pong and close. Server side only."""
import base64
import hashlib
import struct
import threading

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
MAX_MESSAGE = 16 << 20


class Closed(Exception):
    pass


def upgrade(handler):
    """Answer the HTTP upgrade on a BaseHTTPRequestHandler; returns a WebSocket
    or None after sending an error."""
    key = handler.headers.get("Sec-WebSocket-Key", "")
    if handler.headers.get("Upgrade", "").lower() != "websocket" or not key:
        handler.send_error(400, "expected a WebSocket upgrade")
        return None
    accept = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
    # Written by hand: the stdlib handler would answer as HTTP/1.0.
    handler.wfile.write(("HTTP/1.1 101 Switching Protocols\r\n"
                         "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                         f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
    handler.wfile.flush()
    handler.close_connection = True
    return WebSocket(handler.rfile, handler.connection)


def _unmask(data, mask):
    n = len(data)
    if not n:
        return data
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")


class WebSocket:
    def __init__(self, rfile, sock):
        self.rfile, self.sock = rfile, sock
        self.wlock = threading.Lock()
        self.closed = False

    def _read(self, n):
        buf = self.rfile.read(n)
        if len(buf) < n:
            raise Closed()
        return buf

    def _frame(self):
        b0, b1 = self._read(2)
        fin, op = bool(b0 & 0x80), b0 & 0x0F
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read(8))[0]
        if n > MAX_MESSAGE:
            raise Closed()
        mask = self._read(4) if b1 & 0x80 else None
        data = self._read(n) if n else b""
        return fin, op, _unmask(data, mask) if mask else data

    def recv(self):
        """Next message: str for text, bytes for binary, None once closed."""
        kind, parts, size = None, [], 0
        while True:
            try:
                fin, op, data = self._frame()
            except (Closed, OSError, ValueError):
                self.closed = True
                return None
            if op == OP_PING:
                self._send(OP_PONG, data)
                continue
            if op == OP_PONG:
                continue
            if op == OP_CLOSE:
                self.close()
                return None
            if op in (OP_TEXT, OP_BIN):
                kind, parts, size = op, [], 0
            elif op != OP_CONT or kind is None:
                self.close(1002)
                return None
            parts.append(data)
            size += len(data)
            if size > MAX_MESSAGE:
                self.close(1009)
                return None
            if fin:
                msg = b"".join(parts)
                return msg.decode("utf-8", "replace") if kind == OP_TEXT else msg

    def _send(self, op, data):
        n = len(data)
        if n < 126:
            head = struct.pack(">BB", 0x80 | op, n)
        elif n < 1 << 16:
            head = struct.pack(">BBH", 0x80 | op, 126, n)
        else:
            head = struct.pack(">BBQ", 0x80 | op, 127, n)
        with self.wlock:
            if self.closed:
                raise Closed()
            try:
                self.sock.sendall(head + data)
            except OSError:
                self.closed = True
                raise Closed()

    def send_text(self, text):
        self._send(OP_TEXT, text.encode("utf-8"))

    def send_binary(self, data):
        self._send(OP_BIN, bytes(data))

    def close(self, code=1000):
        if self.closed:
            return
        try:
            self._send(OP_CLOSE, struct.pack(">H", code))
        except Closed:
            pass
        self.closed = True
