#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Multi-MT5 Trade Copier - Central Engine (Windows production)
=============================================================

Connects to one MQL5 "MT5CopierEA" bridge per MetaTrader 5 terminal over
local TCP (127.0.0.1:8777, JSON lines) and copies trades from the terminal
configured as MASTER to all active SLAVE terminals.

Design goals (mirrors the TypeScript reference engine shipped in this repo):
  - Event-driven: reacts to EA OnTradeTransaction events (no polling loops).
  - Idempotent: copy_ops table has UNIQUE(slave_id, event_key); a retried or
    replayed event can never open a second order.
  - Restart-safe: full state lives in SQLite; on boot the engine restores
    terminals, settings and the open-position mirror, then reconciles.
  - Isolated: every slave is processed independently; a failing/slave
    offline path never blocks or breaks other slaves.
  - Local only: no cloud, no external traffic, no account passwords.

HTTP API (127.0.0.1:8321) implements the same REST contract the web
dashboard uses (see deploy/docs/API-CONTRACT.md) and serves the exported
dashboard from ./ui (if present).

Run:  python copier_engine.py          (or the packaged MT5CopierEngine.exe)
"""

import asyncio
import json
import os
import sqlite3
import sys
import time
import urllib.parse
from pathlib import Path

if getattr(sys, "frozen", False):
    # PyInstaller onedir: keep db/ and ui/ next to the EXE, not inside _internal/
    BASE = Path(sys.executable).resolve().parent
else:
    BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("COPIER_DB", BASE / "db" / "mt5copier.db"))
UI_DIR = Path(os.environ.get("COPIER_UI", BASE / "ui"))
TCP_HOST = "127.0.0.1"
TCP_PORT = int(os.environ.get("COPIER_TCP_PORT", "8777"))
HTTP_HOST = "127.0.0.1"
HTTP_PORT = int(os.environ.get("COPIER_HTTP_PORT", "8321"))

now_ms = lambda: int(time.time() * 1000)  # noqa: E731

# ----------------------------------------------------------------------------
# Database (SQLite, single writer guarded by a threading lock; accessed from
# asyncio handlers which are all on one thread - the lock is belt & braces)
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


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.cx = sqlite3.connect(str(path), check_same_thread=False)
        self.cx.row_factory = sqlite3.Row
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


def log(level: str, category: str, message: str, terminal_id="", terminal_name="", details=""):
    DB.x(
        "INSERT INTO logs (ts, level, category, terminal_id, terminal_name, message, details) VALUES (?,?,?,?,?,?,?)",
        (now_ms(), level, category, terminal_id, terminal_name, message, details),
    )
    print(f"[{time.strftime('%H:%M:%S')}] {level.upper():7} {category:10} {message}" + (f" | {details}" if details else ""))


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
# Lot calculation + filters (mirror of the TypeScript engine)
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


# ----------------------------------------------------------------------------
# Terminal sessions (one TCP connection per MT5 terminal / EA)
# ----------------------------------------------------------------------------

class Session:
    def __init__(self, engine, reader, writer):
        self.engine = engine
        self.reader = reader
        self.writer = writer
        self.terminal_id = None
        self.account = None
        self.info = {}
        self.specs = {}
        self.pending_acks = {}
        self.alive = True

    async def send(self, obj: dict):
        try:
            self.writer.write((json.dumps(obj) + "\n").encode())
            await self.writer.drain()
        except Exception:
            self.alive = False

    async def command(self, obj: dict, timeout=10.0):
        """Send a command and wait for the EA ack (matched by eventKey)."""
        key = obj.get("eventKey") or f"cmd:{now_ms()}:{id(obj)}"
        obj = dict(obj)
        obj["eventKey"] = key
        fut = asyncio.get_event_loop().create_future()
        self.pending_acks[key] = fut
        await self.send(obj)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return {"ok": False, "error": "ack timeout", "code": "timeout", "at": now_ms()}
        finally:
            self.pending_acks.pop(key, None)

    # -- inbound ------------------------------------------------------------

    async def run(self):
        engine = self.engine
        buf = b""
        try:
            while self.alive:
                chunk = await self.reader.read(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        try:
                            await self.handle(json.loads(line.decode("utf-8", "replace")))
                        except Exception as e:
                            log("error", "engine", f"message handling failed: {e}")
        except Exception:
            pass
        finally:
            engine.session_closed(self)

    async def handle(self, msg: dict):
        engine = self.engine
        mtype = msg.get("type")
        if mtype == "hello":
            self.info = msg
            self.account = str(msg.get("account", ""))
            self.specs = {s.get("symbol", "").upper(): s for s in msg.get("specs", []) if isinstance(s, dict)}
            engine.register_session(self)
        elif mtype == "heartbeat":
            if self.terminal_id:
                engine.update_account(self.terminal_id, msg)
        elif mtype == "event":
            if self.terminal_id:
                await engine.on_event(self.terminal_id, msg)
        elif mtype == "ack":
            fut = self.pending_acks.pop(msg.get("eventKey", ""), None)
            if fut and not fut.done():
                fut.set_result(msg)
        elif mtype == "snapshot":
            if self.terminal_id:
                engine.ingest_snapshot(self.terminal_id, msg)


# ----------------------------------------------------------------------------
# The Copier Engine
# ----------------------------------------------------------------------------

class Engine:
    def __init__(self):
        self.sessions = {}          # terminal_id -> Session
        self.account_index = {}     # account -> terminal_id
        self.db = DB

    # -- session registry ---------------------------------------------------

    def register_session(self, session: Session):
        account = session.account
        tid = self.account_index.get(account)
        if not tid:
            row = DB.one("SELECT id FROM terminals WHERE account_number=?", (account,))
            tid = row["id"] if row else None
        if not tid:
            name = session.info.get("terminal") or f"MT5-{account}"
            tid = f"t{now_ms()}{len(self.sessions)}"
            DB.x(
                "INSERT INTO terminals (id, name, broker, server, account_number, currency, status, last_seen, balance, equity, free_margin, leverage) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (tid, name, session.info.get("broker", ""), session.info.get("server", ""),
                 account, session.info.get("currency", "USD"), "connected", now_ms(),
                 float(session.info.get("balance", 0)), float(session.info.get("equity", 0)),
                 float(session.info.get("balance", 0)), int(session.info.get("leverage", 100))),
            )
            ensure_slave_settings(tid)
            log("success", "connection", f"Terminal registered: {name} (account {account})")
        self.account_index[account] = tid
        session.terminal_id = tid
        self.sessions[tid] = session
        # update identity + status
        DB.x("UPDATE terminals SET status='connected', last_seen=?, broker=COALESCE(NULLIF(?,''),broker), server=COALESCE(NULLIF(?,''),server) WHERE id=?",
             (now_ms(), session.info.get("broker", ""), session.info.get("server", ""), tid))
        prev = DB.one("SELECT status FROM terminals WHERE id=?", (tid,))
        self.set_status(tid, "connected", log_it=(prev and prev["status"] != "connected"))
        # request a snapshot to rebuild the position mirror
        asyncio.ensure_future(session.command({"kind": "snapshot"}, timeout=8))
        log("success", "connection", f"Terminal connected: {DB.one('SELECT name FROM terminals WHERE id=?', (tid,))['name']}")

    def session_closed(self, session: Session):
        tid = session.terminal_id
        if tid and self.sessions.get(tid) is session:
            del self.sessions[tid]
            self.set_status(tid, "disconnected", log_it=True)
            name = DB.one("SELECT name FROM terminals WHERE id=?", (tid,))
            log("error", "connection", f"Terminal disconnected: {name['name'] if name else tid}")

    def set_status(self, tid, status, log_it=False):
        prev = DB.one("SELECT status, reconnect_count FROM terminals WHERE id=?", (tid,))
        if not prev:
            return
        data = {"status": status, "last_seen": now_ms()}
        rc = prev["reconnect_count"]
        if status == "connected" and prev["status"] in ("reconnecting", "disconnected", "error"):
            rc += 1
            DB.x("UPDATE terminals SET reconnect_count=? WHERE id=?", (rc, tid))
        DB.x("UPDATE terminals SET status=?, last_seen=? WHERE id=?", (status, data["last_seen"], tid))
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

    # -- snapshot ingestion (ledger mirror) ----------------------------------

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
            DB.x(
                "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(terminal_id, ticket) DO UPDATE SET current_price=excluded.current_price, volume=excluded.volume, sl=excluded.sl, tp=excluded.tp, profit=excluded.profit",
                (tid, tk, p.get("symbol", ""), p.get("side", "buy"), p.get("kind", "position"),
                 p.get("pendingType", ""), float(p.get("volume", 0)), float(p.get("openPrice", 0)),
                 float(p.get("currentPrice", p.get("openPrice", 0))), float(p.get("sl", 0)),
                 float(p.get("tp", 0)), float(p.get("profit", 0)), int(p.get("openTime", 0)),
                 self.master_ticket_from_comment(p.get("comment", "")), 1 if self.master_ticket_from_comment(p.get("comment", "")) else 0),
            )
        if self.master_id() and tid != self.master_id() and DB.one("SELECT role FROM terminals WHERE id=?", (tid,))["role"] == "slave":
            asyncio.ensure_future(self.reconcile_slave(tid, trigger="snapshot"))

    @staticmethod
    def master_ticket_from_comment(comment: str) -> str:
        # comment format: "MC:<eventKey>" where eventKey contains master ticket
        if comment and comment.startswith("MC:"):
            key = comment[3:]
            parts = key.split(":")
            if len(parts) >= 2:
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

    # -- event ingress --------------------------------------------------------

    async def on_event(self, tid, evt):
        try:
            role = (DB.one("SELECT role, name FROM terminals WHERE id=?", (tid,)) or {}).get("role")
            DB.x("UPDATE app_settings SET last_event_at=? WHERE id='singleton'", (now_ms(),))
            event = evt.get("event")
            if role == "master":
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
                elif event == "pending_filled":
                    DB.x("UPDATE positions SET kind='position', open_price=COALESCE(?,open_price), current_price=COALESCE(?,open_price) WHERE terminal_id=? AND ticket=? AND kind='pending'",
                         (evt.get("price", 0), evt.get("price", 0), tid, str(evt.get("ticket"))))
                    log("info", "trade", f"Master pending #{evt.get('ticket')} filled")
            else:
                self.handle_slave_ledger(tid, evt)
        except Exception as e:
            log("error", "engine", f"event handling failed: {e}", details=str(evt))

    # -- master event handlers ------------------------------------------------

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
            spec = self.spec_for(sid, mapped)
            open_count = DB.one("SELECT COUNT(*) c FROM positions WHERE terminal_id=? AND kind='position'", (sid,))["c"]
            code, reason = check_filters(slave, s, symbol, side, kind, spec, open_count)
            if code:
                return fail("skipped", code, reason)
            sl_dist = abs(float(evt.get("price", 0)) - float(evt.get("sl", 0))) / max(spec["point"], 1e-9) if evt.get("sl") else 0
            vol, err = calc_volume(s["lot_mode"], float(evt.get("volume", 0)), master["balance"],
                                   slave["equity"], s, sl_dist, spec)
            if err:
                return fail("failed", "invalid_volume", err, metric=True)
            session = self.sessions.get(sid)
            if not session or not session.alive:
                return fail("failed", "offline", "Slave terminal is not connected", metric=True)

            cmd = {
                "kind": "open", "symbol": mapped, "side": side, "volume": vol,
                "sl": float(evt.get("sl", 0)) if s["copy_sl"] else 0,
                "tp": float(evt.get("tp", 0)) if s["copy_tp"] else 0,
                "masterTicket": str(evt.get("ticket")),
            }
            sent = now_ms()
            DB.x("UPDATE copy_ops SET status='sent', sent_at=? WHERE id=?", (sent, op_id))
            res = await session.command(cmd)
            ack, done = int(res.get("at", now_ms())), now_ms()
            if res.get("ok") and res.get("ticket"):
                sticket = str(res.get("ticket"))
                DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, ack_at=?, done_at=?, latency_ms=?, total_ms=? WHERE id=?",
                     (sticket, ack, done, ack - detected, done - detected, op_id))
                DB.x(
                    "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id, ticket) DO NOTHING",
                    (sid, sticket, mapped, side, "position", "", vol, float(res.get("price") or evt.get("price", 0)),
                     float(res.get("price") or evt.get("price", 0)),
                     float(evt.get("sl", 0)) if s["copy_sl"] else 0,
                     float(evt.get("tp", 0)) if s["copy_tp"] else 0, 0, done, str(evt.get("ticket")), 1),
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
                continue
            if not slave_pos:
                miss("missed", "no_position", "no copied position on slave")
                continue
            if action == "close" and not s["close_on_master_close"]:
                miss("skipped", "close_disabled", "closeOnMasterClose disabled")
                continue
            session = self.sessions.get(sid)
            if not session or not session.alive:
                miss("failed", "offline", "slave offline")
                continue
            vol = float(evt.get("closedVolume", 0))
            if partial:
                ratio = (slave_pos["volume"] / max(float(evt.get("preVolume") or (float(evt.get("volume", 0)) + float(evt.get("closedVolume", 0)))), 1e-9))
                vol = min(slave_pos["volume"], max(0.01, round(slave_pos["volume"] * ratio, 2)))
            sent = now_ms()
            DB.x("UPDATE copy_ops SET status='sent', sent_at=? WHERE id=?", (sent, op_id))
            res = await session.command({
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
            session = self.sessions.get(sid)
            if not session or not session.alive:
                DB.x("UPDATE copy_ops SET status='failed', fail_code='offline', fail_reason='slave offline', done_at=? WHERE id=?", (now_ms(), op_id))
                continue
            res = await session.command({
                "kind": "modify_sltp", "ticket": slave_pos["ticket"], "symbol": slave_pos["symbol"],
                "sl": float(evt.get("sl", 0)) if s["copy_sl"] else 0,
                "tp": float(evt.get("tp", 0)) if s["copy_tp"] else 0,
            })
            if res.get("ok"):
                DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, done_at=?, latency_ms=? WHERE id=?",
                     (slave_pos["ticket"], now_ms(), now_ms() - detected, op_id))
                DB.x("UPDATE positions SET sl=?, tp=? WHERE terminal_id=? AND ticket=?",
                     (float(evt.get("sl", 0)) if s["copy_sl"] else 0,
                      float(evt.get("tp", 0)) if s["copy_tp"] else 0, sid, slave_pos["ticket"]))
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
            session = self.sessions.get(sid)
            if not session or not session.alive:
                DB.x("UPDATE copy_ops SET status='failed', fail_code='offline', fail_reason='slave offline', done_at=? WHERE id=?", (now_ms(), op_id))
                continue
            if placed:
                mapped = parse_mapping(s["symbol_mapping"]).get(evt.get("symbol", "").upper(), evt.get("symbol", "").upper())
                spec = self.spec_for(sid, mapped)
                code, reason = (None, None)
                if not spec:
                    code, reason = "unknown_symbol", "symbol not found after mapping"
                vol = None
                if not code:
                    vol, reason = calc_volume(s["lot_mode"], float(evt.get("volume", 0)),
                                              DB.one("SELECT balance FROM terminals WHERE id=?", (tid,))["balance"],
                                              slave["equity"], s, 0, spec)
                    code = "invalid_volume" if reason else None
                if code:
                    DB.x("UPDATE copy_ops SET status='skipped', fail_code=?, fail_reason=?, done_at=? WHERE id=?", (code, reason, now_ms(), op_id))
                    continue
                res = await session.command({
                    "kind": "place_pending", "symbol": mapped, "side": evt.get("side", "buy"),
                    "volume": vol, "price": evt.get("price", 0), "pendingType": evt.get("pendingType", ""),
                    "sl": float(evt.get("sl", 0)) if s["copy_sl"] else 0,
                    "tp": float(evt.get("tp", 0)) if s["copy_tp"] else 0,
                    "masterTicket": ticket,
                })
            else:
                slave_pending = DB.one("SELECT * FROM positions WHERE terminal_id=? AND master_ticket=? AND kind='pending'", (sid, ticket))
                if not slave_pending:
                    DB.x("UPDATE copy_ops SET status='missed', fail_code='no_order', fail_reason='no pending on slave', done_at=? WHERE id=?", (now_ms(), op_id))
                    continue
                res = await session.command({"kind": "cancel_pending", "ticket": slave_pending["ticket"], "symbol": slave_pending["symbol"]})
                DB.x("DELETE FROM positions WHERE terminal_id=? AND ticket=?", (sid, slave_pending["ticket"]))
            if res.get("ok") and res.get("ticket"):
                DB.x("UPDATE copy_ops SET status='executed', slave_ticket=?, done_at=?, latency_ms=? WHERE id=?",
                     (str(res.get("ticket")), now_ms(), now_ms() - detected, op_id))
                if placed:
                    DB.x(
                        "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id, ticket) DO NOTHING",
                        (sid, str(res.get("ticket")), mapped, evt.get("side", "buy"), "pending",
                         evt.get("pendingType", ""), vol, float(evt.get("price", 0)), float(evt.get("price", 0)),
                         float(evt.get("sl", 0)) if s["copy_sl"] else 0,
                         float(evt.get("tp", 0)) if s["copy_tp"] else 0, 0, now_ms(), ticket, 1),
                    )
            else:
                DB.x("UPDATE copy_ops SET status='failed', fail_code=?, fail_reason=?, done_at=? WHERE id=?",
                     (res.get("code", "broker_reject"), res.get("error", ""), now_ms(), op_id))

    # -- slave-side events (ledger accuracy only) ------------------------------

    def handle_slave_ledger(self, tid, evt):
        event = evt.get("event")
        ticket = str(evt.get("ticket"))
        if event == "position_opened" or event == "pending_filled":
            exists = DB.one("SELECT master_ticket FROM positions WHERE terminal_id=? AND ticket=?", (tid, ticket))
            if exists and not exists["master_ticket"]:
                log("info", "trade", f"Slave opened own trade (not copied): {evt.get('side')} {evt.get('symbol')} {evt.get('volume')}", tid)
        elif event == "position_closed":
            pos = DB.one("SELECT master_ticket FROM positions WHERE terminal_id=? AND ticket=?", (tid, ticket))
            self.move_to_closed(tid, ticket, reason=evt.get("closeReason", "manual"), close_price=evt.get("price"))
            if pos and pos["master_ticket"] and self.master_id():
                master_open = DB.one("SELECT ticket FROM positions WHERE terminal_id=? AND ticket=?", (self.master_id(), pos["master_ticket"]))
                if master_open:
                    log("warn", "sync", f"Slave closed copied position {ticket} while master #{pos['master_ticket']} still open (drift)", tid)
        elif event == "partial_closed":
            DB.x("UPDATE positions SET volume=? WHERE terminal_id=? AND ticket=?", (float(evt.get("volume", 0)), tid, ticket))
        elif event == "sltp_modified":
            DB.x("UPDATE positions SET sl=?, tp=? WHERE terminal_id=? AND ticket=?",
                 (float(evt.get("sl", 0)), float(evt.get("tp", 0)), tid, ticket))
        elif event == "pending_placed":
            DB.x(
                "INSERT INTO positions (terminal_id, ticket, symbol, side, kind, pending_type, volume, open_price, current_price, sl, tp, profit, open_time, master_ticket, copied_by_engine) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(terminal_id, ticket) DO NOTHING",
                (tid, ticket, evt.get("symbol", ""), evt.get("side", "buy"), "pending",
                 evt.get("pendingType", ""), float(evt.get("volume", 0)), float(evt.get("price", 0)),
                 float(evt.get("price", 0)), float(evt.get("sl", 0)), float(evt.get("tp", 0)), 0, now_ms(), "", 0),
            )
        elif event == "pending_cancelled":
            DB.x("DELETE FROM positions WHERE terminal_id=? AND ticket=? AND kind='pending'", (tid, ticket))

    # -- reconciliation ---------------------------------------------------------

    def spec_for(self, sid, symbol):
        session = self.sessions.get(sid)
        if session:
            return session.specs.get(symbol.upper())
        return None

    async def reconcile_slave(self, sid, trigger="manual"):
        """Report (or auto-fix per policy) drift between master and a slave."""
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
                session = self.sessions.get(sid)
                if sp and session and session.alive:
                    res = await session.command({"kind": "close", "ticket": sp["ticket"], "symbol": sp["symbol"]})
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

    # -- global controls ---------------------------------------------------------

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
            session = self.sessions.get(mid)
            if session:
                for p in DB.q("SELECT * FROM positions WHERE terminal_id=? AND kind='position'", (mid,)):
                    await session.command({"kind": "close", "ticket": p["ticket"], "symbol": p["symbol"], "masterTicket": p["ticket"]})
                log("warn", "trade", "Emergency: closed master positions")
        if policy == "halt_close_all":
            for slave in DB.q("SELECT * FROM terminals WHERE role='slave'"):
                session = self.sessions.get(slave["id"])
                if not session:
                    continue
                for p in DB.q("SELECT * FROM positions WHERE terminal_id=? AND kind='position'", (slave["id"],)):
                    await session.command({"kind": "close", "ticket": p["ticket"], "symbol": p["symbol"]})
            log("warn", "trade", "Emergency: closed all slave positions")

    # -- dashboard snapshot ---------------------------------------------------------

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
# TCP server
# ----------------------------------------------------------------------------

async def handle_ea(reader, writer):
    session = Session(ENGINE, reader, writer)
    await session.run()
    try:
        writer.close()
    except Exception:
        pass


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
    DB.x("INSERT INTO terminals (id, name, broker, server, exe_path) VALUES (?,?,?,?,?)",
         (tid, body.get("name", "Manual Terminal"), body.get("broker", ""), body.get("server", ""), body.get("exePath", "")))
    ensure_slave_settings(tid)
    log("success", "settings", f"Terminal added: {body.get('name')}")
    return jbody({"id": tid}, 201)


@route("PATCH", "/api/terminals")
async def api_terminals_patch(req):
    # /api/terminals/{id} handled below via path splitting in http handler
    return jbody({"error": "not found"}, 404)


async def api_terminal_patch(tid, req):
    body = req["json"]
    action = body.get("action")
    value = body.get("value")
    if action == "connect":
        ENGINE.set_status(tid, "connecting")
        log("info", "connection", "Manual connect requested (waiting for EA socket)", tid)
    elif action == "disconnect":
        session = ENGINE.sessions.get(tid)
        if session:
            session.alive = False
        ENGINE.set_status(tid, "disconnected")
    elif action == "setRole":
        role = value if value in ("master", "slave", "none") else "none"
        if role == "master":
            DB.x("UPDATE terminals SET role='slave' WHERE role='master'")
        DB.x("UPDATE terminals SET role=? WHERE id=?", (role, tid))
        log("info", "settings", f"Role changed to {role}", tid)
    elif action == "enable":
        DB.x("UPDATE terminals SET enabled=1 WHERE id=?", (tid,))
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
    return jbody({"error": "Simulator is not available on the real Windows engine; use demo accounts in the MT5 terminals."}, 409)


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
        key = (method, "/" + "/".join(segments[:2]))
        args = ()
        if (method, parsed.path) in HTTP_ROUTES:
            handler = HTTP_ROUTES[(method, parsed.path)]
        elif len(segments) >= 3 and segments[:1] == ["api", "terminals"] or (len(segments) >= 3 and segments[1] == "terminals"):
            tid = segments[2]
            rest = segments[3:]
            if method == "PATCH":
                handler = api_terminal_patch
                args = (tid,)
            elif method == "DELETE":
                DB.x("DELETE FROM terminals WHERE id=?", (tid,))
                log("warn", "settings", f"Terminal removed {tid}")
                handler = None
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
            try:
                status, ctype, data = await handler({
                    "query": urllib.parse.parse_qs(parsed.query),
                    "json": json.loads(body_bytes.decode("utf-8") or "{}"),
                }, *args) if args else await handler({
                    "query": urllib.parse.parse_qs(parsed.query),
                    "json": json.loads(body_bytes.decode("utf-8") or "{}"),
                })
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
# Main
# ----------------------------------------------------------------------------

async def main():
    settings = get_settings()
    DB.x("UPDATE app_settings SET engine_running=1, booted_at=? WHERE id='singleton'", (now_ms(),))
    for t in DB.q("SELECT id, status FROM terminals"):
        if t["status"] == "connected":
            DB.x("UPDATE terminals SET status='reconnecting' WHERE id=?", (t["id"],))
    log("info", "engine", f"Engine starting (db: {DB_PATH})")
    await ENGINE.reconcile_all(policy_override=settings["sync_on_start"])
    tcp = await asyncio.start_server(handle_ea, TCP_HOST, TCP_PORT)
    http = await asyncio.start_server(http_handler, HTTP_HOST, HTTP_PORT)
    log("success", "engine", f"TCP bridge listening on {TCP_HOST}:{TCP_PORT}")
    log("success", "engine", f"Dashboard/API on http://{HTTP_HOST}:{HTTP_PORT}")
    async with tcp, http:
        await asyncio.gather(tcp.serve_forever(), http.serve_forever())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("warn", "engine", "Shutting down (Ctrl+C)")
