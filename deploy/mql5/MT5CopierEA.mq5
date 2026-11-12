//+------------------------------------------------------------------+
//|                                                 MT5CopierEA.mq5 |
//|                          Multi-MT5 Trade Copier - Terminal Bridge |
//+------------------------------------------------------------------+
//| PURPOSE                                                          |
//|   A single Expert Advisor used on BOTH master and slave          |
//|   MetaTrader 5 terminals. The EA itself never decides anything:  |
//|     - it reports every trade event of its account to the         |
//|       central engine (position open/close/partial, SL/TP         |
//|       modification, pending place/cancel),                       |
//|     - it executes trade commands received from the engine        |
//|       (open, close, partial, modify_sltp, place_pending,         |
//|       cancel_pending).                                           |
//|   Whether this terminal is a master or a slave is decided by     |
//|   the central Python engine (configured in the dashboard),       |
//|   therefore this EA has NO master/slave inputs.                  |
//|                                                                  |
//| PROTOCOL (local TCP 127.0.0.1:8777, one persistent socket,       |
//| JSON lines: every message is one line terminated by "\n")        |
//|   EA -> engine : hello | heartbeat | event | ack | snapshot |    |
//|                  symbol_info | pong | bye                        |
//|   engine -> EA : {"kind":"open"|"close"|"partial"|               |
//|                  "modify_sltp"|"place_pending"|                  |
//|                  "cancel_pending"|"snapshot"|"symbol_info"|      |
//|                  "ping"}                                         |
//|                                                                  |
//| INSTALLATION                                                     |
//|   1. Copy this file into <MT5 Data Folder>\MQL5\Experts\         |
//|      (MetaTrader 5 menu: File -> Open Data Folder).              |
//|   2. Open it in MetaEditor and press F7 (Compile). It uses only  |
//|      the standard library include <Trade/Trade.mqh>.             |
//|   3. In the terminal open Tools -> Options -> Expert Advisors:   |
//|        - enable "Allow WebRequest for listed URL"                |
//|        - add the entry:  127.0.0.1                               |
//|      (MQL5 socket functions require the host to be listed).      |
//|   4. Enable the "Algo Trading" button on the toolbar.            |
//|   5. Attach the EA to ANY ONE chart of the terminal (any symbol, |
//|      any timeframe - it trades whatever the engine commands).    |
//|      Use exactly ONE EA per terminal, never on two charts.       |
//|      No DLL imports are needed. Account passwords are never      |
//|      read or stored. All traffic stays on 127.0.0.1.             |
//|   6. On start the EA connects to the engine automatically and    |
//|      keeps reconnecting with backoff if the engine is offline.   |
//|      The chart shows a small status text in the top-left corner. |
//|                                                                  |
//| RELIABILITY NOTES                                                |
//|   - OnTradeTransaction only BUILDS a JSON line and queues it;    |
//|     the actual socket write happens in OnTimer, so the event     |
//|     handler never blocks.                                        |
//|   - Events queued while the engine is offline are flushed on     |
//|     reconnect; entries older than InpEventMaxAgeMs are dropped   |
//|     because the engine reconciles state from fresh snapshots.    |
//|   - Copy idempotency layer 1 (EA side): before executing an      |
//|     "open"/"place_pending" command, existing positions/orders    |
//|     are scanned for the exact comment "TAG:eventKey"; if found,  |
//|     the EA acknowledges the EXISTING ticket instead of sending   |
//|     a duplicate order to the broker. Layer 2 (engine side) is    |
//|     the UNIQUE(slave,eventKey) constraint in the copy_ops table. |
//+------------------------------------------------------------------+
#property copyright "Multi-MT5 Trade Copier"
#property link      "local deployment only"
#property version   "1.00"
#property description "Local bridge EA for the Multi-MT5 Trade Copier engine."
#property description "Talks to the central engine over 127.0.0.1 TCP (JSON lines)."
#property description "One EA per terminal. Master/slave role is engine-side."

#include <Trade/Trade.mqh>

//--- inputs ---------------------------------------------------------
input string InpServerHost     = "127.0.0.1"; // Engine host (keep local)
input int    InpServerPort     = 8777;        // Engine TCP port
input int    InpReconnectMs    = 1000;        // Base reconnect delay (ms)
input int    InpHeartbeatMs    = 250;         // Timer interval / heartbeat (ms)
input long   InpMagicCopied    = 777001;      // Magic number for copied orders
input string InpCommentTag     = "MC";        // Order comment tag prefix
input int    InpSlippage       = 20;          // Deviation for market orders (points)
input int    InpEventMaxAgeMs  = 60000;       // Drop queued events older than this
input int    InpMaxOutQueue    = 256;         // Max queued outbound messages

#define EA_VERSION  "1.0.0"

//--- globals --------------------------------------------------------
CTrade   g_trade;
int      g_socket          = INVALID_HANDLE;
string   g_gvName          = "";
uchar    g_rxBuf[];                   // inbound byte buffer (frame by \n)
string   g_outText[];                 // outbound queue (parallel arrays)
ulong    g_outEnq[];
ulong    g_nextConnectMs   = 0;
int      g_backoff         = 0;
ulong    g_lastHbMs        = 0;
int      g_eventsSent      = 0;

//+------------------------------------------------------------------+
//| Small helpers                                                    |
//+------------------------------------------------------------------+
ulong TickMs()
  {
   return GetTickCount64();
  }

long ServerMs()
  {
   datetime t = TimeTradeServer();
   if(t <= 0)
      t = TimeCurrent();
   return ((long)t) * 1000;
  }

string LocalEventKey()
  {
   return StringFormat("l%I64u", GetTickCount64());
  }

string TickStr(const ulong ticket)
  {
   return StringFormat("%I64u", ticket);
  }

int DigitsOfStep(const double step)
  {
   double s = step;
   if(s <= 0.0)
      return 2;
   int d = 0;
   while(d < 8)
     {
      double r = MathRound(s);
      if(MathAbs(s - r) < 0.0000001)
         break;
      s *= 10.0;
      d++;
     }
   return d;
  }

double NormPrice(const string symbol, const double price)
  {
   if(price <= 0.0)
      return 0.0;
   int dg = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   return NormalizeDouble(price, dg);
  }

double NormVolume(const string symbol, const double volume)
  {
   double vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(vmin <= 0.0)
      return 0.0;
   double v = volume;
   if(step > 0.0)
      v = MathRound(v / step) * step;
   if(v > vmax)
      v = vmax;
   if(v < vmin)
      v = vmin;
   return NormalizeDouble(v, DigitsOfStep(step));
  }

string CommentTag()
  {
   return (StringLen(InpCommentTag) > 0 ? InpCommentTag : "MC");
  }

string BuildComment(const string eventKey)
  {
   string tag = CommentTag();
   int maxKey = 31 - (StringLen(tag) + 1);
   if(maxKey < 1)
      maxKey = 1;
   string key = eventKey;
   if(StringLen(key) > maxKey)
      key = StringSubstr(key, 0, maxKey);
   return tag + ":" + key;
  }

//+------------------------------------------------------------------+
//| Tiny manual JSON builder / parser (flat objects only)            |
//+------------------------------------------------------------------+
string JsonEscape(const string s)
  {
   string out = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '"')       out += "\\\"";
      else if(c == '\\') out += "\\\\";
      else if(c == '\n') out += "\\n";
      else if(c == '\r') out += "\\r";
      else if(c == '\t') out += "\\t";
      else               out += ShortToString(c);
     }
   return out;
  }

string JStr(const string s)
  {
   return "\"" + JsonEscape(s) + "\"";
  }

// returns raw value token of "key": ... ("" when missing)
string JsonField(const string json, const string key)
  {
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0)
      return "";
   int L = StringLen(json);
   p = StringFind(json, ":", p + StringLen(pat));
   if(p < 0)
      return "";
   p++;
   while(p < L)
     {
      ushort c = StringGetCharacter(json, p);
      if(c == ' ' || c == '\t' || c == '\r' || c == '\n')
        {
         p++;
         continue;
        }
      break;
     }
   if(p >= L)
      return "";
   ushort c0 = StringGetCharacter(json, p);
   if(c0 == '"')
     {
      string out = "";
      int e = p + 1;
      while(e < L)
        {
         ushort ch = StringGetCharacter(json, e);
         if(ch == '\\' && e + 1 < L)
           {
            ushort n2 = StringGetCharacter(json, e + 1);
            if(n2 == '"')      { out += "\""; e += 2; continue; }
            if(n2 == '\\')     { out += "\\"; e += 2; continue; }
            if(n2 == 'n')      { out += "\n"; e += 2; continue; }
            if(n2 == 't')      { out += "\t"; e += 2; continue; }
            if(n2 == 'r')      { out += "\r"; e += 2; continue; }
            out += ShortToString(ch);
            e++;
            continue;
           }
         if(ch == '"')
            break;
         out += ShortToString(ch);
         e++;
        }
      return out;
     }
   int e = p;
   while(e < L)
     {
      ushort ch = StringGetCharacter(json, e);
      if(ch == ',' || ch == '}' || ch == ']' ||
         ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t')
         break;
      e++;
     }
   return StringSubstr(json, p, e - p);
  }

double JsonNumField(const string json, const string key, const double def)
  {
   string v = JsonField(json, key);
   if(StringLen(v) == 0)
      return def;
   return StringToDouble(v);
  }

bool JsonHas(const string json, const string key)
  {
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0)
      return false;
   int q = StringFind(json, ":", p + StringLen(pat));
   return (q >= 0);
  }

//+------------------------------------------------------------------+
//| Symbol helpers                                                   |
//+------------------------------------------------------------------+
bool IsPendingType(const long type)
  {
   return (type == ORDER_TYPE_BUY_LIMIT  || type == ORDER_TYPE_SELL_LIMIT ||
           type == ORDER_TYPE_BUY_STOP   || type == ORDER_TYPE_SELL_STOP  ||
           type == ORDER_TYPE_BUY_STOP_LIMIT || type == ORDER_TYPE_SELL_STOP_LIMIT);
  }

string PendingTypeFromOrder(const long type)
  {
   switch(type)
     {
      case ORDER_TYPE_BUY_LIMIT:      return "buylimit";
      case ORDER_TYPE_SELL_LIMIT:     return "selllimit";
      case ORDER_TYPE_BUY_STOP:       return "buystop";
      case ORDER_TYPE_SELL_STOP:      return "sellstop";
      case ORDER_TYPE_BUY_STOP_LIMIT: return "buystoplimit";
      case ORDER_TYPE_SELL_STOP_LIMIT:return "sellstoplimit";
     }
   return "";
  }

string SideFromPending(const long type)
  {
   if(type == ORDER_TYPE_BUY_LIMIT || type == ORDER_TYPE_BUY_STOP ||
      type == ORDER_TYPE_BUY_STOP_LIMIT)
      return "buy";
   return "sell";
  }

string ReasonFromDeal(const long reason)
  {
   switch(reason)
     {
      case DEAL_REASON_SL:     return "sl";
      case DEAL_REASON_TP:     return "tp";
      case DEAL_REASON_SO:     return "stopout";
      case DEAL_REASON_EXPERT: return "expert";
     }
   return "manual";
  }

double MarketPrice(const string symbol)
  {
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   if(bid > 0.0)
      return bid;
   return SymbolInfoDouble(symbol, SYMBOL_ASK);
  }

string SymbolSpecJson(const string sym)
  {
   double vmin  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   long   dg    = SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double bid   = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask   = SymbolInfoDouble(sym, SYMBOL_ASK);
   double spread = 0.0;
   if(point > 0.0)
      spread = (ask - bid) / point;
   double cs = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   double tv = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tsz= SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   string js = "{";
   js += "\"symbol\":" + JStr(sym);
   js += ",\"volumeMin\":" + DoubleToString(vmin, 2);
   js += ",\"volumeMax\":" + DoubleToString(vmax, 2);
   js += ",\"volumeStep\":" + DoubleToString(vstep, 8);
   js += ",\"spreadPoints\":" + DoubleToString(spread, 0);
   js += ",\"contractSize\":" + DoubleToString(cs, 2);
   js += ",\"tickValue\":" + DoubleToString(tv, 8);
   js += ",\"tickSize\":" + DoubleToString(tsz, 8);
   js += ",\"digits\":" + IntegerToString(dg);
   js += ",\"point\":" + DoubleToString(point, 8);
   js += "}";
   return js;
  }

string AllSpecsJson()
  {
   string out = "";
   int total = SymbolsTotal(true);       // Market Watch only
   int max = total;
   if(max > 256)
      max = 256;
   int added = 0;
   for(int i = 0; i < max; i++)
     {
      string sym = SymbolName(i, true);
      if(StringLen(sym) == 0)
         continue;
      if(added > 0)
         out += ",";
      out += SymbolSpecJson(sym);
      added++;
     }
   return out;
  }

string ReqIdPart(const string reqId)
  {
   if(StringLen(reqId) == 0)
      return "";
   return ",\"reqId\":" + JStr(reqId);
  }

//+------------------------------------------------------------------+
//| Outbound queue (events are queued, flushed from OnTimer)         |
//| NOTE: arrays of structs with strings cannot be used with         |
//| ArrayRemove, therefore two parallel arrays + manual shift.       |
//+------------------------------------------------------------------+
void QueueOut(const string text)
  {
   int n = ArraySize(g_outText);
   if(n >= InpMaxOutQueue)
     {
      Print("[MT5CopierEA] outbound queue full, dropping oldest message");
      for(int i = 1; i < n; i++)
        {
         g_outText[i - 1] = g_outText[i];
         g_outEnq[i - 1]  = g_outEnq[i];
        }
      ArrayResize(g_outText, n - 1);
      ArrayResize(g_outEnq, n - 1);
      n--;
     }
   ArrayResize(g_outText, n + 1);
   ArrayResize(g_outEnq, n + 1);
   g_outText[n] = text;
   g_outEnq[n]  = TickMs();
  }

void QueuePop()
  {
   int n = ArraySize(g_outText);
   if(n <= 0)
      return;
   for(int i = 1; i < n; i++)
     {
      g_outText[i - 1] = g_outText[i];
      g_outEnq[i - 1]  = g_outEnq[i];
     }
   ArrayResize(g_outText, n - 1);
   ArrayResize(g_outEnq, n - 1);
  }

//+------------------------------------------------------------------+
//| Connection management                                            |
//+------------------------------------------------------------------+
bool EngineConnected()
  {
   return (g_socket != INVALID_HANDLE && SocketIsConnected(g_socket));
  }

void EngineDisconnect(const string why)
  {
   if(g_socket != INVALID_HANDLE)
     {
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
     }
   Print("[MT5CopierEA] disconnected: ", why);
  }

ulong BackoffDelay()
  {
   ulong base = (ulong)MathMax(InpReconnectMs, 100);
   int shift = g_backoff;
   if(shift > 5)
      shift = 5;
   ulong delay = base << shift;
   if(delay > 30000)
      delay = 30000;
   return delay;
  }

void TryConnect()
  {
   ulong now = TickMs();
   if(now < g_nextConnectMs)
      return;
   ulong delay = BackoffDelay();
   g_nextConnectMs = now + delay;

   int s = SocketCreate();
   if(s == INVALID_HANDLE)
     {
      Print("[MT5CopierEA] SocketCreate failed, error=", GetLastError());
      g_backoff = (int)MathMin(g_backoff + 1, 6);
      return;
     }
   if(SocketConnect(s, InpServerHost, (uint)InpServerPort, 3000))
     {
      g_socket = s;
      g_backoff = 0;
      ArrayResize(g_rxBuf, 0);
      Print("[MT5CopierEA] connected to engine ", InpServerHost, ":", IntegerToString(InpServerPort));
      SendHello();
      SendSnapshot("");
     }
   else
     {
      SocketClose(s);
      if(g_backoff < 6)
         g_backoff++;
      Print("[MT5CopierEA] engine not reachable (", InpServerHost, ":", IntegerToString(InpServerPort),
            "), retry in ", (int)delay, " ms, error=", GetLastError());
     }
  }

//+------------------------------------------------------------------+
//| Outbound senders (they only QUEUE - flushed in OnTimer)          |
//+------------------------------------------------------------------+
void SendHello()
  {
   string js = "{\"type\":\"hello\"";
   js += ",\"terminal\":" + JStr(TerminalInfoString(TERMINAL_NAME));
   js += ",\"account\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   js += ",\"server\":" + JStr(AccountInfoString(ACCOUNT_SERVER));
   js += ",\"broker\":" + JStr(AccountInfoString(ACCOUNT_COMPANY));
   js += ",\"currency\":" + JStr(AccountInfoString(ACCOUNT_CURRENCY));
   js += ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2);
   js += ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   js += ",\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE));
   js += ",\"version\":" + JStr(EA_VERSION);
   js += ",\"ts\":" + IntegerToString(ServerMs());
   js += ",\"specs\":[" + AllSpecsJson() + "]";
   js += "}";
   QueueOut(js + "\n");
  }

void SendHeartbeat()
  {
   string js = "{\"type\":\"heartbeat\"";
   js += ",\"account\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   js += ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2);
   js += ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   js += ",\"floatingPL\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2);
   js += ",\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2);
   js += ",\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2);
   js += ",\"ts\":" + IntegerToString(ServerMs());
   js += "}";
   QueueOut(js + "\n");
  }

void SendAck(const string kind, const string eventKey, const bool ok,
             const string ticket, const double price,
             const string errorText, const string code)
  {
   string js = "{\"type\":\"ack\"";
   js += ",\"kind\":" + JStr(kind);
   js += ",\"eventKey\":" + JStr(eventKey);
   js += ",\"ok\":" + (ok ? "true" : "false");
   if(StringLen(ticket) > 0)
      js += ",\"ticket\":" + JStr(ticket);
   if(price > 0.0)
      js += ",\"price\":" + DoubleToString(price, 8);
   if(StringLen(errorText) > 0)
      js += ",\"error\":" + JStr(errorText);
   if(StringLen(code) > 0)
      js += ",\"code\":" + JStr(code);
   js += ",\"at\":" + IntegerToString(ServerMs());
   js += "}";
   QueueOut(js + "\n");
  }

// One position object as used in the snapshot payload
string PositionJson(const ulong ticket)
  {
   string sym  = PositionGetString(POSITION_SYMBOL);
   long   ptyp = PositionGetInteger(POSITION_TYPE);
   int    dg   = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   int    vd   = DigitsOfStep(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP));
   string js = "{";
   js += "\"ticket\":" + JStr(TickStr(ticket));
   js += ",\"symbol\":" + JStr(sym);
   js += ",\"side\":" + (ptyp == POSITION_TYPE_BUY ? "\"buy\"" : "\"sell\"");
   js += ",\"kind\":\"position\"";
   js += ",\"pendingType\":\"\"";
   js += ",\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), vd);
   js += ",\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), dg);
   js += ",\"currentPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), dg);
   js += ",\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), dg);
   js += ",\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), dg);
   js += ",\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2);
   js += ",\"openTime\":" + IntegerToString(PositionGetInteger(POSITION_TIME_MSC));
   js += ",\"comment\":" + JStr(PositionGetString(POSITION_COMMENT));
   js += "}";
   return js;
  }

string PendingJson(const ulong ticket)
  {
   string sym  = OrderGetString(ORDER_SYMBOL);
   long   otyp = OrderGetInteger(ORDER_TYPE);
   int    dg   = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   int    vd   = DigitsOfStep(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP));
   double px   = OrderGetDouble(ORDER_PRICE_OPEN);
   string js = "{";
   js += "\"ticket\":" + JStr(TickStr(ticket));
   js += ",\"symbol\":" + JStr(sym);
   js += ",\"side\":" + JStr(SideFromPending(otyp));
   js += ",\"kind\":\"pending\"";
   js += ",\"pendingType\":" + JStr(PendingTypeFromOrder(otyp));
   js += ",\"volume\":" + DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), vd);
   js += ",\"openPrice\":" + DoubleToString(px, dg);
   js += ",\"currentPrice\":" + DoubleToString(px, dg);
   js += ",\"sl\":" + DoubleToString(OrderGetDouble(ORDER_SL), dg);
   js += ",\"tp\":" + DoubleToString(OrderGetDouble(ORDER_TP), dg);
   js += ",\"profit\":0.00";
   js += ",\"openTime\":" + IntegerToString(OrderGetInteger(ORDER_TIME_SETUP_MSC));
   js += ",\"comment\":" + JStr(OrderGetString(ORDER_COMMENT));
   js += "}";
   return js;
  }

void SendSnapshot(const string reqId)
  {
   string js = "{\"type\":\"snapshot\"";
   js += ReqIdPart(reqId);
   js += ",\"account\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   js += ",\"server\":" + JStr(AccountInfoString(ACCOUNT_SERVER));
   js += ",\"broker\":" + JStr(AccountInfoString(ACCOUNT_COMPANY));
   js += ",\"currency\":" + JStr(AccountInfoString(ACCOUNT_CURRENCY));
   js += ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2);
   js += ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   js += ",\"floatingPL\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2);
   js += ",\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2);
   js += ",\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2);
   js += ",\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE));
   js += ",\"ts\":" + IntegerToString(ServerMs());

   js += ",\"positions\":[";
   int total = PositionsTotal();
   if(total > 200)
      total = 200;
   int added = 0;
   for(int i = 0; i < total; i++)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(added > 0)
         js += ",";
      js += PositionJson(t);
      added++;
     }

   js += "],\"pending\":[";
   total = OrdersTotal();
   if(total > 200)
      total = 200;
   added = 0;
   for(int i = 0; i < total; i++)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0)
         continue;
      if(added > 0)
         js += ",";
      js += PendingJson(t);
      added++;
     }

   js += "],\"specs\":[" + AllSpecsJson() + "]}";
   QueueOut(js + "\n");
  }

void SendSymbolInfoReply(const string symbol, const string reqId, const bool ok)
  {
   string js = "{\"type\":\"symbol_info\"";
   js += ReqIdPart(reqId);
   js += ",\"symbol\":" + JStr(symbol);
   if(ok)
      js += ",\"ok\":true,\"spec\":" + SymbolSpecJson(symbol);
   else
      js += ",\"ok\":false,\"code\":\"unknown_symbol\"";
   js += "}";
   QueueOut(js + "\n");
  }

//+------------------------------------------------------------------+
//| Event JSON builder                                               |
//+------------------------------------------------------------------+
string EventJson(const string event, const long ticket, const string symbol,
                 const string side, const double volume, const double closedVolume,
                 const double price, const double sl, const double tp,
                 const string closeReason, const string pendingType)
  {
   int vd = DigitsOfStep(SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP));
   int dg = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string js = "{\"type\":\"event\",\"event\":" + JStr(event);
   js += ",\"ticket\":" + JStr(StringFormat("%I64d", ticket));
   js += ",\"symbol\":" + JStr(symbol);
   js += ",\"side\":" + JStr(side);
   js += ",\"volume\":" + DoubleToString(volume, vd);
   if(closedVolume > 0.0)
      js += ",\"closedVolume\":" + DoubleToString(closedVolume, vd);
   if(price > 0.0)
      js += ",\"price\":" + DoubleToString(price, dg);
   if(sl > 0.0)
      js += ",\"sl\":" + DoubleToString(sl, dg);
   if(tp > 0.0)
      js += ",\"tp\":" + DoubleToString(tp, dg);
   if(StringLen(closeReason) > 0)
      js += ",\"closeReason\":" + JStr(closeReason);
   if(StringLen(pendingType) > 0)
      js += ",\"pendingType\":" + JStr(pendingType);
   js += ",\"ts\":" + IntegerToString(ServerMs());
   js += "}";
   return js + "\n";
  }

//+------------------------------------------------------------------+
//| Trade event pump (never blocks: build JSON, queue, return)       |
//+------------------------------------------------------------------+
void EmitDealEvent(const MqlTradeTransaction &trans)
  {
   if(!HistoryDealSelectByTicket(trans.deal))
      return;
   long dtype = HistoryDealGetInteger(trans.deal, DEAL_TYPE);
   if(dtype != DEAL_TYPE_BUY && dtype != DEAL_TYPE_SELL)
      return;                                   // balance/credit operations
   long   entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   string sym   = HistoryDealGetString(trans.deal, DEAL_SYMBOL);
   string side  = (dtype == DEAL_TYPE_BUY) ? "buy" : "sell";
   double vol   = HistoryDealGetDouble(trans.deal, DEAL_VOLUME);
   double price = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
   long   posId = HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID);

   if(entry == DEAL_ENTRY_IN)
     {
      // Market open OR pending order fill (spec: report as position_opened,
      // the engine maps it; the originating order id is not needed).
      double sl = HistoryDealGetDouble(trans.deal, DEAL_SL);
      double tp = HistoryDealGetDouble(trans.deal, DEAL_TP);
      if(PositionSelectByTicket((ulong)posId))
        {
         sl = PositionGetDouble(POSITION_SL);
         tp = PositionGetDouble(POSITION_TP);
        }
      QueueOut(EventJson("position_opened", posId, sym, side, vol, 0.0, price, sl, tp, "", ""));
     }
   else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT)
     {
      if(PositionSelectByTicket((ulong)posId))
        {
         // position still exists -> partial close
         string sym2 = PositionGetString(POSITION_SYMBOL);
         double sl = PositionGetDouble(POSITION_SL);
         double tp = PositionGetDouble(POSITION_TP);
         double rem = PositionGetDouble(POSITION_VOLUME);
         QueueOut(EventJson("partial_closed", posId, sym2, side, rem, vol, price, sl, tp, "", ""));
        }
      else
        {
         long reason = HistoryDealGetInteger(trans.deal, DEAL_REASON);
         QueueOut(EventJson("position_closed", posId, sym, side, vol, vol,
                            price, 0.0, 0.0, ReasonFromDeal(reason), ""));
        }
     }
  }

void EmitOrderAddEvent(const MqlTradeTransaction &trans)
  {
   if(!OrderSelect(trans.order))
      return;
   long type = OrderGetInteger(ORDER_TYPE);
   if(!IsPendingType(type))
      return;                                   // market orders are not reported
   long state = OrderGetInteger(ORDER_STATE);
   if(state != ORDER_STATE_PLACED && state != ORDER_STATE_PARTIAL)
      return;
   string sym   = OrderGetString(ORDER_SYMBOL);
   double vol   = OrderGetDouble(ORDER_VOLUME_CURRENT);
   double price = OrderGetDouble(ORDER_PRICE_OPEN);
   double sl    = OrderGetDouble(ORDER_SL);
   double tp    = OrderGetDouble(ORDER_TP);
   QueueOut(EventJson("pending_placed", (long)trans.order, sym, SideFromPending(type),
                      vol, 0.0, price, sl, tp, "", PendingTypeFromOrder(type)));
  }

void EmitOrderDeleteEvent(const MqlTradeTransaction &trans)
  {
   // ORDER_DELETE fires when an order leaves the active list: it was either
   // FILLED (the deal event reports it - skip here) or CANCELLED.
   if(HistoryOrderSelect(trans.order))
     {
      long state = OrderGetInteger(ORDER_STATE);
      if(state == ORDER_STATE_FILLED)
         return;
     }
   string sym   = trans.symbol;
   long   type  = trans.order_type;
   double vol   = trans.volume;
   double price = trans.price;
   double sl    = trans.price_sl;
   double tp    = trans.price_tp;
   if(HistoryOrderSelect(trans.order))
     {
      sym   = OrderGetString(ORDER_SYMBOL);
      type  = OrderGetInteger(ORDER_TYPE);
      vol   = OrderGetDouble(ORDER_VOLUME_CURRENT);
      price = OrderGetDouble(ORDER_PRICE_OPEN);
      sl    = OrderGetDouble(ORDER_SL);
      tp    = OrderGetDouble(ORDER_TP);
     }
   if(!IsPendingType(type))
      return;
   QueueOut(EventJson("pending_cancelled", (long)trans.order, sym, SideFromPending(type),
                      vol, 0.0, price, sl, tp, "cancelled", PendingTypeFromOrder(type)));
  }

void EmitPositionEvent(const MqlTradeTransaction &trans)
  {
   // Direct SL/TP change of an existing position (terminal UI, mobile app...)
   ulong posId = trans.position;
   if(posId == 0 || !PositionSelectByTicket(posId))
      return;
   string sym = PositionGetString(POSITION_SYMBOL);
   long   ptyp = PositionGetInteger(POSITION_TYPE);
   QueueOut(EventJson("sltp_modified", (long)posId, sym,
                      (ptyp == POSITION_TYPE_BUY ? "buy" : "sell"),
                      PositionGetDouble(POSITION_VOLUME), 0.0,
                      PositionGetDouble(POSITION_PRICE_OPEN),
                      PositionGetDouble(POSITION_SL),
                      PositionGetDouble(POSITION_TP), "", ""));
  }

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
  {
   switch(trans.type)
     {
      case TRADE_TRANSACTION_DEAL_ADD:
         EmitDealEvent(trans);
         break;
      case TRADE_TRANSACTION_ORDER_ADD:
         EmitOrderAddEvent(trans);
         break;
      case TRADE_TRANSACTION_ORDER_DELETE:
         EmitOrderDeleteEvent(trans);
         break;
      case TRADE_TRANSACTION_POSITION:
         EmitPositionEvent(trans);
         break;
      default:
         break;
     }
  }

//+------------------------------------------------------------------+
//| Idempotency scan: find position/order created for an eventKey    |
//+------------------------------------------------------------------+
bool FindByEventKey(const string eventKey, ulong &ticket, bool &isPosition)
  {
   ticket = 0;
   isPosition = false;
   string want = CommentTag() + ":" + eventKey;
   if(StringLen(eventKey) == 0)
      return false;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_COMMENT) == want)
        {
         ticket = t;
         isPosition = true;
         return true;
        }
     }
   total = OrdersTotal();
   for(int i = 0; i < total; i++)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0)
         continue;
      if(OrderGetString(ORDER_COMMENT) == want)
        {
         ticket = t;
         isPosition = false;
         return true;
        }
     }
   return false;
  }

//+------------------------------------------------------------------+
//| Retcode mapping (matches engine CommandResult codes)             |
//+------------------------------------------------------------------+
string MapRetcode(const uint rc)
  {
   switch(rc)
     {
      case TRADE_RETCODE_DONE:
      case TRADE_RETCODE_DONE_PARTIAL:
      case TRADE_RETCODE_PLACED:
      case TRADE_RETCODE_NO_CHANGES:
         return "ok";
      case TRADE_RETCODE_INVALID_VOLUME:      return "invalid_volume";
      case TRADE_RETCODE_INVALID_PRICE:       return "invalid_price";
      case TRADE_RETCODE_INVALID_STOPS:       return "invalid_stops";
      case TRADE_RETCODE_INVALID_EXPIRATION:  return "invalid_expiration";
      case TRADE_RETCODE_INVALID_ORDER:       return "invalid_order";
      case TRADE_RETCODE_INVALID_FILL:        return "invalid_fill";
      case TRADE_RETCODE_INVALID:             return "invalid_request";
      case TRADE_RETCODE_UNKNOWN_SYMBOL:      return "unknown_symbol";
      case TRADE_RETCODE_MARKET_CLOSED:       return "market_closed";
      case TRADE_RETCODE_NO_MONEY:            return "no_money";
      case TRADE_RETCODE_REQUOTE:
      case TRADE_RETCODE_PRICE_CHANGED:
      case TRADE_RETCODE_PRICE_OFF:
      case TRADE_RETCODE_REJECT:
      case TRADE_RETCODE_ERROR:
      case TRADE_RETCODE_TIMEOUT:
      case TRADE_RETCODE_LOCKED:
      case TRADE_RETCODE_FROZEN:
         return "broker_reject";
      case TRADE_RETCODE_CONNECTION:          return "connection_error";
      case TRADE_RETCODE_TOO_MANY_REQUESTS:   return "too_many_requests";
      case TRADE_RETCODE_LIMIT_ORDERS:
      case TRADE_RETCODE_LIMIT_VOLUME:        return "broker_limit";
      case TRADE_RETCODE_POSITION_CLOSED:     return "already_closed";
      case TRADE_RETCODE_SERVER_DISABLES_AT:
      case TRADE_RETCODE_CLIENT_DISABLES_AT:  return "trading_disabled";
     }
   return "broker_reject";
  }

string ErrText(const uint rc)
  {
   string d = g_trade.ResultRetcodeDescription();
   return d + " (retcode " + IntegerToString((int)rc) + ")";
  }

double AckPrice(const ulong deal, const string symbol)
  {
   if(deal > 0 && HistoryDealSelectByTicket(deal))
      return HistoryDealGetDouble(deal, DEAL_PRICE);
   if(StringLen(symbol) > 0)
      return MarketPrice(symbol);
   return g_trade.ResultPrice();
  }

ulong ResolveOpenTicket()
  {
   ulong deal = g_trade.ResultDeal();
   if(deal > 0 && HistoryDealSelectByTicket(deal))
     {
      long posId = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(posId > 0)
         return (ulong)posId;
     }
   return g_trade.ResultOrder();
  }

void SetupTrade()
  {
   g_trade.SetExpertMagicNumber((ulong)InpMagicCopied);
   g_trade.SetDeviationInPoints((ulong)MathMax(InpSlippage, 0));
   g_trade.SetAsyncMode(false);
  }

void FinishMarketResult(const string kind, const string eventKey, const bool sent, const string symbol)
  {
   uint rc = g_trade.ResultRetcode();
   if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL || rc == TRADE_RETCODE_PLACED))
     {
      ulong ticket = ResolveOpenTicket();
      double price = g_trade.ResultPrice();
      if(price <= 0.0)
         price = AckPrice(g_trade.ResultDeal(), symbol);
      SendAck(kind, eventKey, true, TickStr(ticket), price, "", "");
      Print("[MT5CopierEA] ", kind, " OK ", symbol, " ticket=", TickStr(ticket));
     }
   else
     {
      SendAck(kind, eventKey, false, "", 0.0, ErrText(rc), MapRetcode(rc));
      Print("[MT5CopierEA] ", kind, " FAILED retcode=", rc, " code=", MapRetcode(rc));
     }
  }

//+------------------------------------------------------------------+
//| Command handlers                                                 |
//+------------------------------------------------------------------+
void CmdOpen(const string msg)
  {
   string eventKey = JsonField(msg, "eventKey");
   string symbol   = JsonField(msg, "symbol");
   string side     = JsonField(msg, "side");
   double volume   = JsonNumField(msg, "volume", 0.0);
   double sl       = JsonNumField(msg, "sl", 0.0);
   double tp       = JsonNumField(msg, "tp", 0.0);
   if(StringLen(eventKey) == 0)
      eventKey = LocalEventKey();

   // idempotency: previous attempt may have produced the order already
   ulong existing = 0;
   bool  isPos = false;
   if(FindByEventKey(eventKey, existing, isPos))
     {
      double px = 0.0;
      if(isPos && PositionSelectByTicket(existing))
         px = PositionGetDouble(POSITION_PRICE_OPEN);
      SendAck("open", eventKey, true, TickStr(existing), px, "", "already_open");
      Print("[MT5CopierEA] open idempotent hit, eventKey=", eventKey, " ticket=", TickStr(existing));
      return;
     }

   if(!SymbolSelect(symbol, true))
     {
      SendAck("open", eventKey, false, "", 0.0, "symbol not available: " + symbol, "unknown_symbol");
      return;
     }
   if(volume <= 0.0)
     {
      SendAck("open", eventKey, false, "", 0.0, "volume must be > 0", "invalid_volume");
      return;
     }
   double vnorm = NormVolume(symbol, volume);
   if(vnorm <= 0.0)
     {
      SendAck("open", eventKey, false, "", 0.0, "volume normalization failed", "invalid_volume");
      return;
     }

   SetupTrade();
   g_trade.SetTypeFillingBySymbol(symbol);
   string comment = BuildComment(eventKey);
   bool sent = false;
   if(side == "buy")
      sent = g_trade.Buy(vnorm, symbol, 0.0, NormPrice(symbol, sl), NormPrice(symbol, tp), comment);
   else if(side == "sell")
      sent = g_trade.Sell(vnorm, symbol, 0.0, NormPrice(symbol, sl), NormPrice(symbol, tp), comment);
   else
     {
      SendAck("open", eventKey, false, "", 0.0, "side must be buy or sell, got: " + side, "invalid_side");
      return;
     }
   FinishMarketResult("open", eventKey, sent, symbol);
  }

void CmdClose(const string msg)
  {
   string eventKey = JsonField(msg, "eventKey");
   if(StringLen(eventKey) == 0)
      eventKey = LocalEventKey();
   long t = StringToInteger(JsonField(msg, "ticket"));
   ulong ticket = (ulong)(t > 0 ? t : 0);
   if(ticket == 0)
     {
      SendAck("close", eventKey, false, "", 0.0, "missing ticket", "invalid_request");
      return;
     }
   if(!PositionSelectByTicket(ticket))
     {
      // idempotent: nothing to close anymore
      SendAck("close", eventKey, true, TickStr(ticket), 0.0, "", "already_closed");
      return;
     }
   string sym = PositionGetString(POSITION_SYMBOL);
   SetupTrade();
   bool sent = g_trade.PositionClose(ticket);
   uint rc = g_trade.ResultRetcode();
   if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL ||
               rc == TRADE_RETCODE_PLACED))
      SendAck("close", eventKey, true, TickStr(ticket), AckPrice(g_trade.ResultDeal(), sym), "", "");
   else if(rc == TRADE_RETCODE_POSITION_CLOSED)
      SendAck("close", eventKey, true, TickStr(ticket), 0.0, "", "already_closed");
   else
      SendAck("close", eventKey, false, TickStr(ticket), 0.0, ErrText(rc), MapRetcode(rc));
  }

void CmdPartial(const string msg)
  {
   string eventKey = JsonField(msg, "eventKey");
   if(StringLen(eventKey) == 0)
      eventKey = LocalEventKey();
   long t = StringToInteger(JsonField(msg, "ticket"));
   ulong ticket = (ulong)(t > 0 ? t : 0);
   double volume = JsonNumField(msg, "volume", 0.0);
   if(ticket == 0)
     {
      SendAck("partial", eventKey, false, "", 0.0, "missing ticket", "invalid_request");
      return;
     }
   if(!PositionSelectByTicket(ticket))
     {
      SendAck("partial", eventKey, true, TickStr(ticket), 0.0, "", "already_closed");
      return;
     }
   string sym   = PositionGetString(POSITION_SYMBOL);
   double rem   = PositionGetDouble(POSITION_VOLUME);
   double vmin  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   if(volume <= 0.0)
     {
      SendAck("partial", eventKey, false, TickStr(ticket), 0.0, "volume must be > 0", "invalid_volume");
      return;
     }
   SetupTrade();
   // if the remaining part would be below the broker minimum -> close fully
   if(volume >= rem || (rem - volume) < vmin)
     {
      bool sentFull = g_trade.PositionClose(ticket);
      FinishMarketResult("partial", eventKey, sentFull, sym);
      return;
     }
   double vnorm = NormVolume(sym, volume);
   bool sent = g_trade.PositionClosePartial(ticket, vnorm);
   FinishMarketResult("partial", eventKey, sent, sym);
  }

bool StopsOk(const string sym, const long posType, const double sl, const double tp)
  {
   long stops = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(stops <= 0 || point <= 0)
      return true;
   double minDist = (double)stops * point;
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(sl > 0.0)
     {
      if(posType == POSITION_TYPE_BUY  && sl > bid - minDist)
         return false;
      if(posType == POSITION_TYPE_SELL && sl < ask + minDist)
         return false;
     }
   if(tp > 0.0)
     {
      if(posType == POSITION_TYPE_BUY  && tp < ask + minDist)
         return false;
      if(posType == POSITION_TYPE_SELL && tp > bid - minDist)
         return false;
     }
   return true;
  }

void CmdModify(const string msg)
  {
   string eventKey = JsonField(msg, "eventKey");
   if(StringLen(eventKey) == 0)
      eventKey = LocalEventKey();
   long t = StringToInteger(JsonField(msg, "ticket"));
   ulong ticket = (ulong)(t > 0 ? t : 0);
   bool hasSl = JsonHas(msg, "sl");
   bool hasTp = JsonHas(msg, "tp");
   double sl = JsonNumField(msg, "sl", -1.0);
   double tp = JsonNumField(msg, "tp", -1.0);
   if(ticket == 0)
     {
      SendAck("modify_sltp", eventKey, false, "", 0.0, "missing ticket", "invalid_request");
      return;
     }
   if(!PositionSelectByTicket(ticket))
     {
      SendAck("modify_sltp", eventKey, true, TickStr(ticket), 0.0, "", "already_closed");
      return;
     }
   string sym = PositionGetString(POSITION_SYMBOL);
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double newSl = (hasSl ? NormalizeDouble(MathMax(sl, 0.0), dg) : PositionGetDouble(POSITION_SL));
   double newTp = (hasTp ? NormalizeDouble(MathMax(tp, 0.0), dg) : PositionGetDouble(POSITION_TP));
   long posType = PositionGetInteger(POSITION_TYPE);
   if(!StopsOk(sym, posType, newSl, newTp))
     {
      SendAck("modify_sltp", eventKey, false, TickStr(ticket), 0.0,
              "SL/TP violates SYMBOL_TRADE_STOPS_LEVEL", "invalid_stops");
      return;
     }
   SetupTrade();
   bool sent = g_trade.PositionModify(ticket, newSl, newTp);
   uint rc = g_trade.ResultRetcode();
   if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_NO_CHANGES))
      SendAck("modify_sltp", eventKey, true, TickStr(ticket), 0.0, "", "");
   else
      SendAck("modify_sltp", eventKey, false, TickStr(ticket), 0.0, ErrText(rc), MapRetcode(rc));
  }

void CmdPlacePending(const string msg)
  {
   string eventKey = JsonField(msg, "eventKey");
   string symbol   = JsonField(msg, "symbol");
   string ptype    = JsonField(msg, "pendingType");
   double volume   = JsonNumField(msg, "volume", 0.0);
   double price    = JsonNumField(msg, "price", 0.0);
   double sl       = JsonNumField(msg, "sl", 0.0);
   double tp       = JsonNumField(msg, "tp", 0.0);
   if(StringLen(eventKey) == 0)
      eventKey = LocalEventKey();

   ulong existing = 0;
   bool  isPos = false;
   if(FindByEventKey(eventKey, existing, isPos))
     {
      SendAck("place_pending", eventKey, true, TickStr(existing), price, "", "already_placed");
      return;
     }
   if(!SymbolSelect(symbol, true))
     {
      SendAck("place_pending", eventKey, false, "", 0.0, "symbol not available: " + symbol, "unknown_symbol");
      return;
     }
   if(volume <= 0.0)
     {
      SendAck("place_pending", eventKey, false, "", 0.0, "volume must be > 0", "invalid_volume");
      return;
     }
   if(price <= 0.0)
     {
      SendAck("place_pending", eventKey, false, "", 0.0, "price must be > 0", "invalid_price");
      return;
     }
   double v = NormVolume(symbol, volume);
   double p = NormPrice(symbol, price);
   double sln = NormPrice(symbol, sl);
   double tpn = NormPrice(symbol, tp);
   string comment = BuildComment(eventKey);
   SetupTrade();
   g_trade.SetTypeFillingBySymbol(symbol);
   bool sent = false;
   if(ptype == "buylimit")
      sent = g_trade.BuyLimit(v, p, symbol, sln, tpn, ORDER_TIME_GTC, 0, comment);
   else if(ptype == "selllimit")
      sent = g_trade.SellLimit(v, p, symbol, sln, tpn, ORDER_TIME_GTC, 0, comment);
   else if(ptype == "buystop")
      sent = g_trade.BuyStop(v, p, symbol, sln, tpn, ORDER_TIME_GTC, 0, comment);
   else if(ptype == "sellstop")
      sent = g_trade.SellStop(v, p, symbol, sln, tpn, ORDER_TIME_GTC, 0, comment);
   else if(ptype == "buystoplimit")
     {
      double stopLimit = JsonNumField(msg, "stopLimit", 0.0);
      if(stopLimit <= 0.0)
         stopLimit = p;
      sent = g_trade.BuyStopLimit(v, p, stopLimit, symbol, sln, tpn, ORDER_TIME_GTC, 0, comment);
     }
   else if(ptype == "sellstoplimit")
     {
      double stopLimit = JsonNumField(msg, "stopLimit", 0.0);
      if(stopLimit <= 0.0)
         stopLimit = p;
      sent = g_trade.SellStopLimit(v, p, stopLimit, symbol, sln, tpn, ORDER_TIME_GTC, 0, comment);
     }
   else
     {
      SendAck("place_pending", eventKey, false, "", 0.0, "unknown pendingType: " + ptype, "invalid_pending_type");
      return;
     }
   FinishMarketResult("place_pending", eventKey, sent, symbol);
  }

void CmdCancelPending(const string msg)
  {
   string eventKey = JsonField(msg, "eventKey");
   if(StringLen(eventKey) == 0)
      eventKey = LocalEventKey();
   long t = StringToInteger(JsonField(msg, "ticket"));
   ulong ticket = (ulong)(t > 0 ? t : 0);
   if(ticket == 0)
     {
      SendAck("cancel_pending", eventKey, false, "", 0.0, "missing ticket", "invalid_request");
      return;
     }
   if(!OrderSelect(ticket))
     {
      // already filled/expired/deleted -> idempotent success
      SendAck("cancel_pending", eventKey, true, TickStr(ticket), 0.0, "", "already_gone");
      return;
     }
   SetupTrade();
   bool sent = g_trade.OrderDelete(ticket);
   uint rc = g_trade.ResultRetcode();
   if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED))
      SendAck("cancel_pending", eventKey, true, TickStr(ticket), 0.0, "", "");
   else if(rc == TRADE_RETCODE_POSITION_CLOSED || !OrderSelect(ticket))
      SendAck("cancel_pending", eventKey, true, TickStr(ticket), 0.0, "", "already_gone");
   else
      SendAck("cancel_pending", eventKey, false, TickStr(ticket), 0.0, ErrText(rc), MapRetcode(rc));
  }

void CmdSymbolInfo(const string msg)
  {
   string symbol = JsonField(msg, "symbol");
   string reqId  = JsonField(msg, "reqId");
   if(StringLen(symbol) == 0 || !SymbolSelect(symbol, true))
     {
      SendSymbolInfoReply(symbol, reqId, false);
      return;
     }
   SendSymbolInfoReply(symbol, reqId, true);
  }

//+------------------------------------------------------------------+
//| Inbound line dispatcher                                          |
//+------------------------------------------------------------------+
void HandleLine(const string line)
  {
   string s = line;
   StringTrimLeft(s);
   StringTrimRight(s);
   int len = StringLen(s);
   if(len <= 0)
      return;
   if(StringGetCharacter(s, 0) != '{')
     {
      Print("[MT5CopierEA] ignoring non-JSON line from engine");
      return;
     }
   string kind = JsonField(s, "kind");
   if(kind == "open")            { CmdOpen(s);          return; }
   if(kind == "close")           { CmdClose(s);         return; }
   if(kind == "partial")         { CmdPartial(s);       return; }
   if(kind == "modify_sltp")     { CmdModify(s);        return; }
   if(kind == "place_pending")   { CmdPlacePending(s);  return; }
   if(kind == "cancel_pending")  { CmdCancelPending(s); return; }
   if(kind == "snapshot")        { SendSnapshot(JsonField(s, "reqId")); return; }
   if(kind == "symbol_info")     { CmdSymbolInfo(s);    return; }
   if(kind == "ping")
     {
      QueueOut("{\"type\":\"pong\",\"ts\":" + IntegerToString(ServerMs()) + "}\n");
      return;
     }
   Print("[MT5CopierEA] unknown command kind: ", kind);
  }

//+------------------------------------------------------------------+
//| Byte-level inbound framing (safe across chunk boundaries)        |
//+------------------------------------------------------------------+
void ProcessRxBuf()
  {
   int size = ArraySize(g_rxBuf);
   if(size <= 0)
      return;
   int start = 0;
   for(int i = 0; i < size; i++)
     {
      if(g_rxBuf[i] != 10)               // '\n'
         continue;
      if(i > start)
        {
         string line = CharArrayToString(g_rxBuf, start, i - start, CP_UTF8);
         HandleLine(line);
        }
      start = i + 1;
      if(i - start > 8388608)            // >8MB single line: drop it
         start = i + 1;
     }
   if(start > 0)
     {
      int rem = size - start;
      if(rem > 0)
        {
         uchar tmp[];
         ArrayResize(tmp, rem);
         ArrayCopy(tmp, g_rxBuf, 0, start, rem);
         ArrayResize(g_rxBuf, rem);
         ArrayCopy(g_rxBuf, tmp, 0, 0, rem);
        }
      else
         ArrayResize(g_rxBuf, 0);
     }
   else if(size > 8388608)
      ArrayResize(g_rxBuf, 0);           // overflow guard
  }

void ReadIncoming()
  {
   if(!EngineConnected())
      return;
   int reads = 0;
   while(reads < 16)                     // cap work per timer tick
     {
      uint avail = 0;
      if(!SocketIsReadable(g_socket, avail))
        {
         EngineDisconnect("socket not readable");
         return;
        }
      if(avail <= 0)
         break;
      int toread = (int)MathMin((int)avail, 65536);
      uchar buf[];
      ArrayResize(buf, toread);
      int n = SocketRead(g_socket, buf, (uint)toread, 100);
      if(n < 0)
        {
         EngineDisconnect("read error");
         return;
        }
      if(n == 0)
         break;
      int old = ArraySize(g_rxBuf);
      ArrayResize(g_rxBuf, old + n);
      ArrayCopy(g_rxBuf, buf, old, 0, n);
      reads++;
     }
   ProcessRxBuf();
  }

void FlushOut()
  {
   if(!EngineConnected())
      return;
   ulong now = TickMs();
   while(ArraySize(g_outText) > 0)
     {
      string text = g_outText[0];
      ulong enq = g_outEnq[0];
      if(InpEventMaxAgeMs > 0 && now - enq > (ulong)InpEventMaxAgeMs)
        {
         Print("[MT5CopierEA] dropped stale queued message (age ",
               (int)(now - enq), " ms > ", InpEventMaxAgeMs, " ms); engine reconciles via snapshot");
         QueuePop();
         continue;
        }
      uchar arr[];
      int n = StringToCharArray(text, arr, 0, WHOLE_ARRAY, CP_UTF8);
      if(n <= 1)
        {
         QueuePop();
         continue;
        }
      int sent = SocketSend(g_socket, arr, (uint)(n - 1));   // drop the trailing 0
      if(sent <= 0)
        {
         EngineDisconnect("send failed");
         return;                                            // message stays queued
        }
      g_eventsSent++;
      QueuePop();
     }
  }

//+------------------------------------------------------------------+
//| Main pump (OnTimer)                                              |
//+------------------------------------------------------------------+
void UpdateComment()
  {
   string st = (EngineConnected() ? "CONNECTED" : "DISCONNECTED (retrying)");
   Comment("MT5Copier EA v", EA_VERSION,
           "\nEngine: ", InpServerHost, ":", IntegerToString(InpServerPort), "  [", st, "]",
           "\nAccount: ", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)),
           "  ", AccountInfoString(ACCOUNT_SERVER),
           "\nQueued messages: ", IntegerToString(ArraySize(g_outText)),
           "  Sent events: ", IntegerToString(g_eventsSent));
  }

void OnTimer()
  {
   if(StringLen(g_gvName) > 0)
      GlobalVariableSet(g_gvName, (double)TickMs());   // instance heartbeat

   if(!EngineConnected())
     {
      TryConnect();
      UpdateComment();
      if(!EngineConnected())
         return;
     }
   FlushOut();
   ReadIncoming();

   ulong now = TickMs();
   int hb = MathMax(InpHeartbeatMs, 100);
   if(now - g_lastHbMs >= (ulong)hb)
     {
      g_lastHbMs = now;
      SendHeartbeat();
     }
   UpdateComment();
  }

//+------------------------------------------------------------------+
//| Init / deinit                                                    |
//+------------------------------------------------------------------+
int OnInit()
  {
   g_gvName = "MT5CopierEA_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   if(GlobalVariableCheck(g_gvName))
     {
      double last = GlobalVariableGet(g_gvName);
      if(TickMs() - (ulong)last < 15000)
        {
         Print("[MT5CopierEA] ERROR: another instance of this EA is already running ",
               "on this terminal (use exactly ONE chart per terminal).");
         return INIT_FAILED;
        }
     }
   GlobalVariableSet(g_gvName, (double)TickMs());

   SetupTrade();
   int timerMs = MathMax(InpHeartbeatMs, 50);
   if(!EventSetMillisecondTimer(timerMs))
     {
      Print("[MT5CopierEA] ERROR: EventSetMillisecondTimer failed, error=", GetLastError());
      return INIT_FAILED;
     }
   g_nextConnectMs = 0;      // connect immediately
   ArrayResize(g_rxBuf, 0);
   ArrayResize(g_outText, 0);
   ArrayResize(g_outEnq, 0);
   Print("[MT5CopierEA] v", EA_VERSION, " started on terminal ", TerminalInfoString(TERMINAL_NAME),
         ", account ", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)),
         "; engine ", InpServerHost, ":", IntegerToString(InpServerPort));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_socket != INVALID_HANDLE)
     {
      uchar arr[];
      int n = StringToCharArray("{\"type\":\"bye\"}\n", arr, 0, WHOLE_ARRAY, CP_UTF8);
      if(n > 1)
         SocketSend(g_socket, arr, (uint)(n - 1));
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
     }
   Comment("");
   Print("[MT5CopierEA] stopped, deinit reason=", reason);
  }
//+------------------------------------------------------------------+
