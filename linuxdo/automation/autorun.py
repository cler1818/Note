#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
VirtualBrowser 批量签到 + 日常维护 自动化

流程（逐个启动检查，默认最多 9 个浏览器同时维护）：
  按编号逐个打开、验证；当前环境确认首个成功动作或确定故障后才打开下一个。
  已开始的维护继续并行运行 3 分钟；达到上限后等空位，再依次启动后续环境。
  启动、重启、运行、关闭中的环境均占用名额；不等待整组或余额。

所有模式均不查询内存。自动模式将其他已打开的浏览器计入并发上限。
窗口使用固定九宫格，确认关闭后复用空位；验证期间不放大；所有退出路径恢复初始小窗口尺寸。

用法：
  py autorun.py --test     默认试跑前 45 个，持续补位
  py autorun.py --all      跑全部环境，结束后自动补跑问题环境一次，再合并汇总
  py autorun.py --ids 1-9  只跑指定范围
  py autorun.py --all --concurrency 5  最多同时 5 个（--batch 仍可用）
  P 暂停/恢复补位；Ctrl+C 中断并关闭本轮正在处理的浏览器

"""

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.request as urlreq
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from auxiliary_verifier import CF_CLICK_LOCK, AuxiliaryVerifier
from grade_report import collect_grade, print_grade_report, retention_summary_line
from window_layout import NORMAL_SIZE, POSITIONS, bounds_for_slot, launch_args, set_browser_bounds

# ─────────── 配置 ───────────
API_KEY  = os.environ.get("VIRTUAL_BROWSER_API_KEY", "")
API_HOST = "http://localhost:9000"

FORUM_ONLY = False      # 默认获取等级、LDC / Agent；--forum-only 可显式跳过辅助获取。
MAX_BROWSERS = 9        # 自动模式的硬上限；--batch/--concurrency 可设为 1–9。
CONFIRM_WAIT = 4        # 点完「日常维护」后确认真的在跑，等几秒（原来写死 8 秒）
PANEL_WAIT_MAX = 180    # 慢网络下给论坛主脚本充分时间；仍受五分钟总预算限制。
RUN_SECONDS  = 190      # 日常维护运行时长（脚本内 3 分钟 + 10 秒缓冲）。
                        # 这是真正在刷帖的时间，别动 —— 砍它就等于少刷帖。

# ---- 固定窗口 ----
# 沿用当前 1–9 的九宫格坐标，页面验证均保持初始小窗口。
WIN_NORMAL   = NORMAL_SIZE
CF_SETTLE    = 2        # 已读取真实、可点复选框后，只等布局稳定，不再固定等 12 秒。
CF_WIDGET_WAIT = 60
CF_PASS_WAIT = 60
CF_TOTAL_TIMEOUT = 90   # 所有 CF 轮次共用此预算，新控件出现也不能重置。
ENV_READY_TIMEOUT = 180  # 单次启动、验证、会话和面板确认共用预算。
CDP_IO_TIMEOUT = 20      # 单次调试调用的上限，防止连续事件导致 recv 永久等待。
STARTUP_TOTAL_TIMEOUT = 300  # 所有启动检查和重试共用 5 分钟；维护另计。
MAX_RETRIES = 5              # 首次失败后最多重试 5 次，先到总预算则停止。
TEST_MULTIPLIER = 5     # --test 处理并发数的五倍，默认前 45 个。

APP_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(APP_DIR, "log")
_window_contexts = {}   # 本次启动的窗口，异常/中断关闭前也按原分配位置恢复。

# ─────────── 日志 ───────────
def bj_now():
    """东八区当前时间（与脚本 todayStr 一致）"""
    return datetime.now(timezone.utc) + timedelta(hours=8)

_log_fh = None
_log_lock = threading.Lock()       # 并行启动后多线程同时写日志，必须加锁
_summary_buf = []                  # report() 期间同时把行攒起来，最后置顶写到文件开头
_capture_summary = False


def log_path():
    return os.path.join(LOG_DIR, "autorun_log_%s.txt" % bj_now().strftime("%Y%m%d"))


def prepend_summary():
    """把本轮汇总插到日志文件【最前面】（第 1 行开始）。

    为什么要这么做：日志是 append 模式，一天可能跑好几轮，汇总原本埋在几千行
    明细的最末尾，每次都得翻到底。置顶后打开文件第一屏就是最新结果。
    实现：先关掉句柄，读出全文，把汇总拼到最前再整体写回，然后重新以 append 打开。
    """
    global _log_fh
    if not _summary_buf:
        return
    head = "\n".join(_summary_buf)
    try:
        if _log_fh:
            _log_fh.flush()
            _log_fh.close()
            _log_fh = None
        path = log_path()
        old = ""
        if os.path.exists(path):
            with io.open(path, encoding="utf-8", errors="replace") as f:
                old = f.read()
        with io.open(path, "w", encoding="utf-8") as f:
            f.write(head + "\n\n" + old)
    except Exception as e:
        print("  (汇总置顶失败: %s)" % e, flush=True)

def log(msg, quiet=False):
    global _log_fh
    line = "[%s] %s" % (bj_now().strftime("%H:%M:%S"), msg)
    with _log_lock:
        if _capture_summary:
            _summary_buf.append(line)
        return _log_locked(line, quiet)

def _safe_print(line):
    """控制台编码不一定是 UTF-8。Windows 命令提示符默认 GBK，
    而日志里有 ✔ 和页面 r4 里的 ⛔ 这类 GBK 编不了的字符 ——
    直接 print 会抛 UnicodeEncodeError 把整轮跑挂掉（实测限流时必崩）。
    所以这里兜一层：印不出来就把不支持的字符换成 ?，绝不让日志弄死主流程。"""
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        enc = (sys.stdout.encoding or "ascii")
        try:
            print(line.encode(enc, "replace").decode(enc, "replace"), flush=True)
        except Exception:
            print(line.encode("ascii", "replace").decode("ascii"), flush=True)
    except Exception:
        pass

def _log_locked(line, quiet):
    global _log_fh
    if not quiet:
        _safe_print(line)
    if _log_fh is None:
        try:
            os.makedirs(LOG_DIR, exist_ok=True)
            path = os.path.join(LOG_DIR, "autorun_log_%s.txt" % bj_now().strftime("%Y%m%d"))
            _log_fh = open(path, "a", encoding="utf-8")
            _log_fh.write("\n===== 启动 %s =====\n" % bj_now().strftime("%Y-%m-%d %H:%M:%S"))
        except Exception as e:
            print("  (日志文件打开失败: %s)" % e, flush=True)
            return
    try:
        _log_fh.write(line + "\n")
        _log_fh.flush()
    except Exception:
        pass

# ─────────── 暂停/恢复（按 P 键）───────────
# Ctrl+C 是中断退出，但有时只想临时停一下（比如要腾出机器干别的），
# 停完还要接着跑。所以加一个 P 键：按一次暂停，再按一次恢复。
#
# P 只暂停接纳新环境，已经接纳的环境继续运行并关闭。
_pause_flag = threading.Event()
_cancel_flag = threading.Event()
_auto_slots = None
_startup_lock = threading.RLock()  # 初次检查与重启检查共用，避免同时验证多个浏览器。
_key_thread_started = False


def _key_listener():
    try:
        import msvcrt
    except ImportError:
        return                               # 非 Windows 不支持，静默跳过
    while True:
        try:
            if msvcrt.kbhit():
                ch = msvcrt.getwch()
                if ch in ("p", "P"):
                    if _pause_flag.is_set():
                        _pause_flag.clear()
                        log("  ▶ 已恢复，继续跑")
                    else:
                        _pause_flag.set()
                        log("  ⏸ 已收到暂停请求 —— 停止补位，当前环境继续完成并关闭（再按 P 恢复）")
            time.sleep(0.15)
        except Exception:
            time.sleep(0.5)


def start_key_listener():
    global _key_thread_started
    if _key_thread_started:
        return
    _key_thread_started = True
    t = threading.Thread(target=_key_listener, daemon=True)
    t.start()


# 2026-09-12 实测 env22：CF 会连续下发不同验证框，需要识别新控件并分轮处理。
# “同一浏览器只能点一次”以及“readyState=complete 就能判断未登录”均已撤销。

# ─────────── VirtualBrowser API ───────────
def api(path, body=None, timeout=180):
    hdr = {"Api-Key": API_KEY}
    if body is None:
        req = urlreq.Request(API_HOST + path, headers=hdr)
    else:
        hdr["Content-Type"] = "application/json; charset=utf-8"
        req = urlreq.Request(API_HOST + path,
                             json.dumps(body, ensure_ascii=False).encode("utf-8"), hdr)
    raw = urlreq.urlopen(req, timeout=min(timeout, 20)).read().decode("utf-8", "replace")
    return json.loads(raw)

def list_envs():
    return sorted(b["id"] for b in api("/api/getBrowserList")["data"])

def launch(env_id, deadline=None, normal_bounds=None):
    if _cancel_flag.is_set():
        return None
    if _auto_slots is not None:
        return _auto_slots.launch(env_id, deadline, normal_bounds)
    return _launch(env_id, deadline, normal_bounds)


def _launch(env_id, deadline=None, normal_bounds=None):
    """启动环境，返回调试端口；已在运行时从运行列表里取端口"""
    def remaining():
        left = 20 if deadline is None else min(20, deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("环境启动预算已用完")
        return left
    def remember(port):
        if port and normal_bounds is not None:
            _window_contexts[env_id] = {"port": port, "bounds": dict(normal_bounds)}
        return port
    try:
        body = {"id": env_id}
        if normal_bounds is not None:
            body["tempLaunchArgs"] = launch_args(normal_bounds)
        r = api("/api/launchBrowser", body, timeout=remaining())
        if r.get("success"):
            port = (r.get("data") or {}).get("debuggingPort")
            if port:
                return remember(port)
    except Exception as e:
        log("  env%-3d 启动异常: %s" % (env_id, str(e)[:70]))
    try:
        for x in api("/api/getBrowserRunningList", timeout=remaining())["data"]:
            if x.get("id") == env_id and x.get("debuggingPort"):
                return remember(x["debuggingPort"])
    except Exception:
        pass
    return None

def running_browsers():
    """用于并发和关闭确认；接口异常不能当作没有浏览器。"""
    reply = api("/api/getBrowserRunningList", timeout=5)
    rows = reply.get("data")
    if not reply.get("success") or not isinstance(rows, list):
        raise RuntimeError("无法确认当前浏览器数量")
    if any(not isinstance(row, dict) or not isinstance(row.get("id"), int) for row in rows):
        raise RuntimeError("浏览器运行列表格式异常")
    return {row["id"]: row for row in rows}


class BrowserSlots:
    """名额覆盖启动到确认关闭；重启继续占用原名额。"""
    def __init__(self, limit):
        if not 1 <= limit <= MAX_BROWSERS:
            raise ValueError("自动运行并发数必须为 1–9")
        self.limit = limit
        self.lock = threading.Lock()
        self.reserved = {}
        self.unclosed = {}

    def claim(self, pending):
        with self.lock:
            if _cancel_flag.is_set() or _pause_flag.is_set():
                return None
            running = running_browsers()
            if _cancel_flag.is_set() or _pause_flag.is_set():
                return None
            for env_id, result in list(self.unclosed.items()):
                if env_id not in running:
                    result["closed"] = True
                    self.unclosed.pop(env_id)
                    self.reserved.pop(env_id)
                    log("  env%-3d 已确认关闭，释放空位" % env_id)
            if len(self.reserved) >= self.limit:
                return None
            # 严格按队列依次处理；其他已打开的浏览器仍占用容量。
            env_id = pending[0]
            if env_id not in running and len(set(running) | set(self.reserved)) >= self.limit:
                return None
            slot = next(i for i in range(self.limit) if i not in self.reserved.values())
            self.reserved[env_id] = slot
            return env_id, slot

    def launch(self, env_id, deadline, normal_bounds):
        # 容量检查和启动请求串行；完整启动检查另由 _startup_lock 串行控制。
        with self.lock:
            if _cancel_flag.is_set():
                return None
            if env_id not in self.reserved:
                raise RuntimeError("环境没有预留并发名额")
            running = running_browsers()
            if _cancel_flag.is_set():
                return None
            if env_id in running:
                port = running[env_id].get("debuggingPort")
                if port and normal_bounds is not None:
                    _window_contexts[env_id] = {"port": port, "bounds": dict(normal_bounds)}
                return port
            if len(set(running) | set(self.reserved)) > self.limit:
                raise RuntimeError("其他浏览器占满容量，取消本次启动")
            return _launch(env_id, deadline, normal_bounds)

    def finish(self, result):
        with self.lock:
            if result.get("closed"):
                self.reserved.pop(result["id"], None)
            else:
                self.unclosed[result["id"]] = result


def running_ids():
    """当前正在运行的环境 ID 集合"""
    try:
        return set(x.get("id") for x in api("/api/getBrowserRunningList")["data"])
    except Exception:
        return set()

def restore_environment_window(env_id):
    context = _window_contexts.get(env_id)
    if not context:
        return None
    try:
        result = set_browser_bounds(context["port"], context["bounds"],
                                    target_id=context.get("target_id"),
                                    window_id=context.get("window_id"))
        context["window_id"] = result["windowId"]
        return result
    except Exception as e:
        log("  env%-3d 固定窗口恢复失败: %s" % (env_id, str(e)[:100]))
        return None


def stop(env_id, verify_timeout=60):
    """关闭环境。stopBrowser 返回成功≠已关闭（实测需要几秒），
    必须轮询运行列表确认 ID 消失，否则残留实例会吃掉下一批的内存，
    导致后续环境页面渲染不完而被误判成'未登录'。"""
    restore_environment_window(env_id)
    deadline = time.monotonic() + verify_timeout
    try:
        api("/api/stopBrowser", {"id": env_id}, timeout=min(8, verify_timeout))
    except Exception:
        pass
    while time.monotonic() < deadline:
        left = deadline - time.monotonic()
        try:
            if env_id not in running_browsers():
                _window_contexts.pop(env_id, None)
                return True
        except Exception:
            pass
        time.sleep(min(1, max(0, deadline-time.monotonic())))
    log("  env%-3d 关闭后 %ds 未能确认停止" % (env_id, verify_timeout))
    return False


def stop_many(env_ids, verify_timeout=60):
    """并行关闭一批环境。

    原来是 for 循环里一个个 stop()，每个都自己轮询、每轮 sleep 3 秒，
    5 个环境实测要 45 秒。而 stopBrowser 本身是瞬间返回的，慢的全是等待确认。
    这里改成：先把所有 stopBrowser 一次性发出去，然后【统一】轮询一次运行列表，
    直到这批 ID 全部消失。5 个环境从 45 秒压到 10 秒左右。
    """
    ids = list(env_ids)
    if not ids:
        return set()
    with ThreadPoolExecutor(max_workers=min(12, len(ids))) as ex:
        list(ex.map(lambda i: _stop_fire(i), ids))
    waited = 0
    left = set(ids)
    while waited < verify_timeout and left:
        time.sleep(3)
        waited += 3
        try:
            left = set(ids) & set(running_browsers())
        except Exception:
            pass  # 查询失败时保留未关闭集合，不能释放名额。
    if left:
        log("  关闭后 %ds 仍在运行列表中: %s" % (verify_timeout, sorted(left)))
    for env_id in set(ids) - left:
        _window_contexts.pop(env_id, None)
    return left


def _stop_fire(env_id):
    """只发关闭指令，不等确认（确认交给 stop_many 统一做）"""
    restore_environment_window(env_id)
    try:
        api("/api/stopBrowser", {"id": env_id}, timeout=120)
    except Exception:
        pass

# ─────────── CDP ───────────
class CDP(object):
    """极简 CDP 客户端。websocket-client 缺失时抛异常，由调用方降级处理。"""

    def __init__(self, port, url=None, timeout=180, target_id=None, deadline=None):
        import websocket                              # 延迟导入，便于给出友好报错
        self.port = port
        self._ws = None
        self._id = 0
        self.dead = False        # WS 断开后置位，上层据此跳过后续探测
        self.deadline = deadline
        self.io_timeout = min(timeout, CDP_IO_TIMEOUT)
        self.last_error = ""
        self.trace = None
        if target_id:
            target = next((t for t in self._http('/json/list')
                           if t.get('id') == target_id), None)
        else:
            target = self._new_tab(url) if url else self._pick_tab()
        if not target:
            raise RuntimeError("无可用标签页")
        self.target_id = target.get("id")
        self._ws = websocket.create_connection(target["webSocketDebuggerUrl"],
                                               timeout=self._remaining(), suppress_origin=True)
        for m in ("Page.enable", "Runtime.enable"):
            self.send(m)

    def _remaining(self):
        left = self.io_timeout
        if self.deadline is not None:
            left = min(left, self.deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("环境时间预算已用完")
        return max(0.05, left)

    def _http(self, path, put=False):
        req = urlreq.Request("http://127.0.0.1:%d%s" % (self.port, path))
        if put:
            req.get_method = lambda: "PUT"
        raw = urlreq.urlopen(req, timeout=self._remaining()).read().decode("utf-8", "replace")
        return raw if path.startswith('/json/close/') else json.loads(raw)

    def _new_tab(self, url):
        return self._http("/json/new?" + url, put=True)

    def close_idle_tabs(self, keep_id, default_only=False):
        """关掉 VirtualBrowser 自带的 chrome://virtual-worker/ 空白页。
        它一直挂着白占内存（实测每环境约 0.09GB，9 并发就是 0.8GB，
        在 7.9GB 的机器上是够不够跑 9 个的分水岭）。
        已实测关掉它之后：浏览器不退出、面板和登录态不受影响、
        刷帖照常、stopBrowser 也能正常关 —— 是安全的。
        只关 chrome:// 开头的，绝不碰论坛标签。"""
        closed = 0
        try:
            tabs = self._http("/json/list")
            if default_only:
                tabs.sort(key=lambda t: not (t.get("url") or "").startswith("chrome://virtual-worker"))
            for t in tabs:
                if t.get("type") != "page":
                    continue
                if t.get("id") == keep_id:
                    continue
                u = t.get("url") or ""
                # 手动打开环境时优先清理内置启动页，最多关闭一个默认页。
                if default_only and u.split("?", 1)[0].split("#", 1)[0].rstrip("/") not in (
                        "chrome://virtual-worker", "chrome://newtab", "chrome://new-tab-page"):
                    continue
                if u.startswith("chrome://"):
                    try:
                        self._http("/json/close/" + t["id"])
                        closed += 1
                        if default_only:
                            break
                    except Exception:
                        pass
        except Exception:
            pass
        return closed

    def _pick_tab(self):
        for t in self._http("/json/list"):
            if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                return t
        return None

    def send(self, method, params=None):
        call_deadline = time.monotonic() + self._remaining()
        self._id += 1
        mid = self._id
        self._ws.settimeout(self._remaining())
        self._ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            left = min(self._remaining(), call_deadline - time.monotonic())
            if left <= 0:
                raise TimeoutError("CDP调用超时: %s" % method)
            self._ws.settimeout(left)
            msg = json.loads(self._ws.recv())
            if msg.get("id") == mid:
                return msg
            if self.trace:
                self.trace(msg)

    def ev(self, expr, await_promise=False):
        """求值并返回 value。

        浏览器被关、标签页崩溃、内存压力下 WS 被系统掐断，都会在这里抛
        ConnectionAbortedError / WebSocketException。实测未捕获时会把整个
        批处理打挂并留下孤儿浏览器进程，所以这里一律吞掉，返回 None 由上层降级。
        """
        try:
            r = self.send("Runtime.evaluate",
                          {"returnByValue": True, "awaitPromise": await_promise,
                           "expression": expr}).get("result", {}).get("result", {})
            return r.get("value")
        except Exception as e:
            self.dead = True
            self.last_error = str(e)[:160]
            return None

    def evj(self, expr, await_promise=False):
        v = self.ev(expr, await_promise)
        if not isinstance(v, str):
            return None
        try:
            return json.loads(v)
        except Exception:
            return None

    def click_xy(self, x, y):
        """发送鼠标移动、按下和松开，并检查每条 CDP 指令是否被接受。"""
        try:
            def dispatch(params):
                reply = self.send("Input.dispatchMouseEvent", params)
                if reply.get("error"):
                    raise RuntimeError(str(reply["error"]))
            for px, py in ((x - 120, y - 70), (x - 60, y - 30), (x - 20, y - 8), (x, y)):
                dispatch({"type": "mouseMoved", "x": max(0, px), "y": max(0, py), "buttons": 0})
                time.sleep(0.05)
            time.sleep(0.2)
            dispatch({"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1})
            time.sleep(0.09)
            dispatch({"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1})
            return True
        except Exception as e:
            self.dead = True
            self.last_error = str(e)[:160]
            return False

    def restore_window(self):
        env_id = getattr(self, "env_id", None)
        if env_id in _window_contexts:
            return restore_environment_window(env_id)
        try:
            return set_browser_bounds(self.port, bounds_for_slot(0), target_id=self.target_id)
        except Exception:
            return None

    @staticmethod
    def _dom_nodes(node):
        yield node
        for key in ("children", "shadowRoots"):
            for child in node.get(key, []):
                yield from CDP._dom_nodes(child)
        if node.get("contentDocument"):
            yield from CDP._dom_nodes(node["contentDocument"])

    @staticmethod
    def _dom_attrs(node):
        attrs = node.get("attributes", [])
        return dict(zip(attrs[::2], attrs[1::2]))

    def cf_checkbox(self):
        """读取真实 CF 复选框及命中目标，不用外层容器或任意 checkbox 猜坐标。

        Turnstile 在 closed shadow DOM + 跨域 iframe 中；页面 querySelector
        只能看到隐藏 response，CDP 的 DOM 树可以读取实际可见控件。
        """
        self.cf_probe_reason = "复选框尚未出现"
        try:
            self.send("DOM.enable")
            root = self.send("DOM.getDocument", {"depth": -1, "pierce": True}).get("result", {}).get("root", {})
            targets = self._http("/json/list")
            viewport = self.evj("JSON.stringify({w:innerWidth,h:innerHeight,focus:document.hasFocus()})") or {}
            for owner in self._dom_nodes(root):
                oa = self._dom_attrs(owner)
                if owner.get("nodeName") != "IFRAME" or "challenges.cloudflare.com/" not in oa.get("src", ""):
                    continue
                target = next((t for t in targets if t.get("type") == "iframe" and
                               (t.get("id") == owner.get("frameId") or t.get("url") == oa.get("src"))), None)
                if not target:
                    continue
                self.send("DOM.scrollIntoViewIfNeeded", {"backendNodeId": owner["backendNodeId"]})
                model = self.send("DOM.getBoxModel", {"backendNodeId": owner["backendNodeId"]}).get("result", {}).get("model")
                if not model or model.get("width", 0) < 100 or model.get("height", 0) < 30:
                    continue               # 正常论坛也有 2x2 隐藏 Turnstile，不能点击。
                frame = CDP(self.port, target_id=target["id"], timeout=CDP_IO_TIMEOUT, deadline=self.deadline)
                try:
                    frame.send("DOM.enable")
                    fr = frame.send("DOM.getDocument", {"depth": -1, "pierce": True}).get("result", {}).get("root", {})
                    for control in self._dom_nodes(fr):
                        ca = self._dom_attrs(control)
                        if control.get("nodeName") != "INPUT" or ca.get("type") != "checkbox" or "disabled" in ca:
                            continue
                        cb = frame.send("DOM.getBoxModel", {"backendNodeId": control["backendNodeId"]}).get("result", {}).get("model")
                        if not cb or cb.get("width", 0) <= 0 or cb.get("height", 0) <= 0:
                            continue
                        obj = frame.send("DOM.resolveNode", {"backendNodeId": control["backendNodeId"]}).get("result", {}).get("object", {})
                        props = frame.send("Runtime.callFunctionOn", {
                            "objectId": obj.get("objectId"), "returnByValue": True,
                            "functionDeclaration": "function(){return {checked:this.checked,disabled:this.disabled,hidden:getComputedStyle(this).visibility==='hidden'};}"
                        }).get("result", {}).get("result", {}).get("value", {})
                        if props.get("checked") or props.get("disabled") or props.get("hidden"):
                            self.cf_probe_reason = "复选框已选中或暂不可操作"
                            continue
                        q, fq = cb["content"], model["content"]
                        # input 覆盖方框和文字，瞄准左侧方框中心；所有坐标均为 CSS 像素。
                        x = fq[0] + q[0] + min(cb["width"], cb["height"]) / 2
                        y = fq[1] + (q[1] + q[5]) / 2
                        if not (1 < x < viewport.get("w", 0) - 1 and 1 < y < viewport.get("h", 0) - 1):
                            self.cf_probe_reason = "复选框在视口之外"
                            continue
                        hit = self.send("DOM.getNodeForLocation", {"x": round(x), "y": round(y),
                            "includeUserAgentShadowDOM": True}).get("result", {})
                        if (hit.get("frameId") != target["id"] and
                                hit.get("backendNodeId") != owner["backendNodeId"]):
                            self.cf_probe_reason = "复选框被其它元素遮挡"
                            continue
                        return {"x": x, "y": y, "frameId": target["id"],
                                "w": cb["width"], "h": cb["height"], "focus": viewport.get("focus"), "via": "cdp-checkbox"}
                finally:
                    frame.close()
        except Exception as e:
            self.cf_probe_reason = "读取控件暂失败: %s" % str(e)[:100]
        return None

    def close(self):
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

# ─────────── 页面探测（注入 JS，避免正则转义踩坑）───────────
JS_STATE = r"""(function(){
var o={url:location.href,title:document.title};
/* 面板、body 字数和 readyState 都不能证明论坛已加载。
   CF 页也会注入面板；正常论坛则会保留隐藏 Turnstile。 */
var forum=!!document.querySelector('#main-outlet,.topic-list,.topic-body');
var forumDoc=!!document.querySelector('meta[name="generator"][content^="Discourse"]')&&!!document.getElementById('data-preloaded');
var cfIframe=!!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
var cfForm=!!document.querySelector('#challenge-form,#cf-challenge-running,#challenge-stage');
var cfWidget=!!document.querySelector('input[id^="cf-chl-widget"]');
/* CF 会按环境语言显示日文等标题，且 iframe 在 closed shadow DOM 内。
   从 response 字段查找可见控件宿主；正常论坛残留控件只有 0/2px，不能误报。 */
var cfVisibleWidget=false,cfInput=document.querySelector('input[id^="cf-chl-widget"]');
if(cfInput){
 var host=cfInput.parentElement;
 while(host&&host!==document.body){
  var rect=host.getBoundingClientRect();
  if(rect.width>=180&&rect.width<=500&&rect.height>=35&&rect.height<=150){cfVisibleWidget=true;break;}
  host=host.parentElement;
 }
}
var cfTitle=/Just a moment|Verifying you are human|Checking your browser|Attention required|请稍[候后]|請稍[候後]|稍候|檢查|正在验证|正在驗證/i.test(document.title);
var cfOptions=!!(window._cf_chl_opt&&window._cf_chl_opt.cType);
var bodyLen=document.body?document.body.innerText.trim().length:0;
o.cfBlock=!forum&&!forumDoc&&(cfVisibleWidget||cfTitle||cfForm||cfOptions||cfIframe);
o.forumDocument=forumDoc;
o.cfWhy=(cfWidget?'widget ':'')+(cfIframe?'iframe ':'')+(cfForm?'challengeForm ':'')
        +(cfVisibleWidget?'visibleWidget ':'')+(cfOptions?'challengeOptions ':'')
        +(cfTitle?'title ':'')+(!forum?'noApp ':'')+'len='+bodyLen;
o.loggedIn=!!document.querySelector('#current-user,.current-user');
o.anon=document.documentElement.classList.contains('anon');
var visible=e=>!!(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
o.loginForm=visible(document.querySelector('#login-account-name'))&&visible(document.querySelector('#login-account-password'));
o.loginButton=visible(document.querySelector('.login-button,.header-buttons .login-button'));
o.anonymousPage=!o.cfBlock&&!o.loggedIn&&(o.loginForm||(forum&&o.anon&&o.loginButton));
o.panel=!!document.getElementById('ldh_panel');
o.domReady=document.readyState==='complete';
o.appLoaded=forum&&!o.cfBlock;
o.focus=document.hasFocus();
o.visibility=document.visibilityState;
o.helperGuard=document.documentElement.getAttribute('data-ldh-guard')||'';
o.panelAccountStatus=document.documentElement.getAttribute('data-ldh-account-state')||'';
var r1=document.getElementById('ldh_r1');
o.r1=r1?r1.innerText.replace(/\s+/g,' ').slice(0,110):'';
o.panelLoginFailed=/未登录|尚未登录|确认登录中|登录待确认|接口限流|接口待验证/.test(o.r1)||
                  (!!o.panelAccountStatus&&o.panelAccountStatus!=='authenticated');
/* 无 OAuth 权限标记（脚本 1.0.7 起）。
   这类号(env101 起)在 connect 授权页被"你所在的用户组无法使用"直接拒掉，
   脚本会永久停用 LDC/Agent/Any 并把这三段从面板上隐藏。
   必须读这个显式属性，不能靠"r1 里没有 LDC 字样"推断 ——
   脚本刚起、还没渲染完时 r1 同样是空的，那样会把正常环境误判成无权限。
   此标记仅用于结果报告；余额读取不阻塞日常维护。 */
o.noOauth=!!(r1&&r1.getAttribute('data-nooauth')==='1');
var r4=document.getElementById('ldh_r4');
o.r4=r4?r4.innerText.replace(/\s+/g,' ').slice(0,140):'';
/* 429/限流的三种后果，表现完全不同（读脚本源码确认）：
   ① 启动前拒绝: r4 显示 "⛔ 本窗口已发X次，约Y分钟后再来" → 根本没刷帖
   ② 运行中软限流: sleep 8 秒继续跑 → 刷帖照常，只是变慢，界面无提示
   ③ 运行中硬封/达上限: 立即停止，但脚本【故意不显示】原因，
      r4 仍是 "脚本结束：主题 X 丨 回复 Y"，只能靠数字偏低反推 */
o.banned=/本窗口已发|⛔/.test(o.r4);
var mt=o.r4.match(/主题\s*(\d+)/), mr=o.r4.match(/回复\s*(\d+)/), ml=o.r4.match(/点赞\s*(\d+)/);
o.topics=mt?parseInt(mt[1]):-1;
o.replies=mr?parseInt(mr[1]):-1;
o.likes=ml?parseInt(ml[1]):-1;
o.finished=o.r4.indexOf('脚本结束')>=0;
o.busy=/脚本运行|刷帖中/.test(o.r4);
var m=o.r1.match(/\$[0-9][0-9.,]*/);
o.bal=m?m[0]:'';
/* LDC 积分。面板上格式是 "LDC：1215.9"，没有 $ 前缀，所以不能被上面那个正则捞到。
   非数字态(获取中/失败/账号不符)也一并抓出来，方便日志里区分
   "没读到" 和 "读到了但是失败"。 */
var lm=o.r1.match(/LDC[：:]\s*([^\s ]+)/);
o.ldc=lm?lm[1]:'';
o.ldcNum=(lm&&/^[0-9][0-9.,]*$/.test(lm[1]))?lm[1]:'';
o.fetching=o.r1.indexOf('获取中')>=0;
var b=document.getElementById('ldh_daily');
o.dailyText=b?(b.innerText||'').trim():'';
o.dailyReady=!!b && !b.disabled;
try{o.health=JSON.parse(document.documentElement.getAttribute('data-ldh-health')||'{}');}catch(e){o.health={};}
try{o.last=JSON.parse(localStorage.getItem('ld_helper_last')||'null');}catch(e){o.last=null;}
o.now=Date.now();
o.errorDetail=(r4?r4.title:'')||o.health.error||'';
return JSON.stringify(o);})()"""

# 账号查询必须区分匿名、CF/网络错误，不能把所有异常都归为未登录。
JS_SESSION = r"""(async function(){
var ctrl=new AbortController(),timer=setTimeout(function(){ctrl.abort();},15000);
try{
 var r=await fetch('/session/current.json',{credentials:'same-origin',cache:'no-store',
  signal:ctrl.signal,headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest'}});
 if(r.status===429)return JSON.stringify({status:'rate_limited',http:429,retryAfter:r.headers.get('retry-after')||''});
 var ct=r.headers.get('content-type')||'',text=await r.text();
 if(r.headers.get('cf-mitigated')==='challenge'||(!/json/i.test(ct)&&
  /just a moment|cf[-_]chl|challenges\.cloudflare\.com|请稍[候后]|請稍[候後]/i.test(text)))
  return JSON.stringify({status:'challenge',http:r.status});
 if(!/json/i.test(ct))return JSON.stringify({status:'unknown',http:r.status,reason:'non_json'});
 var j;try{j=JSON.parse(text);}catch(e){return JSON.stringify({status:'unknown',http:r.status,reason:'invalid_json'});}
 var u=j.current_user||j.currentUser;
 if(r.ok&&u&&u.username)return JSON.stringify({status:'authenticated',http:r.status,username:String(u.username)});
 if(r.status===401||r.status===404||(r.ok&&Object.prototype.hasOwnProperty.call(j,'current_user')&&!j.current_user))
  return JSON.stringify({status:'anonymous',http:r.status});
 return JSON.stringify({status:'unknown',http:r.status,reason:'unexpected_response'});
}catch(e){return JSON.stringify({status:'unknown',reason:e.name==='AbortError'?'timeout':'network'});}
finally{clearTimeout(timer);}
})()"""


def probe_session(cdp):
    return cdp.evj(JS_SESSION, await_promise=True) or {"status": "unknown", "reason": "cdp"}


# 找 CF 质询的可点坐标。
# 实测 env95 的真实拦截页结构（linux.do 的 CF interstitial）：
#   body > div.container > ... > div#XXXX  300x65 可见   ← Turnstile widget 容器
#                                input[id^="cf-chl-widget"]  0x0 隐藏(response 字段)
#   页面里【没有】challenges.cloudflare.com 的 iframe，也没有 input[type=checkbox]，
#   所以旧版两条路径全部落空 → 报"未找到可点元素"。
# 实测点击 widget 容器左侧(left+30, 垂直居中)可通过，约 12 秒 loggedIn 变 True。
# 优先级：CF iframe → widget 容器(按隐藏 input 反查) → 尺寸启发式 → checkbox。
JS_CF_BOX = r"""(function(){
function box(e,offx){var r=e.getBoundingClientRect();
  if(r.width<=0||r.height<=0)return null;
  return {x:Math.round(r.left+(offx||Math.min(30,r.width/2))),
          y:Math.round(r.top+r.height/2),
          w:Math.round(r.width),h:Math.round(r.height)};}
/* 1) 标准 Turnstile iframe */
var fs=[].slice.call(document.querySelectorAll('iframe'));
for(var i=0;i<fs.length;i++){
  if(/challenges\.cloudflare\.com|turnstile/i.test(fs[i].src||'')){
    var b=box(fs[i],30); if(b){b.via='iframe';return JSON.stringify(b);}}}
/* 2) 由隐藏 response 字段反查它所在的可见容器。
      实测 env11/14/46/51/53 在这条上返回空 → 点了"找不到复选框"。
      原因是原判据要求容器宽 250-320、高 55-80，太窄：
      撑大窗口后页面重排瞬间尺寸会溢出这个区间，Turnstile 也会按容器宽度
      自适应（实测见过 299/300/301 宽、64/65/66 高）。
      放宽到 200-420 x 40-120，并且【向上多找几层】，取第一个符合的。 */
var inp=document.querySelector('input[id^="cf-chl-widget"]');
if(inp){
  var n=inp.parentElement;
  while(n&&n!==document.body){
    var r=n.getBoundingClientRect();
    if(r.width>=200&&r.width<=420&&r.height>=40&&r.height<=120){
      var b2=box(n,30); if(b2){b2.via='widget';return JSON.stringify(b2);}}
    n=n.parentElement;}}
/* 3) 尺寸启发式（谨慎）：仅当页面已是纯质询页(正文极短)时才用，
      否则会在"还在加载的正常页面"上抓错元素 —— 实测 env97 首次就因此点到 (54,77) 失败。 */
if((document.body?document.body.innerText.trim().length:0)<400){
  var cand=[].slice.call(document.querySelectorAll('body > div.container div, body > div div'))
    .filter(function(e){var r=e.getBoundingClientRect();
      return r.width>=250&&r.height>=40&&r.height<=110;});
  if(cand.length){var b3=box(cand[cand.length-1],30);
    if(b3){b3.via='heuristic';return JSON.stringify(b3);}}}
/* 4) 兜底：可见 checkbox */
var cb=document.querySelector('input[type=checkbox]');
if(cb){var b4=box(cb); if(b4){b4.via='checkbox';return JSON.stringify(b4);}}
return '';})()"""

JS_CLICK_DAILY = r"""(function(){
var b=document.getElementById('ldh_daily');
if(!b)return 'no_button';
var t=(b.innerText||'').trim();
if(t.indexOf('停止')>=0)return 'already_running';
if(b.disabled)return 'disabled';
b.click();
return 'clicked';})()"""

# Turnstile 复选框到底渲染出来没有。
# 【别用正文字数判断】—— 之前用 bodyLen<100 当兜底，结果油猴面板的文字
# 也算在正文里，有等级数据的号面板文字多、字数超 100，被误判成"加载中"
# （env109 截图里复选框明明在，却报 loading:143）。那是假指标，已删。
# 尺寸区间要和 JS_CF_BOX 里的放宽后区间保持一致，否则一个能点、一个说没就绪。
JS_CF_READY = r"""(function(){
  var inp=document.querySelector('input[id^="cf-chl-widget"]');
  if(!inp) return 'no_widget';
  var n=inp.parentElement, box=null;
  while(n&&n!==document.body){
    var r=n.getBoundingClientRect();
    if(r.width>=200&&r.width<=420&&r.height>=40&&r.height<=120){box=n;break;}
    n=n.parentElement;}
  if(!box) return 'no_box';
  if(box.querySelector('iframe')) return 'ready';
  var all=box.querySelectorAll('*');
  for(var i=0;i<all.length;i++){ if(all[i].shadowRoot) return 'ready'; }
  // 容器有尺寸(300x65)就是画出来了 —— 复选框在闭合 shadow DOM 里，
  // 从外面看不到子节点，但盒子本身有大小就说明渲染完成
  return 'ready';
})()"""


def try_pass_cf(cdp, env_id, why=""):
    """一次浏览器会话内处理最多五轮不同的 CF 控件，全程保持小窗口。

    env22 实测：第一个框点击后重新下发一个新框，再点才进入论坛。
    不能把“同一浏览器”当成“同一个验证框”，也不能凭面板/账号判通过。
    """
    t0 = time.monotonic()
    previous_deadline = getattr(cdp, "deadline", None)
    cf_deadline = min(t0 + CF_TOTAL_TIMEOUT, previous_deadline or float('inf'))
    cdp.deadline = cf_deadline
    cdp.last_cf_result = {"encountered": True, "clicks": 0, "passed": False, "reason": ""}
    clicked_frames = []
    last_clicked = {}
    ready_frame, ready_since = None, None
    log("  env%-3d 检测到CF拦截 [%s]" % (env_id, why or "?"))
    try:
        cdp.send("Page.bringToFront")
        cdp.ev("(()=>{let e=document.getElementById('ldh-cf-viewport');if(!e){e=document.createElement('style');e.id='ldh-cf-viewport';e.textContent='#ldh_panel,#ldh_login_panel{visibility:hidden!important;pointer-events:none!important}';document.documentElement.appendChild(e);}return true})()")
        log("  env%-3d 保持原小窗口，滚动定位验证控件" % env_id)
        deadline = time.monotonic() + CF_WIDGET_WAIT
        hard_deadline = cf_deadline
        while not _cancel_flag.is_set() and time.monotonic() < min(deadline, hard_deadline):
            st = cdp.evj(JS_STATE) or {}
            if (st.get("appLoaded") or st.get("forumDocument")) and not st.get("cfBlock"):
                cdp.last_cf_result.update(passed=True, reason="forum_loaded" if st.get("appLoaded") else "forum_document")
                log("  env%-3d CF已通过，论坛文档已返回（点击%d轮，%.1f秒）" %
                    (env_id, len(clicked_frames), time.monotonic() - t0))
                return True
            if getattr(cdp, "dead", False):
                cdp.last_cf_result.update(reason="调试状态读取失败", error=getattr(cdp, "last_error", ""))
                return False
            if st.get("cfBlock"):
                # CF 可能重新加载整个文档；每轮确保助手面板没有挡住小视口里的控件。
                cdp.ev("(()=>{if(!document.getElementById('ldh-cf-viewport')){const e=document.createElement('style');e.id='ldh-cf-viewport';e.textContent='#ldh_panel,#ldh_login_panel{visibility:hidden!important;pointer-events:none!important}';document.documentElement.appendChild(e);}return true})()")
            box = cdp.cf_checkbox() if st.get("cfBlock") else None
            if box and time.monotonic() - last_clicked.get(box["frameId"], float('-inf')) >= 15:
                if ready_frame != box["frameId"]:
                    ready_frame, ready_since = box["frameId"], time.monotonic()
                    log("  env%-3d 发现第%d轮真实CF复选框，等待控件稳定" % (env_id, len(clicked_frames) + 1))
                    deadline = time.monotonic() + CF_WIDGET_WAIT
                if len(clicked_frames) >= 5:
                    cdp.last_cf_result["reason"] = "连续五轮后仍有新验证"
                    break
                if time.monotonic() - ready_since >= CF_SETTLE:
                    with CF_CLICK_LOCK:
                        cdp.send("Page.bringToFront")
                        fresh = cdp.cf_checkbox()
                        clicked = bool(fresh and fresh["frameId"] == ready_frame and cdp.click_xy(fresh["x"], fresh["y"]))
                    if fresh and fresh["frameId"] == ready_frame:
                        if not clicked:
                            cdp.last_cf_result.update(reason="点击指令失败", error=getattr(cdp, "last_error", ""))
                            return False
                        clicked_frames.append(ready_frame)
                        last_clicked[ready_frame] = time.monotonic()
                        cdp.last_cf_result["clicks"] = len(clicked_frames)
                        cdp.last_cf_result.setdefault("clickDetails", []).append({
                            "elapsed": round(time.monotonic()-t0, 1), "frame": ready_frame,
                            "focus": fresh.get("focus"), "x": fresh["x"], "y": fresh["y"]})
                        log("  env%-3d 已点第%d轮CF真实复选框 (%.1f,%.1f)，页面焦点=%s" %
                            (env_id, len(clicked_frames), fresh["x"], fresh["y"], fresh.get("focus")))
                        ready_frame, ready_since = None, None
                        deadline = time.monotonic() + CF_PASS_WAIT
            elif not box:
                # 控件消失/重建时重新计稳定时间，不能沿用旧坐标。
                ready_frame, ready_since = None, None
            time.sleep(1)
        if not cdp.last_cf_result["reason"]:
            total_timeout = time.monotonic() >= cf_deadline
            cdp.last_cf_result.update(
                reason="CF总预算超时" if total_timeout else ("点击后等待论坛超时" if clicked_frames else "CF控件等待超时"),
                timedOut=True,
                timeoutSource="cf_total" if total_timeout else ("cf_after_click" if clicked_frames else "cf_widget"),
                probeReason=getattr(cdp, "cf_probe_reason", ""))
        log("  env%-3d CF尚未通过：%s（点击%d轮）" %
            (env_id, cdp.last_cf_result["reason"], len(clicked_frames)))
        return False
    except Exception as e:
        total_timeout = time.monotonic() >= cf_deadline
        io_timeout = isinstance(e, TimeoutError) or 'timeout' in type(e).__name__.lower()
        reason = "CF总预算超时" if total_timeout else ("CF调试调用超时" if io_timeout else "CF调试调用失败")
        cdp.last_cf_result.update(reason=reason, timedOut=total_timeout or io_timeout,
                                 error=type(e).__name__+": "+str(e)[:160])
        log("  env%-3d %s，结束本环境验证" % (env_id, reason))
        return False
    finally:
        cdp.last_cf_result["elapsed"] = round(time.monotonic() - t0, 1)
        if not cdp.last_cf_result.get("passed"):
            log("  env%-3d CF检查结束: %s，用时 %.1fs，点击 %d 轮%s" %
                (env_id, cdp.last_cf_result.get("reason", ""), cdp.last_cf_result["elapsed"],
                 cdp.last_cf_result["clicks"],
                 "；"+cdp.last_cf_result["error"] if cdp.last_cf_result.get("error") else ""))
        cdp.deadline = time.monotonic() + 2
        cdp.ev("document.getElementById('ldh-cf-viewport')?.remove();true")
        cdp.deadline = previous_deadline
        cdp.restore_window()


def retry_after_seconds(value, default=30):
    try:
        return max(1, float(value))
    except (TypeError, ValueError):
        try:
            from email.utils import parsedate_to_datetime
            return max(1, parsedate_to_datetime(value).timestamp() - time.time())
        except Exception:
            return default


def confirmed_anonymous(st, last=None):
    """只采用页面、会话或当前运行的明确未登录状态，不把网络/CF当成未登录。"""
    if (last or {}).get("reason") in ("未登录", "登录失效"):
        return True
    # 当前会话接口的明确结果优先于面板尚未同步的旧信息。
    session = st.get("sessionStatus")
    if session in ("authenticated", "anonymous", "challenge", "rate_limited"):
        return session == "anonymous"
    return (bool(st.get("anonymousPage")) or
            st.get("panelAccountStatus") == "anonymous" or
            (st.get("health") or {}).get("account") == "anonymous")


def mark_not_logged_in(result, state, last=None):
    result.update(ok=False, success=False, note="论坛未登录", loginStatus="anonymous",
                  loginRetryable=False, wasAnonymous=True, state=state)
    if last:
        result["run"] = last


def open_forum(env_id, port, attempt, handle_cf=True, deadline=None, normal_bounds=None):
    """加载主体、完成 CF、确认服务器会话，再确认面板。

    --open 使用 handle_cf=False，只打开供人工操作。
    """
    env_deadline = deadline or (time.monotonic() + ENV_READY_TIMEOUT)
    try:
        cdp = CDP(port, url="about:blank" if handle_cf else "https://linux.do/",
                  timeout=CDP_IO_TIMEOUT, deadline=env_deadline)
        if handle_cf:
            # 在导航前确定本轮模式，并清理上一轮仅论坛模式的标记。
            flags = ("sessionStorage.setItem('ldh_python_managed','1');sessionStorage.setItem('ldh_forum_only','1');"
                     if FORUM_ONLY else
                     "sessionStorage.removeItem('ldh_python_managed');sessionStorage.removeItem('ldh_forum_only');")
            injected = cdp.send("Page.addScriptToEvaluateOnNewDocument", {"source":
                "if(location.origin==='https://linux.do'){" + flags + "}"})
            if injected.get("error"):
                raise RuntimeError("无法设置本轮辅助功能模式，未开始运行")
            cdp.send("Page.navigate", {"url": "https://linux.do/"})
    except Exception as e:
        log("  env%-3d CDP连接失败(第%d次): %s" % (env_id, attempt, str(e)[:70]))
        return None, None
    cdp.env_id = env_id
    context = _window_contexts.setdefault(env_id, {"port": port,
        "bounds": dict(normal_bounds or bounds_for_slot(0))})
    context["target_id"] = cdp.target_id
    cdp.restore_window()
    if not handle_cf:
        closed = cdp.close_idle_tabs(cdp.target_id, default_only=True)
        if closed:
            log("  env%-3d 已打开论坛，关闭 %d 个默认标签页" % (env_id, closed))
    st, session = {}, {"status": "unknown"}
    t0 = time.monotonic()
    deadline = min(t0 + PANEL_WAIT_MAX, env_deadline)
    cf_handled, reloaded = False, False
    next_session, mismatch_since = 0, None
    saw_anonymous = False
    while not _cancel_flag.is_set() and time.monotonic() < deadline:
        st = cdp.evj(JS_STATE) or {}
        if getattr(cdp, "dead", False):
            break
        if st.get("cfBlock"):
            if not handle_cf or cf_handled:
                break
            cf_handled = True
            passed = try_pass_cf(cdp, env_id, st.get("cfWhy", ""))
            st = cdp.evj(JS_STATE) or st
            if not passed:
                break
            session, next_session = {"status": "unknown"}, 0
            deadline = min(time.monotonic() + PANEL_WAIT_MAX, env_deadline)
            continue
        if not handle_cf and (st.get("appLoaded") or st.get("loginForm")):
            break
        if handle_cf and st.get("anonymousPage"):
            saw_anonymous = True
            session = {"status": "anonymous", "reason": "anonymous_page"}
            log("  env%-3d 页面确认未登录，标记失败并跳过" % env_id)
            break
        if st.get("appLoaded"):
            hold_until = (st.get("health") or {}).get("holdUntil") or 0
            if (st.get("loggedIn") and st.get("panelAccountStatus") == "rate_limited" and
                    hold_until - st.get("now", time.time()*1000) > STARTUP_TOTAL_TIMEOUT*1000):
                # 已登录且已有超过本轮全部预算的明确冷却记录，继续探测/刷新也无法运行。
                st["storedCooldownUntil"] = hold_until
                session = {"status": "rate_limited", "reason": "stored_cooldown"}
                break
            now = time.monotonic()
            if now >= next_session and session.get("status") != "authenticated":
                session = probe_session(cdp)
                next_session = time.monotonic() + (retry_after_seconds(session.get("retryAfter"))
                    if session.get("status") == "rate_limited" else 10)
            st["sessionStatus"] = session.get("status", "unknown")
            st["sessionUser"] = session.get("username", "")
            st["sessionHttp"] = session.get("http")
            if session.get("status") == "anonymous":
                saw_anonymous = True
                log("  env%-3d 会话接口确认未登录，标记失败并跳过" % env_id)
                break
            if session.get("status") == "rate_limited":
                if next_session >= env_deadline:
                    break
                # 等服务器要求的冷却，不刷新页面绕过退避。
                deadline = env_deadline
            elif session.get("status") in ("anonymous", "challenge"):
                break
            if session.get("status") == "authenticated" and st.get("panel"):
                # 给首次账号请求时间；持续误报时仅刷新这个新开的论坛标签一次。
                if st.get("panelLoginFailed") or not st.get("r1"):
                    mismatch_since = mismatch_since or time.monotonic()
                    if time.monotonic() - mismatch_since >= 20 and not reloaded:
                        log("  env%-3d 服务器已登录但面板未同步，刷新论坛标签重建面板" % env_id)
                        cdp.send("Page.reload", {"ignoreCache": False})
                        reloaded = True
                        session, next_session, mismatch_since = {"status": "unknown"}, 0, None
                        deadline = min(time.monotonic() + PANEL_WAIT_MAX, env_deadline)
                        time.sleep(1)
                        continue
                else:
                    cdp.close_idle_tabs(cdp.target_id)
                    break
        time.sleep(1)
    st["sessionStatus"] = session.get("status", "unknown")
    st["sessionUser"] = session.get("username", "")
    st["sessionHttp"] = session.get("http")
    st["sessionRetryAfter"] = session.get("retryAfter", "")
    st["wasAnonymous"] = saw_anonymous
    st["panelReloaded"] = reloaded
    st["timedOut"] = time.monotonic() >= env_deadline
    st["cdpError"] = getattr(cdp, "last_error", "")
    st["cfResult"] = getattr(cdp, "last_cf_result", {"encountered": False, "clicks": 0})
    if not (st.get("appLoaded") and st.get("panel")) or st.get("cfBlock"):
        log("  env%-3d 页面检查结束 %.1fs: CF=%s 主体=%s 面板=%s 会话=%s" %
            (env_id, time.monotonic() - t0, st.get("cfBlock"), st.get("appLoaded"),
             st.get("panel"), st.get("sessionStatus")))
    return cdp, st


def run_one(env_id, attempt=1, deadline=None, normal_bounds=None):
    """加载/验证一个环境；就绪后由该环境的工作线程立即启动日常维护。"""
    res = {"id": env_id, "attempt": attempt, "ok": False, "bal": "", "note": "", "started": False,
           "forumOnly": FORUM_ONLY}
    deadline = deadline or (time.monotonic() + ENV_READY_TIMEOUT)
    if _cancel_flag.is_set():
        res["note"] = "用户中断"
        return res
    if time.monotonic() >= deadline:
        res.update(note="环境启动验证超时", timedOut=True)
        return res
    normal_bounds = normal_bounds or bounds_for_slot(0)
    port = launch(env_id, deadline=deadline, normal_bounds=normal_bounds)
    if not port:
        if time.monotonic() >= deadline:
            res.update(note="环境启动验证超时", timedOut=True)
        else:
            res["note"] = "启动失败/无调试端口"
        return res
    res["port"] = port
    cdp, st = open_forum(env_id, port, attempt, deadline=deadline, normal_bounds=normal_bounds)
    if cdp is None:
        if time.monotonic() >= deadline:
            res.update(note="环境启动验证超时", timedOut=True)
        else:
            res["note"] = "CDP连接失败"
        return res
    res["cdp"] = cdp
    if _cancel_flag.is_set():
        res["note"] = "用户中断"
        return res
    if not st:
        res["note"] = "页面状态读取失败"
        return res
    res["state"] = st
    res["cfResult"] = st.get("cfResult", {})
    res["wasAnonymous"] = bool(st.get("wasAnonymous"))
    res["loginStatus"] = st.get("sessionStatus", "unknown")
    cf_reason = res["cfResult"].get("reason", "")
    if confirmed_anonymous(st):
        mark_not_logged_in(res, st)
    elif st.get("sessionStatus") == "rate_limited" or st.get("panelAccountStatus") == "rate_limited":
        if st.get("storedCooldownUntil"):
            end = datetime.fromtimestamp(st["storedCooldownUntil"]/1000, timezone.utc) + timedelta(hours=8)
            res.update(note="脚本已有429冷却记录，截止 %s（北京时间），超出本轮等待预算" % end.strftime("%Y-%m-%d %H:%M:%S"), banned=True)
        else:
            res.update(note="会话接口限流(HTTP 429)，冷却未结束", banned=True)
    elif st.get("timedOut") or res["cfResult"].get("timedOut"):
        note = "CF验证超时" if res["cfResult"].get("encountered") and not res["cfResult"].get("passed") else "环境启动验证超时"
        res.update(note=note + (" [%s]" % cf_reason if cf_reason else ""), timedOut=True)
    elif st.get("cfBlock"):
        res.update(note="CF验证未通过 [%s]" % (cf_reason or st.get("cfWhy") or "?"), cf=True)
    elif not st.get("appLoaded"):
        # complete 也可能是 CF 壳、空白页或错误页，绝不据此宣布未登录。
        res["note"] = "页面未加载完"
    elif st.get("sessionStatus") == "rate_limited":
        res["note"] = "会话接口限流(HTTP 429)，本次跳过"
    elif st.get("sessionStatus") == "challenge":
        res["note"] = "会话接口受CF拦截，本次跳过"
    elif st.get("panelAccountStatus") == "rate_limited":
        res["note"] = "脚本会话接口限流(HTTP 429)，本次跳过"
    elif st.get("panelAccountStatus") == "challenge":
        res["note"] = "脚本会话接口受CF拦截，本次跳过"
    elif st.get("sessionStatus") != "authenticated":
        res["note"] = "登录状态暂未确认"
    elif not st.get("panel"):
        res["note"] = "已登录但脚本面板未出现"
    elif st.get("panelLoginFailed") or not st.get("r1"):
        res["note"] = "脚本登录状态未同步"
    else:
        res.update(ok=True, bal=st.get("bal", ""), ldc=st.get("ldc", ""),
                   r1=st.get("r1", ""), noOauth=bool(st.get("noOauth")))
        # 启动预算不限制正式维护；就绪连接还要用于后续余额检查和日常维护。
        cdp.deadline = None
    return res


# 每个环境首次尝试加最多五次重试，共用五分钟预算；不清除服务器限流状态。
MAX_ATTEMPTS = MAX_RETRIES + 1
RETRYABLE = ("启动失败/无调试端口", "CDP连接失败", "页面状态读取失败",
             "页面未加载完", "已登录但脚本面板未出现", "环境启动验证超时",
             "登录状态暂未确认", "脚本登录状态未同步", "CF验证未通过", "CF验证超时",
             "会话接口受CF拦截", "脚本会话接口受CF拦截")

def is_retryable(note):
    return any(str(note).startswith(x) for x in RETRYABLE)

def rate_blocked(st):
    h = st.get("health") or {}
    return (st.get("banned") or st.get("sessionStatus") == "rate_limited" or
            st.get("panelAccountStatus") == "rate_limited" or
            h.get("account") == "rate_limited" or
            h.get("holdUntil", 0) > st.get("now", time.time() * 1000))

def remember_attempt(r, history, began):
    history.append({"attempt": r.get("attempt", 1), "note": r.get("note", ""),
                    "elapsed": round(time.monotonic() - began, 2),
                    "loginStatus": r.get("loginStatus", "unknown"), "cfResult": r.get("cfResult")})


def can_retry_result(r):
    if r.get("loginStatus") == "anonymous" or confirmed_anonymous(r.get("state") or {}):
        return False
    return (is_retryable(r.get("note", "")) and
            not rate_blocked(r.get("state") or {}) and not r.get("banned"))


def reopen_once(r):
    """重试入口，首次及点击后的启动恢复共用五次额度和五分钟预算。"""
    deadline = r.setdefault("startupDeadline", time.monotonic() + STARTUP_TOTAL_TIMEOUT)
    while not _cancel_flag.is_set():
        left = deadline - time.monotonic()
        if left <= 0:
            r.update(ok=False, budgetExhausted=True)
            return False
        if _startup_lock.acquire(timeout=min(1, left)):
            try:
                return _reopen_once(r)
            finally:
                _startup_lock.release()
    r.update(ok=False, note="用户中断，取消重启")
    return False


def _reopen_once(r):
    deadline = r.setdefault("startupDeadline", time.monotonic() + STARTUP_TOTAL_TIMEOUT)
    if _cancel_flag.is_set() or r.get("restartsUsed", 0) >= MAX_RETRIES or time.monotonic() >= deadline:
        return False
    retries = r.get("restartsUsed", 0) + 1
    r["restartsUsed"] = retries
    if r.get("cdp"):
        r["cdp"].close()
    if not stop(r["id"], verify_timeout=max(.1, min(15, deadline - time.monotonic()))):
        r.update(ok=False, note=r.get("note", "") + "; 未能确认关闭，取消重启")
        return False
    log("  env%-3d %s → 重试 %d/%d，剩余启动预算 %.0f 秒" %
        (r["id"], r.get("note", "启动未就绪"), retries, MAX_RETRIES, max(0, deadline-time.monotonic())))
    time.sleep(min(3, max(0, deadline-time.monotonic())))
    if _cancel_flag.is_set() or time.monotonic() >= deadline:
        r.update(ok=False, note="用户中断，取消重启" if _cancel_flag.is_set() else r.get("note", "") + "; 五分钟启动预算已用完",
                 budgetExhausted=not _cancel_flag.is_set())
        return False
    history, slot, began = r.get("attemptHistory", []), r.get("slot", 0), time.monotonic()
    try:
        fresh = run_one(r["id"], attempt=retries+1, deadline=min(deadline, began+ENV_READY_TIMEOUT),
                        normal_bounds=bounds_for_slot(slot))
    except Exception as e:
        fresh = {"id": r["id"], "ok": False, "started": False,
                 "attempt": retries+1, "note": "重启检查异常: %s" % type(e).__name__}
    remember_attempt(fresh, history, began)
    r.clear()
    r.update(fresh, slot=slot, restartsUsed=retries, startupDeadline=deadline, attemptHistory=history)
    return bool(r.get("ok"))


def start_one(env_id, slot=0):
    with _startup_lock:
        return _start_one(env_id, slot)


def _start_one(env_id, slot=0):
    began = time.monotonic()
    deadline = began + STARTUP_TOTAL_TIMEOUT
    try:
        r = run_one(env_id, deadline=min(deadline, began+ENV_READY_TIMEOUT), normal_bounds=bounds_for_slot(slot))
    except Exception as e:
        r = {"id": env_id, "ok": False, "started": False, "note": "环境检查异常: %s" % type(e).__name__}
    history = []
    remember_attempt(r, history, began)
    r.update(slot=slot, restartsUsed=0, startupDeadline=deadline, attemptHistory=history)
    while (not r["ok"] and can_retry_result(r) and not _cancel_flag.is_set() and
           r["restartsUsed"] < MAX_RETRIES and time.monotonic() < deadline):
        old_count = r["restartsUsed"]
        if reopen_once(r):
            break
        if r["restartsUsed"] == old_count or "未能确认关闭" in r.get("note", ""):
            break
    if not r["ok"]:
        r["budgetExhausted"] = time.monotonic() >= deadline
        if r.get("cdp"):
            r["cdp"].close()
        r["closed"] = stop(env_id, verify_timeout=15)
        log("  env%-3d 启动检查结束: %s（重试 %d 次，总用时 %.1f 秒）" %
            (env_id, r["note"], r["restartsUsed"], time.monotonic()-began))
    return r


def current_run(st, click_at):
    last = st.get("last") or (st.get("health") or {}).get("last") or {}
    return last if last.get("startedAt", 0) >= click_at and last.get("mode") == "daily" else {}


def recover_startup(r):
    """仅恢复尚未确认未登录的启动故障。"""
    if (r.get("loginStatus") == "anonymous" or "未登录" in str(r.get("note", "")) or
            confirmed_anonymous(r.get("state") or {})):
        return False
    while not _cancel_flag.is_set():
        previous = r.get("restartsUsed", 0)
        if reopen_once(r):
            return True
        if (r.get("restartsUsed", 0) == previous or r.get("restartsUsed", 0) >= MAX_RETRIES or
            not can_retry_result(r) or "未能确认关闭" in r.get("note", "")):
            return False
    return False

def startup_restart_needed(st, last, age):
    if confirmed_anonymous(st, last):
        return False
    h = st.get("health") or {}
    counts = last.get("sent") or {}
    # 轮询可能晚一拍；以真实停止时间判断“启动即退出”，不能把检查延迟算入运行时长。
    if last.get("at") is not None and last.get("startedAt") is not None:
        age = max(0, (last["at"] - last["startedAt"]) / 1000)
    # 登录复核和首次动作前的明确 CF 失败都允许使用剩余启动预算恢复。
    login_failure = last.get("reason") in ("登录复核失败", "未登录", "登录失效")
    cf_failure = bool(last) and (last.get("reason") == "challenge" or
        (last.get("reason") == "异常" and str(last.get("endNote", "")).startswith("需要完成 CF 验证")))
    if (age > 15 and not (login_failure or cf_failure)) or rate_blocked(st) or (h.get("running") and not last):
        return False
    if any(counts.get(k, 0) > 0 for k in ("topics", "replies", "likes")):
        return False
    # 已确认未登录直接失败；仅恢复未知会话/CF等启动故障。
    return (h.get("account") in ("unknown", "challenge") or
            bool(h.get("challenge")) or
            st.get("panelAccountStatus") in ("unknown", "challenge") or
            last.get("reason") in ("登录复核失败", "challenge") or
            (last.get("reason") == "异常" and
             str(last.get("endNote", "")).startswith("需要完成 CF 验证")))

def run_daily(r, on_started=None):
    """以当前 startedAt 的真实记录判断结果，读取、回复、点赞任一成功即可。"""
    try:
        while True:
            if _cancel_flag.is_set():
                r.update(ok=False, success=False, note="用户中断")
                return
            st = r["cdp"].evj(JS_STATE) or {}
            if confirmed_anonymous(st):
                mark_not_logged_in(r, st)
                return
            if rate_blocked(st):
                r.update(ok=False, success=False, banned=True, note="服务器限流冷却中，本次跳过")
                return
            if (st.get("health") or {}).get("running"):
                r.update(ok=False, success=False, note="已有运行，本次不重复点击")
                return
            click_at = st.get("now", time.time()*1000)
            r.update(clickAt=click_at, success=False, started=False, confirmed=False)
            if _cancel_flag.is_set():
                r.update(ok=False, note="用户中断")
                return
            out = r["cdp"].ev(JS_CLICK_DAILY)
            r["clickResult"] = out
            if out != "clicked":
                r.update(ok=False, note="日常按钮未启动: %s" % out)
                return
            log("  env%-3d 已点日常维护，计划运行 3 分钟" % r["id"])
            began = time.monotonic()
            retry = False
            last = {}
            while time.monotonic()-began < RUN_SECONDS:
                time.sleep(1)
                if _cancel_flag.is_set():
                    r.update(ok=False, success=False, note="用户中断")
                    return
                st = r["cdp"].evj(JS_STATE) or {}
                if not st:
                    r.update(ok=False, note="运行状态读取失败，未确认成功")
                    return
                h = st.get("health") or {}
                last = current_run(st, click_at)
                age = time.monotonic()-began
                if h.get("running") and h.get("startedAt", 0) >= click_at:
                    r.update(started=True, confirmed=True)
                if last:
                    r.update(started=True, confirmed=True)
                # 首个动作成功前，保留启动通道给本环境的 CF/登录恢复。
                # 避免下一号的慢加载占住锁，把前一号剩余的重试预算耗尽。
                live_action = (h.get("running") and h.get("startedAt", 0) >= click_at and
                    any((h.get("sent") or {}).get(k, 0) > 0 for k in ("topics", "replies", "likes")))
                completed_action = any((last.get("sent") or {}).get(k, 0) > 0 for k in ("topics", "replies", "likes"))
                if confirmed_anonymous(st, last) and not (live_action or completed_action):
                    mark_not_logged_in(r, st, last)
                    return
                if on_started is not None and (live_action or completed_action):
                    log("  env%-3d 已确认首个成功动作，可以检查下一个环境" % r["id"])
                    on_started()
                    on_started = None
                if age >= CONFIRM_WAIT and startup_restart_needed(st, last, age):
                    r["note"] = last.get("endNote") or h.get("error") or st.get("errorDetail") or "登录未确认/CF 启动即退出"
                    if last:
                        history = r.setdefault("attemptHistory", [])
                        if not history:
                            history.append({"attempt": r.get("attempt", 1)})
                        failed_run = dict(last)
                        failed_run.pop("user", None)
                        history[-1].setdefault("dailyRuns", []).append(failed_run)
                    retry = recover_startup(r)
                    break
                if last or rate_blocked(st):
                    if last and age < CONFIRM_WAIT and startup_restart_needed(st, last, age):
                        continue
                    break
                if age >= 15 and not r.get("started"):
                    r.update(ok=False, note=h.get("error") or st.get("errorDetail") or "点击后未进入运行")
                    return
            if retry:
                continue
            # 重启耗尽或失败时，不再使用旧连接的记录覆盖新失败原因。
            if not r.get("ok") or not r.get("started"):
                r.update(ok=False, success=False)
                if not r.get("note"):
                    r["note"] = "启动未成功，重试次数或五分钟预算已用完"
                return
            counts = last.get("sent") or {}
            r.update(topics=counts.get("topics",0), replies=counts.get("replies",0), likes=counts.get("likes",0),
                     endR4=st.get("r4",""), endBal="已跳过" if FORUM_ONLY else st.get("bal",""),
                     endLdc="已跳过" if FORUM_ONLY else st.get("ldc",""), forumOnly=FORUM_ONLY,
                     run=last, throttled=last.get("reason")=="rate_limited", banned=bool(rate_blocked(st)))
            r["success"] = any(counts.get(k,0)>0 for k in ("topics","replies","likes"))
            r["ok"] = r["success"]
            r["note"] = last.get("endNote") or ("未取得本轮结束记录" if not last else "本轮没有成功动作")
            log("  env%-3d 结束: 主题%d 回复%d 点赞%d；%s；%s" %
                (r["id"],r["topics"],r["replies"],r["likes"],"成功" if r["success"] else "零动作/未确认",r["note"]))
            return
    except Exception as e:
        r.update(ok=False, success=False, note="日常运行检查异常: %s" % type(e).__name__)
        log("  env%-3d %s" % (r["id"],r["note"]))


def start_auxiliary_verifier(result):
    if FORUM_ONLY or not isinstance(result.get("port"), int) or not isinstance(getattr(result.get("cdp"), "target_id", None), str):
        return None
    return AuxiliaryVerifier(sys.modules[__name__], result).start()


def process_environment(env_id, slot, startup_done=None):
    """油猴确认首个成功动作后交出启动次序；维护并行，失败则清理后交出次序。"""
    r = {"id": env_id, "slot": slot, "ok": False, "started": False, "note": "用户中断", "forumOnly": FORUM_ONLY}
    auxiliary = None
    try:
        if not _cancel_flag.is_set():
            r = start_one(env_id, slot)
            if r.get("ok") and not _cancel_flag.is_set():
                auxiliary = start_auxiliary_verifier(r)
                log("  env%-3d 油猴已就绪，立即运行（位置 %d）" % (env_id, slot + 1))
                # 预算只管启动恢复；正式维护仍独立运行三分钟。
                run_daily(r, on_started=startup_done.set if startup_done is not None else None)
    except Exception as e:
        r.update(ok=False, success=False, note="环境运行异常: %s" % type(e).__name__)
        log("  env%-3d %s" % (env_id, r["note"]))
    finally:
        if auxiliary:
            r["auxiliaryVerification"] = auxiliary.stop()
        # 在关闭前保存精确等级条件；读取失败只影响风险清单，不改变本轮运行结果。
        try:
            r["gradeCheck"] = collect_grade(sys.modules[__name__], r)
        except Exception as error:
            r["gradeCheck"] = {"status": "unavailable", "reason": "等级检查异常：" + type(error).__name__}
        if r.get("cdp"):
            try:
                r["cdp"].close()
            except Exception:
                pass
        if not r.get("closed"):
            r["closed"] = stop(env_id, verify_timeout=30)
        log("  env%-3d %s" % (env_id, "已关闭，可以补位" if r["closed"] else "关闭未确认，继续占用名额"))
        if startup_done is not None:
            startup_done.set()
    return r


def process_rolling(targets, limit=MAX_BROWSERS, reset_cancel=True):
    """启动逐个按序，维护并行；前一个确认首个成功动作或确定故障才接纳下一个。"""
    global _auto_slots
    slots = BrowserSlots(limit)
    _auto_slots = slots
    if reset_cancel:
        _cancel_flag.clear()
    pending, active, results = list(dict.fromkeys(targets)), {}, []
    executor = ThreadPoolExecutor(max_workers=limit)
    last_wait_log = float("-inf")
    starting = None

    def collect(future):
        env_id = active.pop(future)
        try:
            r = future.result()
        except Exception as e:
            r = {"id": env_id, "ok": False, "started": False,
                 "note": "环境线程异常: %s" % type(e).__name__,
                 "closed": stop(env_id, verify_timeout=15)}
        slots.finish(r)
        results.append(r)
        log("  进度 %d/%d，处理中 %d，待运行 %d" %
            (len(results), len(targets), len(active), len(pending)))

    try:
        while pending or active:
            try:
                for future in list(active):
                    if future.done():
                        collect(future)
                if _cancel_flag.is_set():
                    break
                if starting is not None and starting[1].is_set():
                    starting = None
                waiting = "容量已满，等待浏览器确认关闭后补位"
                if starting is not None:
                    waiting = "env%d 仍在启动检查，确认首个成功动作或确定故障后再打开下一个" % starting[0]
                if pending and starting is None and len(active) < limit and not _pause_flag.is_set():
                    try:
                        claim = slots.claim(pending)
                    except Exception as e:
                        claim = None
                        waiting = "运行列表暂不可用，暂停补位: %s" % type(e).__name__
                    if claim and not _cancel_flag.is_set():
                        env_id, slot = claim
                        pending.remove(env_id)
                        log("  env%-3d 开始处理（位置 %d，最多同时 %d 个浏览器）" % (env_id, slot + 1, limit))
                        startup_done = threading.Event()
                        starting = (env_id, startup_done)
                        future = executor.submit(process_environment, env_id, slot, startup_done)
                        # 即使线程意外抛错，也不能一直卡住后续编号。
                        future.add_done_callback(lambda _, event=startup_done: event.set())
                        active[future] = env_id
                        continue
                if pending and len(active) < limit and time.monotonic() - last_wait_log >= 30:
                    log("  已暂停补位，当前环境继续完成；按 P 恢复" if _pause_flag.is_set() else "  " + waiting)
                    last_wait_log = time.monotonic()
                time.sleep(.2)
            except KeyboardInterrupt:
                _cancel_flag.set()
                log("!! 收到中断：停止补位和重启，等待本轮环境关闭")
                break
    finally:
        # 先通知工作线程退出，再等它们各自关闭；避免清理完又重开。
        if pending or active:
            _cancel_flag.set()
        while active:
            try:
                for future in list(active):
                    if future.done():
                        collect(future)
                if active:
                    time.sleep(.2)
            except KeyboardInterrupt:
                _cancel_flag.set()
                log("  正在关闭本轮浏览器，请稍候")
        executor.shutdown(wait=True)
        _auto_slots = None
        if slots.unclosed:
            log("  关闭未确认的本轮环境: %s" % sorted(slots.unclosed))
        if pending:
            log("  本次未启动的环境: %s" % pending)
    order = {env_id: i for i, env_id in enumerate(targets)}
    return sorted(results, key=lambda r: order[r["id"]])


def open_only(env_ids):
    """只启动环境 + 打开论坛，然后【原样留着不关】，让人工接管。

    和自动运行模式的区别：
      · 不点「日常维护」
      · 不等 RUN_SECONDS
      · 【不关浏览器】—— 这是本模式存在的意义，留给你手动点
    典型用途：未登录的号要人工登录；被限流的号要人工看情况；
    失败的号想自己盯着跑一遍。

    逐个打开全部指定环境，不查询内存、不按内存停止。
    按打开顺序分配固定九宫格，超过九个循环使用这些位置。
    """
    ok, bad = [], []
    total = len(env_ids)
    log("")
    log("=" * 58)
    log("只开浏览器模式：开 %d 个环境，打开论坛后【不关闭】，你自己点" % total)
    log("=" * 58)
    for n, env_id in enumerate(env_ids, 1):
        normal_bounds = bounds_for_slot(n - 1)
        port = launch(env_id, normal_bounds=normal_bounds)
        if not port:
            log("  env%-3d 启动失败" % env_id)
            bad.append({"id": env_id, "note": "启动失败"})
            continue
        cdp, st = open_forum(env_id, port, 1, handle_cf=False, normal_bounds=normal_bounds)
        if cdp is None:
            log("  env%-3d 打开论坛失败" % env_id)
            bad.append({"id": env_id, "note": "打开论坛失败"})
            continue
        st = st or {}
        # 只报状态，不做任何点击；浏览器保持打开
        if st.get("cfBlock"):
            tip = "有CF验证，需要你手动过"
        elif not st.get("appLoaded"):
            tip = "论坛尚未加载完成，暂不能判断登录状态"
        elif not st.get("loggedIn"):
            tip = "论坛已加载，待确认登录状态"
        elif not st.get("panel"):
            tip = "面板没出来，刷新一下页面看看"
        else:
            tip = "已就绪，可以直接点「日常维护」"
        log("  env%-3d 已打开 [%s]  (第%d/%d个)" % (env_id, tip, n, total))
        ok.append({"id": env_id, "tip": tip})
        try:
            cdp.restore_window()
            cdp.close()          # 只断开调试连接，浏览器本身不关
        except Exception:
            pass
    log("")
    log("-" * 58)
    log("  已打开 %d 个浏览器，全部保持开启状态：" % len(ok))
    for r in ok:
        log("    env%-3d %s" % (r["id"], r["tip"]))
    if bad:
        log("  没能打开的 %d 个: %s" % (len(bad), [r["id"] for r in bad]))
    log("")
    log("  接下来你自己操作：登录 / 过验证 / 点「日常维护」")
    log("  用完可以跑这条一次性全关：")
    log('       cd /d "%s"' % APP_DIR)
    log("       py autorun.py --close-all")
    log("-" * 58)
    return ok, bad


def close_all():
    """一次性关掉所有正在运行的环境（配合 --open 用完之后清场）"""
    ids = sorted(running_ids())
    if not ids:
        log("当前没有运行中的环境")
        return
    log("正在关闭 %d 个环境: %s" % (len(ids), ids))
    stop_many(ids, verify_timeout=60)
    log("关闭流程结束")


def parse_ids(spec, all_ids):
    """把 "1-5,9,109-117" 解析成环境 ID 列表。

    容错很重要：这个值是人手输进来的（运行.bat 的菜单），
    输错字母或全角逗号时不能直接抛 ValueError 甩一屏红色堆栈 ——
    那对着屏幕的人根本不知道发生了什么。这里跳过看不懂的片段并提示。
    """
    out, bad = [], []
    # 顺手把常见的全角逗号/减号换成半角，中文输入法下很容易打出来
    spec = str(spec).replace("，", ",").replace("－", "-").replace("—", "-")
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if "-" in part:
                a, b = part.split("-", 1)
                lo, hi = int(a), int(b)
                if lo > hi:
                    lo, hi = hi, lo
                out += [i for i in range(lo, hi + 1) if i in all_ids]
            elif int(part) in all_ids:
                out.append(int(part))
            else:
                bad.append(part + "(没有这个环境)")
        except ValueError:
            bad.append(part)
    if bad:
        log("  ⚠ 这些输入看不懂或不存在，已跳过: %s" % ", ".join(bad))
    return sorted(set(out))


def problem_environment_ids(results):
    """自动补跑与最终『有问题的环境』使用同一判断。"""
    return sorted({r["id"] for r in results
                   if not r.get("success") or r.get("banned") or r.get("throttled")})


def needs_login(result):
    """只根据最后一轮的明确登录状态或原因分类。"""
    status = result.get("finalLoginStatus", result.get("loginStatus"))
    note = str(result.get("finalNote", result.get("note", "")))
    return status == "anonymous" or "未登录" in note or "登录失效" in note


def ordered_problem_environment_ids(results):
    problem = set(problem_environment_ids(results))
    login_ids = {r["id"] for r in results if r["id"] in problem and needs_login(r)}
    return sorted(login_ids) + sorted(problem - login_ids)


def environment_list_lines(label, ids):
    """编号按传入顺序输出，每行最多九个；标题和总数只写一次。"""
    lines = []
    for offset in range(0, len(ids), 9):
        numbers = ",".join(str(i) for i in ids[offset:offset + 9])
        prefix = "  【%s】%d 个: " % (label, len(ids)) if offset == 0 else "  "
        lines.append(prefix + numbers)
    return lines


def round_counts(result):
    sent = (result.get("run") or {}).get("sent") or {}
    counts = {}
    for key in ("topics", "replies", "likes"):
        value = result.get(key, sent.get(key, 0))
        counts[key] = value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
    return counts


def combine_round_results(first_results, retry_results, retry_ids):
    """每个环境只保留一条综合结果，并保留两轮结论供日志解释。"""
    retried = {r["id"]: r for r in retry_results}
    planned = set(retry_ids)
    combined = []
    for first in first_results:
        second = retried.get(first["id"])
        # 补跑没有成功时，保留首轮已有的成功动作、余额和运行记录。
        selected = second if second and (second.get("success") or not first.get("success")) else first
        row = dict(selected)
        final = second if second is not None else first
        row["finalNote"] = final.get("note", "")
        row["finalLoginStatus"] = final.get("loginStatus", "unknown")
        row["firstRoundSuccess"] = bool(first.get("success"))
        row["automaticRetryPlanned"] = first["id"] in planned
        row["automaticRetried"] = second is not None
        row["retrySuccess"] = bool(second and second.get("success"))
        row["success"] = bool(first.get("success") or row["retrySuccess"])
        row["ok"] = row["success"]
        rounds = [first] + ([second] if second is not None else [])
        row["automaticRounds"] = [
            {"round": i + 1, "success": bool(r.get("success")), "note": r.get("note", ""),
             "banned": bool(r.get("banned")), "throttled": bool(r.get("throttled")),
             "counts": round_counts(r)} for i, r in enumerate(rounds)
        ]
        row.update({key: sum(round_counts(r)[key] for r in rounds)
                    for key in ("topics", "replies", "likes")})
        row["started"] = any(r.get("started") for r in rounds)
        row["confirmed"] = any(r.get("confirmed") for r in rounds)
        if second is not None:
            row["closed"] = bool(second.get("closed"))
            # 补跑成功后，首轮限流不再列为最终问题；否则保留尚未解决的提示。
            for key in ("banned", "throttled"):
                row[key] = bool(second.get(key)) if second.get("success") else any(r.get(key) for r in rounds)
            row["note"] = "首轮：%s；自动补跑：%s" % (first.get("note") or "无异常", second.get("note") or "无异常")
            # 补跑取数失败时，保留首轮已经取得的数据；其同步时间仍会接受原有复核。
            for r in reversed(rounds):
                check = r.get("gradeCheck") or {}
                if check.get("status") in ("captured", "summary_only"):
                    row["gradeCheck"] = check
                    break
            for final_key, initial_key in (("endBal", "bal"), ("endLdc", "ldc")):
                for r in reversed(rounds):
                    value = r.get(final_key) or r.get(initial_key)
                    if value and value not in ("获取中", "失败", "账号不符", "?", "已跳过"):
                        row[final_key] = value
                        break
        combined.append(row)
    return combined


def run_all_with_retry(targets, limit):
    """全部环境首轮完成后，对问题环境只自动补跑一轮。"""
    first_results, retry_results, retry_ids = [], [], []
    try:
        log("【第1轮】运行全部环境；结束后自动补跑有问题的环境一次")
        first_results = process_rolling(targets, limit)
        retry_ids = problem_environment_ids(first_results)
        if _cancel_flag.is_set():
            log("首轮已中断，取消自动补跑，汇总已完成的结果")
        elif retry_ids:
            log("【自动补跑第2轮】%d 个有问题的环境：%s" %
                (len(retry_ids), ",".join(map(str, retry_ids))))
            # 第二轮不清除取消标记，Ctrl+C 在两轮交接期间也能生效。
            retry_results = process_rolling(retry_ids, limit, reset_cancel=False)
        else:
            log("首轮没有有问题的环境，无需自动补跑")
    except KeyboardInterrupt:
        _cancel_flag.set()
        log("已取消自动补跑，汇总已完成的结果")
    return combine_round_results(first_results, retry_results, retry_ids)


def report(all_results, elapsed):
    global _capture_summary
    _capture_summary = True                 # 从这里开始的日志行会被收集并置顶
    log("")
    log("=" * 58)
    log("汇总报告  %s" % bj_now().strftime("%Y-%m-%d %H:%M:%S"))
    log("=" * 58)
    total = len(all_results)
    started = [r for r in all_results if r.get("started")]
    confirmed = [r for r in all_results if r.get("confirmed")]
    skipped = [r for r in all_results if not r.get("success")]
    banned = [r for r in all_results if r.get("banned")]
    throttled = [r for r in all_results if r.get("throttled")]
    no_oauth = [r for r in all_results if r.get("noOauth")]
    log("  环境总数    : %d" % total)
    log("  成功刷帖    : %d" % sum(bool(r.get("success")) for r in all_results))
    log("  确认曾运行  : %d" % len(confirmed))
    log("  跳过/失败   : %d" % len(skipped))
    if any("firstRoundSuccess" in r for r in all_results):
        retried = [r for r in all_results if r.get("automaticRetried")]
        recovered = [r for r in retried if not r.get("firstRoundSuccess") and r.get("retrySuccess")]
        log("  首轮成功    : %d" % sum(bool(r.get("firstRoundSuccess")) for r in all_results))
        log("  自动补跑    : %d 个；补跑后恢复成功 %d 个" % (len(retried), len(recovered)))
        log("  两轮累计    : 主题%d 阅读篇数%d 点赞%d" %
            tuple(sum(round_counts(r)[key] for r in all_results) for key in ("topics", "replies", "likes")))
        unrun = [r["id"] for r in all_results if r.get("automaticRetryPlanned") and not r.get("automaticRetried")]
        if unrun:
            log("  自动补跑未执行（运行中断）: %s" % ",".join(map(str, sorted(unrun))))
    if no_oauth:
        # 这不是故障，是这些号本来就没权限。单列出来免得看成异常去白排查。
        log("  无OAuth权限 : %d (跳过签到/余额，刷帖照常) %s"
            % (len(no_oauth), [r["id"] for r in no_oauth]))
    if banned:
        log("  仍有限流拒绝: %d（综合未成功 %d）" %
            (len(banned), sum(not r.get("success") for r in banned)))
    if throttled:
        log("  实际接口限流: %d %s"
            % (len(throttled), [r["id"] for r in throttled]))
    log("  总耗时      : %d 分 %d 秒" % (elapsed // 60, elapsed % 60))
    log(retention_summary_line(all_results))

    # ---- 有问题的环境编号及状态；省略重复的打开浏览器操作提示 ----
    # 汇总四类：没登录的、被限流拒绝的、疑似中途限流的、其它跳过失败的。
    # need_login / can_retry 在下面补跑指引里还要用，这里先算好。
    problem = ordered_problem_environment_ids(all_results)
    problem_set = set(problem)
    need_login = sorted({r["id"] for r in all_results if r["id"] in problem_set and needs_login(r)})
    can_retry = sorted({r["id"] for r in skipped if not needs_login(r)})
    if problem:
        log("")
        for line in environment_list_lines("有问题的环境", problem):
            log(line)
        log("  状态标记：未登录 %d，限流拒绝 %d，接口限流 %d；失败共 %d 个（状态可能重叠）"
            % (len(need_login), len(banned), len(throttled), len(skipped)))
    if banned:
        log("")
        log("  仍有限流拒绝明细:")
        for r in banned:
            log("    env%-3d %s" % (r["id"], (r.get("endR4") or r.get("r4") or "")[:70]))
    if skipped:
        log("")
        log("  跳过明细:")
        for r in skipped:
            log("    env%-3d %s" % (r["id"], r["note"]))
    retried = [r for r in all_results if r.get("automaticRetried")]
    if retried:
        log("")
        log("  首轮 / 自动补跑 / 综合结果:")
        for r in retried:
            log("    env%-3d 首轮%s → 补跑%s → 综合%s；%s" %
                (r["id"], "成功" if r["firstRoundSuccess"] else "失败",
                 "成功" if r["retrySuccess"] else "失败", "成功" if r["success"] else "失败", r["note"]))
    # 余额/LDC 先算好，但【逐行明细放到最后打印】——
    # 117 行明细排在前面的话，每次都要往下翻很久才看到真正要操作的结论。
    bals = [(r["id"], r.get("endBal") or r.get("bal"), r.get("endLdc") or r.get("ldc"))
            for r in started if not r.get("forumOnly")]
    if FORUM_ONLY or any(r.get("forumOnly") for r in all_results):
        log("  LDC / Agent：已按仅论坛模式跳过，不计入失败或余额统计")
    if bals:
        # 只把统计结论放前面。没读到的多说明签到/Credit 那边有问题。
        got_bal = sum(1 for _, b, _ in bals if b)
        got_ldc = sum(1 for _, _, l in bals if l and l not in ("获取中", "失败", "账号不符"))
        bad_ldc = [i for i, _, l in bals if l in ("获取中", "失败", "账号不符")]
        log("")
        log("  读到 Agent 余额 %d/%d，读到 LDC 数值 %d/%d"
            % (got_bal, len(bals), got_ldc, len(bals)))
        if bad_ldc:
            # 无 OAuth 权限的号 LDC 必然显示"失败"，那是设计行为不是故障。
            # 混在一起报会让人以为出了问题去白排查，所以剔掉它们。
            no_oauth_ids = set(r["id"] for r in no_oauth)
            real_bad = [i for i in bad_ldc if i not in no_oauth_ids]
            if real_bad:
                log("  LDC 异常(获取中/失败/账号不符)的环境: %s" % real_bad)

    # ---- 补跑指引：把失败环境拼成能直接粘贴的编号串 ----
    # 未登录项先手动登录；其他失败项列入补跑。
    # need_login / can_retry 已在上面「一次打开全部有问题的环境」处算好。
    log("")
    log("-" * 58)
    if can_retry:
        ids = ",".join(str(i) for i in sorted(can_retry))
        log("  【要补跑的环境】%d 个: %s" % (len(can_retry), ids))
        log("  补跑办法（任选一种）:")
        log("    A. 双击 运行.bat → 选 2（补跑指定环境）→ 粘贴这一行:")
        log("         %s" % ids)
        log("    B. 或者命令行里跑:")
        log('         cd /d "%s"' % APP_DIR)
        log("         py autorun.py --ids %s" % ids)
        log("    C. 只把浏览器打开、停在论坛页，你自己点「日常维护」:")
        log('         cd /d "%s"' % APP_DIR)
        log("         py autorun.py --open --ids %s" % ids)
    else:
        log("  【要补跑的环境】无" + ("；未登录项请先处理下面的具体原因" if need_login else ""))
    if need_login:
        log("")
        log("  【未登录】%d 个: %s"
            % (len(need_login), ",".join(str(i) for i in sorted(need_login))))
        log("  已标记失败并跳过，请先手动登录，再补跑这些环境")
    log("-" * 58)

    # ---- 余额/LDC 逐行明细：压在最末尾 ----
    # 这是"事后查账"用的，不需要每次都看，所以放最后，
    # 免得 117 行明细把上面真正要操作的结论顶下去。
    if bals:
        log("")
        log("  余额 / LDC 明细:")
        for i, b, l in bals:
            log("    env%-3d Agent=%-9s LDC=%s" % (i, b or "?", l or "?"))

    # 放在最后，BAT 第一项和第二项完成后直接可见，只写入同一个运行日志。
    print_grade_report(all_results, log, LOG_DIR, bj_now())


def main():
    global CF_TOTAL_TIMEOUT, ENV_READY_TIMEOUT, STARTUP_TOTAL_TIMEOUT, FORUM_ONLY
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="试跑并发数的五倍（默认前 45 个），持续补位")
    ap.add_argument("--all", action="store_true", help="跑全部环境，问题环境自动补跑一次后合并汇总")
    ap.add_argument("--forum-only", action="store_true", help="跳过 LDC / Agent，只运行论坛阅读和点赞")
    ap.add_argument("--ids", help="指定范围，如 1-9 或 1,3,5")
    ap.add_argument("--batch", "--concurrency", dest="batch", type=int, default=MAX_BROWSERS,
                    choices=range(1, MAX_BROWSERS + 1), help="自动运行最多同时几个浏览器（1–9，默认 9）")
    ap.add_argument("--cf-timeout", type=int, default=CF_TOTAL_TIMEOUT,
                    help="每次 CF 验证上限秒数（默认 90）")
    ap.add_argument("--startup-timeout", type=int, default=STARTUP_TOTAL_TIMEOUT,
                    help="所有启动检查和重试的总预算秒数（默认 300，最多 300）")
    ap.add_argument("--env-timeout", type=int, default=ENV_READY_TIMEOUT,
                    help="单次启动、验证和会话检查上限秒数（默认 180）")
    ap.add_argument("--open", action="store_true",
                    help="只打开浏览器和论坛，不自动点、不关闭，留给你手动操作")
    ap.add_argument("--close-all", action="store_true", dest="close_all",
                    help="关掉所有正在运行的环境")
    args = ap.parse_args()
    FORUM_ONLY = args.forum_only
    if not 1 <= args.startup_timeout <= 300:
        ap.error("--startup-timeout 必须为 1–300 秒")
    STARTUP_TOTAL_TIMEOUT = args.startup_timeout
    if args.cf_timeout <= 0 or args.env_timeout <= 0:
        ap.error("--cf-timeout 和 --env-timeout 必须大于 0")
    CF_TOTAL_TIMEOUT, ENV_READY_TIMEOUT = args.cf_timeout, args.env_timeout

    if args.close_all:
        close_all()
        return 0

    if not (args.test or args.all or args.ids or args.open):
        ap.print_help()
        print("\n提示: 先跑 --test 确认流程")
        return 1

    try:
        all_ids = list_envs()
    except Exception as e:
        print("无法连接 VirtualBrowser API (%s): %s" % (API_HOST, str(e)[:90]))
        print("请确认 VirtualBrowser 已启动、本地 API 已开启。")
        return 1

    targets = parse_ids(args.ids, all_ids) if args.ids else all_ids
    if not targets:
        # 全输错时早点说清楚，别让人对着"处理 0 个"发呆
        log("没有可处理的环境 —— 输入的编号一个都没对上。")
        log("正确写法：单个 51 / 多个 9,51,74 / 一段 6-10 / 混合 1-5,109")
        return 1
    if args.open:
        open_only(targets)
        return 0

    size = args.batch
    if args.test:
        targets = targets[:TEST_MULTIPLIER * size]
    log("环境总数 %d，本次处理 %d 个，逐个启动、并行维护，最多同时 %d 个浏览器" %
        (len(all_ids), len(targets), size))
    log("当前环境确认首个成功动作或确定故障后，才打开下一个；维护并行运行 3 分钟")
    log("启动容错：单次 CF %d 秒、启动检查 %d 秒；最多重试 %d 次，共用 %d 秒预算" %
        (CF_TOTAL_TIMEOUT, ENV_READY_TIMEOUT, MAX_RETRIES, STARTUP_TOTAL_TIMEOUT))
    log("确认未登录直接标记失败并跳过，需先手动登录；全程保持初始小窗口尺寸")
    log("窗口使用固定九宫格空位；其他已打开的浏览器也计入并发上限")
    if FORUM_ONLY:
        log("本次仅论坛模式：跳过 LDC 和 Agent，只运行论坛阅读/点赞")
    else:
        log("本次获取等级、LDC 和 Agent；辅助获取在后台进行，论坛阅读按原定时间运行")
    t0 = time.time()
    start_key_listener()
    log("提示：按 P 暂停/恢复补位（当前环境继续完成），Ctrl+C 中断并关闭本轮环境")
    all_results = run_all_with_retry(targets, size) if args.all and not args.test else process_rolling(targets, size)
    report(all_results, int(time.time() - t0))
    prepend_summary()          # 把汇总插到日志文件最前面
    if args.test:
        log("")
        log("试跑结束。确认无误后运行:  py %s --all" % os.path.basename(__file__))
    return 0


if __name__ == "__main__":
    sys.exit(main())
