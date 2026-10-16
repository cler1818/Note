"""固定九宫格窗口；只使用 VirtualBrowser 的启动参数和浏览器 CDP。"""

import json
import time
import urllib.request


# 2026-09-15 从当前 1–9 的窗口配置读取；坐标单位与 CDP 一致。
NORMAL_SIZE = (514, 274)
POSITIONS = (
    (0, 0), (512, 0), (1024, 0),
    (0, 274), (512, 274), (1024, 274),
    (0, 549), (512, 549), (1024, 549),
)
RESTORE_TIMEOUT = 4


def bounds_for_slot(slot):
    """按本批打开顺序分配位置，超过九个时循环叠放，不限制打开数量。"""
    left, top = POSITIONS[slot % len(POSITIONS)]
    return dict(left=left, top=top, width=NORMAL_SIZE[0], height=NORMAL_SIZE[1])


def launch_args(bounds):
    return "--window-position=%d,%d --window-size=%d,%d" % (
        bounds["left"], bounds["top"], bounds["width"], bounds["height"])


def set_browser_bounds(port, bounds, target_id=None, window_id=None,
                       timeout=RESTORE_TIMEOUT):
    """独立的短时浏览器连接：页面失效或 CF 预算耗尽仍能恢复窗口。

    所有 HTTP/WS 调用共用一个总上限；不依赖论坛页面的 JavaScript。
    返回实际窗口信息，Windows 缩放可能使宽高出现少量像素取整。
    """
    import websocket

    deadline = time.monotonic() + timeout
    ws = None
    sequence = 0

    def remaining():
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("恢复窗口超时")
        return left

    def http(path):
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path),
                                    timeout=remaining()) as response:
            return json.loads(response.read().decode("utf-8"))

    def call(method, params):
        nonlocal sequence
        sequence += 1
        ws.settimeout(remaining())
        ws.send(json.dumps(dict(id=sequence, method=method, params=params)))
        while True:
            ws.settimeout(remaining())
            reply = json.loads(ws.recv())
            if reply.get("id") != sequence:
                continue
            if reply.get("error"):
                raise RuntimeError("%s: %s" % (method, reply["error"].get("message", "失败")))
            return reply.get("result", {})

    try:
        version = http("/json/version")
        ws = websocket.create_connection(version["webSocketDebuggerUrl"],
                                         timeout=remaining(), suppress_origin=True)
        if window_id is None:
            if not target_id:
                target_id = next((t["id"] for t in http("/json/list")
                                  if t.get("type") == "page"), None)
            if not target_id:
                raise RuntimeError("没有可恢复的浏览器窗口")
            window_id = call("Browser.getWindowForTarget", {"targetId": target_id})["windowId"]
        call("Browser.setWindowBounds", {"windowId": window_id,
                                         "bounds": {"windowState": "normal"}})
        call("Browser.setWindowBounds", {"windowId": window_id, "bounds": dict(bounds)})
        actual = call("Browser.getWindowBounds", {"windowId": window_id})["bounds"]
        return dict(windowId=window_id, bounds=actual)
    finally:
        if ws is not None:
            try:
                ws.close(timeout=0.1)
            except Exception:
                pass
