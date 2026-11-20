#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Multi-MT5 Trade Copier - Central Engine (Windows production, No-EA edition)
===========================================================================

v2.0.0 architecture - NO Expert Advisor, NO MQL5 file, NO cloud service:

    MT5CopierEngine.exe  (this program; dashboard/API on 127.0.0.1:8321)
      |
      |-- spawns one bridge subprocess per MT5 terminal:
      |       MT5CopierEngine.exe --bridge <cfg.json>
      |     each bridge talks to its terminal through the OFFICIAL
      |     MetaTrader5 Python API (local IPC to terminal64.exe).
      |     Nothing is installed inside the terminals: no EA, no MQL5,
      |     no DLL, no chart template, no WebRequest permission.
      |
      |-- polls the MASTER terminal bridge, diffs consecutive snapshots into
      |     trade events (open / close / partial / SLTP / pending ...) and
      |     executes them on every SLAVE bridge via order_send().
      |
      |-- keeps the full ledger (terminals, positions, copy operations,
      |     metrics, logs) in a local SQLite database (db/mt5copier.db).
      |
      `-- serves the Persian RTL dashboard from ./ui (embedded in the EXE).

Local only: every socket binds 127.0.0.1. The only internet traffic is the
MT5 terminals' own connection to their broker. No cloud service involved.

Demo mode: start with COPIER_DEMO=1 to create simulated terminals and watch
the whole copy pipeline live without any MT5 installation (also used as the
built-in self-test of this engine).

Run:  python copier_engine.py          (or the packaged MT5CopierEngine.exe)
"""

import asyncio
import json
import os
import random
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import webbrowser
import zlib
from pathlib import Path

if getattr(sys, "frozen", False):
    # PyInstaller ONEFILE: writable data (db/) lives next to the EXE itself,
    # while the dashboard UI is embedded inside the binary (extracted to
    # _MEIPASS at runtime). COPIER_UI still overrides both cases.
    BASE = Path(sys.executable).resolve().parent
    UI_DIR = Path(os.environ.get("COPIER_UI", Path(getattr(sys, "_MEIPASS", BASE)) / "ui"))
else:
    BASE = Path(__file__).resolve().parent
    UI_DIR = Path(os.environ.get("COPIER_UI", BASE / "ui"))
DB_PATH = Path(os.environ.get("COPIER_DB", BASE / "db" / "mt5copier.db"))
HTTP_HOST = "127.0.0.1"
HTTP_PORT = int(os.environ.get("COPIER_HTTP_PORT", "8321"))
MASTER_POLL_MS = int(os.environ.get("COPIER_MASTER_POLL_MS", "150"))
SLAVE_POLL_MS = int(os.environ.get("COPIER_SLAVE_POLL_MS", "400"))
BRIDGE_READY_TIMEOUT = int(os.environ.get("COPIER_BRIDGE_TIMEOUT", "90"))

now_ms = lambda: int(time.time() * 1000)  # noqa: E731

# ----------------------------------------------------------------------------
# Database (SQLite, single writer; accessed from asyncio handlers which are
# all on one thread)
# ----------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '', broker TEXT DEFAULT '', server TEXT DEFAULT '',
  account_number TEXT DEFAULT '', currency TEXT DEFAULT 'USD',
  exe_path TEXT DEFAULT '', simulated INTEGER DEFAULT 0,
  role TEXT DEFAULT 'none', enabled INTEGER DEFAULT 1, paused INTEGER DEFAULT 0,
  status TEXT DEFAULT 'disconnected', auto_reconnect INTEGER DEFAULT 1,
  last_seen INTEGER DEFAULT 0, leverage INTEGER DEFAULT 100,
  balance REAL DEFAULT 10000, equity REAL DEFAULT 10000, floating_pl REAL DEFAULT 0,
  free_margin REAL DEFAULT 10000, margin_level REAL DEFAULT 0,
  closed_today INTEGER DEFAULT 0, reconnect_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS slave_settings (
  terminal_id TEXT PRIMARY KEY,
  lot_mode TEXT DEFAULT 'same', fixed_lot REAL DEFAULT 0.01,
  multiplier REAL DEFAULT 1, balance_ratio_cap REAL DEFAULT 5,
  risk_percent REAL DEFAULT 1,
  copy_sl INTEGER DEFAULT 1, copy_tp INTEGER DEFAULT 1,
  copy_modifications INTEGER DEFAULT 1, copy_partial_close INTEGER DEFAULT 1,
  copy_pending INTEGER DEFAULT 1, close_on_master_close INTEGER DEFAULT 1,
  max_spread_points INTEGER DEFAULT 100, max_lot REAL DEFAULT 100,
  max_positions INTEGER DEFAULT 50, slippage_points INTEGER DEFAULT 20,
  buy_enabled INTEGER DEFAULT 1, sell_enabled INTEGER DEFAULT 1,
  symbol_whitelist TEXT DEFAULT '', symbol_blacklist TEXT DEFAULT '',
  symbol_mapping TEXT DEFAULT '', sync_policy TEXT DEFAULT 'report',
  reject_probability REAL DEFAULT 0, base_latency_ms INTEGER DEFAULT 0,
  jitter_ms INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT, ticket TEXT, symbol TEXT, side TEXT DEFAULT 'buy',
  kind TEXT DEFAULT 'position', pending_type TEXT DEFAULT '',
  volume REAL, open_price REAL, current_price REAL DEFAULT 0,
  sl REAL DEFAULT 0, tp REAL DEFAULT 0, profit REAL DEFAULT 0,
  open_time INTEGER DEFAULT 0, master_ticket TEXT DEFAULT '',
  copied_by_engine INTEGER DEFAULT 0,
  UNIQUE(terminal_id, ticket)
);
CREATE TABLE IF NOT EXISTS closed_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT, ticket TEXT, symbol TEXT, side TEXT DEFAULT 'buy',
  kind TEXT DEFAULT 'position', pending_type TEXT DEFAULT '',
  volume REAL, open_price REAL, close_price REAL,
  sl REAL DEFAULT 0, tp REAL DEFAULT 0, profit REAL DEFAULT 0,
  open_time INTEGER DEFAULT 0, close_time INTEGER DEFAULT 0,
  close_reason TEXT DEFAULT 'manual', master_ticket TEXT DEFAULT '',
  UNIQUE(terminal_id, ticket)
);
CREATE TABLE IF NOT EXISTS copy_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  master_terminal_id TEXT, slave_terminal_id TEXT,
  master_ticket TEXT, slave_ticket TEXT DEFAULT '',
  action TEXT, event_key TEXT, status TEXT DEFAULT 'pending',
  fail_reason TEXT DEFAULT '', fail_code TEXT DEFAULT '',
  detected_at INTEGER DEFAULT 0, sent_at INTEGER DEFAULT 0,
  ack_at INTEGER DEFAULT 0, done_at INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0, total_ms INTEGER DEFAULT 0,
  payload TEXT DEFAULT '{}',
  UNIQUE(slave_terminal_id, event_key)
);
CREATE TABLE IF NOT EXISTS metric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, slave_terminal_id TEXT, master_ticket TEXT, action TEXT,
  detect_ms INTEGER DEFAULT 0, send_ms INTEGER DEFAULT 0, ack_ms INTEGER DEFAULT 0,
  total_ms INTEGER DEFAULT 0, ok INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, level TEXT, category TEXT,
  terminal_id TEXT DEFAULT '', terminal_name TEXT DEFAULT '',
  message TEXT, details TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  engine_running INTEGER DEFAULT 0, copy_enabled INTEGER DEFAULT 1,
  emergency_policy TEXT DEFAULT 'halt', sync_on_start TEXT DEFAULT 'report',
  master_auto_trade INTEGER DEFAULT 0, auto_trade_interval_ms INTEGER DEFAULT 9000,
  last_event_at INTEGER DEFAULT 0, booted_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_copy_ops_master ON copy_ops(master_ticket);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
"""

# Columns added in v2.0.0 (bridge connection data lives on the terminal row).
MIGRATE_COLUMNS = {
    "login": "TEXT DEFAULT ''",
    "password": "TEXT DEFAULT ''",
    "portable": "INTEGER DEFAULT 0",
    "magic": "INTEGER DEFAULT 0",
}


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.cx = sqlite3.connect(str(path), check_same_thread=False, timeout=15)
        self.cx.row_factory = sqlite3.Row
        try:
            self.cx.execute("PRAGMA busy_timeout=10000")
        except Exception:
            pass
        self.cx.executescript(SCHEMA)
        self.cx.commit()

    def q(self, sql, args=()):
        cur = self.cx.execute(sql, args)
        return [dict(r) for r in cur.fetchall()]

    def x(self, sql, args=()) -> int:
        cur = self.cx.execute(sql, args)
        self.cx.commit()
        return cur.lastrowid

    def one(self, sql, args=()):
        rows = self.q(sql, args)
        return rows[0] if rows else None


DB = Database(DB_PATH)


def migrate_schema():
    try:
        cols = {r["name"] for r in DB.q("PRAGMA table_info(terminals)")}
        for col, decl in MIGRATE_COLUMNS.items():
            if col not in cols:
                DB.x(f"ALTER TABLE terminals ADD COLUMN {col} {decl}")
    except Exception:
        pass


migrate_schema()

LOG_FILE = DB_PATH.parent / "engine.log"


def _append_engine_log(line: str) -> None:
    """Mirror logs to db\\engine.log (the only visible log in windowed builds)."""
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 1_500_000:
            data = LOG_FILE.read_text(encoding="utf-8", errors="replace")[-300_000:]
            LOG_FILE.write_text(data, encoding="utf-8")
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def log(level: str, category: str, message: str, terminal_id="", terminal_name="", details=""):
    try:
        DB.x(
            "INSERT INTO logs (ts, level, category, terminal_id, terminal_name, message, details) VALUES (?,?,?,?,?,?,?)",
            (now_ms(), level, category, terminal_id, terminal_name, message, details),
        )
    except Exception:
        pass
    try:
        _append_engine_log(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {level.upper():7} {category:10} {message}" + (f" | {details}" if details else ""))
    except Exception:
        pass
    try:
        print(f"[{time.strftime('%H:%M:%S')}] {level.upper():7} {category:10} {message}" + (f" | {details}" if details else ""), flush=True)
    except Exception:
        pass


# ----------------------------------------------------------------------------
# Settings helpers
# ----------------------------------------------------------------------------

def get_settings() -> dict:
    row = DB.one("SELECT * FROM app_settings WHERE id='singleton'")
    if not row:
        DB.x("INSERT OR IGNORE INTO app_settings (id, engine_running, booted_at) VALUES ('singleton', 1, ?)", (now_ms(),))
        row = DB.one("SELECT * FROM app_settings WHERE id='singleton'")
    return row


def ensure_slave_settings(terminal_id: str) -> dict:
    row = DB.one("SELECT * FROM slave_settings WHERE terminal_id=?", (terminal_id,))
    if not row:
        DB.x("INSERT OR IGNORE INTO slave_settings (terminal_id) VALUES (?)", (terminal_id,))
        row = DB.one("SELECT * FROM slave_settings WHERE terminal_id=?", (terminal_id,))
    return row


# ----------------------------------------------------------------------------
# Lot calculation + filters (mirror of the TypeScript reference engine)
# ----------------------------------------------------------------------------

def parse_mapping(mapping: str) -> dict:
    out = {}
    for part in (mapping or "").split(";"):
        part = part.strip()
        if "=" in part:
            a, b = part.split("=", 1)
            if a.strip() and b.strip():
                out[a.strip().upper()] = b.strip().upper()
    return out


def parse_csv(s: str):
    return [x.strip().upper() for x in (s or "").split(",") if x.strip()]


def floor_to_step(v: float, step: float) -> float:
    if step <= 0:
        return v
    return round(int(v / step + 1e-9) * step, 8)


def calc_volume(mode, master_volume, master_balance, slave_equity, s, sl_distance_points, spec):
    """Returns (volume, None) on success or (None, reason) on failure."""
    try:
        if mode == "fixed":
            v = float(s["fixed_lot"])
        elif mode == "multiplier":
            v = master_volume * float(s["multiplier"])
        elif mode == "balance":
            if master_balance <= 0:
                v = master_volume
            else:
                ratio = (slave_equity / master_balance) if slave_equity > 0 else 1.0
                ratio = max(1.0 / max(float(s["balance_ratio_cap"]), 0.01), min(float(s["balance_ratio_cap"]), ratio))
                v = master_volume * ratio
        elif mode == "risk":
            if sl_distance_points <= 0:
                v = master_volume
            else:
                value_per_price_unit_per_lot = spec["tickValue"] / max(spec["tickSize"], 1e-9)
                target = slave_equity * float(s["risk_percent"]) / 100.0
                dist_price = sl_distance_points * spec["point"]
                v = target / max(dist_price * value_per_price_unit_per_lot, 1e-9)
        else:  # same
            v = master_volume
        vmin, vmax, step = spec["volumeMin"], spec["volumeMax"], spec["volumeStep"]
        cap = min(vmax, float(s["max_lot"]) if s["max_lot"] else vmax)
        v = floor_to_step(v, step)
        v = min(max(v, 0.0), cap)
        if v < vmin:
            return None, f"Volume {v} below broker minimum {vmin}"
        return round(v, 8), None
    except Exception as e:  # pragma: no cover
        return None, f"lot calc error: {e}"


def check_filters(slave, s, symbol, side, kind, spec, open_count):
    if slave["role"] != "slave":
        return "role", "Terminal is not a slave"
    if not slave["enabled"]:
        return "disabled", "Slave copying is disabled"
    if slave["paused"]:
        return "paused", "Slave is paused"
    if slave["status"] != "connected":
        return "not_connected", f"Slave status is {slave['status']}"
    if side == "buy" and not s["buy_enabled"]:
        return "buy_disabled", "Buy copying disabled"
    if side == "sell" and not s["sell_enabled"]:
        return "sell_disabled", "Sell copying disabled"
    sym = symbol.upper()
    wl = parse_csv(s["symbol_whitelist"])
    if wl and sym not in wl:
        return "whitelist", f"Symbol {symbol} not in whitelist"
    if sym in parse_csv(s["symbol_blacklist"]):
        return "blacklist", f"Symbol {symbol} blacklisted"
    if spec and spec.get("spreadPoints", 0) > s["max_spread_points"]:
        return "spread", f"Spread {spec['spreadPoints']} > max {s['max_spread_points']}"
    if kind == "position" and open_count >= s["max_positions"]:
        return "max_positions", "Max positions reached"
    if kind == "pending" and not s["copy_pending"]:
        return "pending_disabled", "Pending copying disabled"
    if not spec:
        return "unknown_symbol", f"Symbol {symbol} not found on slave even after mapping"
    return None, None


# ============================================================================
# BRIDGE WORKERS (subprocess side)
# ============================================================================
# Each MT5 terminal gets its own bridge subprocess so that the MetaTrader5
# Python module (which is a per-process singleton) can attach to exactly one
# terminal64.exe. The engine talks to the worker over stdin/stdout with
# newline-delimited JSON. The real worker needs the official MetaTrader5
# package; the mock worker is pure Python and powers the demo/self-test mode.

def emit_json(obj: dict) -> None:
    """Write one JSON line to stdout (ASCII-safe) and flush; exit on broken pipe."""
    data = json.dumps(obj, ensure_ascii=True, default=str)
    try:
        sys.stdout.write(data + "\n")
        sys.stdout.flush()
    except Exception:
        raise SystemExit(0)


class WorkerFatal(Exception):
    """Raised by a bridge worker when it cannot start at all."""


WORKER_NOTIFY = None  # set by the active transport (socket); None = stdio


def worker_notify(obj: dict) -> None:
    """Send an unsolicited worker message (status/fatal) over the active transport."""
    fn = WORKER_NOTIFY
    if fn:
        try:
            fn(obj)
            return
        except Exception:
            pass
    emit_json(obj)


def running_terminal64_paths() -> set:
    """File paths of every RUNNING terminal64.exe process (Windows only).

    Used to ATTACH to terminals the user opened manually - the engine never
    launches MetaTrader by itself (mt5.initialize would silently start the
    terminal, so we always check the process list first).
    """
    if sys.platform != "win32":
        return set()
    try:
        import ctypes
        from ctypes import wintypes

        psapi = ctypes.WinDLL("Psapi.dll")
        k32 = ctypes.WinDLL("kernel32.dll")
        psapi.EnumProcesses.restype = wintypes.BOOL
        psapi.EnumProcesses.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.CloseHandle.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]

        arr = (wintypes.DWORD * 8192)()
        needed = wintypes.DWORD()
        if not psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(needed)):
            return set()
        count = min(needed.value // ctypes.sizeof(wintypes.DWORD), 8192)
        out = set()
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        for i in range(count):
            pid = arr[i]
            if not pid:
                continue
            h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h:
                continue
            try:
                buf = ctypes.create_unicode_buffer(2048)
                size = wintypes.DWORD(2048)
                if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                    p = buf.value
                    if p.lower().endswith("terminal64.exe"):
                        out.add(p)
            finally:
                k32.CloseHandle(h)
        return out
    except Exception:
        return set()


def _serve_stdio(dispatch, make_ready) -> int:
    """Serve the engine over stdin/stdout (dev/test fallback transport)."""
    global WORKER_NOTIFY
    WORKER_NOTIFY = None
    try:
        ready = make_ready()
    except WorkerFatal as e:
        emit_json({"type": "fatal", "error": str(e)})
        return 3
    emit_json({"type": "ready", **ready})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        try:
            res = dispatch(req)
        except SystemExit:
            raise
        except Exception as e:  # keep the worker alive on single-command errors
            res = {"ok": False, "code": "worker_exception", "error": f"{type(e).__name__}: {e}"}
        res.setdefault("type", "ack")
        res["eventKey"] = req.get("eventKey", "")
        emit_json(res)
    return 0


def _serve_socket(cfg, dispatch, make_ready) -> int:
    """Serve the engine over loopback TCP (newline-delimited JSON).

    A console-free (windowed) PyInstaller build has no usable stdio handles,
    so the child process connects BACK to the engine's IPC listener,
    authenticates with a one-time token and speaks exactly the same
    newline-JSON protocol as the stdio transport.
    """
    global WORKER_NOTIFY
    import socket as _sock
    port = int(cfg.get("ipcPort") or 0)
    token = str(cfg.get("ipcToken") or "")
    if port <= 0:
        return _serve_stdio(dispatch, make_ready)
    sock = None
    deadline = time.time() + 30
    last_err = ""
    while sock is None:
        try:
            sock = _sock.create_connection(("127.0.0.1", port), timeout=10)
        except OSError as e:
            last_err = str(e)
            if time.time() > deadline:
                emit_json({"type": "fatal", "error": f"cannot reach engine IPC listener: {last_err}"})
                return 3
            time.sleep(0.25)

    def _send(obj: dict) -> None:
        sock.sendall(json.dumps(obj, ensure_ascii=True, default=str).encode() + b"\n")

    WORKER_NOTIFY = _send
    try:
        # authenticate first, then let make_ready() stream live status updates
        # (e.g. "waiting" while the user has not opened the terminal yet)
        _send({"type": "hello", "token": token})
        try:
            ready = make_ready()
        except WorkerFatal as e:
            _send({"type": "fatal", "error": str(e)})
            return 3
        _send({"type": "ready", "token": token, **ready})
        buf = b""
        while True:
            try:
                chunk = sock.recv(65536)
            except OSError:
                return 0
            if not chunk:
                return 0  # engine closed the connection -> exit quietly
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line.decode("utf-8", "replace"))
                except Exception:
                    continue
                try:
                    res = dispatch(req)
                except SystemExit:
                    raise
                except Exception as e:
                    res = {"ok": False, "code": "worker_exception", "error": f"{type(e).__name__}: {e}"}
                res.setdefault("type", "ack")
                res["eventKey"] = req.get("eventKey", "")
                _send(res)
    finally:
        WORKER_NOTIFY = None
        try:
            sock.close()
        except Exception:
            pass
    return 0


class BaseBridgeWorker:
    """Shared plumbing for the real MT5 worker and the simulated worker."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.magic = int(cfg.get("magic") or 0)

    def _norm_pos(self, ticket, symbol, side, volume, open_price, current_price, sl, tp, profit, open_time, comment):
        return {
            "ticket": str(ticket), "symbol": symbol, "side": side, "kind": "position",
            "pendingType": "", "volume": float(volume), "openPrice": float(open_price),
            "currentPrice": float(current_price), "sl": float(sl), "tp": float(tp),
            "profit": float(profit), "openTime": int(open_time), "comment": comment or "",
        }

    def _norm_pend(self, ticket, symbol, side, ptype, volume, price, sl, tp, open_time, comment):
        return {
            "ticket": str(ticket), "symbol": symbol, "side": side, "kind": "pending",
            "pendingType": ptype, "volume": float(volume), "openPrice": float(price),
            "currentPrice": float(price), "sl": float(sl), "tp": float(tp),
            "profit": 0.0, "openTime": int(open_time), "comment": comment or "",
        }


class Mt5Worker(BaseBridgeWorker):
    """Bridge to one real MetaTrader 5 terminal via the official Python API.

    Requires only a running/installable terminal64.exe - no EA, no MQL5 file.
    If the terminal connection drops mid-session the worker reports the loss
    and exits; the engine supervisor respawns it with a backoff.
    """

    RETCODE_TEXT = {
        10004: "requote", 10006: "broker rejected the request", 10007: "cancelled by trader",
        10008: "placed", 10009: "done", 10010: "done_partial", 10011: "request error",
        10012: "cancelled by timeout", 10013: "invalid request", 10014: "invalid volume",
        10015: "invalid price", 10016: "invalid stops (SL/TP too close)", 10017: "trading disabled",
        10018: "market closed", 10019: "not enough money", 10020: "price changed",
        10021: "off quotes", 10022: "invalid expiration", 10023: "order state changed",
        10024: "too many requests", 10026: "AutoTrading disabled in this terminal (enable the AutoTrading button)",
        10027: "AutoTrading disabled for this account/terminal", 10028: "order locking disabled",
        10029: "freeze level reached", 10030: "unsupported filling mode", 10031: "broker connection lost",
        10033: "limit of pending orders reached", 10034: "limit of orders/volume reached",
        10038: "close volume too large", 10044: "only opposite position close allowed",
    }

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        import MetaTrader5 as mt5  # official MetaQuotes package (Windows only)
        self.mt5 = mt5
        self.OT = {
            mt5.ORDER_TYPE_BUY: ("buy", ""), mt5.ORDER_TYPE_SELL: ("sell", ""),
            mt5.ORDER_TYPE_BUY_LIMIT: ("buy", "buy_limit"), mt5.ORDER_TYPE_SELL_LIMIT: ("sell", "sell_limit"),
            mt5.ORDER_TYPE_BUY_STOP: ("buy", "buy_stop"), mt5.ORDER_TYPE_SELL_STOP: ("sell", "sell_stop"),
        }
        self.PT = {
            "buy_limit": mt5.ORDER_TYPE_BUY_LIMIT, "sell_limit": mt5.ORDER_TYPE_SELL_LIMIT,
            "buy_stop": mt5.ORDER_TYPE_BUY_STOP, "sell_stop": mt5.ORDER_TYPE_SELL_STOP,
        }

    # -- connection ---------------------------------------------------------

    def _err(self) -> str:
        try:
            return "; ".join(str(x) for x in self.mt5.last_error() if x) or "unknown mt5 error"
        except Exception:
            return "unknown mt5 error"

    def init_terminal(self) -> bool:
        kw = {"timeout": 60000}
        p = str(self.cfg.get("exePath") or "").strip()
        if p:
            kw["path"] = p
        if self.cfg.get("portable"):
            kw["portable"] = True
        login = str(self.cfg.get("login") or "").strip()
        if login:
            kw.update({
                "login": int(login),
                "password": str(self.cfg.get("password") or ""),
                "server": str(self.cfg.get("server") or "").strip(),
            })
        try:
            return bool(self.mt5.initialize(**kw))
        except Exception:
            return False

    def account_msg(self):
        try:
            a = self.mt5.account_info()
            t = self.mt5.terminal_info()
        except Exception:
            return None
        if not a or not t:
            return None
        return {
            "account": str(a.login), "broker": a.company or "", "server": a.server or "",
            "currency": a.currency or "USD", "leverage": int(a.leverage or 100),
            "balance": float(a.balance), "equity": float(a.equity),
            "floatingPL": float(a.profit or 0), "freeMargin": float(a.margin_free or 0),
            "marginLevel": float(a.margin_level or 0),
            "name": getattr(t, "name", "") or "", "build": int(getattr(t, "build", 0) or 0),
        }

    def alive(self) -> bool:
        try:
            return self.mt5.terminal_info() is not None
        except Exception:
            return False

    # -- normalization -------------------------------------------------------

    def norm_pos(self, p) -> dict:
        return self._norm_pos(
            p.ticket, p.symbol, "buy" if int(p.type) == 0 else "sell", float(p.volume),
            float(p.price_open), float(p.price_current), float(p.sl), float(p.tp),
            float(p.profit), int(p.time) * 1000, p.comment,
        )

    def norm_ord(self, o) -> dict:
        side, ptype = self.OT.get(int(o.type), ("buy", "buy_limit"))
        vol = float(getattr(o, "volume_current", 0) or o.volume)
        return self._norm_pend(
            o.ticket, o.symbol, side, ptype, vol, float(o.price_open),
            float(o.sl), float(o.tp), int(o.time_setup or 0) * 1000, o.comment,
        )

    # -- helpers --------------------------------------------------------------

    def pick_filling(self, si):
        mt5 = self.mt5
        flags = int(getattr(si, "filling_mode", 0) or 0)
        if flags & 1:
            return mt5.ORDER_FILLING_FOK
        if flags & 2:
            return mt5.ORDER_FILLING_IOC
        return mt5.ORDER_FILLING_RETURN

    def ensure_symbol(self, symbol):
        mt5 = self.mt5
        si = mt5.symbol_info(symbol)
        if si is None:
            try:
                mt5.symbol_select(symbol, True)
            except Exception:
                pass
            si = mt5.symbol_info(symbol)
        return si

    def send_request(self, req: dict):
        res = self.mt5.order_send(req)
        if res is None:
            return {"ok": False, "code": "no_response", "error": self._err()}
        ret = int(res.retcode)
        if ret in (10008, 10009, 10010):  # PLACED / DONE / DONE_PARTIAL
            return {"ok": True, "retcode": ret, "order": str(res.order or ""),
                    "deal": str(res.deal or ""), "price": float(res.price or 0), "res": res}
        text = self.RETCODE_TEXT.get(ret, f"broker retcode {ret}")
        detail = getattr(res, "comment", "") or ""
        return {"ok": False, "retcode": ret, "code": f"retcode_{ret}", "error": f"{text}{(' - ' + detail) if detail else ''}"}

    def _dead_check(self, payload):
        if not self.alive():
            worker_notify({"type": "status", "status": "reconnecting", "error": self._err()})
            raise SystemExit(1)
        return payload

    # -- commands --------------------------------------------------------------

    def snapshot_payload(self, event_key="") -> dict:
        acc = self.account_msg()
        if not acc:
            return self._dead_check({"ok": False, "code": "no_account", "error": self._err()})
        mt5 = self.mt5
        poses = mt5.positions_get() or []
        ords = mt5.orders_get() or []
        prices = {}
        for p in list(poses)[:40] + list(ords)[:40]:
            s = p.symbol
            if s in prices:
                continue
            tick = mt5.symbol_info_tick(s)
            if tick and tick.bid:
                prices[s] = {"bid": float(tick.bid), "ask": float(tick.ask)}
        return {
            "ok": True, "snapshot": True,
            "positions": [self.norm_pos(x) for x in poses],
            "pending": [self.norm_ord(x) for x in ords],
            "prices": prices,
            **acc,
        }

    def do_symbol_spec(self, req) -> dict:
        s = str(req.get("symbol") or "")
        si = self.ensure_symbol(s)
        if si is None:
            return {"ok": False, "code": "unknown_symbol", "error": f"symbol {s} not found on this terminal"}
        tick = self.mt5.symbol_info_tick(s)
        point = float(si.point or 0.00001)
        spread = int(getattr(si, "spread", 0) or 0)
        if tick and tick.bid and tick.ask and point:
            spread = int(round((tick.ask - tick.bid) / point))
        return {"ok": True, "spec": {
            "symbol": s, "point": point, "digits": int(getattr(si, "digits", 5) or 5),
            "tickValue": float(getattr(si, "trade_tick_value", 0) or 1.0),
            "tickSize": float(getattr(si, "trade_tick_size", 0) or point),
            "volumeMin": float(si.volume_min or 0.01), "volumeMax": float(si.volume_max or 100),
            "volumeStep": float(si.volume_step or 0.01), "spreadPoints": spread,
            "bid": float(tick.bid) if tick else 0.0, "ask": float(tick.ask) if tick else 0.0,
        }}

    def do_open(self, c) -> dict:
        mt5 = self.mt5
        symbol = str(c.get("symbol") or "")
        si = self.ensure_symbol(symbol)
        if si is None:
            return {"ok": False, "code": "unknown_symbol", "error": f"symbol {symbol} not found on this terminal"}
        tick = mt5.symbol_info_tick(symbol)
        if not tick or not tick.ask or not tick.bid:
            return self._dead_check({"ok": False, "code": "no_price", "error": f"no tick for {symbol}"})
        side = "buy" if c.get("side", "buy") == "buy" else "sell"
        otype = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        price = float(tick.ask if side == "buy" else tick.bid)
        comment = ("MC:open:" + str(c.get("masterTicket") or ""))[:31]
        req = {
            "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol,
            "volume": float(c.get("volume") or 0), "type": otype, "price": price,
            "sl": float(c.get("sl") or 0), "tp": float(c.get("tp") or 0),
            "deviation": int(c.get("deviation") or 20), "magic": self.magic,
            "comment": comment, "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self.pick_filling(si),
        }
        r = self.send_request(req)
        if not r.get("ok"):
            return {k: v for k, v in r.items() if k != "res"}
        res = r["res"]
        ticket = str(res.order or "")
        try:
            pos = mt5.positions_get(ticket=res.order)
            if pos:
                ticket = str(pos[0].ticket)
            else:
                mc = ("MC:open:" + str(c.get("masterTicket") or ""))[:31]
                cands = [x for x in (mt5.positions_get(symbol=symbol) or []) if x.comment == mc]
                if cands:
                    ticket = str(cands[-1].ticket)
        except Exception:
            pass
        return {"ok": True, "ticket": ticket, "price": float(res.price or price), "retcode": r.get("retcode")}

    def _close_inner(self, c, volume) -> dict:
        mt5 = self.mt5
        ticket = int(c.get("ticket") or 0)
        pos_list = mt5.positions_get(ticket=ticket)
        if not pos_list:
            return self._dead_check({"ok": False, "code": "position_not_found",
                                     "error": "position not found (maybe already closed)"})
        p = pos_list[0]
        si = self.ensure_symbol(p.symbol)
        if si is None:
            return {"ok": False, "code": "unknown_symbol", "error": f"symbol {p.symbol} missing"}
        tick = mt5.symbol_info_tick(p.symbol)
        if not tick or not tick.ask or not tick.bid:
            return self._dead_check({"ok": False, "code": "no_price", "error": f"no tick for {p.symbol}"})
        side = "sell" if int(p.type) == 0 else "buy"
        otype = mt5.ORDER_TYPE_SELL if side == "sell" else mt5.ORDER_TYPE_BUY
        price = float(tick.ask if side == "buy" else tick.bid)
        vol = float(p.volume if volume is None else min(float(volume), float(p.volume)))
        if vol <= 0:
            return {"ok": False, "code": "invalid_volume", "error": "close volume <= 0"}
        req = {
            "action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": vol,
            "type": otype, "position": int(p.ticket), "price": price,
            "deviation": int(c.get("deviation") or 20), "magic": self.magic,
            "comment": "MC:close", "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self.pick_filling(si),
        }
        r = self.send_request(req)
        if not r.get("ok"):
            return {k: v for k, v in r.items() if k != "res"}
        return {"ok": True, "ticket": str(p.ticket), "price": float(r["res"].price or price)}

    def do_close(self, c) -> dict:
        return self._close_inner(c, None)

    def do_partial(self, c) -> dict:
        return self._close_inner(c, float(c.get("volume") or 0))

    def do_modify(self, c) -> dict:
        mt5 = self.mt5
        symbol = str(c.get("symbol") or "")
        req = {
            "action": mt5.TRADE_ACTION_SLTP, "position": int(c.get("ticket") or 0),
            "symbol": symbol, "sl": float(c.get("sl") or 0), "tp": float(c.get("tp") or 0),
        }
        r = self.send_request(req)
        return {k: v for k, v in r.items() if k != "res"} if not r.get("ok") else {"ok": True}

    def do_place(self, c) -> dict:
        mt5 = self.mt5
        symbol = str(c.get("symbol") or "")
        si = self.ensure_symbol(symbol)
        if si is None:
            return {"ok": False, "code": "unknown_symbol", "error": f"symbol {symbol} not found on this terminal"}
        ptype = str(c.get("pendingType") or "buy_limit").lower()
        otype = self.PT.get(ptype)
        if otype is None:
            return {"ok": False, "code": "invalid_pending_type", "error": f"unknown pending type {ptype}"}
        comment = ("MC:open:" + str(c.get("masterTicket") or ""))[:31]
        req = {
            "action": mt5.TRADE_ACTION_PENDING, "symbol": symbol,
            "volume": float(c.get("volume") or 0), "type": otype,
            "price": float(c.get("price") or 0),
            "sl": float(c.get("sl") or 0), "tp": float(c.get("tp") or 0),
            "magic": self.magic, "comment": comment, "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_RETURN,
        }
        r = self.send_request(req)
        if not r.get("ok"):
            return {k: v for k, v in r.items() if k != "res"}
        res = r["res"]
        return {"ok": True, "ticket": str(res.order or ""), "price": float(res.price or 0)}

    def do_cancel(self, c) -> dict:
        mt5 = self.mt5
        req = {"action": mt5.TRADE_ACTION_REMOVE, "order": int(c.get("ticket") or 0)}
        r = self.send_request(req)
        return {k: v for k, v in r.items() if k != "res"} if not r.get("ok") else {"ok": True}

    def dispatch(self, req) -> dict:
        kind = req.get("kind")
        if kind == "ping":
            return {"ok": True, "pong": True, "at": now_ms()}
        if kind == "snapshot":
            return self.snapshot_payload()
        if kind == "account":
            acc = self.account_msg()
            if not acc:
                return self._dead_check({"ok": False, "code": "no_account", "error": self._err()})
            return {"ok": True, **acc}
        if kind == "symbol_spec":
            return self.do_symbol_spec(req)
        if kind == "tick":
            return self.do_tick(req)
        if kind == "open":
            return self.do_open(req)
        if kind == "close":
            return self.do_close(req)
        if kind == "partial":
            return self.do_partial(req)
        if kind == "modify_sltp":
            return self.do_modify(req)
        if kind == "place_pending":
            return self.do_place(req)
        if kind == "cancel_pending":
            return self.do_cancel(req)
        return {"ok": False, "code": "unknown_kind", "error": f"unknown command {kind}"}

    def notify_status(self, status: str, error: str = "") -> None:
        try:
            worker_notify({"type": "status", "status": status, "error": error})
        except Exception:
            pass

    def _terminal_process_running(self) -> bool:
        """True when THIS terminal (or, if no path is known, any terminal64) is running."""
        exe = str(self.cfg.get("exePath") or "").strip()
        paths = running_terminal64_paths()
        if not exe:
            return bool(paths)
        want = _normalize_exe(exe)
        return any(_normalize_exe(p) == want for p in paths)

    def make_ready(self) -> dict:
        # ATTACH-ONLY policy: the engine never starts MetaTrader by itself.
        # mt5.initialize() would silently LAUNCH terminal64.exe if it is not
        # running, so we wait until the user opens the terminal manually.
        notified_waiting = False
        while not self._terminal_process_running():
            if not notified_waiting:
                self.notify_status("waiting", "MetaTrader is not running - open the terminal manually to connect")
                notified_waiting = True
            time.sleep(3.0)
        self.notify_status("connecting")
        ok = False
        for _ in range(6):
            if self.init_terminal():
                ok = True
                break
            time.sleep(2.0)
        if not ok:
            raise WorkerFatal(f"mt5.initialize failed: {self._err()}")
        acc = self.account_msg()
        if not acc:
            raise WorkerFatal(f"terminal started but account is not ready: {self._err()}")
        return acc

    def do_tick(self, req) -> dict:
        """Fresh bid/ask for one symbol (used to scale SL/TP at copy time)."""
        s = str(req.get("symbol") or "")
        try:
            t = self.mt5.symbol_info_tick(s)
        except Exception:
            t = None
        if not t or not t.bid or not t.ask:
            return {"ok": False, "code": "no_price", "error": f"no tick for {s}"}
        return {"ok": True, "bid": float(t.bid), "ask": float(t.ask)}

    def on_exit(self) -> None:
        try:
            self.mt5.shutdown()
        except Exception:
            pass


class MockTerminal(BaseBridgeWorker):
    """Fully local simulated MT5 terminal - demo mode + engine self-test.

    Speaks the exact same JSON command surface as Mt5Worker, so the whole
    copy pipeline (snapshot diff -> copy handlers -> order execution) is
    exercised end-to-end without any MetaTrader installation.
    """

    SPECS = {
        "EURUSD": {"point": 0.00001, "digits": 5, "tickValue": 1.0, "tickSize": 0.00001,
                   "volumeMin": 0.01, "volumeMax": 100.0, "volumeStep": 0.01,
                   "spreadPoints": 14, "contract": 100000.0, "start": 1.08650, "vol": 0.00012},
        "GBPUSD": {"point": 0.00001, "digits": 5, "tickValue": 1.0, "tickSize": 0.00001,
                   "volumeMin": 0.01, "volumeMax": 100.0, "volumeStep": 0.01,
                   "spreadPoints": 18, "contract": 100000.0, "start": 1.26500, "vol": 0.00015},
        "XAUUSD": {"point": 0.01, "digits": 2, "tickValue": 1.0, "tickSize": 0.01,
                   "volumeMin": 0.01, "volumeMax": 50.0, "volumeStep": 0.01,
                   "spreadPoints": 30, "contract": 100.0, "start": 2352.00, "vol": 0.35},
    }

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        # unseeded => different demo behaviour on every run
        self.rnd = random.Random()
        self.prices = {s: float(spec["start"]) for s, spec in self.SPECS.items()}
        self.positions = {}   # ticket -> normalized position dict
        self.orders = {}      # ticket -> normalized pending dict
        self.balance = float(cfg.get("demoBalance") or 10000.0)
        self.next_ticket = 300000 + (zlib.crc32(str(cfg.get("terminalId") or "mock").encode()) % 400000)
        self.act = bool(cfg.get("act"))
        self._last_walk = 0.0
        self._next_act = time.time() + self.rnd.uniform(5, 12)

    # -- market simulation -----------------------------------------------------

    def walk(self):
        now = time.time()
        if now - self._last_walk < 0.8:
            return
        self._last_walk = now
        for s, spec in self.SPECS.items():
            drift = self.rnd.uniform(-1, 1) * spec["vol"]
            self.prices[s] = max(spec["point"], self.prices[s] + drift)
        for p in self.positions.values():
            spec = self.SPECS.get(p["symbol"])
            if not spec:
                continue
            px = self.prices[p["symbol"]]
            p["currentPrice"] = round(px, spec["digits"])
            direction = 1 if p["side"] == "buy" else -1
            p["profit"] = round((px - p["openPrice"]) * direction * p["volume"] * spec["contract"], 2)

    def floating(self) -> float:
        return round(sum(p["profit"] for p in self.positions.values()), 2)

    def equity(self) -> float:
        return round(self.balance + self.floating(), 2)

    def account_msg(self) -> dict:
        return {
            "account": str(99000 + (zlib.crc32(str(self.cfg.get("terminalId") or "x").encode()) % 8000)),
            "broker": "Demo Broker (simulated)", "server": "Demo-Server",
            "currency": "USD", "leverage": 100, "balance": round(self.balance, 2),
            "equity": self.equity(), "floatingPL": self.floating(),
            "freeMargin": round(self.equity(), 2), "marginLevel": 0.0,
            "name": "Mock Terminal", "build": 0,
        }

    def prices_payload(self) -> dict:
        out = {}
        for s, spec in self.SPECS.items():
            half = spec["point"] * spec["spreadPoints"] / 2.0
            out[s] = {"bid": round(self.prices[s] - half, spec["digits"]),
                      "ask": round(self.prices[s] + half, spec["digits"])}
        return out

    # -- random master behaviour (so the engine has real events to copy) -------

    def step_actor(self):
        if not self.act or time.time() < self._next_act:
            return
        self._next_act = time.time() + self.rnd.uniform(9, 20)
        r = self.rnd.random()
        try:
            if not self.positions and not self.orders:
                self.actor_open()
            elif self.orders and r > 0.55:
                self.actor_cancel()
            elif r < 0.32 and len(self.positions) < 6:
                self.actor_open()
            elif r < 0.47 and self.positions:
                self.actor_partial()
            elif r < 0.58 and self.positions:
                self.actor_modify()
            elif r < 0.72 and self.positions:
                self.actor_close()
            elif len(self.orders) < 3:
                self.actor_pending()
            elif self.positions:
                self.actor_close()
        except Exception:
            pass

    def actor_open(self):
        s = self.rnd.choice(list(self.SPECS))
        spec = self.SPECS[s]
        side = self.rnd.choice(["buy", "sell"])
        vol = self.rnd.choice([0.10, 0.20, 0.30, 0.50])
        px = round(self.prices[s], spec["digits"])
        sl = tp = 0.0
        dist = spec["vol"] * self.rnd.randint(20, 60) + spec["point"] * 100
        if self.rnd.random() < 0.6:
            sl = round(px - dist if side == "buy" else px + dist, spec["digits"])
            tp = round(px + 2 * dist if side == "buy" else px - 2 * dist, spec["digits"])
        t = str(self.next_ticket)
        self.next_ticket += 1
        self.positions[t] = {
            "ticket": t, "symbol": s, "side": side, "kind": "position", "pendingType": "",
            "volume": vol, "openPrice": px, "currentPrice": px, "sl": sl, "tp": tp,
            "profit": 0.0, "openTime": now_ms(), "comment": "",
        }

    def actor_partial(self):
        t = self.rnd.choice(list(self.positions))
        p = self.positions[t]
        part = max(0.01, round(p["volume"] * self.rnd.uniform(0.3, 0.6), 2))
        p["volume"] = round(p["volume"] - part, 2)
        if p["volume"] < 0.01:
            del self.positions[t]

    def actor_modify(self):
        t = self.rnd.choice(list(self.positions))
        p = self.positions[t]
        spec = self.SPECS[p["symbol"]]
        px = self.prices[p["symbol"]]
        dist = spec["vol"] * self.rnd.randint(15, 45)
        if self.rnd.random() < 0.5:
            p["sl"] = round(px - dist if p["side"] == "buy" else px + dist, spec["digits"])
        else:
            p["tp"] = round(px + dist * 2 if p["side"] == "buy" else px - dist * 2, spec["digits"])

    def actor_close(self):
        t = self.rnd.choice(list(self.positions))
        p = self.positions.pop(t)
        self.balance = round(self.balance + p["profit"], 2)

    def actor_pending(self):
        s = self.rnd.choice(list(self.SPECS))
        spec = self.SPECS[s]
        side = self.rnd.choice(["buy", "sell"])
        ptype = self.rnd.choice(["buy_limit", "sell_limit", "buy_stop", "sell_stop"])
        if side == "buy":
            ptype = "buy_limit" if self.rnd.random() < 0.6 else "buy_stop"
        else:
            ptype = "sell_limit" if self.rnd.random() < 0.6 else "sell_stop"
        px = self.prices[s]
        off = spec["vol"] * self.rnd.randint(10, 40)
        price = round(px - off if "limit" in ptype else px + off, spec["digits"])
        if side == "buy":
            price = round(px + off if "stop" in ptype else price, spec["digits"])
        t = str(self.next_ticket)
        self.next_ticket += 1
        self.orders[t] = {
            "ticket": t, "symbol": s, "side": side, "kind": "pending", "pendingType": ptype,
            "volume": self.rnd.choice([0.10, 0.30]), "openPrice": price, "currentPrice": price,
            "sl": 0.0, "tp": 0.0, "profit": 0.0, "openTime": now_ms(), "comment": "",
        }

    def actor_cancel(self):
        t = self.rnd.choice(list(self.orders))
        self.orders.pop(t, None)

    # -- command surface (identical to Mt5Worker) -------------------------------

    def snapshot_payload(self, event_key="") -> dict:
        self.walk()
        return {
            "ok": True, "snapshot": True,
            "positions": [dict(p) for p in self.positions.values()],
            "pending": [dict(o) for o in self.orders.values()],
            "prices": self.prices_payload(),
            **self.account_msg(),
        }

    def do_symbol_spec(self, req) -> dict:
        s = str(req.get("symbol") or "").upper()
        spec = self.SPECS.get(s)
        if not spec:
            return {"ok": False, "code": "unknown_symbol", "error": f"symbol {s} not found"}
        half = spec["point"] * spec["spreadPoints"] / 2.0
        px = self.prices[s]
        return {"ok": True, "spec": {
            "symbol": s, "point": spec["point"], "digits": spec["digits"],
            "tickValue": spec["tickValue"], "tickSize": spec["tickSize"],
            "volumeMin": spec["volumeMin"], "volumeMax": spec["volumeMax"],
            "volumeStep": spec["volumeStep"], "spreadPoints": spec["spreadPoints"],
            "bid": round(px - half, spec["digits"]), "ask": round(px + half, spec["digits"]),
        }}

    def do_open(self, c) -> dict:
        self.walk()
        s = str(c.get("symbol") or "").upper()
        spec = self.SPECS.get(s)
        if not spec:
            return {"ok": False, "code": "unknown_symbol", "error": f"symbol {s} not found"}
        vol = floor_to_step(float(c.get("volume") or 0), spec["volumeStep"])
        if vol < spec["volumeMin"]:
            return {"ok": False, "code": "invalid_volume", "error": f"volume {vol} below minimum {spec['volumeMin']}"}
        side = "buy" if c.get("side", "buy") == "buy" else "sell"
        half = spec["point"] * spec["spreadPoints"] / 2.0
        price = round(self.prices[s] + (half if side == "buy" else -half), spec["digits"])
        t = str(self.next_ticket)
        self.next_ticket += 1
        self.positions[t] = {
            "ticket": t, "symbol": s, "side": side, "kind": "position", "pendingType": "",
            "volume": vol, "openPrice": price, "currentPrice": price,
            "sl": float(c.get("sl") or 0), "tp": float(c.get("tp") or 0),
            "profit": 0.0, "openTime": now_ms(),
            "comment": ("MC:open:" + str(c.get("masterTicket") or ""))[:31],
        }
        return {"ok": True, "ticket": t, "price": price, "retcode": 10009}

    def _close_inner(self, c, volume) -> dict:
        self.walk()
        t = str(c.get("ticket") or "")
        p = self.positions.get(t)
        if not p:
            return {"ok": False, "code": "position_not_found", "error": "position not found (maybe already closed)"}
        if volume is None or float(volume) >= p["volume"] - 1e-9:
            closed = self.positions.pop(t)
            self.balance = round(self.balance + closed["profit"], 2)
            return {"ok": True, "ticket": t, "price": p["currentPrice"]}
        vol = floor_to_step(float(volume), self.SPECS[p["symbol"]]["volumeStep"])
        if vol < self.SPECS[p["symbol"]]["volumeMin"]:
            closed = self.positions.pop(t)
            self.balance = round(self.balance + closed["profit"], 2)
            return {"ok": True, "ticket": t, "price": p["currentPrice"]}
        realized = round(p["profit"] * (vol / p["volume"]), 2)
        p["volume"] = round(p["volume"] - vol, 2)
        self.balance = round(self.balance + realized, 2)
        return {"ok": True, "ticket": t, "price": p["currentPrice"]}

    def do_close(self, c) -> dict:
        return self._close_inner(c, None)

    def do_partial(self, c) -> dict:
        return self._close_inner(c, float(c.get("volume") or 0))

    def do_modify(self, c) -> dict:
        t = str(c.get("ticket") or "")
        p = self.positions.get(t)
        if not p:
            return {"ok": False, "code": "position_not_found", "error": "position not found"}
        p["sl"] = float(c.get("sl") or 0)
        p["tp"] = float(c.get("tp") or 0)
        return {"ok": True}

    def do_place(self, c) -> dict:
        self.walk()
        s = str(c.get("symbol") or "").upper()
        spec = self.SPECS.get(s)
        if not spec:
            return {"ok": False, "code": "unknown_symbol", "error": f"symbol {s} not found"}
        vol = floor_to_step(float(c.get("volume") or 0), spec["volumeStep"])
        if vol < spec["volumeMin"]:
            return {"ok": False, "code": "invalid_volume", "error": f"volume {vol} below minimum"}
        price = round(float(c.get("price") or 0), spec["digits"])
        if price <= 0:
            return {"ok": False, "code": "invalid_price", "error": "invalid pending price"}
        t = str(self.next_ticket)
        self.next_ticket += 1
        self.orders[t] = {
            "ticket": t, "symbol": s, "side": "buy" if c.get("side", "buy") == "buy" else "sell",
            "kind": "pending", "pendingType": str(c.get("pendingType") or "buy_limit").lower(),
            "volume": vol, "openPrice": price, "currentPrice": price,
            "sl": float(c.get("sl") or 0), "tp": float(c.get("tp") or 0),
            "profit": 0.0, "openTime": now_ms(),
            "comment": ("MC:open:" + str(c.get("masterTicket") or ""))[:31],
        }
        return {"ok": True, "ticket": t, "price": price, "retcode": 10008}

    def do_cancel(self, c) -> dict:
        t = str(c.get("ticket") or "")
        if t not in self.orders:
            return {"ok": False, "code": "order_not_found", "error": "pending order not found"}
        self.orders.pop(t, None)
        return {"ok": True}

    def dispatch(self, req) -> dict:
        self.walk()
        self.step_actor()
        kind = req.get("kind")
        if kind == "ping":
            return {"ok": True, "pong": True, "at": now_ms()}
        if kind == "snapshot":
            return self.snapshot_payload()
        if kind == "account":
            return {"ok": True, **self.account_msg()}
        if kind == "symbol_spec":
            return self.do_symbol_spec(req)
        if kind == "tick":
            return self.do_tick(req)
        if kind == "open":
            return self.do_open(req)
        if kind == "close":
            return self.do_close(req)
        if kind == "partial":
            return self.do_partial(req)
        if kind == "modify_sltp":
            return self.do_modify(req)
        if kind == "place_pending":
            return self.do_place(req)
        if kind == "cancel_pending":
            return self.do_cancel(req)
        return {"ok": False, "code": "unknown_kind", "error": f"unknown command {kind}"}

    def do_tick(self, req) -> dict:
        s = str(req.get("symbol") or "")
        pr = self.prices_payload().get(s)
        if not pr:
            return {"ok": False, "code": "unknown_symbol", "error": f"no simulated price for {s}"}
        return {"ok": True, **pr}

    def make_ready(self) -> dict:
        return self.account_msg()


def run_bridge_worker(cfg_path: str) -> int:
    """Entry point for `MT5CopierEngine.exe --bridge <cfg.json>`."""
    if not cfg_path:
        print("bridge mode requires a config file path", file=sys.stderr)
        return 2
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:
        print(f"bad bridge config: {e}", file=sys.stderr)
        return 2
    try:
        worker = MockTerminal(cfg) if cfg.get("mock") else Mt5Worker(cfg)
    except ImportError as e:
        emit_json({"type": "fatal", "error": f"MetaTrader5 Python package unavailable: {e}"})
        return 3
    except Exception as e:
        print(f"bridge worker crashed: {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 2
    try:
        if cfg.get("ipcPort"):
            return _serve_socket(cfg, worker.dispatch, worker.make_ready)
        return _serve_stdio(worker.dispatch, worker.make_ready)
    finally:
        on_exit = getattr(worker, "on_exit", None)
        if on_exit:
            try:
                on_exit()
            except Exception:
                pass


# ============================================================================
# AUTOMATIC MT5 TERMINAL DISCOVERY (Windows, fully local)
# ============================================================================
# The engine scans the machine for installed MetaTrader 5 terminals and
# registers every new terminal64.exe automatically, so the user does not
# have to type any path. Sources (all local, no network):
#   1) HKCU\Software\MetaQuotes\Terminal\<hash>\InstallPath  (official)
#   2) %APPDATA%\MetaQuotes\Terminal\<hash>\origin.txt
#   3) common install roots (Program Files / %LOCALAPPDATA%\Programs)


def _normalize_exe(p: str) -> str:
    try:
        return os.path.normcase(os.path.normpath(os.path.abspath(p)))
    except Exception:
        return (p or "").strip().lower()


def _mt5_candidate_paths() -> list:
    """Return [{exePath, suggestedName}] for every installed MT5 terminal."""
    found = {}
    if sys.platform != "win32":
        return []

    def add(path: str):
        try:
            path = os.path.normpath(os.path.abspath(path))
        except Exception:
            return
        if not path.lower().endswith("terminal64.exe") or not os.path.isfile(path):
            return
        folder = os.path.basename(os.path.dirname(path)) or "MetaTrader 5"
        found.setdefault(_normalize_exe(path), {"exePath": path, "suggestedName": folder})

    # 1) official registry entries written by the MetaTrader 5 installer
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\MetaQuotes\Terminal") as root:
            idx = 0
            while True:
                try:
                    sub = winreg.EnumKey(root, idx)
                    idx += 1
                except OSError:
                    break
                try:
                    with winreg.OpenKey(root, sub) as k:
                        val, _ = winreg.QueryValueEx(k, "InstallPath")
                        if val:
                            add(os.path.join(str(val), "terminal64.exe"))
                except OSError:
                    continue
    except Exception:
        pass

    # 2) data-folder origin.txt (written for every non-portable install)
    try:
        appdata = os.environ.get("APPDATA") or ""
        base = os.path.join(appdata, "MetaQuotes", "Terminal")
        if os.path.isdir(base):
            for name in os.listdir(base):
                origin = os.path.join(base, name, "origin.txt")
                if os.path.isfile(origin):
                    try:
                        txt = (origin.read_text(encoding="utf-8", errors="replace")
                               if hasattr(origin, "read_text") else open(origin, encoding="utf-8", errors="replace").read())
                        val = txt.strip().splitlines()[0].strip() if txt.strip() else ""
                        if val:
                            add(os.path.join(val, "terminal64.exe"))
                    except Exception:
                        pass
    except Exception:
        pass

    # 3) well-known install roots (covers portable / custom installs too)
    import glob
    patterns = [
        r"C:\\Program Files\\*\\terminal64.exe",
        r"C:\\Program Files (x86)\\*\\terminal64.exe",
    ]
    local = os.environ.get("LOCALAPPDATA") or ""
    if local:
        patterns.append(os.path.join(local, "Programs", "*", "terminal64.exe"))
    desktop = os.environ.get("USERPROFILE") or ""
    if desktop:
        patterns.append(os.path.join(desktop, "Desktop", "*", "terminal64.exe"))
    for pat in patterns:
        try:
            for hit in glob.glob(pat):
                add(hit)
        except Exception:
            pass

    return list(found.values())


def auto_register_terminals(log_result: bool = True) -> dict:
    """Discover installed MT5 terminals and add the unknown ones to the DB.

    Every newly found terminal is registered enabled and connected right
    away: the bridge worker will start/attach its terminal64.exe through
    the official MetaTrader5 API (no EA, no login needed if the terminal
    already has a saved account).
    """
    demo = os.environ.get("COPIER_DEMO", "").strip().lower() in {"1", "true", "yes"}
    cands = [] if demo else _mt5_candidate_paths()
    existing = {
        _normalize_exe(r["exe_path"])
        for r in DB.q("SELECT exe_path FROM terminals") if r["exe_path"]
    }
    added = []
    for c in cands:
        np = _normalize_exe(c["exePath"])
        if np in existing:
            continue
        name = c["suggestedName"]
        base, n = name, 2
        while DB.one("SELECT id FROM terminals WHERE name=?", (name,)):
            name = f"{base} ({n})"
            n += 1
        tid = f"t{now_ms()}{random.randrange(100, 999)}"
        DB.x(
            "INSERT INTO terminals (id, name, exe_path, enabled, status) VALUES (?,?,?,1,'connecting')",
            (tid, name, c["exePath"]),
        )
        ensure_slave_settings(tid)
        added.append({"id": tid, "name": name, "exePath": c["exePath"]})
        log("success", "connection", f"MT5 terminal discovered automatically: {name}", tid, name, c["exePath"])
        ENGINE.start_terminal_tasks(tid)
    if log_result:
        if added:
            log("success", "connection", f"Auto-scan: {len(added)} new MT5 terminal(s) registered and connecting")
        elif cands:
            log("info", "connection", f"Auto-scan: {len(cands)} installed MT5 terminal(s), all already registered")
        else:
            if demo:
                log("info", "connection", "Auto-scan skipped in demo mode")
            else:
                log("info", "connection", "Auto-scan: no MetaTrader 5 installation found (add one manually in Connections)")
    return {"found": [c["exePath"] for c in cands], "added": added, "demo": demo}


# ============================================================================
# BRIDGE CLIENT (engine side, one asyncio subprocess per terminal)
# ============================================================================

class Bridge:
    """Async wrapper around one `--bridge` subprocess (real or mock).

    Transport: loopback TCP (127.0.0.1) with newline-delimited JSON and a
    one-time auth token. A TCP channel (instead of stdin/stdout pipes)
    works identically in windowed, console-free PyInstaller builds where
    the child process has no stdio handles.
    """

    def __init__(self, engine, tid: str, cfg: dict):
        self.engine = engine
        self.terminal_id = tid
        self.cfg = dict(cfg)
        self.magic = int(cfg.get("magic") or 0)
        self.account = None
        self.specs = {}
        self.proc = None
        self.ready = False
        self.waiting = False
        self.fatal_error = ""
        self.last_error = ""
        self.pending_acks = {}
        self.err_path = DB_PATH.parent / f"bridge-{tid}.err"
        self.alive = False
        self.ipc_token = secrets.token_hex(16)
        self.ipc_server = None
        self.writer = None

    async def spawn(self) -> bool:
        self.ready = False
        self.fatal_error = ""
        try:
            self.ipc_server = await asyncio.start_server(self._ipc_handler, "127.0.0.1", 0)
            port = self.ipc_server.sockets[0].getsockname()[1]
        except Exception as e:
            self.last_error = f"cannot open bridge IPC listener: {e}"
            return False
        cfg = dict(self.cfg)
        cfg["ipcPort"] = int(port)
        cfg["ipcToken"] = self.ipc_token
        cfg_path = DB_PATH.parent / f"bridge-cfg-{self.terminal_id}.json"
        try:
            cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
        except Exception as e:
            self.last_error = f"cannot write bridge config: {e}"
            return False
        if getattr(sys, "frozen", False):
            argv = [sys.executable, "--bridge", str(cfg_path)]
        else:
            argv = [sys.executable, str(Path(__file__).resolve()), "--bridge", str(cfg_path)]
        extra = {}
        if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            extra["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            err_fp = open(self.err_path, "ab")
            self.proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=err_fp,
                **extra,
            )
        except Exception as e:
            self.last_error = f"spawn failed: {e}"
            return False
        self.alive = True
        return True

    async def _ipc_handler(self, reader, writer):
        connected = False
        try:
            first = await asyncio.wait_for(reader.readline(), timeout=BRIDGE_READY_TIMEOUT)
            if not first:
                writer.close()
                return
            try:
                hello = json.loads(first.decode("utf-8", "replace"))
            except Exception:
                writer.close()
                return
            if str(hello.get("token") or "") != self.ipc_token:
                writer.close()  # a foreign process knocked - reject
                return
            self.writer = writer
            connected = True
            await self.handle(hello)
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8", "replace"))
                except Exception:
                    continue
                try:
                    await self.handle(msg)
                except Exception as e:
                    log("error", "engine", f"bridge message handling failed: {e}", self.terminal_id)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError):
            pass
        except Exception:
            pass
        finally:
            if connected:
                self.alive = False
                self.ready = False
                for fut in self.pending_acks.values():
                    if not fut.done():
                        fut.set_result({"ok": False, "code": "bridge_dead", "error": "bridge process exited", "at": now_ms()})
                self.pending_acks.clear()
                self.engine.bridge_exited(self.terminal_id, self)
            try:
                writer.close()
            except Exception:
                pass
            if self.ipc_server:
                try:
                    self.ipc_server.close()
                except Exception:
                    pass

    def send(self, obj: dict) -> bool:
        w = self.writer
        if w is None:
            return False
        try:
            w.write((json.dumps(obj) + "\n").encode())
            return True
        except Exception:
            self.alive = False
            return False

    async def command(self, obj: dict, timeout=10.0) -> dict:
        """Send a command and wait for the worker ack (matched by eventKey)."""
        key = f"cmd:{now_ms()}:{id(obj)}:{random.randrange(99999)}"
        obj = dict(obj)
        obj["eventKey"] = key
        fut = asyncio.get_event_loop().create_future()
        self.pending_acks[key] = fut
        if not self.send(obj):
            self.pending_acks.pop(key, None)
            return {"ok": False, "code": "bridge_dead", "error": "bridge stdin unavailable", "at": now_ms()}
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return {"ok": False, "code": "timeout", "error": "bridge ack timeout", "at": now_ms()}
        finally:
            self.pending_acks.pop(key, None)

    async def handle(self, msg: dict):
        mtype = msg.get("type")
        if mtype == "ready":
            self.ready = True
            self.engine.register_bridge(self.terminal_id, self, msg)
        elif mtype == "status":
            st = msg.get("status")
            if st:
                self.waiting = str(st) == "waiting"
                self.engine.set_status(self.terminal_id, st)
                log("warn" if st != "waiting" else "info", "connection",
                    f"bridge reported: {msg.get('error', '')}", self.terminal_id)
        elif mtype == "fatal":
            self.fatal_error = str(msg.get("error", ""))
        elif mtype == "ack":
            fut = self.pending_acks.pop(msg.get("eventKey", ""), None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def wait_ready(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ready:
                return True
            if self.proc and self.proc.returncode is not None:
                return False
            await asyncio.sleep(0.15)
        return False

    async def stop(self):
        self.alive = False
        self.ready = False
        try:
            if self.writer:
                self.writer.close()
        except Exception:
            pass
        if self.ipc_server:
            try:
                self.ipc_server.close()
            except Exception:
                pass
        if self.proc:
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=4)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass


# ----------------------------------------------------------------------------
# The Copier Engine
# ----------------------------------------------------------------------------

class Engine:
    def __init__(self):
        self.sessions = {}          # terminal_id -> Bridge (same interface as old EA sessions)
        self.account_index = {}     # account -> terminal_id
        self.last_snap = {}         # terminal_id -> {"positions": {}, "pending": {}}
        self.last_prices = {}       # terminal_id -> {symbol: {"bid","ask"}}
        self.bridge_desired = {}    # terminal_id -> bool (should a bridge run?)
        self.terminal_tasks = {}    # terminal_id -> [keeper task, poll task]
        self._drift_sig = {}        # slave_id -> last drift signature (dedupe logs)
        self.db = DB

    # -- lifecycle management ---------------------------------------------------

    def start_terminal_tasks(self, tid: str):
        if tid in self.terminal_tasks:
            return
        self.bridge_desired.setdefault(tid, True)
        self.terminal_tasks[tid] = [
            asyncio.ensure_future(self.bridge_keeper(tid)),
            asyncio.ensure_future(self.poll_terminal(tid)),
        ]

    async def stop_terminal_tasks(self, tid: str):
        self.bridge_desired[tid] = False
        await self.stop_bridge_process(tid)
        for t in self.terminal_tasks.pop(tid, []):
            t.cancel()

    async def stop_bridge_process(self, tid: str):
        b = self.sessions.pop(tid, None)
        if b:
            await b.stop()

    async def restart_bridge(self, tid: str):
        await self.stop_bridge_process(tid)
        # the keeper loop notices the missing bridge and respawns it

    def bridge_config(self, trow) -> dict:
        magic = int(trow.get("magic") or 0) or (777001 + (zlib.crc32(str(trow["id"]).encode()) % 8999))
        return {
            "terminalId": trow["id"],
            "name": trow["name"],
            "exePath": trow.get("exe_path") or "",
            "portable": bool(trow.get("portable")),
            "login": str(trow.get("login") or ""),
            "password": str(trow.get("password") or ""),
            "server": trow.get("server") or "",
            "magic": magic,
            "mock": bool(trow.get("simulated")),
            "act": trow.get("role") == "master",
            "demoBalance": 10000.0,
        }

    async def bridge_keeper(self, tid: str):
        """Supervise the bridge subprocess for one terminal (spawn/reconnect)."""
        backoff = 2.0
        logged_no_exe = False
        logged_waiting = False
        try:
            while self.bridge_desired.get(tid):
                trow = DB.one("SELECT * FROM terminals WHERE id=?", (tid,))
                if not trow:
                    break
                if not trow["enabled"]:
                    if self.sessions.get(tid):
                        await self.stop_bridge_process(tid)
                    self.set_status(tid, "disconnected")
                    await asyncio.sleep(1.5)
                    continue
                if not (trow["exe_path"] or trow["simulated"]):
                    if not logged_no_exe:
                        log("warn", "connection",
                            f"{trow['name']}: no terminal path set - open the dashboard, Connections view and add the terminal64.exe path", tid, trow["name"])
                        logged_no_exe = True
                    self.set_status(tid, "disconnected")
                    await asyncio.sleep(2.0)
                    continue
                b = self.sessions.get(tid)
                if b is None:
                    self.set_status(tid, "connecting")
                    b = Bridge(self, tid, self.bridge_config(trow))
                    if not await b.spawn():
                        self.set_status(tid, "error")
                        log("error", "connection", f"bridge spawn failed: {b.last_error}", tid, trow["name"])
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 30)
                        continue
                    self.sessions[tid] = b
                    ok = await b.wait_ready(BRIDGE_READY_TIMEOUT)
                    if not ok and b.waiting and (b.proc is None or b.proc.returncode is None):
                        # bridge is alive but the user has not opened this
                        # terminal yet - do NOT kill it, keep waiting quietly
                        if not logged_waiting:
                            log("info", "connection",
                                f"{trow['name']}: waiting for MetaTrader to be opened manually (the engine never starts terminals by itself)",
                                tid, trow["name"])
                            logged_waiting = True
                        await asyncio.sleep(2.0)
                        continue
                    if not ok:
                        err = b.fatal_error or b.last_error or "bridge did not report ready in time"
                        tail = ""
                        try:
                            tail = b.err_path.read_text(encoding="utf-8", errors="replace").strip()[-500:]
                        except Exception:
                            pass
                        await self.stop_bridge_process(tid)
                        self.set_status(tid, "error")
                        log("error", "connection", f"bridge failed to start: {err}", tid, trow["name"],
                            tail or "check the terminal path and that the terminal is logged in")
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 30)
                        continue
                    backoff = 2.0
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass
        finally:
            self.bridge_desired.pop(tid, None)

    async def poll_terminal(self, tid: str):
        """Poll one terminal bridge: master snapshots are diffed into events,
        every terminal snapshot refreshes the local ledger mirror."""
        try:
            while True:
                trow = DB.one("SELECT role FROM terminals WHERE id=?", (tid,))
                if not trow:
                    break
                role = trow["role"]
                interval = (MASTER_POLL_MS if role == "master" else SLAVE_POLL_MS if role == "slave" else 2000) / 1000.0
                b = self.sessions.get(tid)
                if b and b.alive and b.ready:
                    try:
                        res = await b.command({"kind": "snapshot"}, timeout=max(8.0, interval * 8))
                        if res.get("ok") and res.get("snapshot"):
                            self.last_prices[tid] = res.get("prices", {}) or {}
                            self.ingest_snapshot(tid, res)
                            if role == "master":
                                if tid in self.last_snap:
                                    for evt in self.diff_master(tid, res):
                                        await self.on_event(tid, evt)
                                else:
                                    self.diff_master(tid, res)  # first poll = baseline, no events
                    except Exception as e:
                        log("error", "engine", f"poll failed: {e}", tid)
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            pass

    def bridge_exited(self, tid: str, bridge: Bridge):
        if self.sessions.get(tid) is bridge:
            self.sessions.pop(tid, None)
        trow = DB.one("SELECT name, auto_reconnect, enabled FROM terminals WHERE id=?", (tid,))
        if not trow:
            return
        tail = ""
        try:
            tail = bridge.err_path.read_text(encoding="utf-8", errors="replace").strip()[-400:]
        except Exception:
            pass
        if not self.bridge_desired.get(tid):
            self.set_status(tid, "disconnected")
            return
        if not trow["enabled"] or not trow["auto_reconnect"]:
            self.set_status(tid, "error", log_it=True)
            self.bridge_desired[tid] = False
            log("error", "connection", f"bridge exited (auto reconnect off): {trow['name']}", tid, trow["name"], tail or bridge.fatal_error)
        else:
            self.set_status(tid, "reconnecting", log_it=True)
            log("warn", "connection", f"bridge exited, will restart automatically: {trow['name']}", tid, trow["name"],
                tail or bridge.fatal_error or "terminal window may be closed")

    # -- bridge registration ------------------------------------------------------

    def register_bridge(self, tid: str, bridge: Bridge, msg: dict):
        trow = DB.one("SELECT * FROM terminals WHERE id=?", (tid,))
        if not trow:
            return
        account = str(msg.get("account", ""))
        if account:
            other = self.account_index.get(account)
            if other and other != tid and self.sessions.get(other) and self.sessions[other].alive:
                bridge.last_error = f"account {account} already used by another terminal"
                self.set_status(tid, "error")
                log("error", "connection",
                    f"{trow['name']}: account {account} is already connected as another terminal", tid, trow["name"])
                return
            self.account_index[account] = tid
        bridge.account = account
        DB.x(
            "UPDATE terminals SET status='connected', last_seen=?, "
            "account_number=COALESCE(NULLIF(?,''),account_number), broker=COALESCE(NULLIF(?,''),broker), "
            "server=COALESCE(NULLIF(?,''),server), currency=COALESCE(NULLIF(?,''),currency), "
            "balance=?, equity=? WHERE id=?",
            (now_ms(), account, msg.get("broker", ""), msg.get("server", ""), msg.get("currency", "USD"),
             float(msg.get("balance", 0)), float(msg.get("equity", 0)), tid),
        )
        ensure_slave_settings(tid)
        self.set_status(tid, "connected", log_it=True)
        log("success", "connection",
            f"{trow['name']}: MT5 bridge attached (account {account or 'n/a'}, broker {msg.get('broker') or msg.get('server') or 'n/a'})",
            tid, trow["name"])

    def set_status(self, tid, status, log_it=False):
        prev = DB.one("SELECT status, reconnect_count FROM terminals WHERE id=?", (tid,))
        if not prev:
            return
        rc = prev["reconnect_count"]
        if status == "connected" and prev["status"] in ("reconnecting", "disconnected", "error", "connecting", "waiting"):
            rc += 1
            DB.x("UPDATE terminals SET reconnect_count=? WHERE id=?", (rc, tid))
        DB.x("UPDATE terminals SET status=?, last_seen=? WHERE id=?", (status, now_ms(), tid))
        if log_it:
            name = DB.one("SELECT name FROM terminals WHERE id=?", (tid,))
            log("success" if status == "connected" else "info", "connection",
                f"{name['name'] if name else tid}: {prev['status']} -> {status}")

    def update_account(self, tid, msg):
        try:
            DB.x(
                "UPDATE terminals SET balance=?, equity=?, floating_pl=?, free_margin=?, margin_level=?, last_seen=? WHERE id=?",
                (float(msg.get("balance", 0)), float(msg.get("equity", 0)), float(msg.get("floatingPL", 0)),
                 float(msg.get("freeMargin", 0)), float(msg.get("marginLevel", 0)), now_ms(), tid),
            )
        except Exception:
            pass

    # -- snapshot ingestion (ledger mirror) --------------------------------------

    def ingest_snapshot(self, tid, msg):
        self.update_account(tid, msg)
        live = {}
        for p in msg.get("positions", []):
            live[(str(p.get("ticket")))] = p
        for p in msg.get("pending", []):
            live[str(p.get("ticket"))] = p
        rows = DB.q("SELECT ticket FROM positions WHERE terminal_id=?", (tid,))
        for r in rows:
            if r["ticket"] not in live:
                self.move_to_closed(tid, r["ticket"], reason="unknown")
        for tk, p in live.items():
            mt_from_comment = self.master_ticket_from_comment(p.get("comment", ""))
            DB.x(
                "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(terminal_id, ticket) DO UPDATE SET current_price=excluded.current_price, volume=excluded.volume, sl=excluded.sl, tp=excluded.tp, profit=excluded.profit",
                (tid, tk, p.get("symbol", ""), p.get("side", "buy"), p.get("kind", "position"),
                 p.get("pendingType", ""), float(p.get("volume", 0)), float(p.get("openPrice", 0)),
                 float(p.get("currentPrice", p.get("openPrice", 0))), float(p.get("sl", 0)),
                 float(p.get("tp", 0)), float(p.get("profit", 0)), int(p.get("openTime", 0)),
                 mt_from_comment, 1 if mt_from_comment else 0),
            )
        if self.master_id() and tid != self.master_id() and (DB.one("SELECT role FROM terminals WHERE id=?", (tid,)) or {}).get("role") == "slave":
            asyncio.ensure_future(self.reconcile_slave(tid, trigger="snapshot"))

    @staticmethod
    def master_ticket_from_comment(comment: str) -> str:
        # comment format: "MC:open:<masterTicket>" (written by the copier bridges)
        if comment and comment.startswith("MC:"):
            parts = comment[3:].split(":")
            if len(parts) >= 2 and parts[0] == "open":
                return parts[1]
        return ""

    def move_to_closed(self, tid, ticket, reason="manual", close_price=None):
        pos = DB.one("SELECT * FROM positions WHERE terminal_id=? AND ticket=?", (tid, ticket))
        if not pos:
            return
        DB.x(
            "INSERT OR IGNORE INTO closed_trades (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, close_price, sl, tp, profit, open_time, close_time, close_reason, master_ticket) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (tid, pos["ticket"], pos["symbol"], pos["side"], pos["kind"], pos["pending_type"],
             pos["volume"], pos["open_price"], close_price or pos["current_price"], pos["sl"], pos["tp"],
             pos["profit"], pos["open_time"], now_ms(), reason, pos["master_ticket"]),
        )
        DB.x("DELETE FROM positions WHERE terminal_id=? AND ticket=?", (tid, ticket))
        DB.x("UPDATE terminals SET closed_today=closed_today+1 WHERE id=?", (tid,))

    def master_id(self):
        row = DB.one("SELECT id FROM terminals WHERE role='master' LIMIT 1")
        return row["id"] if row else None

    # -- master snapshot diff -> trade events --------------------------------------

    def diff_master(self, tid, snap):
        prev = self.last_snap.get(tid) or {"positions": {}, "pending": {}}
        cur_pos = {str(p.get("ticket")): p for p in snap.get("positions", []) if p.get("kind") == "position"}
        cur_pend = {str(p.get("ticket")): p for p in snap.get("pending", []) if p.get("kind") == "pending"}
        events = []
        ts = now_ms()
        for tk, p in cur_pos.items():
            old = prev["positions"].get(tk)
            if not old:
                events.append({"event": "position_opened", "ticket": tk, "symbol": p.get("symbol", ""),
                               "side": p.get("side", "buy"), "volume": float(p.get("volume", 0)),
                               "price": float(p.get("openPrice", 0)), "sl": float(p.get("sl", 0)),
                               "tp": float(p.get("tp", 0)), "ts": ts})
                continue
            new_v, old_v = float(p.get("volume", 0)), float(old.get("volume", 0))
            if new_v < old_v - 1e-9:
                events.append({"event": "partial_closed", "ticket": tk, "symbol": p.get("symbol", ""),
                               "volume": new_v, "preVolume": old_v,
                               "closedVolume": old_v - new_v,
                               "price": float(p.get("currentPrice", 0)), "ts": ts})
            elif new_v > old_v + 1e-9:
                log("warn", "trade", f"Master #{tk} volume increased (netting add-on) - add-on copying is not supported", tid)
            if abs(float(p.get("sl", 0)) - float(old.get("sl", 0))) > 1e-9 or abs(float(p.get("tp", 0)) - float(old.get("tp", 0))) > 1e-9:
                events.append({"event": "sltp_modified", "ticket": tk, "symbol": p.get("symbol", ""),
                               "sl": float(p.get("sl", 0)), "tp": float(p.get("tp", 0)), "ts": ts})
        for tk, old in prev["positions"].items():
            if tk not in cur_pos:
                events.append({"event": "position_closed", "ticket": tk, "symbol": old.get("symbol", ""),
                               "volume": float(old.get("volume", 0)),
                               "price": float(old.get("currentPrice", 0)),
                               "closeReason": "unknown", "ts": ts})
        for tk, p in cur_pend.items():
            if tk not in prev["pending"]:
                events.append({"event": "pending_placed", "ticket": tk, "symbol": p.get("symbol", ""),
                               "side": p.get("side", "buy"), "pendingType": p.get("pendingType", "buy_limit"),
                               "volume": float(p.get("volume", 0)), "price": float(p.get("openPrice", 0)),
                               "sl": float(p.get("sl", 0)), "tp": float(p.get("tp", 0)), "ts": ts})
        for tk, old in prev["pending"].items():
            if tk not in cur_pend:
                events.append({"event": "pending_cancelled", "ticket": tk, "symbol": old.get("symbol", ""), "ts": ts})
        self.last_snap[tid] = {"positions": cur_pos, "pending": cur_pend}
        return events

    # -- event ingress -------------------------------------------------------------

    async def on_event(self, tid, evt):
        try:
            DB.x("UPDATE app_settings SET last_event_at=? WHERE id='singleton'", (now_ms(),))
            event = evt.get("event")
            if event == "position_opened":
                await self.handle_master_open(tid, evt)
            elif event == "position_closed":
                await self.handle_master_close(tid, evt, partial=False)
            elif event == "partial_closed":
                await self.handle_master_close(tid, evt, partial=True)
            elif event == "sltp_modified":
                await self.handle_master_modify(tid, evt)
            elif event == "pending_placed":
                await self.handle_master_pending(tid, evt, placed=True)
            elif event == "pending_cancelled":
                await self.handle_master_pending(tid, evt, placed=False)
        except Exception as e:
            log("error", "engine", f"event handling failed: {e}", details=str(evt))

    # -- spec helper -----------------------------------------------------------------

    async def ensure_spec(self, sid, symbol):
        b = self.sessions.get(sid)
        if not b:
            return None
        sym = str(symbol).upper()
        if sym in b.specs:
            return b.specs[sym]
        res = await b.command({"kind": "symbol_spec", "symbol": symbol}, timeout=10)
        if res.get("ok") and res.get("spec"):
            b.specs[sym] = res["spec"]
            return res["spec"]
        return None

    async def price_ratio(self, master_tid, sid, orig_symbol, mapped_symbol) -> float:
        """Convert master-symbol absolute prices into mapped-slave-symbol prices."""
        try:
            if str(orig_symbol).upper() == str(mapped_symbol).upper():
                return 1.0
            mref = (self.last_prices.get(master_tid) or {}).get(str(orig_symbol).upper()) or {}
            sspec = await self.ensure_spec(sid, mapped_symbol)
            mbid = float(mref.get("bid") or 0)
            sbid = float((sspec or {}).get("bid") or 0)
            if mbid > 0 and sbid > 0:
                return sbid / mbid
        except Exception:
            pass
        return 1.0

    @staticmethod
    def round_price(v, spec):
        try:
            return round(float(v), int((spec or {}).get("digits", 5)))
        except Exception:
            return round(float(v), 5)

    @staticmethod
    def mid_price(price) -> float:
        """Mid price from a {bid, ask} dict (0 when unavailable)."""
        try:
            bid = float((price or {}).get("bid") or 0)
            ask = float((price or {}).get("ask") or 0)
            if bid > 0 and ask > 0:
                return (bid + ask) / 2.0
            return max(bid, ask)
        except Exception:
            return 0.0

    @staticmethod
    def scale_prices(k, spec, *prices):
        """Scale absolute prices by k = slave_ref / master_ref.

        Preserves the RELATIVE distance of SL/TP from the entry price, which
        stays identical across brokers, symbols and price scales (the old
        behaviour copied absolute master prices and diverged on other brokers).
        """
        try:
            k = float(k)
        except Exception:
            k = 1.0
        if not k or k <= 0 or abs(k - 1.0) < 1e-12:
            return [float(p) if p else 0.0 for p in prices]
        digits = int((spec or {}).get("digits", 5))
        return [round(float(p) * k, digits) if p else 0.0 for p in prices]

    # -- master event handlers ---------------------------------------------------------

    async def handle_master_open(self, tid, evt):
        detected = now_ms()
        ticket = str(evt.get("ticket"))
        symbol = evt.get("symbol", "")
        side = evt.get("side", "buy")
        volume = float(evt.get("volume", 0))
        DB.x(
            "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id, ticket) DO NOTHING",
            (tid, ticket, symbol, side, "position", "", volume, float(evt.get("price", 0)),
             float(evt.get("price", 0)), float(evt.get("sl", 0)), float(evt.get("tp", 0)), 0, detected, "", 0),
        )
        log("info", "trade", f"MASTER #{ticket} {side} {symbol} {volume} lots @ {evt.get('price')}")
        master = DB.one("SELECT * FROM terminals WHERE id=?", (tid,))
        slaves = DB.q("SELECT * FROM terminals WHERE role='slave'")
        await asyncio.gather(*[
            self.copy_open_to_slave(slave, master, evt, detected) for slave in slaves
        ], return_exceptions=True)

    async def copy_open_to_slave(self, slave, master, evt, detected):
        try:
            sid = slave["id"]
            s = ensure_slave_settings(sid)
            event_key = f"open:{evt.get('ticket')}"
            exists = DB.one("SELECT id, status FROM copy_ops WHERE slave_terminal_id=? AND event_key=?", (sid, event_key))
            if exists:
                return  # idempotency layer 1
            op_id = DB.x(
                "INSERT OR IGNORE INTO copy_ops (master_terminal_id, slave_terminal_id, master_ticket, action, event_key, status, detected_at) VALUES (?,?,?,?,?,'pending',?)",
                (master["id"], sid, str(evt.get("ticket")), "open", event_key, detected),
            )
            if not op_id:
                return
            symbol = evt.get("symbol", "")
            side = evt.get("side", "buy")
            kind = "pending" if evt.get("pendingType") else "position"

            def fail(status, code, reason, metric=False):
                DB.x("UPDATE copy_ops SET status=?, fail_code=?, fail_reason=?, done_at=? WHERE id=?",
                     (status, code, reason, now_ms(), op_id))
                log("warn" if status in ("skipped", "missed") else "error", "copy",
                    f"Copy {status} for master #{evt.get('ticket')} {symbol}: {reason}", sid, slave["name"], f"code={code}")
                if metric:
                    DB.x("INSERT INTO metric_events (ts, slave_terminal_id, master_ticket, action, total_ms, ok) VALUES (?,?,?,?,?,0)",
                         (detected, sid, str(evt.get("ticket")), "open", now_ms() - detected))

            if not self.engine_running():
                return fail("skipped", "engine_stopped", "Engine/copying is stopped")
            if not DB.one("SELECT copy_enabled FROM app_settings WHERE id='singleton'")["copy_enabled"]:
                return fail("skipped", "copy_disabled", "Global copying is stopped")

            mapped = parse_mapping(s["symbol_mapping"]).get(symbol.upper(), symbol.upper())
            spec = await self.ensure_spec(sid, mapped)
            open_count = DB.one("SELECT COUNT(*) c FROM positions WHERE terminal_id=? AND kind='position'", (sid,))["c"]
            code, reason = check_filters(slave, s, symbol, side, kind, spec, open_count)
            if code:
                return fail("skipped", code, reason)
            sl_dist = abs(float(evt.get("price", 0)) - float(evt.get("sl", 0))) / max(spec["point"], 1e-9) if evt.get("sl") else 0
            vol, err = calc_volume(s["lot_mode"], float(evt.get("volume", 0)), master["balance"],
                                   slave["equity"], s, sl_dist, spec)
            if err:
                return fail("failed", "invalid_volume", err, metric=True)
            bridge = self.sessions.get(sid)
            if not bridge or not bridge.alive:
                return fail("failed", "offline", "Slave terminal is not connected", metric=True)

            # If one of this slave's own copied pendings already filled on the
            # broker while the master pending filled on the master, LINK it
            # instead of opening a second (duplicate) position.
            try:
                pend_tks = {r["master_ticket"] for r in DB.q(
                    "SELECT DISTINCT master_ticket FROM copy_ops WHERE slave_terminal_id=? AND action='place_pending' AND status='executed'",
                    (sid,))}
                if pend_tks:
                    cand = DB.q(
                        "SELECT * FROM positions WHERE terminal_id=? AND kind='position' AND copied_by_engine=1 AND symbol=? AND side=? AND ABS(volume-?)<0.02 AND open_time>?",
                        (sid, mapped, side, vol, now_ms() - 180_000))
                    cand = [p for p in cand if p["master_ticket"] in pend_tks and p["master_ticket"] != str(evt.get("ticket"))]
                    if cand:
                        sp = cand[0]
                        done = now_ms()
                        DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, ack_at=?, done_at=?, latency_ms=?, total_ms=? WHERE id=?",
                             (sp["ticket"], done, done, done - detected, done - detected, op_id))
                        DB.x("UPDATE positions SET master_ticket=? WHERE terminal_id=? AND ticket=?",
                             (str(evt.get("ticket")), sid, sp["ticket"]))
                        log("info", "copy",
                            f"Linked slave filled pending {sp['ticket']} to master #{evt.get('ticket')} (double-open prevented)",
                            sid, slave["name"])
                        return
            except Exception:
                pass

            sl = float(evt.get("sl", 0)) if s["copy_sl"] else 0
            tp = float(evt.get("tp", 0)) if s["copy_tp"] else 0
            m_entry = float(evt.get("price", 0))
            pred_entry = 0.0
            if sl > 0 or tp > 0:
                # predicted slave fill: the LIVE price on the SLAVE terminal
                tick = await bridge.command({"kind": "tick", "symbol": mapped}, timeout=5)
                if tick.get("ok"):
                    pred_entry = float(tick.get("ask") or 0) if side == "buy" else float(tick.get("bid") or 0)
                if m_entry > 0 and pred_entry > 0:
                    # SL/TP relative to the entry prices -> identical relative
                    # stop/target distance on ANY broker / symbol scale
                    sl, tp = self.scale_prices(pred_entry / m_entry, spec, sl, tp)
                elif mapped.upper() != symbol.upper():
                    ratio = await self.price_ratio(master["id"], sid, symbol, mapped)
                    if ratio and abs(ratio - 1.0) > 1e-9:
                        sl, tp = self.scale_prices(ratio, spec, sl, tp)

            cmd = {
                "kind": "open", "symbol": mapped, "side": side, "volume": vol,
                "sl": sl, "tp": tp,
                "deviation": int(s["slippage_points"] or 20),
                "masterTicket": str(evt.get("ticket")),
            }
            sent = now_ms()
            DB.x("UPDATE copy_ops SET status='sent', sent_at=? WHERE id=?", (sent, op_id))
            res = await bridge.command(cmd)
            ack, done = int(res.get("at", now_ms())), now_ms()
            if res.get("ok") and res.get("ticket"):
                sticket = str(res.get("ticket"))
                actual = float(res.get("price") or 0)
                if (sl > 0 or tp > 0) and actual > 0 and pred_entry > 0 and m_entry > 0 \
                        and abs(actual - pred_entry) / pred_entry > 0.0005:
                    # the real fill differs from the predicted entry (slippage /
                    # another broker) - re-anchor SL/TP to the actual fill price
                    sl2, tp2 = self.scale_prices(actual / m_entry, spec,
                                                 float(evt.get("sl", 0)) if s["copy_sl"] else 0,
                                                 float(evt.get("tp", 0)) if s["copy_tp"] else 0)
                    if sl2 != sl or tp2 != tp:
                        corr = await bridge.command({"kind": "modify_sltp", "ticket": sticket,
                                                     "symbol": mapped, "sl": sl2, "tp": tp2}, timeout=8)
                        if corr.get("ok"):
                            sl, tp = sl2, tp2
                            log("info", "copy", "SL/TP re-anchored to the slave's actual fill price", sid, slave["name"])
                DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, ack_at=?, done_at=?, latency_ms=?, total_ms=? WHERE id=?",
                     (sticket, ack, done, ack - detected, done - detected, op_id))
                DB.x(
                    "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id, ticket) DO NOTHING",
                    (sid, sticket, mapped, side, "position", "", vol, float(res.get("price") or evt.get("price", 0)),
                     float(res.get("price") or evt.get("price", 0)),
                     sl, tp, 0, done, str(evt.get("ticket")), 1),
                )
                DB.x("INSERT INTO metric_events (ts, slave_terminal_id, master_ticket, action, detect_ms, send_ms, ack_ms, total_ms, ok) VALUES (?,?,?,?,?,?,?,?,1)",
                     (detected, sid, str(evt.get("ticket")), "open", sent - detected, ack - sent, done - ack, done - detected))
                log("success", "copy",
                    f"Copied master #{evt.get('ticket')} {side} {symbol} -> {mapped} {vol} lots",
                    sid, slave["name"], f"slaveTicket={sticket} latency={ack - detected}ms")
            else:
                rcode = res.get("code", "broker_reject")
                DB.x("UPDATE copy_ops SET status='failed', fail_code=?, fail_reason=?, ack_at=?, done_at=?, latency_ms=?, total_ms=? WHERE id=?",
                     (rcode, res.get("error", "broker rejected"), ack, done, ack - detected, done - detected, op_id))
                DB.x("INSERT INTO metric_events (ts, slave_terminal_id, master_ticket, action, total_ms, ok) VALUES (?,?,?,?,?,0)",
                     (detected, sid, str(evt.get("ticket")), "open", done - detected))
                log("error", "copy", f"Copy FAILED for master #{evt.get('ticket')} {symbol}: {res.get('error')}",
                    sid, slave["name"], f"code={rcode}")
        except Exception as e:
            log("error", "copy", f"copy pipeline error for master #{evt.get('ticket')}: {e}")

    async def handle_master_close(self, tid, evt, partial):
        detected = now_ms()
        ticket = str(evt.get("ticket"))
        if partial:
            DB.x("UPDATE positions SET volume=?, current_price=? WHERE terminal_id=? AND ticket=?",
                 (float(evt.get("volume", 0)), float(evt.get("price", 0)), tid, ticket))
            log("info", "trade", f"MASTER partial close #{ticket}: closed {evt.get('closedVolume')} lots")
        else:
            pos = DB.one("SELECT * FROM positions WHERE terminal_id=? AND ticket=?", (tid, ticket))
            if pos:
                self.move_to_closed(tid, ticket, reason=evt.get("closeReason", "manual"), close_price=evt.get("price"))
            log("info", "trade", f"MASTER closed #{ticket} ({evt.get('closeReason', 'manual')}) @ {evt.get('price')}")
        action = "partial" if partial else "close"
        master = DB.one("SELECT * FROM terminals WHERE id=?", (tid,))
        for slave in DB.q("SELECT * FROM terminals WHERE role='slave'"):
            sid = slave["id"]
            s = ensure_slave_settings(sid)
            event_key = f"{action}:{ticket}:{evt.get('ts', detected)}"
            op_id = DB.x(
                "INSERT OR IGNORE INTO copy_ops (master_terminal_id, slave_terminal_id, master_ticket, action, event_key, status, detected_at) VALUES (?,?,?,?,?,'pending',?)",
                (tid, sid, ticket, action, event_key, detected),
            )
            if not op_id:
                continue
            slave_pos = DB.one("SELECT * FROM positions WHERE terminal_id=? AND master_ticket=? AND kind='position'", (sid, ticket))

            def miss(status, code, reason):
                DB.x("UPDATE copy_ops SET status=?, fail_code=?, fail_reason=?, done_at=? WHERE id=?", (status, code, reason, now_ms(), op_id))
                log("warn", "copy", f"{action} for master #{ticket}: {reason}", sid, slave["name"])

            if partial and not s["copy_partial_close"]:
                if op_id:
                    miss("skipped", "partial_disabled", "copyPartialClose disabled")
                continue
            if not slave_pos:
                miss("missed", "no_position", "no copied position on slave")
                continue
            if action == "close" and not s["close_on_master_close"]:
                miss("skipped", "close_disabled", "closeOnMasterClose disabled")
                continue
            bridge = self.sessions.get(sid)
            if not bridge or not bridge.alive:
                miss("failed", "offline", "slave offline")
                continue
            vol = float(evt.get("closedVolume", 0))
            if partial:
                spec = await self.ensure_spec(sid, slave_pos["symbol"])
                pre = max(float(evt.get("preVolume") or (float(evt.get("volume", 0)) + float(evt.get("closedVolume", 0)))), 1e-9)
                closed_m = max(float(evt.get("closedVolume") or (pre - float(evt.get("volume", 0)))), 0.0)
                # proportional partial close: closed_slave = closed_master * (slave_vol / master_pre_vol)
                vol = slave_pos["volume"] * (closed_m / pre)
                if spec:
                    vol = floor_to_step(vol, spec["volumeStep"])
                    if vol < spec["volumeMin"]:
                        vol = slave_pos["volume"]  # too small for a legal partial close -> close fully
                vol = min(vol, slave_pos["volume"])
            sent = now_ms()
            DB.x("UPDATE copy_ops SET status='sent', sent_at=? WHERE id=?", (sent, op_id))
            res = await bridge.command({
                "kind": action, "ticket": slave_pos["ticket"], "symbol": slave_pos["symbol"],
                **({"volume": vol} if partial else {}),
            })
            ack, done = int(res.get("at", now_ms())), now_ms()
            if res.get("ok"):
                DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, ack_at=?, done_at=?, latency_ms=?, total_ms=? WHERE id=?",
                     (slave_pos["ticket"], ack, done, ack - detected, done - detected, op_id))
                DB.x("INSERT INTO metric_events (ts, slave_terminal_id, master_ticket, action, total_ms, ok) VALUES (?,?,?,?,?,1)",
                     (detected, sid, ticket, action, done - detected))
                if not partial:
                    self.move_to_closed(sid, slave_pos["ticket"], reason="engine", close_price=evt.get("price"))
                    log("success", "copy", f"Closed slave position {slave_pos['ticket']} (master #{ticket})", sid, slave["name"])
            else:
                DB.x("UPDATE copy_ops SET status='failed', fail_code=?, fail_reason=?, done_at=? WHERE id=?",
                     (res.get("code", "broker_reject"), res.get("error", "broker rejected"), now_ms(), op_id))
                log("error", "copy", f"{action} copy FAILED for master #{ticket}: {res.get('error')}", sid, slave["name"])

    async def handle_master_modify(self, tid, evt):
        detected = now_ms()
        ticket = str(evt.get("ticket"))
        DB.x("UPDATE positions SET sl=?, tp=? WHERE terminal_id=? AND ticket=?",
             (float(evt.get("sl", 0)), float(evt.get("tp", 0)), tid, ticket))
        log("info", "trade", f"MASTER modify #{ticket}: sl={evt.get('sl')} tp={evt.get('tp')}")
        for slave in DB.q("SELECT * FROM terminals WHERE role='slave'"):
            sid = slave["id"]
            s = ensure_slave_settings(sid)
            event_key = f"modify:{ticket}:{evt.get('ts', detected)}"
            op_id = DB.x(
                "INSERT OR IGNORE INTO copy_ops (master_terminal_id, slave_terminal_id, master_ticket, action, event_key, status, detected_at) VALUES (?,?,?,?,?,'pending',?)",
                (tid, sid, ticket, "modify_sltp", event_key, detected),
            )
            if not op_id or not s["copy_modifications"]:
                if op_id:
                    DB.x("UPDATE copy_ops SET status='skipped', fail_code='mod_disabled', fail_reason='copyModifications disabled', done_at=? WHERE id=?", (now_ms(), op_id))
                continue
            slave_pos = DB.one("SELECT * FROM positions WHERE terminal_id=? AND master_ticket=? AND kind='position'", (sid, ticket))
            if not slave_pos:
                DB.x("UPDATE copy_ops SET status='missed', fail_code='no_position', fail_reason='no copied position', done_at=? WHERE id=?", (now_ms(), op_id))
                continue
            bridge = self.sessions.get(sid)
            if not bridge or not bridge.alive:
                DB.x("UPDATE copy_ops SET status='failed', fail_code='offline', fail_reason='slave offline', done_at=? WHERE id=?", (now_ms(), op_id))
                continue
            sl = float(evt.get("sl", 0)) if s["copy_sl"] else 0
            tp = float(evt.get("tp", 0)) if s["copy_tp"] else 0
            if sl > 0 or tp > 0:
                spec = await self.ensure_spec(sid, slave_pos["symbol"])
                # re-anchor SL/TP relative to each side's OPEN price so the
                # relative stop/target distance stays identical across brokers
                mpos = DB.one("SELECT open_price FROM positions WHERE terminal_id=? AND ticket=? AND kind='position'", (tid, ticket))
                m_open = float((mpos or {}).get("open_price") or 0)
                s_open = float(slave_pos["open_price"] or 0)
                if m_open > 0 and s_open > 0:
                    sl, tp = self.scale_prices(s_open / m_open, spec, sl, tp)
                else:
                    ratio = await self.price_ratio(tid, sid, evt.get("symbol", slave_pos["symbol"]), slave_pos["symbol"])
                    if ratio and abs(ratio - 1.0) > 1e-9 and spec:
                        sl, tp = self.scale_prices(ratio, spec, sl, tp)
            res = await bridge.command({
                "kind": "modify_sltp", "ticket": slave_pos["ticket"], "symbol": slave_pos["symbol"],
                "sl": sl, "tp": tp,
            })
            if res.get("ok"):
                DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, done_at=?, latency_ms=? WHERE id=?",
                     (slave_pos["ticket"], now_ms(), now_ms() - detected, op_id))
                DB.x("UPDATE positions SET sl=?, tp=? WHERE terminal_id=? AND ticket=?",
                     (sl, tp, sid, slave_pos["ticket"]))
            else:
                DB.x("UPDATE copy_ops SET status='failed', fail_code=?, fail_reason=?, done_at=? WHERE id=?",
                     (res.get("code", "broker_reject"), res.get("error", ""), now_ms(), op_id))

    async def handle_master_pending(self, tid, evt, placed):
        detected = now_ms()
        ticket = str(evt.get("ticket"))
        action = "place_pending" if placed else "cancel_pending"
        if placed:
            DB.x(
                "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id, ticket) DO NOTHING",
                (tid, ticket, evt.get("symbol", ""), evt.get("side", "buy"), "pending",
                 evt.get("pendingType", ""), float(evt.get("volume", 0)), float(evt.get("price", 0)),
                 float(evt.get("price", 0)), float(evt.get("sl", 0)), float(evt.get("tp", 0)), 0, detected, "", 0),
            )
        else:
            DB.x("DELETE FROM positions WHERE terminal_id=? AND ticket=? AND kind='pending'", (tid, ticket))
        log("info", "trade", f"MASTER pending {'placed' if placed else 'cancelled'} #{ticket} {evt.get('pendingType','')} {evt.get('symbol','')}")
        for slave in DB.q("SELECT * FROM terminals WHERE role='slave'"):
            sid = slave["id"]
            s = ensure_slave_settings(sid)
            if not s["copy_pending"]:
                continue
            event_key = f"{'popen' if placed else 'pcancel'}:{ticket}"
            op_id = DB.x(
                "INSERT OR IGNORE INTO copy_ops (master_terminal_id, slave_terminal_id, master_ticket, action, event_key, status, detected_at) VALUES (?,?,?,?,?,'pending',?)",
                (tid, sid, ticket, action, event_key, detected),
            )
            if not op_id:
                continue
            bridge = self.sessions.get(sid)
            if not bridge or not bridge.alive:
                DB.x("UPDATE copy_ops SET status='failed', fail_code='offline', fail_reason='slave offline', done_at=? WHERE id=?", (now_ms(), op_id))
                continue
            if placed:
                mapped = parse_mapping(s["symbol_mapping"]).get(evt.get("symbol", "").upper(), evt.get("symbol", "").upper())
                spec = await self.ensure_spec(sid, mapped)
                code, reason = (None, None)
                if not spec:
                    code, reason = "unknown_symbol", "symbol not found after mapping"
                vol = None
                price = float(evt.get("price", 0))
                sl = float(evt.get("sl", 0)) if s["copy_sl"] else 0
                tp = float(evt.get("tp", 0)) if s["copy_tp"] else 0
                if not code:
                    vol, reason = calc_volume(s["lot_mode"], float(evt.get("volume", 0)),
                                              DB.one("SELECT balance FROM terminals WHERE id=?", (tid,))["balance"],
                                              slave["equity"], s, 0, spec)
                    code = "invalid_volume" if reason else None
                if not code and (price > 0 or sl > 0 or tp > 0):
                    # scale the pending entry + SL/TP with the CURRENT market
                    # levels (live slave-side price), preserving all relative
                    # distances - correct for any broker / symbol scale
                    side_ = evt.get("side", "buy")
                    mtick = self.mid_price((self.last_prices.get(tid) or {}).get(str(evt.get("symbol", "")).upper()) or {})
                    s_px = 0.0
                    tick = await bridge.command({"kind": "tick", "symbol": mapped}, timeout=5)
                    if tick.get("ok"):
                        s_px = float(tick.get("ask") or 0) if side_ == "buy" else float(tick.get("bid") or 0)
                    if mtick > 0 and s_px > 0:
                        price, sl, tp = self.scale_prices(s_px / mtick, spec, price, sl, tp)
                    elif mapped != evt.get("symbol", "").upper():
                        ratio = await self.price_ratio(tid, sid, evt.get("symbol", ""), mapped)
                        if ratio and abs(ratio - 1.0) > 1e-9 and spec:
                            price, sl, tp = self.scale_prices(ratio, spec, price, sl, tp)
                if code:
                    DB.x("UPDATE copy_ops SET status='skipped', fail_code=?, fail_reason=?, done_at=? WHERE id=?", (code, reason, now_ms(), op_id))
                    continue
                res = await bridge.command({
                    "kind": "place_pending", "symbol": mapped, "side": evt.get("side", "buy"),
                    "volume": vol, "price": price, "pendingType": evt.get("pendingType", ""),
                    "sl": sl, "tp": tp,
                    "masterTicket": ticket,
                })
            else:
                slave_pending = DB.one("SELECT * FROM positions WHERE terminal_id=? AND master_ticket=? AND kind='pending'", (sid, ticket))
                if not slave_pending:
                    DB.x("UPDATE copy_ops SET status='missed', fail_code='no_order', fail_reason='no pending on slave', done_at=? WHERE id=?", (now_ms(), op_id))
                    continue
                res = await bridge.command({"kind": "cancel_pending", "ticket": slave_pending["ticket"], "symbol": slave_pending["symbol"]})
                if res.get("ok"):
                    DB.x("DELETE FROM positions WHERE terminal_id=? AND ticket=?", (sid, slave_pending["ticket"]))
                    DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, done_at=?, latency_ms=? WHERE id=?",
                         (slave_pending["ticket"], now_ms(), now_ms() - detected, op_id))
                    log("success", "copy", f"Cancelled slave pending {slave_pending['ticket']} (master #{ticket})", sid, slave["name"])
                    continue
                DB.x("UPDATE copy_ops SET status='failed', fail_code=?, fail_reason=?, done_at=? WHERE id=?",
                     (res.get("code", "broker_reject"), res.get("error", ""), now_ms(), op_id))
                continue
            if res.get("ok") and res.get("ticket"):
                DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, done_at=?, latency_ms=? WHERE id=?",
                     (str(res.get("ticket")), now_ms(), now_ms() - detected, op_id))
                if placed:
                    DB.x(
                        "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id, ticket) DO NOTHING",
                        (sid, str(res.get("ticket")), mapped, evt.get("side", "buy"), "pending",
                         evt.get("pendingType", ""), vol, price, price,
                         sl, tp, 0, now_ms(), ticket, 1),
                    )
            elif not res.get("ok") and placed:
                DB.x("UPDATE copy_ops SET status='failed', fail_code=?, fail_reason=?, done_at=? WHERE id=?",
                     (res.get("code", "broker_reject"), res.get("error", ""), now_ms(), op_id))
            elif not res.get("ok"):
                DB.x("UPDATE copy_ops SET status='failed', fail_code=?, fail_reason=?, done_at=? WHERE id=?",
                     (res.get("code", "broker_reject"), res.get("error", ""), now_ms(), op_id))

    # -- reconciliation ------------------------------------------------------------

    async def reconcile_slave(self, sid, trigger="manual"):
        """Report (or auto-fix per policy) drift between master and a slave.
        Reports are deduplicated per slave: a warning is logged only when the
        set of drifted tickets actually changes."""
        mid = self.master_id()
        if not mid:
            return
        s = ensure_slave_settings(sid)
        master_positions = DB.q("SELECT * FROM positions WHERE terminal_id=? AND kind='position'", (mid,))
        slave_copies = DB.q("SELECT * FROM positions WHERE terminal_id=? AND master_ticket!=''", (sid,))
        master_tickets = {p["ticket"] for p in master_positions}
        copied_master_tickets = {p["master_ticket"] for p in slave_copies}
        missing = master_tickets - copied_master_tickets
        extra = {p["master_ticket"] for p in slave_copies} - master_tickets
        signature = (frozenset(missing), frozenset(extra))
        if self._drift_sig.get(sid) == signature:
            return  # same drift as last check - do not spam the log
        self._drift_sig[sid] = signature
        policy = s["sync_policy"]
        name = DB.one("SELECT name FROM terminals WHERE id=?", (sid,))["name"]
        for t in sorted(missing):
            log("warn", "sync", f"Drift: master #{t} missing on slave ({trigger})", sid, name)
            if policy == "autoOpenMissing":
                mp = DB.one("SELECT * FROM positions WHERE terminal_id=? AND ticket=?", (mid, t))
                if mp:
                    evt = {"ticket": t, "symbol": mp["symbol"], "side": mp["side"], "volume": mp["volume"],
                           "price": mp["open_price"], "sl": mp["sl"], "tp": mp["tp"], "ts": now_ms()}
                    await self.copy_open_to_slave(DB.one("SELECT * FROM terminals WHERE id=?", (sid,)),
                                                  DB.one("SELECT * FROM terminals WHERE id=?", (mid,)), evt, now_ms())
        for t in sorted(extra):
            log("warn", "sync", f"Drift: slave position for master #{t} but master position is gone ({trigger})", sid, name)
            if policy == "autoCloseExtra":
                sp = DB.one("SELECT * FROM positions WHERE terminal_id=? AND master_ticket=?", (sid, t))
                bridge = self.sessions.get(sid)
                if sp and bridge and bridge.alive:
                    res = await bridge.command({"kind": "close", "ticket": sp["ticket"], "symbol": sp["symbol"]})
                    if res.get("ok"):
                        self.move_to_closed(sid, sp["ticket"], reason="engine")
                        log("success", "sync", f"Auto-closed extra slave position {sp['ticket']}", sid, name)

    async def reconcile_all(self, policy_override=None):
        mid = self.master_id()
        if not mid:
            return
        for slave in DB.q("SELECT * FROM terminals WHERE role='slave' AND status='connected'"):
            if policy_override:
                DB.x("UPDATE slave_settings SET sync_policy=? WHERE terminal_id=?", (policy_override, slave["id"]))
            await self.reconcile_slave(slave["id"], trigger="startup")

    def engine_running(self):
        return bool(get_settings()["engine_running"])

    # -- global controls --------------------------------------------------------------

    def stop_copying(self):
        DB.x("UPDATE app_settings SET copy_enabled=0 WHERE id='singleton'")
        log("warn", "engine", "STOP COPYING: new trades will not be copied")

    def start_copying(self):
        DB.x("UPDATE app_settings SET copy_enabled=1 WHERE id='singleton'")
        log("success", "engine", "COPYING enabled")

    async def emergency_stop(self):
        policy = get_settings()["emergency_policy"]
        self.stop_copying()
        log("error", "engine", f"EMERGENCY STOP activated (policy: {policy})")
        if policy == "halt":
            return
        mid = self.master_id()
        if policy in ("halt_close_master", "halt_close_all") and mid:
            bridge = self.sessions.get(mid)
            if bridge:
                for p in DB.q("SELECT * FROM positions WHERE terminal_id=? AND kind='position'", (mid,)):
                    await bridge.command({"kind": "close", "ticket": p["ticket"], "symbol": p["symbol"]})
                log("warn", "trade", "Emergency: closed master positions")
        if policy == "halt_close_all":
            for slave in DB.q("SELECT * FROM terminals WHERE role='slave'"):
                bridge = self.sessions.get(slave["id"])
                if not bridge:
                    continue
                for p in DB.q("SELECT * FROM positions WHERE terminal_id=? AND kind='position'", (slave["id"],)):
                    await bridge.command({"kind": "close", "ticket": p["ticket"], "symbol": p["symbol"]})
            log("warn", "trade", "Emergency: closed all slave positions")

    async def shutdown_bridges(self):
        for tid in list(self.sessions.keys()):
            try:
                await self.sessions[tid].stop()
            except Exception:
                pass
        self.sessions.clear()

    # -- dashboard snapshot -------------------------------------------------------------

    def snapshot(self):
        stats = get_settings()
        terminals = DB.q("SELECT * FROM terminals ORDER BY name")
        out_terminals = []
        for t in terminals:
            t = dict(t)
            t["openPositionsCount"] = DB.one("SELECT COUNT(*) c FROM positions WHERE terminal_id=? AND kind='position'", (t["id"],))["c"]
            t["pendingCount"] = DB.one("SELECT COUNT(*) c FROM positions WHERE terminal_id=? AND kind='pending'", (t["id"],))["c"]
            s = DB.one("SELECT * FROM slave_settings WHERE terminal_id=?", (t["id"],))
            t["settings"] = snake_to_camel_settings(s) if s else None
            out_terminals.append(snake_to_camel_terminal(t))
        today0 = now_ms() - 86_400_000
        metrics = DB.q("SELECT * FROM metric_events WHERE ts>? ORDER BY ts DESC LIMIT 300", (today0,))
        totals = DB.q("SELECT COUNT(*) c, SUM(ok) okc FROM metric_events WHERE ts>? AND action='open'", (today0,))
        lat = [m["total_ms"] for m in metrics if m["action"] == "open"]
        missed = DB.one("SELECT COUNT(*) c FROM copy_ops WHERE status='missed' AND detected_at>?", (today0,))["c"]
        reconn = DB.one("SELECT COALESCE(SUM(reconnect_count),0) c FROM terminals")["c"]
        per_slave = {}
        for m in metrics:
            e = per_slave.setdefault(m["slave_terminal_id"], {"n": 0, "sum": 0, "ok": 0, "failed": 0})
            e["n"] += 1
            e["sum"] += m["total_ms"]
            e["ok" if m["ok"] else "failed"] += 1
        names = {t["id"]: t["name"] for t in terminals}
        master = DB.one("SELECT * FROM terminals WHERE role='master'")
        relations = []
        if master:
            mpos = DB.q("SELECT * FROM positions WHERE terminal_id=? ORDER BY open_time DESC LIMIT 40", (master["id"],))
            for p in mpos:
                ops = DB.q("SELECT * FROM copy_ops WHERE master_ticket=? ORDER BY detected_at", (p["ticket"],))
                relations.append({
                    "masterTicket": p["ticket"], "symbol": p["symbol"], "side": p["side"],
                    "volume": p["volume"], "openPrice": p["open_price"], "sl": p["sl"], "tp": p["tp"],
                    "openTime": p["open_time"], "profit": p["profit"], "isOpen": True,
                    "copies": [op_to_dto(o, names) for o in ops],
                })
        return {
            "stats": {
                "engineRunning": bool(stats["engine_running"]),
                "copyEnabled": bool(stats["copy_enabled"]),
                "emergencyPolicy": stats["emergency_policy"],
                "masterStatus": (master["status"] if master else "none"),
                "masterName": (master["name"] if master else ""),
                "totalTerminals": len(terminals),
                "connectedTerminals": sum(1 for t in terminals if t["status"] == "connected"),
                "activeSlaves": sum(1 for t in terminals if t["role"] == "slave" and t["enabled"] and not t["paused"]),
                "openPositionsTotal": sum(t["openPositionsCount"] for t in out_terminals),
                "pendingTotal": sum(t["pendingCount"] for t in out_terminals),
                "copiedToday": (totals[0]["okc"] or 0) if totals else 0,
                "failedToday": ((totals[0]["c"] or 0) - (totals[0]["okc"] or 0)) if totals else 0,
                "lastEventAt": stats["last_event_at"],
                "bootedAt": stats["booted_at"],
                "now": now_ms(),
            },
            "terminals": out_terminals,
            "masterRelations": relations,
            "latency": {
                "current": lat[0] if lat else 0,
                "average": round(sum(lat) / len(lat)) if lat else 0,
                "min": min(lat) if lat else 0,
                "max": max(lat) if lat else 0,
                "samples": len(lat),
                "successfulCopies": (totals[0]["okc"] or 0) if totals else 0,
                "failedCopies": ((totals[0]["c"] or 0) - (totals[0]["okc"] or 0)) if totals else 0,
                "missedEvents": missed,
                "reconnectionEvents": reconn,
                "lastEventAt": stats["last_event_at"],
                "recent": [{"ts": m["ts"], "totalMs": m["total_ms"], "ok": bool(m["ok"])} for m in metrics[:60]],
                "perSlave": [
                    {"terminalId": sid, "name": names.get(sid, sid), "avgMs": round(e["sum"] / max(e["n"], 1)),
                     "count": e["n"], "ok": e["ok"], "failed": e["failed"]}
                    for sid, e in per_slave.items()
                ],
            },
        }


def op_to_dto(o, names):
    return {
        "id": str(o["id"]), "masterTerminalId": o["master_terminal_id"],
        "slaveTerminalId": o["slave_terminal_id"], "slaveName": names.get(o["slave_terminal_id"], o["slave_terminal_id"]),
        "masterTicket": o["master_ticket"], "slaveTicket": o["slave_ticket"], "action": o["action"],
        "eventKey": o["event_key"], "status": o["status"], "failReason": o["fail_reason"],
        "failCode": o["fail_code"], "detectedAt": o["detected_at"], "sentAt": o["sent_at"],
        "ackAt": o["ack_at"], "doneAt": o["done_at"], "latencyMs": o["latency_ms"], "totalMs": o["total_ms"],
    }


def snake_to_camel_terminal(t):
    return {
        "id": t["id"], "name": t["name"], "broker": t["broker"], "server": t["server"],
        "accountNumber": t["account_number"], "currency": t["currency"], "exePath": t["exe_path"],
        "simulated": bool(t["simulated"]), "role": t["role"], "enabled": bool(t["enabled"]),
        "paused": bool(t["paused"]), "status": t["status"], "autoReconnect": bool(t["auto_reconnect"]),
        "lastSeen": t["last_seen"], "leverage": t["leverage"], "balance": t["balance"],
        "equity": t["equity"], "floatingPL": t["floating_pl"], "freeMargin": t["free_margin"],
        "marginLevel": t["margin_level"], "closedToday": t["closed_today"],
        "reconnectCount": t["reconnect_count"], "openPositionsCount": t["openPositionsCount"],
        "pendingCount": t["pendingCount"], "settings": t.get("settings"),
    }


def snake_to_camel_settings(s):
    return {
        "terminalId": s["terminal_id"], "lotMode": s["lot_mode"], "fixedLot": s["fixed_lot"],
        "multiplier": s["multiplier"], "balanceRatioCap": s["balance_ratio_cap"],
        "riskPercent": s["risk_percent"], "copySL": bool(s["copy_sl"]), "copyTP": bool(s["copy_tp"]),
        "copyModifications": bool(s["copy_modifications"]), "copyPartialClose": bool(s["copy_partial_close"]),
        "copyPending": bool(s["copy_pending"]), "closeOnMasterClose": bool(s["close_on_master_close"]),
        "maxSpreadPoints": s["max_spread_points"], "maxLot": s["max_lot"],
        "maxPositions": s["max_positions"], "slippagePoints": s["slippage_points"],
        "buyEnabled": bool(s["buy_enabled"]), "sellEnabled": bool(s["sell_enabled"]),
        "symbolWhitelist": s["symbol_whitelist"], "symbolBlacklist": s["symbol_blacklist"],
        "symbolMapping": s["symbol_mapping"], "syncPolicy": s["sync_policy"],
        "rejectProbability": s["reject_probability"], "baseLatencyMs": s["base_latency_ms"],
        "jitterMs": s["jitter_ms"],
    }


ENGINE = Engine()


# ----------------------------------------------------------------------------
# Minimal HTTP server for the dashboard REST contract + static UI
# ----------------------------------------------------------------------------

HTTP_ROUTES = {}


def route(method, pattern):
    def deco(fn):
        HTTP_ROUTES[(method, pattern)] = fn
        return fn
    return deco


def jbody(body, status=200, ctype="application/json"):
    data = json.dumps(body).encode() if not isinstance(body, bytes) else body
    return status, ctype, data


@route("GET", "/api/state")
async def api_state(req):
    return jbody(ENGINE.snapshot())


@route("GET", "/api/positions")
async def api_positions(req):
    q = req["query"]
    sql = "SELECT p.*, t.name terminal_name, t.role terminal_role FROM positions p JOIN terminals t ON t.id=p.terminal_id WHERE 1=1"
    args = []
    if q.get("terminalId"):
        sql += " AND p.terminal_id=?"; args.append(q["terminalId"][0])
    if q.get("kind") in ("position", "pending"):
        sql += " AND p.kind=?"; args.append(q["kind"][0])
    rows = DB.q(sql + " ORDER BY p.open_time DESC LIMIT 500", args)
    return jbody([{
        "id": str(r["id"]), "terminalId": r["terminal_id"], "terminalName": r["terminal_name"],
        "terminalRole": r["terminal_role"], "ticket": r["ticket"], "symbol": r["symbol"],
        "side": r["side"], "kind": r["kind"], "pendingType": r["pending_type"], "volume": r["volume"],
        "openPrice": r["open_price"], "currentPrice": r["current_price"], "sl": r["sl"], "tp": r["tp"],
        "profit": r["profit"], "openTime": r["open_time"], "masterTicket": r["master_ticket"],
        "copiedByEngine": bool(r["copied_by_engine"]),
    } for r in rows])


@route("GET", "/api/closed")
async def api_closed(req):
    q = req["query"]
    sql = "SELECT c.*, t.name terminal_name, t.role terminal_role FROM closed_trades c JOIN terminals t ON t.id=c.terminal_id WHERE 1=1"
    args = []
    if q.get("terminalId"):
        sql += " AND c.terminal_id=?"; args.append(q["terminalId"][0])
    if q.get("symbol"):
        sql += " AND c.symbol LIKE ?"; args.append(f"%{q['symbol'][0]}%")
    if q.get("reason"):
        sql += " AND c.close_reason=?"; args.append(q["reason"][0])
    if q.get("q"):
        sql += " AND (c.ticket LIKE ? OR c.symbol LIKE ?)"; args.extend([f"%{q['q'][0]}%", f"%{q['q'][0]}%"])
    rows = DB.q(sql + " ORDER BY c.close_time DESC LIMIT 500", args)
    return jbody([{
        "id": str(r["id"]), "terminalId": r["terminal_id"], "terminalName": r["terminal_name"],
        "terminalRole": r["terminal_role"], "ticket": r["ticket"], "symbol": r["symbol"],
        "side": r["side"], "kind": r["kind"], "volume": r["volume"], "openPrice": r["open_price"],
        "closePrice": r["close_price"], "sl": r["sl"], "tp": r["tp"], "profit": r["profit"],
        "openTime": r["open_time"], "closeTime": r["close_time"], "closeReason": r["close_reason"],
        "masterTicket": r["master_ticket"],
    } for r in rows])


@route("GET", "/api/logs")
async def api_logs(req):
    q = req["query"]
    sql = "SELECT * FROM logs WHERE 1=1"
    args = []
    if q.get("level"):
        sql += " AND level=?"; args.append(q["level"][0])
    if q.get("category"):
        sql += " AND category=?"; args.append(q["category"][0])
    if q.get("terminalId"):
        sql += " AND terminal_id=?"; args.append(q["terminalId"][0])
    if q.get("q"):
        sql += " AND message LIKE ?"; args.append(f"%{q['q'][0]}%")
    limit = int(q.get("limit", ["200"])[0])
    rows = DB.q(sql + " ORDER BY ts DESC LIMIT ?", args + [min(limit, 1000)])
    return jbody([{
        "id": str(r["id"]), "ts": r["ts"], "level": r["level"], "category": r["category"],
        "terminalId": r["terminal_id"], "terminalName": r["terminal_name"],
        "message": r["message"], "details": r["details"],
    } for r in rows])


@route("GET", "/api/copies")
async def api_copies(req):
    q = req["query"]
    names = {t["id"]: t["name"] for t in DB.q("SELECT id, name FROM terminals")}
    if q.get("masterTicket"):
        rows = DB.q("SELECT * FROM copy_ops WHERE master_ticket=? ORDER BY detected_at", (q["masterTicket"][0],))
    else:
        rows = DB.q("SELECT * FROM copy_ops ORDER BY detected_at DESC LIMIT ?", (min(int(q.get("limit", ["50"])[0]), 200),))
    return jbody([op_to_dto(o, names) for o in rows])


@route("GET", "/api/metrics")
async def api_metrics(req):
    snap = ENGINE.snapshot()
    return jbody(snap["latency"])


@route("GET", "/api/settings")
async def api_settings(req):
    s = get_settings()
    return jbody({
        "engineRunning": bool(s["engine_running"]), "copyEnabled": bool(s["copy_enabled"]),
        "emergencyPolicy": s["emergency_policy"], "syncOnStart": s["sync_on_start"],
        "masterAutoTrade": bool(s["master_auto_trade"]),
        "autoTradeIntervalMs": s["auto_trade_interval_ms"],
        "defaultRejectProbability": 0.0,
    })


@route("PUT", "/api/settings")
async def api_settings_put(req):
    body = req["json"]
    fields = {
        "emergencyPolicy": "emergency_policy", "syncOnStart": "sync_on_start",
        "masterAutoTrade": "master_auto_trade", "autoTradeIntervalMs": "auto_trade_interval_ms",
    }
    for src, dst in fields.items():
        if src in body:
            DB.x(f"UPDATE app_settings SET {dst}=? WHERE id='singleton'", (body[src],))
    if "copyEnabled" in body:
        DB.x("UPDATE app_settings SET copy_enabled=? WHERE id='singleton'", (1 if body["copyEnabled"] else 0,))
    log("info", "settings", f"Settings updated: {', '.join(body.keys())}")
    return await api_settings(req)


@route("POST", "/api/terminals")
async def api_terminals_post(req):
    body = req["json"]
    tid = f"t{now_ms()}"
    simulated = 1 if body.get("simulated") else 0
    name = (body.get("name") or "").strip() or ("Demo Terminal" if simulated else "MT5 Terminal")
    DB.x(
        "INSERT INTO terminals (id, name, broker, server, exe_path, login, password, portable, magic, simulated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (tid, name, body.get("broker", ""), body.get("server", ""),
         str(body.get("exePath") or ""), str(body.get("login") or ""), str(body.get("password") or ""),
         1 if body.get("portable") else 0, int(body.get("magic") or 0), simulated),
    )
    ensure_slave_settings(tid)
    log("success", "settings", f"Terminal added: {name}" + (" (simulated)" if simulated else ""), tid)
    ENGINE.start_terminal_tasks(tid)
    return jbody({"id": tid}, 201)


@route("POST", "/api/terminals/scan")
async def api_terminals_scan(req):
    """Rescan the machine for installed MT5 terminals and connect the new ones."""
    try:
        return jbody(auto_register_terminals(log_result=True))
    except Exception as e:
        return jbody({"error": f"scan failed: {e}"}, 500)


@route("PATCH", "/api/terminals")
async def api_terminals_patch(req):
    # /api/terminals/{id} handled below via path splitting in http handler
    return jbody({"error": "not found"}, 404)


async def api_terminal_patch(req, tid):
    body = req["json"]
    action = body.get("action")
    value = body.get("value")
    if action == "connect":
        ENGINE.bridge_desired[tid] = True
        ENGINE.set_status(tid, "connecting")
        log("info", "connection", "Manual connect requested (spawning terminal bridge)", tid)
    elif action == "disconnect":
        ENGINE.bridge_desired[tid] = False
        await ENGINE.stop_bridge_process(tid)
        ENGINE.set_status(tid, "disconnected")
    elif action == "setRole":
        role = value if value in ("master", "slave", "none") else "none"
        if role == "master":
            DB.x("UPDATE terminals SET role='slave' WHERE role='master'")
        DB.x("UPDATE terminals SET role=? WHERE id=?", (role, tid))
        log("info", "settings", f"Role changed to {role}", tid)
        row = DB.one("SELECT simulated FROM terminals WHERE id=?", (tid,))
        if row and row["simulated"]:
            await ENGINE.restart_bridge(tid)  # master behaviour flag lives in the bridge config
    elif action == "updateConnection":
        up = []
        for src, col in (("exePath", "exe_path"), ("login", "login"), ("password", "password"), ("server", "server")):
            if src in body:
                up.append((col, str(body[src] or "")))
        if "portable" in body:
            up.append(("portable", 1 if body["portable"] else 0))
        if "magic" in body:
            try:
                up.append(("magic", int(body["magic"] or 0)))
            except Exception:
                pass
        for col, val in up:
            DB.x(f"UPDATE terminals SET {col}=? WHERE id=?", (val, tid))
        log("success", "settings", "Terminal connection settings updated", tid)
        await ENGINE.restart_bridge(tid)
    elif action == "enable":
        DB.x("UPDATE terminals SET enabled=1 WHERE id=?", (tid,))
        ENGINE.bridge_desired[tid] = True
    elif action == "disable":
        DB.x("UPDATE terminals SET enabled=0 WHERE id=?", (tid,))
    elif action == "pause":
        DB.x("UPDATE terminals SET paused=1 WHERE id=?", (tid,))
    elif action == "resume":
        DB.x("UPDATE terminals SET paused=0 WHERE id=?", (tid,))
    elif action == "autoReconnect":
        DB.x("UPDATE terminals SET auto_reconnect=? WHERE id=?", (1 if value else 0, tid))
    else:
        return jbody({"error": f"unknown action {action}"}, 422)
    return jbody({"ok": True})


@route("DELETE", "/api/terminals")
async def api_terminal_delete(req):
    # handled with path in http layer
    return jbody({"error": "not found"}, 404)


@route("PUT", "/api/terminals")
async def api_terminal_settings(req):
    # /api/terminals/{id}/settings handled in http layer
    return jbody({"error": "not found"}, 404)


def update_slave_settings_db(tid, body: dict):
    fields = {
        "lotMode": "lot_mode", "fixedLot": "fixed_lot", "multiplier": "multiplier",
        "balanceRatioCap": "balance_ratio_cap", "riskPercent": "risk_percent",
        "copySL": "copy_sl", "copyTP": "copy_tp", "copyModifications": "copy_modifications",
        "copyPartialClose": "copy_partial_close", "copyPending": "copy_pending",
        "closeOnMasterClose": "close_on_master_close", "maxSpreadPoints": "max_spread_points",
        "maxLot": "max_lot", "maxPositions": "max_positions", "slippagePoints": "slippage_points",
        "buyEnabled": "buy_enabled", "sellEnabled": "sell_enabled",
        "symbolWhitelist": "symbol_whitelist", "symbolBlacklist": "symbol_blacklist",
        "symbolMapping": "symbol_mapping", "syncPolicy": "sync_policy",
    }
    for src, dst in fields.items():
        if src in body:
            DB.x(f"UPDATE slave_settings SET {dst}=? WHERE terminal_id=?", (body[src], tid))
    ensure_slave_settings(tid)


@route("POST", "/api/engine")
async def api_engine(req):
    action = req["json"].get("action")
    if action == "start_copying":
        ENGINE.start_copying()
    elif action == "stop_copying":
        ENGINE.stop_copying()
    elif action == "emergency_stop":
        await ENGINE.emergency_stop()
    elif action == "restart":
        DB.x("UPDATE app_settings SET booted_at=? WHERE id='singleton'", (now_ms(),))
        await ENGINE.reconcile_all(policy_override=get_settings()["sync_on_start"])
        log("info", "engine", "Engine restart: state reloaded and reconciled")
    else:
        return jbody({"error": f"unknown action {action}"}, 422)
    return jbody({"ok": True})


@route("POST", "/api/sync")
async def api_sync(req):
    body = req["json"]
    sid, action = body.get("slaveId"), body.get("action")
    if not sid or not action:
        return jbody({"error": "slaveId and action required"}, 422)
    s = ensure_slave_settings(sid)
    if action == "open_missing":
        DB.x("UPDATE slave_settings SET sync_policy='autoOpenMissing' WHERE terminal_id=?", (sid,))
        await ENGINE.reconcile_slave(sid, trigger="manual-open-missing")
        DB.x("UPDATE slave_settings SET sync_policy=? WHERE terminal_id=?", (s["sync_policy"], sid))
        return jbody({"ok": True})
    if action == "close_extra":
        DB.x("UPDATE slave_settings SET sync_policy='autoCloseExtra' WHERE terminal_id=?", (sid,))
        await ENGINE.reconcile_slave(sid, trigger="manual-close-extra")
        DB.x("UPDATE slave_settings SET sync_policy=? WHERE terminal_id=?", (s["sync_policy"], sid))
        return jbody({"ok": True})
    return jbody({"error": "unknown action"}, 422)


@route("POST", "/api/sim")
async def api_sim(req):
    return jbody({"error": "Simulator is not available on the real Windows engine. For a demo, run the engine with COPIER_DEMO=1 (simulated terminals are created automatically)."}, 409)


@route("GET", "/api/tests")
async def api_tests(req):
    return jbody({"runs": [], "latest": []})


async def http_handler(reader, writer):
    try:
        head = await reader.readuntil(b"\r\n\r\n")
        request_line = head.decode("latin1").split("\r\n")[0]
        method, path, _ = request_line.split(" ", 2)
        cl = 0
        for line in head.decode("latin1").split("\r\n")[1:]:
            if line.lower().startswith("content-length:"):
                cl = int(line.split(":", 1)[1].strip())
        body_bytes = await reader.readexactly(cl) if cl else b"{}"
        parsed = urllib.parse.urlparse(path)
        segments = [s for s in parsed.path.split("/") if s]
        handler = None
        args = ()
        if (method, parsed.path) in HTTP_ROUTES:
            handler = HTTP_ROUTES[(method, parsed.path)]
        elif len(segments) >= 3 and segments[0] == "api" and segments[1] == "terminals":
            tid = segments[2]
            rest = segments[3:]
            if method == "PATCH":
                handler = api_terminal_patch
                args = (tid,)
            elif method == "DELETE":
                await ENGINE.stop_terminal_tasks(tid)
                DB.x("DELETE FROM positions WHERE terminal_id=?", (tid,))
                DB.x("DELETE FROM slave_settings WHERE terminal_id=?", (tid,))
                DB.x("DELETE FROM copy_ops WHERE slave_terminal_id=?", (tid,))
                DB.x("DELETE FROM terminals WHERE id=?", (tid,))
                log("warn", "settings", f"Terminal removed {tid}")
                status, ctype, data = jbody({"ok": True})
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(data)}\r\n\r\n".encode() + data)
                await writer.drain()
                return
            elif method == "PUT" and rest and rest[0] == "settings":
                async def h(req, tid=tid):
                    update_slave_settings_db(tid, req["json"])
                    log("success", "settings", "Slave settings updated", tid)
                    return jbody({"ok": True})
                handler = h
        # static UI fallback
        if handler is None and method == "GET" and not parsed.path.startswith("/api"):
            return await serve_static(parsed.path, writer)
        if handler is None:
            status, ctype, data = jbody({"error": "not found"}, 404)
        else:
            payload = {
                "query": urllib.parse.parse_qs(parsed.query),
                "json": json.loads(body_bytes.decode("utf-8") or "{}"),
            }
            try:
                status, ctype, data = await handler(payload, *args) if args else await handler(payload)
            except Exception as e:
                status, ctype, data = jbody({"error": str(e)}, 500)
        writer.write(f"HTTP/1.1 {status} OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(data)}\r\n\r\n".encode() + data)
        await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
        ".woff2": "font/woff2", ".map": "application/json"}


async def serve_static(path, writer):
    rel = path.lstrip("/") or "index.html"
    file = (UI_DIR / rel).resolve()
    if not str(file).startswith(str(UI_DIR.resolve())) or not file.is_file():
        file = UI_DIR / "index.html"
    if file.is_file():
        data = file.read_bytes()
        ctype = MIME.get(file.suffix, "application/octet-stream")
        writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(data)}\r\n\r\n".encode() + data)
    else:
        msg = b"Dashboard UI not found. Copy the exported dashboard into ./ui (see deploy/ui-export-README.md)."
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + str(len(msg)).encode() + b"\r\n\r\n" + msg)
    await writer.drain()


# ----------------------------------------------------------------------------
# Demo mode (built-in self test)
# ----------------------------------------------------------------------------

def seed_demo_terminals():
    demo = [
        ("Demo Master", "master"),
        ("Demo Slave 1", "slave"),
        ("Demo Slave 2", "slave"),
    ]
    for i, (name, role) in enumerate(demo):
        tid = f"tdemo{i}-{role}"
        DB.x(
            "INSERT INTO terminals (id, name, broker, server, currency, simulated, role, enabled, status) VALUES (?,?,?,?,?,?,?,?,?)",
            (tid, name, "Demo Broker", "Demo-Server", "USD", 1, role, 1, "connecting"),
        )
        ensure_slave_settings(tid)
        log("success", "engine", f"Demo terminal created: {name} ({role})")
    log("info", "engine", "DEMO MODE: simulated terminals were created - no MT5 needed. Delete them from the dashboard anytime.")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def dashboard_url() -> str:
    return f"http://{HTTP_HOST}:{HTTP_PORT}"


# Lifecycle signals used by the desktop-app launcher (GUI mode).
READY_SERVER = threading.Event()   # HTTP dashboard/API listening
READY_SCAN = threading.Event()     # terminal auto-scan finished
ENGINE_FATAL = {"message": ""}
ENGINE_LOOP_REF = None             # engine asyncio loop (for cross-thread shutdown)
HTTP_SERVER_REF = None             # asyncio server object


def browser_disabled() -> bool:
    if "--no-browser" in sys.argv or "--console" in sys.argv or "--headless" in sys.argv:
        return True
    return os.environ.get("COPIER_NO_BROWSER", "").strip().lower() in {"1", "true", "yes"}


def already_running() -> bool:
    """True when another engine instance already owns the dashboard port."""
    try:
        with socket.create_connection((HTTP_HOST, HTTP_PORT), timeout=0.5):
            return True
    except OSError:
        return False


def open_dashboard() -> bool:
    """Open the dashboard in the user's default browser (best effort)."""
    if browser_disabled():
        return False
    url = dashboard_url()
    try:
        if sys.platform == "win32":
            os.startfile(url)  # type: ignore[attr-defined]  # noqa: S606
            return True
    except Exception:
        pass
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:
        return False


def print_ready_banner(dashboard_opened: bool) -> None:
    """Friendly bilingual banner so the black console window is not scary."""
    url = dashboard_url()
    line = "=" * 66
    opened_en = ("Dashboard opened in your browser" if dashboard_opened
                 else f"Open the dashboard in your browser: {url}")
    print("\n" + line)
    print("  Multi-MT5 Trade Copier v2.0 is RUNNING - everything is OK.")
    print("  No EA / no MQL5 needed: the engine talks to your MT5")
    print("  terminals directly, locally (MetaTrader5 official API).")
    print(f"  Dashboard: {url}")
    print(f"  {opened_en}.")
    print("  KEEP THIS WINDOW OPEN - it is the engine console.")
    print("  Closing this window (or Ctrl+C) stops the copier.")
    try:
        # Persian line: skipped automatically if the console cannot render it.
        print("  — داشبورد در مرورگر شما باز شد — این پنجره را نبندید —")
    except Exception:
        pass
    print(line + "\n", flush=True)


async def engine_main(console_mode: bool = False):
    """Engine core: DB + terminal bridges + dashboard HTTP/API.

    console_mode=True additionally opens the browser and prints the friendly
    console banner (classic behaviour). In desktop-app mode the GUI launcher
    drives everything through the READY_* events instead.
    """
    global ENGINE_LOOP_REF, HTTP_SERVER_REF
    settings = get_settings()
    DB.x("UPDATE app_settings SET engine_running=1, booted_at=? WHERE id='singleton'", (now_ms(),))
    for t in DB.q("SELECT id, status FROM terminals"):
        if t["status"] == "connected":
            DB.x("UPDATE terminals SET status='reconnecting' WHERE id=?", (t["id"],))
    log("info", "engine", f"Engine starting (db: {DB_PATH})")
    log("info", "engine", "Mode: local MT5 bridges (no EA / no MQL5 / no cloud) - master poll "
        f"{MASTER_POLL_MS}ms, slave poll {SLAVE_POLL_MS}ms")
    http = await asyncio.start_server(http_handler, HTTP_HOST, HTTP_PORT)
    ENGINE_LOOP_REF = asyncio.get_running_loop()
    HTTP_SERVER_REF = http
    log("success", "engine", f"Dashboard/API on http://{HTTP_HOST}:{HTTP_PORT}")
    READY_SERVER.set()
    if os.environ.get("COPIER_DEMO", "").strip().lower() in {"1", "true", "yes"}:
        if not DB.q("SELECT id FROM terminals LIMIT 1"):
            seed_demo_terminals()
    try:
        auto_register_terminals(log_result=True)  # Windows: find installed terminals
    except Exception as e:
        log("error", "connection", f"terminal auto-scan failed: {e}")
    READY_SCAN.set()
    for t in DB.q("SELECT id FROM terminals"):
        ENGINE.start_terminal_tasks(t["id"])
    await ENGINE.reconcile_all(policy_override=settings["sync_on_start"])
    if console_mode:
        opened = open_dashboard()
        print_ready_banner(opened)
    try:
        async with http:
            await http.serve_forever()
    finally:
        await ENGINE.shutdown_bridges()


# ============================================================================
# DESKTOP APP MODE (default on Windows - no browser needed)
# ============================================================================

SPLASH_HTML = r"""<!doctype html>
<html dir="rtl" lang="fa"><head><meta charset="utf-8">
<title>Multi-MT5 Trade Copier</title>
<style>
  html,body{margin:0;height:100%;background:#09090b;font-family:'Segoe UI',Tahoma,Arial,sans-serif;overflow:hidden;user-select:none}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:26px;color:#e4e4e7}
  .logo{width:54px;height:54px;border-radius:14px;border:1px solid rgba(245,158,11,.45);background:rgba(245,158,11,.12);display:flex;align-items:center;justify-content:center}
  .logo svg{width:26px;height:26px;fill:#f59e0b}
  h1{font-size:15px;margin:0;font-weight:700;color:#fafafa}
  .sk{width:100%;max-width:290px;display:flex;flex-direction:column;gap:9px;margin-top:2px}
  .bar{height:11px;border-radius:6px;background:linear-gradient(90deg,#18181b 25%,#2d2d31 37%,#18181b 63%);background-size:400% 100%;animation:sh 1.25s ease infinite}
  .bar:nth-child(1){width:100%}.bar:nth-child(2){width:80%}.bar:nth-child(3){width:60%}.bar:nth-child(4){width:86%}
  @keyframes sh{0%{background-position:100% 50%}100%{background-position:0 50%}}
  .status{display:flex;align-items:center;gap:8px;font-size:12px;color:#a1a1aa;min-height:18px;margin-top:2px}
  .dot{width:8px;height:8px;border-radius:50%;background:#f59e0b;animation:pu 1s ease infinite;flex:none}
  @keyframes pu{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
  .foot{position:absolute;bottom:9px;inset-inline:0;text-align:center;font-size:10px;color:#52525b}
</style></head><body>
<div class="wrap">
  <div class="logo"><svg viewBox="0 0 24 24"><path d="M9.5 3h5v2.2h-1.4v3.6l4.9 5.4v3.6h1.3V20h-4.6v-2.2h1.1v-2.6l-4.8-5.3-4.8 5.3v2.6h1.1V20H2.7v-2.2H4v-3.6l4.9-5.4V5.2H8.5V3h1z"/></svg></div>
  <h1>کوپیر چندترمیناله MT5</h1>
  <div class="sk"><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
  <div class="status"><span class="dot"></span><span id="st">در حال راه‌اندازی...</span></div>
</div>
<div class="foot">نسخه ۲.۰.۰ · کاملاً محلی · بدون اکسپرت (EA) · بدون سرور ابری</div>
<script>window.__setStatus=function(t){var e=document.getElementById('st');if(e)e.textContent=t;};</script>
</body></html>"""


def gui_available() -> bool:
    """Desktop-app (native window) mode is the default on Windows."""
    if sys.platform != "win32":
        return False
    if "--browser" in sys.argv or "--console" in sys.argv:
        return False
    if browser_disabled():  # --no-browser / --headless / COPIER_NO_BROWSER=1
        return False
    try:
        import webview  # noqa: F401  (pywebview - WebView2 based native window)
        return True
    except Exception:
        return False


def _api_alive(timeout=1.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://{HTTP_HOST}:{HTTP_PORT}/api/state", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _engine_thread_main():
    """Run the whole engine inside a background thread for GUI mode."""
    try:
        asyncio.run(engine_main(console_mode=False))
    except Exception:
        tb = traceback.format_exc()
        ENGINE_FATAL["message"] = (tb.strip().splitlines() or ["unknown error"])[-1]
        try:
            err_dir = DB_PATH.parent
            err_dir.mkdir(parents=True, exist_ok=True)
            (err_dir / "engine-error.log").write_text(tb, encoding="utf-8")
        except Exception:
            pass
        log("error", "engine", f"Fatal error: {ENGINE_FATAL['message']}")


def _js_set_status(window, text: str) -> None:
    try:
        window.evaluate_js(f"window.__setStatus({json.dumps(text, ensure_ascii=False)})")
    except Exception:
        pass


def _stop_engine_thread(thread) -> None:
    """Gracefully stop the engine after the app window is closed."""
    loop = ENGINE_LOOP_REF
    try:
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(ENGINE.shutdown_bridges(), loop)
            srv = HTTP_SERVER_REF
            if srv:
                loop.call_soon_threadsafe(srv.close)
    except Exception:
        pass
    try:
        thread.join(timeout=3)
    except Exception:
        pass


def launch_desktop_app() -> bool:
    """Splash skeleton -> dashboard window, engine in a background thread.

    Returns True when the GUI ran and was closed by the user (process exits).
    Returns False when pywebview is unavailable (caller falls back to console).
    """
    try:
        import webview
    except Exception:
        return False
    log("info", "engine", "Desktop app mode: native window (no browser)")
    engine_thread = threading.Thread(target=_engine_thread_main, daemon=True)
    engine_thread.start()

    splash = webview.create_window(
        "Multi-MT5 Trade Copier", html=SPLASH_HTML, width=460, height=340,
        resizable=False, on_top=True, background_color="#09090b",
    )

    def updater():
        try:
            _js_set_status(splash, "راه‌اندازی موتور کپی...")
            if not READY_SERVER.wait(60):
                if ENGINE_FATAL["message"]:
                    _js_set_status(splash, "خطا در راه‌اندازی - جزئیات در db\\engine-error.log")
                else:
                    _js_set_status(splash, "در حال راه‌اندازی موتور... (کمی صبر کنید)")
                return
            _js_set_status(splash, "شناسایی ترمینال‌های متاتریدر ۵ نصب‌شده...")
            READY_SCAN.wait(60)
            _js_set_status(splash, "اتصال به ترمینال‌ها...")
            deadline = time.time() + 45
            while time.time() < deadline and not _api_alive():
                if ENGINE_FATAL["message"]:
                    _js_set_status(splash, "خطا در راه‌اندازی - جزئیات در db\\engine-error.log")
                    return
                time.sleep(0.3)
            _js_set_status(splash, "بارگذاری داشبورد...")
            time.sleep(0.4)
            webview.create_window(
                "Multi-MT5 Trade Copier", dashboard_url(), width=1440, height=920,
                min_size=(1024, 680), background_color="#09090b",
            )
            time.sleep(0.8)  # give the main window a moment to paint
            try:
                splash.destroy()
            except Exception:
                pass
        except Exception:
            pass

    threading.Thread(target=updater, daemon=True).start()
    try:
        webview.start()  # blocks until all windows are closed
    except Exception as e:
        log("error", "engine", f"native window failed ({e}) - falling back to browser")
        open_dashboard()
        try:
            while engine_thread.is_alive():
                time.sleep(1)
        except Exception:
            pass
        return True
    _stop_engine_thread(engine_thread)
    return True


if __name__ == "__main__":
    # Bridge worker mode: spawned by the engine as
    #   MT5CopierEngine.exe --bridge <cfg.json>
    # This must be checked BEFORE the double-launch guard below.
    if "--bridge" in sys.argv:
        idx = sys.argv.index("--bridge")
        cfg_path = sys.argv[idx + 1] if len(sys.argv) > idx + 1 else ""
        try:
            sys.exit(run_bridge_worker(cfg_path))
        except SystemExit:
            raise
        except Exception:
            traceback.print_exc(file=sys.stderr)
            sys.exit(2)

    # Friendly double-click guard: when the engine is already running, a
    # second launch opens the app window (or the browser) on the LIVE
    # dashboard instead of failing with a port error.
    if already_running():
        url = dashboard_url()
        if gui_available():
            try:
                import webview
                webview.create_window("Multi-MT5 Trade Copier", url, width=1440, height=920,
                                      min_size=(1024, 680), background_color="#09090b")
                webview.start()
                sys.exit(0)
            except Exception:
                pass
        print("Engine is already running - dashboard: " + url)
        if not browser_disabled():
            open_dashboard()
        try:
            input("Press Enter to exit...")
        except Exception:
            pass
        sys.exit(0)

    # Desktop-app mode (default on Windows): splash skeleton + dashboard
    # window, engine in the background. No browser, no black console.
    if gui_available():
        try:
            if launch_desktop_app():
                sys.exit(0)
        except Exception:
            traceback.print_exc(file=sys.stderr)

    # Classic console fallback (Linux/dev, --browser, --console, --headless,
    # or when pywebview is unavailable): engine console + optional browser.
    try:
        asyncio.run(engine_main(console_mode=True))
    except KeyboardInterrupt:
        log("warn", "engine", "Shutting down (Ctrl+C)")
    except Exception:
        # Keep the console open on a Windows double-click so the error is
        # actually visible, and persist the traceback next to the EXE.
        tb = traceback.format_exc()
        try:
            log("error", "engine", f"Fatal error: {tb.strip().splitlines()[-1]}")
        except Exception:
            pass
        try:
            err_dir = DB_PATH.parent
            err_dir.mkdir(parents=True, exist_ok=True)
            (err_dir / "engine-error.log").write_text(tb, encoding="utf-8")
        except Exception:
            pass
        print("\n" + "=" * 62)
        print("FATAL ERROR - full traceback saved to: db\\engine-error.log")
        print(tb)
        print("=" * 62)
        try:
            input("\nPress Enter to exit...")
        except Exception:
            pass
