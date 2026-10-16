"""Handle visible verification checkboxes in helper-owned auxiliary tabs."""
import threading
import time
from urllib.parse import parse_qs, urlsplit

CF_CLICK_LOCK = threading.RLock()
ALLOWED_HOSTS = frozenset(('credit.linux.do', 'agentrouter.org', 'connect.linux.do'))
STATE_JS = r"""JSON.stringify((()=>{
    const title=document.title, challenge=!!document.querySelector('#challenge-form,#cf-challenge-running,#challenge-stage')
        ||!!(window._cf_chl_opt&&window._cf_chl_opt.cType)
        ||/Just a moment|Verifying you are human|Checking your browser|Attention required|请稍[候后]|請稍[候後]|正在验证|正在驗證/i.test(title);
    return {host:location.hostname,challenge,ready:document.readyState!=='loading'&&!challenge};
})())"""


def owns_marker(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https':
        return False
    query = parse_qs(parsed.query)
    return ((parsed.hostname == 'credit.linux.do' and query.get('ldh_credit_auto') == ['1'])
            or (parsed.hostname == 'agentrouter.org' and query.get('ar_auto') == ['1'])
            or (parsed.hostname == 'connect.linux.do' and parsed.fragment.startswith('ldhsync=')))


def owned_targets(targets, forum_id, tracked):
    """Follow opener chains and stable tab IDs, only on the three auxiliary hosts."""
    owned = set(tracked) | {forum_id}
    remaining = list(targets)
    selected = {}
    for _ in range(len(remaining) + 1):
        changed = False
        for target in remaining:
            identity = target.get('targetId')
            parsed = urlsplit(target.get('url', ''))
            if target.get('type') != 'page' or not identity or parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS:
                continue
            if identity in owned or target.get('openerId') in owned or owns_marker(target.get('url', '')):
                selected[identity] = target
                if identity not in owned:
                    owned.add(identity)
                    changed = True
        if not changed:
            break
    return list(selected.values())


class AuxiliaryVerifier:
    def __init__(self, app, result):
        self.app, self.result = app, result
        self.done = threading.Event()
        self.thread = None
        self.events = []
        self.tracked = {}
        self.connection = None
        self.started = time.monotonic()

    def start(self):
        self.thread = threading.Thread(target=self._run, name='auxiliary-%s' % self.result['id'], daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self.done.set()
        if self.thread:
            self.thread.join(timeout=10)
        return {'events': list(self.events), 'stopped': not self.thread or not self.thread.is_alive(),
                'elapsedSeconds': round(time.monotonic() - self.started, 1)}

    def _event(self, host, kind, **data):
        # Never store OAuth query strings, account details or response bodies.
        self.events.append({'at': time.strftime('%H:%M:%S'), 'host': host, 'event': kind, **data})

    def _cancelled(self):
        return self.done.is_set() or self.app._cancel_flag.is_set()

    def _run(self):
        while not self._cancelled():
            try:
                self.scan_once()
            except Exception as error:
                # An auxiliary failure cannot cancel a successful forum reading run.
                if not self._cancelled() and not self.events:
                    self._event('', 'probe_unavailable', errorType=type(error).__name__)
            self.done.wait(1)

    def scan_once(self):
        app, result = self.app, self.result
        forum_id = getattr(result.get('cdp'), 'target_id', None)
        port = result.get('port')
        if not port or not forum_id or self._cancelled():
            return
        connection = (port, forum_id)
        if self.connection != connection:
            self.connection = connection
            self.tracked.clear()
        control = app.CDP(port, target_id=forum_id, timeout=3, deadline=time.monotonic() + 4)
        try:
            reply = control.send('Target.getTargets', {})
            targets = reply.get('result', {}).get('targetInfos', [])
        finally:
            control.close()
        for target in owned_targets(targets, forum_id, self.tracked):
            if self._cancelled():
                break
            self._visit(port, target)

    def _visit(self, port, target):
        app = self.app
        identity = target['targetId']
        host = urlsplit(target['url']).hostname
        state = self.tracked.setdefault(identity, {'created': time.monotonic(), 'clicks': 0,
                                                  'lastClick': {}, 'readyFrame': None, 'wasChallenge': False})
        # A helper tab gets a bounded opportunity; its own script closes it on timeout.
        if time.monotonic() - state['created'] > 100:
            return
        page = None
        try:
            page = app.CDP(port, target_id=identity, timeout=3, deadline=time.monotonic() + 5)
            page.env_id = self.result['id']
            current = page.evj(STATE_JS) or {}
            if current.get('host') not in ALLOWED_HOSTS:
                return
            if not current.get('challenge'):
                if current.get('ready') and state['wasChallenge']:
                    self._event(host, 'verification_page_cleared', clicks=state['clicks'])
                    app.log('  env%-3d %s 验证页已通过，继续读取' % (self.result['id'], host))
                    state['wasChallenge'] = False
                state['readyFrame'] = None
                return
            if not state['wasChallenge']:
                state['wasChallenge'] = True
                self._event(host, 'verification_page_seen')
                app.log('  env%-3d %s 等待辅助页面验证，保持原小窗口' % (self.result['id'], host))
                if CF_CLICK_LOCK.acquire(timeout=0.1):
                    try:
                        page.send('Page.bringToFront', {})
                    finally:
                        CF_CLICK_LOCK.release()
            if state['clicks'] >= 5:
                return
            box = page.cf_checkbox()
            now = time.monotonic()
            if not box:
                state['readyFrame'] = None
                return
            frame = box['frameId']
            if now - state['lastClick'].get(frame, float('-inf')) < 15:
                return
            if state['readyFrame'] != frame:
                state['readyFrame'], state['readySince'] = frame, now
                return
            if now - state['readySince'] < app.CF_SETTLE:
                return
            # Serialize only the focus-and-click operation, never the reading or waiting.
            if not CF_CLICK_LOCK.acquire(timeout=0.1):
                return
            try:
                if self._cancelled():
                    return
                page.deadline = time.monotonic() + 5
                page.send('Page.bringToFront', {})
                fresh = page.cf_checkbox()
                if fresh and fresh['frameId'] == frame and page.click_xy(fresh['x'], fresh['y']):
                    state['clicks'] += 1
                    state['lastClick'][frame] = time.monotonic()
                    state['readyFrame'] = None
                    self._event(host, 'visible_checkbox_clicked', round=state['clicks'], focus=fresh.get('focus'))
                    app.log('  env%-3d %s 已点击真实验证复选框（第 %d 次）' %
                            (self.result['id'], host, state['clicks']))
            finally:
                CF_CLICK_LOCK.release()
        except Exception:
            # Navigation can destroy a CDP context between inspection and click.
            # The next scan reads the new page; it never reuses stale coordinates.
            state['readyFrame'] = None
        finally:
            if page:
                page.close()
