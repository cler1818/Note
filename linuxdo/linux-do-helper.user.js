// ==UserScript==
// @name         LINUX DO 助手
// @namespace    http://tampermonkey.net/
// @version      1.1.6
// @description  论坛三模式 + 等级/积分 + 签到/邀请 + 私库账号/剪贴板登录 + hCaptcha 勾选与验证完成后自动提交
// @author       cler1818
// @homepageURL  https://github.com/cler1818/Note
// @downloadURL  https://github.com/cler1818/Note/raw/refs/heads/main/linuxdo/linux-do-helper.user.js
// @updateURL    https://github.com/cler1818/Note/raw/refs/heads/main/linuxdo/linux-do-helper.user.js
// @match        https://linux.do/*
// @match        https://connect.linux.do/*
// @match        https://credit.linux.do/*
// @match        https://agentrouter.org/*
// @match        https://anyrouter.top/*
// @match        https://newassets.hcaptcha.com/captcha/v1/*/static/hcaptcha.html*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      linux.do
// @connect      connect.linux.do
// @connect      credit.linux.do
// @connect      agentrouter.org
// @connect      api.github.com
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";
    const HC = { origin: "https://newassets.hcaptcha.com", message: "ldh-hcaptcha-v1" };
    if (location.origin === HC.origin) { hcaptchaFrame(); return; }
    if (window.top !== window.self) return;

    // 私库账号源：登录取整行账号密码，点赞只取用户名。
    const ACCOUNTS_API = "https://api.github.com/repos/cler1818/Personal-Backup/contents/linuxdo/username.txt?ref=main";
    const GITHUB_TOKEN_KEY = "ldh_github_token";

    // 运行时间单位为分钟；数量数组是含首尾的随机区间。
    const CFG = {

        DAILY_MINUTES: 3,
        DAILY_TOPICS:  [10, 25],
        DAILY_REPLIES: [200, 250],
        DAILY_LIKES:   [1, 1],

        FAST_MINUTES:  10,
        FAST_TOPICS:   [50, 100],
        FAST_REPLIES:  [2000, 3000],
        FAST_LIKES:    [1, 1],

        IDLE_MINUTES:  500,
        IDLE_TOPICS:   [200, 500],
        IDLE_REPLIES:  [2000, 5000],
        IDLE_LIKES:    [0, 0],

        REQ_GAP_SEC:   [0, 60]         // 秒；运行时限定为 0.8～99 秒
    };

    // 面板尺寸（像素）。
    const UI = {
        WIDTH: 265,
        PAD_X: 8
    };
    UI.COMPOSER_SHIFT = UI.WIDTH * 2;

    function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }

    let wakers = [];
    function sleep(ms) {
        return new Promise(function (resolve) {
            let done = false;
            const t = setTimeout(function () { if (done) return; done = true; drop(w); resolve(); }, ms);
            const w = function () { if (done) return; done = true; clearTimeout(t); resolve(); };
            wakers.push(w);
        });
    }
    function drop(w) { const i = wakers.indexOf(w); if (i >= 0) wakers.splice(i, 1); }
    function wakeAll() { const a = wakers; wakers = []; a.forEach(function (w) { try { w(); } catch (_) {} }); }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
    function fmtNum(n) { n = Number(n) || 0; return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(n); }
    function stripAt(s) { return String(s || "").replace(/^@/, "").trim(); }
    function normUser(s) { return stripAt(s).toLowerCase(); }
    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    function todayStr() {
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    }
    function gmGet(k, fb) { try { return GM_getValue(k, fb); } catch (_) { return fb; } }
    function gmSet(k, v) { try { GM_setValue(k, v); } catch (_) {} }
    function gmDel(k) { try { GM_deleteValue(k); } catch (_) {} }

    async function fetchTimed(url, options) {
        const opts = Object.assign({}, options || {}), parent = opts.signal;
        const ctrl = new AbortController();
        let timedOut = false;
        const cancel = function () { ctrl.abort(); };
        if (parent && parent.aborted) throw new DOMException("请求已取消", "AbortError");
        if (parent) parent.addEventListener("abort", cancel, { once: true });
        opts.signal = ctrl.signal;
        const timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, 20000);
        try {
            const response = await fetch(url, opts);
            await response.clone().arrayBuffer();
            return response;
        } catch (e) {
            if (timedOut) throw new Error("请求超时，请稍后重试。");
            throw e;
        } finally {
            clearTimeout(timer);
            if (parent) parent.removeEventListener("abort", cancel);
        }
    }

    // 站点配置与跨站授权。
    const CONNECT_HOST = "https://connect.linux.do";
    const AUTO_LOGIN_COOLDOWN = 10 * 60 * 1000;
    const SYNC_THROTTLE_MS = 10 * 60 * 1000;

    const AR = {
        HOST: "https://agentrouter.org",
        CLIENT_ID: "KZUecGfhhDZMVnv8UtEdhOhf9sNOhqVX",
        FLOW: "ar_tab_flow",
        DAYKEY: "ar_last_ok_day",
        REWARDKEY: "ar_reward_confirmed_day",
        NOTEKEY: "ar_checkin_note",
        UIDKEY: "ar_user_id",
        BALKEY: "ar_balance",
        BALDAY: "ar_balance_day",

        AUTOKEY: "ar_auto_login_ts",
        SIDEKEY: "ar_side_login_v1",
        TAB_TIMEOUT: 30 * 1000
    };
    const ANY = {
        HOST: "https://anyrouter.top",
        CLIENT_ID: "8w2uZtoWH9AUXrZr1qeCEEmvXLafea3c",
        FLOW: "anyrouter_login_flow_v1",
        TTL: 3 * 60 * 1000,
        AUTOKEY: "any_auto_login_ts",
        BANPREFIX: "anyrouter_ban_"
    };
    const CREDIT = {
        HOST: "https://credit.linux.do",
        CLIENT_ID: "EQepJmrayDhYMykHHouVF9mgcBwdoXcy",
        REDIRECT: "https://credit.linux.do/login",
        SCOPE: "openid profile email",
        BALPREFIX: "credit_bal_",
        API_TIMEOUT: 8000,
        TAB_TIMEOUT: 30 * 1000
    };

    const TABLOCK_KEY = "ldh_fg_tab_lock";
    const TABLOCK_TTL = 40 * 1000;
    function acquireTabLock() {
        const now = Date.now(), cur = Number(gmGet(TABLOCK_KEY, 0)) || 0;
        if (now - cur < TABLOCK_TTL) return false;
        gmSet(TABLOCK_KEY, now); return true;
    }
    function releaseTabLock() { gmDel(TABLOCK_KEY); }

    const OAUTH_ALLOW = [AR.CLIENT_ID, ANY.CLIENT_ID, CREDIT.CLIENT_ID];
    function clientAllowed(id) { return !!id && OAUTH_ALLOW.indexOf(id) >= 0; }

    function autoLoginAllowed(key) { return Date.now() - Number(gmGet(key, 0) || 0) > AUTO_LOGIN_COOLDOWN; }
    function markAutoLogin(key) { gmSet(key, Date.now()); }

    function waitAndClick(find, timeoutMs) {
        timeoutMs = Number(timeoutMs) || 10000;
        const started = Date.now();
        return new Promise(function (resolve) {
            let ob = null, timer = null, done = false;
            function stop(v) {
                if (done) return; done = true;
                if (ob) { try { ob.disconnect(); } catch (_) {} }
                if (timer) clearInterval(timer);
                resolve(v);
            }
            function tryClick() {
                let el = null;
                try { el = find(); } catch (_) { el = null; }

                const visible = (el && el.getClientRects().length > 0) || document.visibilityState === "hidden";
                if (el && visible && !el.disabled && el.getAttribute("aria-disabled") !== "true") {
                    try { el.click(); } catch (_) { stop(false); return true; }
                    stop(true); return true;
                }
                if (Date.now() - started >= timeoutMs) { stop(false); return true; }
                return false;
            }
            if (tryClick()) return;
            try {
                ob = new MutationObserver(function () { tryClick(); });
                ob.observe(document.documentElement, { childList: true, subtree: true });
            } catch (_) {}
            timer = setInterval(tryClick, 250);
        });
    }

    function normText(el) { return String((el && el.textContent) || "").replace(/\s+/g, " ").trim(); }
    function looksLikeLdLoginBtn(el) {
        const t = normText(el);
        if (!t || t.length > 40) return false;
        const s = t.toLowerCase().replace(/[\s_\-]+/g, "");
        if (s.indexOf("linux") < 0) return false;

        if (!/linuxdo/.test(s)) return false;
        return /继续|登录|登陆|login|continue|signin|sign in|授权/i.test(t);
    }
    function findLdLoginBtn() {

        const bg = document.visibilityState === "hidden";
        const seen = function (el) { return bg || el.getClientRects().length > 0; };
        const nodes = document.querySelectorAll('button, a[role="button"], div[role="button"], input[type="button"], input[type="submit"]');
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (el.tagName === "INPUT") {
                const v = String(el.value || "");
                if (/linux\s*do/i.test(v) && /继续|登录|登陆|login|continue|sign/i.test(v) && seen(el)) return el;
                continue;
            }
            if (looksLikeLdLoginBtn(el) && seen(el)) return el;
        }
        return null;
    }

    function arUid() { return Number(gmGet(AR.UIDKEY, 0)) || 0; }
    function setArUid(id) { id = Number(id) || 0; if (id > 0 && id !== arUid()) gmSet(AR.UIDKEY, id); }

    async function waitArUid(maxMs) {
        const t0 = Date.now();
        while (Date.now() - t0 < (maxMs || 3000)) {
            if (arUid() > 0) return arUid();
            await arWait(200);
        }
        return arUid();
    }
    function arWait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function arResponseHeader(r, name) {
        const m = String(r.responseHeaders || "").match(new RegExp("^" + name + ":\\s*(.+)$", "im"));
        return m ? m[1].trim() : "";
    }
    function arBodyPreview(t) {
        return String(t || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    }

    const CF_CHALLENGE_RE = /just a moment|cf[-_]chl|cf-browser-verification|attention required|verify you are human|checking if the site connection|challenges\.cloudflare\.com|cdn-cgi\/challenge/i;

    function arNonJsonError(r, url) {
        const text = String(r.responseText || ""), status = Number(r.status) || 0;
        const preview = arBodyPreview(text), finalUrl = String(r.finalUrl || url || "");
        if (CF_CHALLENGE_RE.test(text)) {
            const e = new Error("被验证页拦截"); e.cf = true; return e;
        }
        if (/bad gateway|service unavailable|gateway timeout|upstream/i.test(text) || [502, 503, 504].indexOf(status) >= 0) {
            return new Error("服务临时异常(HTTP " + (status || "未知") + ")");
        }
        if (/\/login(?:\?|$)/.test(finalUrl) || /登\s*录|sign\s*in/i.test(preview)) {
            return new Error("登录态失效，接口返回登录页");
        }
        return new Error("返回非JSON(HTTP " + (status || "未知") + "," + (arResponseHeader(r, "content-type") || "未知类型") + ")" + (preview ? ":" + preview : ""));
    }
    function gmFetch(url, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest !== "function") { reject(new Error("缺少跨域权限")); return; }
            const h = { "Accept": "application/json, text/plain, */*" };

            let host = ""; try { host = new URL(url).hostname; } catch (_) {}
            if (host === "agentrouter.org" && opts.userHeader !== false) {
                const uid = arUid();
                if (uid > 0) h["New-API-User"] = String(uid);
            }
            const ex = opts.headers || {};
            Object.keys(ex).forEach(function (k) { h[k] = ex[k]; });
            GM_xmlhttpRequest({
                method: opts.method || "GET", url: url, headers: h,
                data: opts.data,
                withCredentials: true, timeout: Number(opts.timeout) || 20000,
                onload: function (r) { resolve(r); },
                onerror: function () { reject(new Error("网络错误")); },
                ontimeout: function () { reject(new Error("请求超时")); },
                onabort: function () { reject(new Error("请求已取消")); }
            });
        });
    }
    async function gmJson(url, opts) {
        const r = await gmFetch(url, opts);
        const text = String(r.responseText || "").replace(/^﻿/, "").trim();
        let b; try { b = JSON.parse(text); } catch (_) { throw arNonJsonError(r, url); }
        if (!b || typeof b !== "object") throw new Error("接口返回的数据不完整");
        if (r.status < 200 || r.status >= 300 || b.success === false) throw new Error(b.message || ("HTTP " + r.status));
        return b;
    }

    async function gmJsonRetry(url, opts, retries) {
        let last; retries = Number(retries) || 0;
        for (let i = 0; i <= retries; i++) {
            try { return await gmJson(url, opts); }
            catch (e) {
                last = e;
                if (i >= retries || !/网络错误|请求超时|临时异常|HTTP 429|HTTP 5\d\d/.test((e && e.message) || "")) throw e;
                await arWait(500 * (i + 1));
            }
        }
        throw last;
    }

    function labelKey(s) {
        s = String(s || "");
        if (/访问/.test(s)) return "visit_days";
        if (/浏览话题|浏览主题/.test(s)) return "topics_viewed";
        if (/浏览帖子|浏览回复/.test(s)) return "posts_viewed";
        if (/回复话题|回复主题/.test(s)) return "topics_replied";
        if (/获赞天数/.test(s)) return "liked_days";
        if (/获赞用户/.test(s)) return "liked_by_users";
        if (/获赞/.test(s)) return "likes_received";
        if (/点赞/.test(s)) return "likes_given";
        if (/被举报/.test(s)) return "reported_posts";
        if (/举报用户|举报的用户/.test(s)) return "users_reported";
        if (/禁言/.test(s)) return "muted";
        if (/封禁|封号/.test(s)) return "banned";
        return null;
    }
    function parseConnectRoot(root) {
        const numOf = function (el) { if (!el) return null; const t = (el.textContent || "").replace(/[^\d.]/g, ""); return t === "" ? null : Number(t); };
        const rings = root.querySelectorAll(".tl3-ring");
        const bars = root.querySelectorAll(".tl3-bar-item");
        const subEl = root.querySelector(".card-subtitle");
        const am = ((subEl && subEl.textContent) || "").match(/@([A-Za-z0-9_.\-]+)/);
        const account = am ? am[1] : "";
        if (!rings.length && !bars.length) {
            if (root.querySelector(".card.empty-state")) return { at: Date.now(), account: account, locked: true };
            return null;
        }
        const data = { at: Date.now(), account: account, locked: false, metrics: {}, compliance: {} };
        rings.forEach(function (r) { const k = labelKey(r.querySelector(".tl3-ring-label") && r.querySelector(".tl3-ring-label").textContent); if (!k) return; data.metrics[k] = { c: numOf(r.querySelector(".tl3-ring-current")) || 0, r: numOf(r.querySelector(".tl3-ring-target")) || 0 }; });
        bars.forEach(function (b) { const k = labelKey(b.querySelector(".tl3-bar-label") && b.querySelector(".tl3-bar-label").textContent); if (!k) return; const parts = ((b.querySelector(".tl3-bar-nums") && b.querySelector(".tl3-bar-nums").textContent) || "").split("/"); data.metrics[k] = { c: Number((parts[0] || "").replace(/[^\d.]/g, "")) || 0, r: Number((parts[1] || "").replace(/[^\d.]/g, "")) || 0 }; });
        function firstNum(el) { const t = (el && el.textContent) || ""; return Number((t.split("/")[0] || "").replace(/[^\d.]/g, "")) || 0; }
        root.querySelectorAll(".tl3-quota-card").forEach(function (q) { const k = labelKey(q.querySelector(".tl3-quota-label") && q.querySelector(".tl3-quota-label").textContent); if (k) data.compliance[k] = firstNum(q.querySelector(".tl3-quota-nums")); });
        root.querySelectorAll(".tl3-veto-item").forEach(function (v) { const k = labelKey(v.querySelector(".tl3-veto-label") && v.querySelector(".tl3-veto-label").textContent); if (k) data.compliance[k] = firstNum(v.querySelector(".tl3-veto-value")); });
        return data;
    }
    function storeTL3(data, fallbackUser) {
        if (!data) return false;
        const u = normUser(data.account) || normUser(fallbackUser);
        if (!u) return false;
        try { GM_setValue("ld_tl3_" + u, JSON.stringify(data)); } catch (_) { return false; }
        return true;
    }

    function saveArNote(state, text, bal) {
        try { gmSet(AR.NOTEKEY, JSON.stringify({ date: todayStr(), state: state, text: text, bal: bal || "" })); } catch (_) {}
    }
    function loadArNote() {
        try {
            const d = JSON.parse(gmGet(AR.NOTEKEY, "null"));
            if (d && d.date === todayStr()) return { state: d.state, text: d.text || "", bal: d.bal || "" };
        } catch (_) {}
        return null;
    }

    function anyBanKey(u) { return ANY.BANPREFIX + (normUser(u) || "unknown"); }
    let _banCache = { key: "", at: 0, v: null };
    function getAnyBan(u) {
        const key = anyBanKey(u);
        if (_banCache.key === key && Date.now() - _banCache.at < 3000) return _banCache.v;
        let v = null;
        try { const j = JSON.parse(gmGet(key, "null")); v = (j && j.banned) ? j : null; } catch (_) { v = null; }
        _banCache = { key: key, at: Date.now(), v: v };
        return v;
    }
    function saveAnyBan(u, msg) {
        gmSet(anyBanKey(u), JSON.stringify({ banned: true, message: msg || "用户已被封禁", at: Date.now() }));
        gmSet(ANY.FLOW, JSON.stringify({ step: "done", error: "用户已被封禁", banned: true, ts: Date.now() }));
        _banCache = { key: "", at: 0, v: null };
    }
    function clearAnyBan(u) { gmDel(anyBanKey(u)); _banCache = { key: "", at: 0, v: null }; }

    const LD_USER_KEY = "ldh_current_ld_user";
    function currentLdUser() { return normUser(gmGet(LD_USER_KEY, "")); }

    const NO_OAUTH_PREFIX = "ldh_no_oauth_";
    const NO_OAUTH_TEXT = "你所在的用户组无法使用";
    const NO_OAUTH_MSG = "该账号所在用户组无法使用 OAuth 授权";
    function noOauthKey(u) { return NO_OAUTH_PREFIX + normUser(u); }
    let _noOauthCache = { key: "", at: 0, v: null };

    function getNoOauth(u) {
        const name = normUser(u);
        if (!name) return null;
        const key = noOauthKey(name);
        if (_noOauthCache.key === key && Date.now() - _noOauthCache.at < 3000) return _noOauthCache.v;
        let v = null;
        try { const j = JSON.parse(gmGet(key, "null")); v = (j && j.locked) ? j : null; } catch (_) { v = null; }
        _noOauthCache = { key: key, at: Date.now(), v: v };
        return v;
    }

    function saveNoOauth(u, from, tl) {
        const name = normUser(u);
        if (!name) return;
        gmSet(noOauthKey(name), JSON.stringify({
            locked: true, from: from || "", tl: (typeof tl === "number" ? tl : null), at: Date.now()
        }));
        _noOauthCache = { key: "", at: 0, v: null };
        console.warn("[LDH] @" + name + " 无 OAuth 权限，已永久停用 LDC/Agent/Any（来源:" + (from || "?") + "）");
    }
    function clearNoOauth(u) {
        const name = normUser(u);
        if (!name) return;
        gmDel(noOauthKey(name));
        _noOauthCache = { key: "", at: 0, v: null };
    }
    function noOauthError() { const e = new Error(NO_OAUTH_MSG); e.noOauth = true; return e; }

    function deniedBoxText(root) {
        const boxes = (root || document).querySelectorAll(".alert-box.alert-danger");
        for (let i = 0; i < boxes.length; i++) {
            const t = String(boxes[i].textContent || "").replace(/\s+/g, "");
            if (t.indexOf(NO_OAUTH_TEXT) >= 0) return t;
        }
        return "";
    }

    function authorizedUserFromPage() {
        const el = document.body;
        if (!el) return "";
        const body = String(el.innerText || el.textContent || "").replace(/\s+/g, " ");
        const m = body.match(/以\s*@([A-Za-z0-9_.\-]+)\s*的身份授权/);
        return m ? normUser(m[1]) : "";
    }

    function detectNoOauth(html) {
        const s = String(html || "");
        if (s.indexOf(NO_OAUTH_TEXT) < 0) return false;
        let doc = null;
        try { doc = new DOMParser().parseFromString(s, "text/html"); } catch (_) { return false; }
        if (!doc || !doc.body) return false;

        const body = String(doc.body.textContent || "").replace(/\s+/g, " ");
        if (!/以\s*@[A-Za-z0-9_.\-]+\s*的身份授权/.test(body)) return false;

        if (doc.querySelector('a[href^="/oauth2/approve/"]')) return false;

        const boxes = doc.querySelectorAll(".alert-box.alert-danger");
        for (let i = 0; i < boxes.length; i++) {
            if (String(boxes[i].textContent || "").replace(/\s+/g, "").indexOf(NO_OAUTH_TEXT) >= 0) return true;
        }
        return false;
    }

    function paramsFrom(u) { try { const x = new URL(u); const c = x.searchParams.get("code"), s = x.searchParams.get("state"); if (c && s) return { code: c, state: s }; } catch (_) {} return null; }
    function paramsFromText(t) {
        const text = String(t || "").replace(/&amp;/g, "&");
        const c = text.match(/[?&]code=([^&"'\s]+)/), s = text.match(/[?&]state=([^&"'\s]+)/);
        try { return (c && s) ? { code: decodeURIComponent(c[1]), state: decodeURIComponent(s[1]) } : null; }
        catch (_) { return null; }
    }
    function parseApprove(html) {
        try {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const links = Array.prototype.slice.call(doc.querySelectorAll('a[href^="/oauth2/approve/"]'));
            const yes = links.find(function (a) { return (a.textContent || "").replace(/\s+/g, "") === "允许"; });
            return yes ? yes.getAttribute("href") : null;
        } catch (_) { return null; }
    }
    async function arOAuth(say, withLogout) {
        if (withLogout) { say("退出登录…"); await gmFetch(AR.HOST + "/api/user/logout", { userHeader: true }).catch(function () {}); }
        say("获取 state…");
        const st = await gmJsonRetry(AR.HOST + "/api/oauth/state?mode=login", { userHeader: false }, 2);
        const state = st.data;
        if (!state) throw new Error("未拿到 state");
        say("请求授权页…");
        const a = await gmFetch(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + AR.CLIENT_ID + "&state=" + encodeURIComponent(state), {
            userHeader: false, headers: { "Accept": "text/html,application/xhtml+xml" }
        });
        if (a.status >= 400 || CF_CHALLENGE_RE.test(a.responseText || "")) throw arNonJsonError(a, a.finalUrl);
        let cs = paramsFrom(a.finalUrl) || paramsFromText(a.responseText);
        if (!cs) {

            if (detectNoOauth(a.responseText)) throw noOauthError();
            const ap = parseApprove(a.responseText);
            if (!ap) throw new Error("授权页无允许链接(Linux DO登录态可能失效)");
            say("点击允许…");
            const approved = await gmFetch(new URL(ap, CONNECT_HOST).href, {
                userHeader: false, headers: { "Accept": "text/html,application/xhtml+xml" }
            });
            cs = paramsFrom(approved.finalUrl) || paramsFromText(approved.responseText);
        }
        if (!cs) throw new Error("授权完成但没返回code/state");
        if (String(cs.state) !== String(state)) throw new Error("授权 state 不匹配，请重新登录。");

        say("提交签到回调…");
        const cb = await gmJson(AR.HOST + "/api/oauth/linuxdo?code=" + encodeURIComponent(cs.code) +
            "&state=" + encodeURIComponent(cs.state) + "&mode=login", { userHeader: false });
        if (!cb || !cb.data || !cb.data.id) throw new Error("回调成功但缺少用户信息");
        setArUid(cb.data.id);
        say("读取账户…");
        const self = await gmJsonRetry(AR.HOST + "/api/user/self", { userHeader: true }, 1).catch(function () { return null; });
        const user = self && self.data && self.data.id ? self.data : cb.data;
        setArUid(user.id);
        return { user: user, checkedIn: cb.data.checked_in === true, source: "code" };
    }

    function arFallbackTab(say) {
        return new Promise(function (resolve, reject) {
            gmSet(AR.FLOW, { step: "start", ts: Date.now() });
            let handle = null;
            try { handle = GM_openInTab(AR.HOST + "/login?ar_auto=1", { active: true, insert: true, setParent: true }); }
            catch (e) { gmDel(AR.FLOW); reject(new Error("无法打开授权标签")); return; }
            if (!handle) { gmDel(AR.FLOW); reject(new Error("无法打开授权标签")); return; }
            say("标签授权兜底中…");
            const started = Date.now();
            const iv = setInterval(function () {
                const flow = gmGet(AR.FLOW, null);
                if (handle.closed) {
                    clearInterval(iv); gmDel(AR.FLOW); reject(new Error("授权标签已关闭。"));
                } else if (flow && flow.step === "done") {
                    clearInterval(iv); gmDel(AR.FLOW); try { handle.close(); } catch (_) {}
                    if (flow.noOauth) reject(noOauthError());
                    else if (flow.error) reject(new Error(flow.error));
                    else resolve({ checkedIn: flow.checkedIn === true, source: "tab" });
                } else if (Date.now() - started > AR.TAB_TIMEOUT) {
                    clearInterval(iv); gmDel(AR.FLOW); try { handle.close(); } catch (_) {}
                    reject(new Error("授权超时(可能需人工过验证)"));
                }
            }, 700);
        });
    }

    const AR_QPD_FALLBACK = 500000;
    async function arBalance(userData, opts) {
        opts = opts || {};
        const waitFirst = opts.waitFirst || 0;
        const retries = opts.retries === undefined ? 3 : opts.retries;
        if (waitFirst > 0) await arWait(waitFirst);

        let u = userData, lastErr = null;

        if (!u || typeof u.quota === "undefined") {

            if (arUid() <= 0) await waitArUid(3000);
            if (arUid() <= 0) throw new Error("尚未取得 AgentRouter 账号ID，点击重试");
            for (let i = 0; i <= retries; i++) {
                try {
                    const s = await gmJson(AR.HOST + "/api/user/self", { userHeader: true });
                    u = s && s.data;
                    if (u && typeof u.quota !== "undefined") { lastErr = null; break; }
                    lastErr = new Error("返回里没有 quota 字段");
                } catch (e) { lastErr = e; }
                if (i < retries) await arWait(1000 * (i + 1));
            }
        }
        if (!u || typeof u.quota === "undefined") {
            throw lastErr || new Error("读不到账户额度");
        }
        let qpd = AR_QPD_FALLBACK;
        try {
            const st = await gmJson(AR.HOST + "/api/status", { userHeader: false });
            qpd = (st && st.data && Number(st.data.quota_per_unit)) || AR_QPD_FALLBACK;
        } catch (_) {}
        if (!(qpd > 0)) qpd = AR_QPD_FALLBACK;
        return "$" + (Number(u.quota) / qpd).toFixed(2);
    }
    async function arCheckin(say, manualTrigger) {
        try { return await arOAuth(say, true); }
        catch (e) {
            const msg = (e && e.message) || String(e);

            if (e && e.noOauth) throw e;
            say("纯代码失败:" + msg);

            if (!manualTrigger && !acquireTabLock()) throw new Error(msg + " / 另一个标签正在授权");
            try {
                const r = await arFallbackTab(say);

                say("等待账号ID…");
                await waitArUid(3000);
                if (!r.user) {
                    try { const s = await gmJsonRetry(AR.HOST + "/api/user/self", { userHeader: true }, 1); r.user = s && s.data; } catch (_) {}
                }
                return r;
            } catch (e2) {
                if (e2 && e2.noOauth) throw e2;
                throw new Error(msg + " / 兜底:" + ((e2 && e2.message) || e2));
            } finally {
                if (!manualTrigger) releaseTabLock();
            }
        }
    }

    function anyGetFlow() {
        try {
            const f = JSON.parse(gmGet(ANY.FLOW, "null"));
            if (!f || !f.ts || Date.now() - f.ts > ANY.TTL) { gmDel(ANY.FLOW); return null; }
            return f;
        } catch (_) { return null; }
    }
    function anyOpenTab() {
        gmSet(ANY.FLOW, JSON.stringify({ step: "start", ts: Date.now() }));
        try { GM_openInTab(ANY.HOST + "/console", { active: true, insert: true, setParent: true }); } catch (_) { window.open(ANY.HOST + "/console"); }
    }
    function getStoredUser() { try { const u = JSON.parse(localStorage.getItem("user") || "null"); return (u && u.id) ? u : null; } catch (_) { return null; } }
    async function siteLoggedIn() {
        const u = getStoredUser();
        if (!u) return false;
        try {
            const r = await fetchTimed("/api/user/self", { credentials: "include", cache: "no-store", headers: { "New-API-User": String(u.id) } });
            const b = await r.json();
            return !!(r.ok && b.success !== false && b.data && b.data.id);
        } catch (_) { return false; }
    }
    function isEntryPath() { const p = location.pathname; return p === "/" || p === "" || p === "/login"; }

    // AgentRouter 页面。
    if (location.hostname === "agentrouter.org") {

        (function selfHealBlankPage() {
            const KEY = "ldh_ar_healed";
            function rootEmpty() { const r = document.getElementById("root"); return !r || r.innerHTML.length === 0; }
            function deadAssets() {
                try {
                    return performance.getEntriesByType("resource")
                        .filter(function (e) { return /\/assets\/.*\.js(\?|$)/.test(e.name) && e.encodedBodySize === 0; })
                        .map(function (e) { return e.name; });
                } catch (_) { return []; }
            }
            function check() {
                if (!rootEmpty()) { try { sessionStorage.removeItem(KEY); } catch (_) {} return true; }
                if (sessionStorage.getItem(KEY) === "1") { console.warn("[LDH] AgentRouter 仍空白，已自动修复过一次，请手动 Ctrl+Shift+R"); return true; }
                const dead = deadAssets();
                if (!dead.length) return false;
                try { sessionStorage.setItem(KEY, "1"); } catch (_) {}
                console.warn("[LDH] 检测到 " + dead.length + " 个分包缓存损坏且页面空白，正在强制回源修复…");
                Promise.all(dead.map(function (u) { return fetch(u, { cache: "reload" }).catch(function () { return 0; }); }))
                    .then(function () { location.reload(); }).catch(function () { location.reload(); });
                return true;
            }
            let n = 0;
            const iv = setInterval(function () { n++; if (check() || n >= 10) clearInterval(iv); }, 1000);
        })();

        (function () { const u = getStoredUser(); if (u && u.id) setArUid(u.id); })();

        function arReportSideBalance() {
            const u = getStoredUser();
            if (!u || !u.id) return;
            fetchTimed("/api/status", { credentials: "include", cache: "no-store" })
                .then(function (r) { return r.json(); })
                .then(function (st) {
                    const qpd = (st && st.data && Number(st.data.quota_per_unit)) || AR_QPD_FALLBACK;
                    return fetchTimed("/api/user/self", { credentials: "include", cache: "no-store", headers: { "New-API-User": String(u.id) } })
                        .then(function (r) { return r.json(); })
                        .then(function (s) {
                            if (!s || !s.data || typeof s.data.quota === "undefined") return;
                            const bal = "$" + (Number(s.data.quota) / (qpd > 0 ? qpd : AR_QPD_FALLBACK)).toFixed(2);
                            gmSet(AR.SIDEKEY, JSON.stringify({ bal: bal, at: Date.now() }));
                        });
                }).catch(function () {});
        }

        let flow = gmGet(AR.FLOW, null);
        if (flow && (!flow.ts || Date.now() - flow.ts > 3 * 60 * 1000)) { gmDel(AR.FLOW); flow = null; }
        if (flow) {
            (async function () {
                const stored = getStoredUser();
                if (flow.step === "authorizing") {

                    const finishIfReady = function () {
                        const cur = getStoredUser();
                        if (!cur || !cur.id) return false;
                        setArUid(cur.id);
                        gmSet(AR.FLOW, { step: "done", ts: Date.now(), checkedIn: cur.checked_in === true });
                        return true;
                    };
                    if (!finishIfReady()) {
                        const timer = setInterval(function () { if (finishIfReady()) clearInterval(timer); }, 250);
                        setTimeout(function () { clearInterval(timer); }, 60000);
                    }
                    return;
                }
                if (flow.step === "start") {
                    gmSet(AR.FLOW, { step: "authorizing", ts: Date.now() });
                    try {
                        const headers = stored && stored.id ? { "New-API-User": String(stored.id) } : {};
                        await fetchTimed("/api/user/logout", { credentials: "include", cache: "no-store", headers: headers }).catch(function () {});
                        localStorage.removeItem("user");
                        const resp = await fetchTimed("/api/oauth/state?mode=login", { credentials: "include", cache: "no-store" });
                        const txt = await resp.text();
                        let b; try { b = JSON.parse(txt); } catch (_) { throw new Error("页面流程返回非JSON(HTTP " + resp.status + ")"); }
                        if (!resp.ok || b.success === false || !b.data) throw new Error(b.message || ("HTTP " + resp.status));
                        location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + AR.CLIENT_ID + "&state=" + encodeURIComponent(b.data));
                    } catch (e) { gmSet(AR.FLOW, { step: "done", ts: Date.now(), error: (e && e.message) || String(e) }); }
                }
            })();
        } else if (isEntryPath()) {

            (async function () {
                if (await siteLoggedIn()) { arReportSideBalance(); return; }
                if (getNoOauth(currentLdUser())) return;
                if (!autoLoginAllowed(AR.AUTOKEY)) return;
                markAutoLogin(AR.AUTOKEY);
                const clicked = await waitAndClick(findLdLoginBtn, 2000);
                if (clicked) return;
                try {
                    const b = await (await fetchTimed("/api/oauth/state?mode=login", { credentials: "include", cache: "no-store" })).json();
                    if (b && b.data) location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + AR.CLIENT_ID + "&state=" + encodeURIComponent(b.data));
                } catch (_) {}
            })();
        } else {

            (function () {
                let n = 0;
                const iv = setInterval(function () {
                    n++;
                    siteLoggedIn().then(function (ok) {
                        if (ok) { clearInterval(iv); arReportSideBalance(); }
                        else if (n >= 6) clearInterval(iv);
                    });
                }, 2000);
            })();
        }
        return;
    }

    // AnyRouter 页面。
    if (location.hostname === "anyrouter.top") {
        const LD_U = currentLdUser();

        (function watchAnyBan() {
            let finished = false;
            function scan() {
                if (finished) return;
                const alerts = Array.prototype.slice.call(document.querySelectorAll('[role="alert"]'));
                const hit = alerts.find(function (el) { return String(el.textContent || "").replace(/\s+/g, "").indexOf("用户已被封禁") >= 0; });
                if (!hit) return;
                finished = true;
                try { ob.disconnect(); } catch (_) {}
                clearTimeout(timer);
                saveAnyBan(LD_U, (hit.textContent || "用户已被封禁").trim());
                console.error("[LDH] AnyRouter 用户已被封禁");
            }
            const ob = new MutationObserver(scan);
            try { ob.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (_) {}
            const timer = setTimeout(function () { finished = true; try { ob.disconnect(); } catch (_) {} }, 60000);
            scan();
        })();

        const f = anyGetFlow();
        if (f) {
            (function () {
                const timer = setInterval(function () {
                    const cur = anyGetFlow();
                    if (!cur) { clearInterval(timer); return; }
                    if (cur.step === "callback" && location.pathname.indexOf("/console") === 0 && getStoredUser()) { gmDel(ANY.FLOW); clearInterval(timer); }
                }, 300);
                setTimeout(function () { clearInterval(timer); }, ANY.TTL);
            })();
            (async function () {
                if (location.pathname === "/oauth/linuxdo") { gmSet(ANY.FLOW, JSON.stringify({ step: "callback", ts: Date.now() })); return; }
                if (await siteLoggedIn()) {
                    gmDel(ANY.FLOW); clearAnyBan(LD_U);
                    if (location.pathname.indexOf("/console") !== 0) location.replace(ANY.HOST + "/console");
                    return;
                }
                if (getNoOauth(LD_U)) { console.warn("[LDH] 无 OAuth 权限，跳过 AnyRouter 自动登录"); gmDel(ANY.FLOW); return; }
                if (getAnyBan(LD_U)) { console.warn("[LDH] AnyRouter 已封禁，跳过自动登录"); gmDel(ANY.FLOW); return; }
                gmSet(ANY.FLOW, JSON.stringify({ step: "authorizing", ts: Date.now() }));
                await anyStartOAuth();
            })();
        } else if (anyIsEntryPath() || anyIsConsolePath()) {
            anyWatchLoginEntry(LD_U);
        }
        return;
    }


    // LDH_ANY_ENTRY_20260915: direct login and bounded authorization attempts.
    // LDH_ANY_116_20260915: bookmark/SPA entry, delayed controls and translated notices.
    function anyIsEntryPath() { return isEntryPath() || location.pathname === "/login/"; }
    function anyIsConsolePath() { return /^\/console(?:\/|$)/.test(location.pathname); }
    function anyEntryAttemptAllowed() {
        try {
            const key = "ldh_any_entry_attempts", now = Date.now();
            let record = JSON.parse(sessionStorage.getItem(key) || "null");
            if (!record || now - Number(record.start || 0) >= 60000) record = { start: now, count: 0 };
            if (Number(record.count || 0) >= 3) {
                console.warn("[LDH] AnyRouter 连续授权未成功，暂停自动重试一分钟");
                return false;
            }
            record.count = Number(record.count || 0) + 1;
            sessionStorage.setItem(key, JSON.stringify(record));
        } catch (_) {}
        return true;
    }
    function anyNormalText(value) {
        return String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    }
    function anyElementVisible(el, allowTransparent) {
        if (!el || !el.getClientRects().length) return false;
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && (allowTransparent || style.opacity !== "0");
    }
    function anyFindLoginButton() {
        const nodes = document.querySelectorAll('button, a[role="button"], div[role="button"], input[type="button"], input[type="submit"]');
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (!anyElementVisible(el)) continue;
            const text = anyNormalText(el.value || el.textContent || el.getAttribute("aria-label"));
            if (!text || text.length > 120 || !/linux[\s_-]*do/i.test(text)) continue;
            if (/继续|繼續|登录|登陆|登入|授权|授權|continue|log\s*in|sign\s*in|계속|로그인|연결|続行|続ける|ログイン|連携|terus(?:kan)?|lanjut(?:kan)?|log\s*masuk|sambung|தொடர|உள்நுழை/i.test(text)) return el;
        }
        return null;
    }
    function anyIsNotice(dialog) {
        const heading = dialog.querySelector('.semi-modal-title, [id="semi-modal-title"], h1, h2, h3, [role="heading"]');
        const title = anyNormalText(heading ? heading.textContent : normText(dialog).slice(0,150));
        return /系统公告|系統公告|system\s*(?:notice|announcement)|시스템\s*(?:공지(?:사항)?|알림|안내)|システム(?:の)?(?:お知らせ|通知|公告|アナウンス)|(?:notis|pengumuman)\s*sistem|சிஸ்டம்\s*அறிவிப்பு|கணினி\s*அறிவிப்பு/i.test(title);
    }
    function anyNoticeCloseButton(dialog) {
        const buttons = Array.prototype.slice.call(dialog.querySelectorAll("button"));
        const enabled = function (b) { return anyElementVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true"; };
        const close = buttons.find(function (b) {
            return enabled(b) && /^(?:关闭公告|關閉公告|关闭|關閉|close\s+(?:notice|announcement)|(?:공지(?:사항)?|알림)\s*닫기|닫기|(?:お知らせ|通知|公告)(?:を)?閉じる|閉じる|tutup(?:\s+(?:notis|pengumuman|pemberitahuan))?|(?:அறிவிப்பை\s*)?மூடு)$/i.test(anyNormalText(b.textContent));
        });
        if (close) return close;
        // The notice's own X button survives browser translation of its contents.
        return buttons.find(function (b) {
            return enabled(b) && b.classList.contains("semi-modal-close") && /^(?:close|关闭|關閉|닫기|閉じる|tutup|மூடு)$/i.test(anyNormalText(b.getAttribute("aria-label")));
        }) || null;
    }
    function anyWatchLoginEntry(ldUser) {
        return new Promise(function (resolve) {
            let busy = false, stopped = false, attempts = 0, retry = null;
            let checkedPath = null, authenticated = false, observer = null, mountTimer = null;
            function stop(result) {
                if (stopped) return;
                stopped = true;
                if (observer) observer.disconnect();
                if (retry) clearTimeout(retry);
                if (mountTimer) clearTimeout(mountTimer);
                window.removeEventListener("resize", step);
                window.removeEventListener("popstate", step);
                window.removeEventListener("hashchange", step);
                window.removeEventListener("pagehide", onHide);
                resolve(result);
            }
            function onHide() { stop(false); }
            async function step() {
                if (stopped || busy) return;
                if (!anyIsEntryPath()) {
                    // The home page reloads /console before the app routes signed-out users to /login.
                    if (!anyIsConsolePath() || attempts) stop(false);
                    return;
                }
                const path = location.pathname;
                busy = true;
                try {
                    if (checkedPath !== path) {
                        authenticated = await siteLoggedIn();
                        if (stopped || path !== location.pathname) return;
                        checkedPath = path;
                    }
                    if (authenticated) {
                        clearAnyBan(ldUser);
                        if (/^\/login\/?$/.test(path)) location.replace(ANY.HOST + "/console");
                        stop(true); return;
                    }
                    if (getNoOauth(ldUser)) { console.warn("[LDH] 无 OAuth 权限，跳过 AnyRouter 自动登录"); stop(false); return; }
                    if (getAnyBan(ldUser)) { console.warn("[LDH] AnyRouter 已封禁，跳过自动登录"); stop(false); return; }
                    // Wait for the app to mount its login controls before using a click attempt.
                    if (!anyFindLoginButton()) return;
                    if (attempts >= 3 || !anyEntryAttemptAllowed()) { stop(false); return; }
                    if (mountTimer) { clearTimeout(mountTimer); mountTimer = null; }
                    attempts++;
                    markAutoLogin(ANY.AUTOKEY);
                    const clicked = await anyClickLoginButton();
                    if (stopped) return;
                    if (clicked) { stop(true); return; }
                    if (attempts >= 3) { stop(false); return; }
                    retry = setTimeout(step, 500);
                } finally {
                    busy = false;
                    if (!stopped && path !== location.pathname) {
                        if (retry) clearTimeout(retry);
                        retry = setTimeout(step, 0);
                    }
                }
            }
            observer = new MutationObserver(step);
            observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "disabled", "aria-hidden", "aria-disabled"] });
            window.addEventListener("resize", step);
            window.addEventListener("popstate", step);
            window.addEventListener("hashchange", step);
            window.addEventListener("pagehide", onHide, { once: true });
            mountTimer = setTimeout(function () { stop(false); }, 60000);
            step();
        });
    }
    async function anyClickLoginButton() {
        if (location.hostname !== "anyrouter.top" || !anyIsEntryPath()) return false;
        const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
        const originalOpen = page.open, dismissed = new WeakSet();
        let installedOpen = null, forwarded = false, leaving = false, readySince = 0;
        let lastScrollButton = null, lastScrollAt = 0;
        function restore() {
            leaving = true;
            if (installedOpen && page.open === installedOpen) page.open = originalOpen;
        }
        function openForLogin(url) {
            let target = null;
            try { target = new URL(String(url), location.href); } catch (_) {}
            if (target && target.origin === CONNECT_HOST && target.pathname === "/oauth2/authorize" &&
                target.searchParams.get("response_type") === "code" &&
                target.searchParams.get("client_id") === ANY.CLIENT_ID && target.searchParams.get("state")) {
                forwarded = true;
                location.assign(target.href);
                return null;
            }
            return originalOpen.apply(page, arguments);
        }
        function findReadyButton() {
            let announcement = false;
            const dialogs = document.querySelectorAll('[role="dialog"]');
            for (let i = 0; i < dialogs.length; i++) {
                const dialog = dialogs[i];
                // A paused opening animation can leave opacity at zero while its mask still blocks input.
                if (!anyElementVisible(dialog, true) || dialog.getAttribute("aria-hidden") === "true" || !anyIsNotice(dialog)) continue;
                announcement = true;
                const close = anyNoticeCloseButton(dialog);
                if (close && !dismissed.has(close)) { dismissed.add(close); close.click(); }
            }
            if (announcement) { readySince = 0; return null; }
            const button = anyFindLoginButton();
            if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") { readySince = 0; return null; }
            const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !button.contains(hit)) {
                readySince = 0;
                const now = Date.now();
                if (lastScrollButton !== button || now - lastScrollAt >= 1000) {
                    lastScrollButton = button; lastScrollAt = now;
                    try { button.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch (_) {}
                }
                return null;
            }
            if (!readySince) readySince = Date.now();
            return Date.now() - readySince >= 600 ? button : null;
        }
        try {
            page.open = openForLogin;
            installedOpen = page.open;
            if (installedOpen === originalOpen) { await anyStartOAuth(); return true; }
            window.addEventListener("pagehide", restore, { once: true });
            const clicked = await waitAndClick(findReadyButton, 12000);
            if (!clicked) {
                console.warn("[LDH] AnyRouter 登录按钮仍被遮挡或不可用，本次停止自动点击");
                return false;
            }
            const deadline = Date.now() + 20000;
            while (!forwarded && !leaving && anyIsEntryPath() && Date.now() < deadline) await arWait(100);
            return true;
        } finally {
            restore();
            window.removeEventListener("pagehide", restore);
        }
    }
    async function anyStartOAuth() {
        try {
            const sres = await fetchTimed("/api/status", { credentials: "include", cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; });
            const cid = (sres && sres.data && sres.data.linuxdo_client_id) || ANY.CLIENT_ID;
            const st = await fetchTimed("/api/oauth/state", { credentials: "include", cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; });
            const state = st && st.data;
            if (!state) return;
            location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + encodeURIComponent(cid) + "&state=" + encodeURIComponent(state));
        } catch (_) {}
    }

    // Credit 页面。
    if (location.hostname === "credit.linux.do") {

        (function creditAutoLogin() {
            if (getNoOauth(currentLdUser())) return;
            const started = Date.now();
            let termsDone = false, loginClicked = false, stopped = false;
            const bg = document.visibilityState === "hidden";
            const seen = function (el) { return bg || el.getClientRects().length > 0; };

            function stop() { if (stopped) return; stopped = true; try { ob.disconnect(); } catch (_) {} clearInterval(iv); }
            function step() {
                if (stopped) return;
                if (Date.now() - started > CREDIT.TAB_TIMEOUT) { stop(); return; }

                if (new URLSearchParams(location.search).has("code")) { stop(); return; }

                if (location.pathname.indexOf("/home") === 0 && !document.querySelector("#terms")) return;

                if (!termsDone) {
                    const t = document.querySelector('#terms[role="checkbox"], #terms');
                    if (t) {
                        if (t.checked === true || t.getAttribute("aria-checked") === "true" || t.getAttribute("data-state") === "checked") {
                            termsDone = true;
                        } else if (seen(t)) {
                            try { t.click(); } catch (_) {}
                            return;
                        }
                    }
                }

                if (termsDone && !loginClicked) {
                    const b = findLdLoginBtn();
                    if (b && seen(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true") { try { b.click(); loginClicked = true; } catch (_) {} }
                }
            }
            const ob = new MutationObserver(step);
            try { ob.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "data-state"] }); } catch (_) {}
            const iv = setInterval(step, 400);
            step();
        })();
        return;
    }

    // Connect 授权和等级同步。
    if (location.hostname === "connect.linux.do") {
        if (location.pathname === "/oauth2/authorize") {

            const cid = new URLSearchParams(location.search).get("client_id") || "";

            const markDeniedHere = function () {
                if (!deniedBoxText()) return false;
                if (document.querySelector('a[href^="/oauth2/approve/"]')) return false;
                const who = authorizedUserFromPage();
                if (!who) {

                    console.warn("[LDH] 授权页显示无权限，但读不到账号名，未落标志");
                    return true;
                }
                if (!getNoOauth(who)) saveNoOauth(who, "connect-page");
                const arFlow = gmGet(AR.FLOW, null);
                if (cid === AR.CLIENT_ID && arFlow && arFlow.step === "authorizing" && Date.now() - arFlow.ts < 180000) {
                    gmSet(AR.FLOW, { step: "done", ts: Date.now(), noOauth: true, error: NO_OAUTH_MSG });
                }
                return true;
            };
            if (markDeniedHere()) return;

            let denyDone = false;
            const denyOb = new MutationObserver(function () {
                if (denyDone) return;
                if (markDeniedHere()) { denyDone = true; try { denyOb.disconnect(); } catch (_) {} }
            });
            try { denyOb.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (_) {}
            setTimeout(function () { denyDone = true; try { denyOb.disconnect(); } catch (_) {} }, 15000);

            if (clientAllowed(cid) && !getNoOauth(authorizedUserFromPage() || currentLdUser())) {

                const bg = document.visibilityState === "hidden";
                waitAndClick(function () {
                    const links = Array.prototype.slice.call(document.querySelectorAll('a[href^="/oauth2/approve/"]'));
                    return links.find(function (a) {
                        return (a.textContent || "").replace(/\s+/g, "") === "允许" && (bg || a.getClientRects().length > 0);
                    }) || null;
                }, 30000);
            }
            return;
        }

        const hm = location.hash.match(/ldhsync=([^&]*)/);
        const passedUser = hm ? decodeURIComponent(hm[1] || "") : "";
        const autoClose = /ldhsync/.test(location.hash);
        function toast(msg) {
            let t = document.getElementById("ldh_connect_toast");
            if (!t) { t = document.createElement("div"); t.id = "ldh_connect_toast"; t.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:rgba(20,20,20,0.92);color:#8fe0b0;padding:8px 12px;border-radius:8px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.4)"; document.body.appendChild(t); }
            t.textContent = msg;
        }
        let tries = 0;
        const iv = setInterval(function () {
            tries++;
            const rings = document.querySelectorAll(".tl3-ring").length, bars = document.querySelectorAll(".tl3-bar-item").length;
            const emptyHome = (location.pathname === "/" || location.pathname === "") && document.querySelector(".card.empty-state");
            if ((rings >= 3 && bars >= 5) || emptyHome) {
                clearInterval(iv);
                const d = parseConnectRoot(document);
                const okStore = d && storeTL3(d, passedUser);
                toast(okStore ? (d.locked ? "等级0/1：未到2级，已记录 ✔" : "✅ 等级3进度已同步") : "没读到账号，回 linux.do 点 ⟳ 重试");
                if (autoClose && okStore) setTimeout(function () { try { window.close(); } catch (_) {} }, 1000);
            } else if (tries > 25) { clearInterval(iv); if (autoClose) setTimeout(function () { try { window.close(); } catch (_) {} }, 500); }
        }, 800);
        return;
    }

    if (location.hostname !== "linux.do") return;
    // 论坛：三种模式、等级/积分、点赞与邀请。
    const COMMON = {
        MSECS_MIN: 800, MSECS_MAX: 1400,
        FLOOR_INTERVAL: 800,
        MAX_BATCH: 60,
        TOPIC_OVERHEAD_MS: 2300,
        ENTER_MIN: 700, ENTER_MAX: 1200,
        HARD_BLOCK_RETRY_THRESHOLD: 600, CF_BACKOFF_MS: 10000, MAX_CONSEC_CF: 5,
        LIKE_REACTION: "heart",
        REQLOG_KEY: "ld_helper_reqlog", WINDOW_MS: 60 * 60 * 1000,
        WARN_REQ: 130, REFUSE_START: 165, HARD_STOP: 185, SAFE_RESUME: 120
    };
    const GAP_MIN_MS = clamp(Math.round(Number(CFG.REQ_GAP_SEC[0]) * 1000) || COMMON.FLOOR_INTERVAL, COMMON.FLOOR_INTERVAL, 99000);
    const GAP_MAX_MS = clamp(Math.round(Number(CFG.REQ_GAP_SEC[1]) * 1000) || GAP_MIN_MS, GAP_MIN_MS, 99000);

    const MODES = {
        daily: { key: "daily", name: "日常维护", color: "#2f6f3e", minutes: CFG.DAILY_MINUTES, topics: CFG.DAILY_TOPICS, replies: CFG.DAILY_REPLIES, likes: CFG.DAILY_LIKES, minPosts: 5, safety: 160,      noLimit: false },
        fast:  { key: "fast",  name: "快速升级", color: "#33507a", minutes: CFG.FAST_MINUTES,  topics: CFG.FAST_TOPICS,  replies: CFG.FAST_REPLIES,  likes: CFG.FAST_LIKES,  minPosts: 5, safety: 175,      noLimit: false },
        idle:  { key: "idle",  name: "日常挂机", color: "#6a4b8a", minutes: CFG.IDLE_MINUTES,  topics: CFG.IDLE_TOPICS,  replies: CFG.IDLE_REPLIES,  likes: CFG.IDLE_LIKES,  minPosts: 8,  safety: Infinity, noLimit: true,  fullRandom: true  }
    };
    const MODE_KEYS = ["daily", "fast", "idle"];
    function totalMs(M) { return M.minutes * 60 * 1000; }

    let running = false, abort = false, activeMode = "", startedAt = 0, csrf = "", consecCf = 0, uiTimer = null;
    let engineController = null, consecutiveErrors = 0, stopReason = "";
    async function engineFetch(url, options) {
        if (abort || (activeMode && elapsed() >= totalMs(MODES[activeMode]))) return Promise.reject(new DOMException("已停止", "AbortError"));
        const opts = Object.assign({}, options || {}, { signal: engineController ? engineController.signal : undefined });
        const response = await fetchTimed(url, opts);
        if ((opts.method || "GET") === "GET" && [401, 403, 429].indexOf(response.status) >= 0) {
            const body = await response.clone().text();
            stopEngine(response.status === 429 ? "读取接口被限流，已停止，请稍后再试。" :
                CF_CHALLENGE_RE.test(body) ? "遇到验证页面，已停止，请先在网页完成验证。" : "登录已失效或没有访问权限，已停止。");
        }
        return response;
    }
    function stopEngine(reason) {
        stopReason = reason || "已停止";
        abort = true;
        if (engineController) engineController.abort();
        wakeAll();
    }
    let finishedOnce = false, frozenTimer = "", banMsg = "", endNote = "";
    let syncState = "idle", syncAt = 0;
    let arState = "idle", arText = "", arBal = "";
    let anyState = "idle";
    let me = { username: "", trustLevel: null };
    let summary = null, summaryState = "idle";
    let ldc = { state: "idle", value: "", msg: "" };

    let plan = { topics: 0, replies: 0, likes: 0 };
    const sent = { topics: 0, replies: 0, likes: 0, timingReq: 0 };
    const handledLikeTopics = new Set();

    function elapsed() { return startedAt ? Date.now() - startedAt : 0; }
    function readJson(k, fb) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? fb : v; } catch (_) { return fb; } }
    function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
    function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

    let _tl3Cache = { key: "", at: 0, v: null };
    function readTL3() {
        if (!me.username) return null;
        const key = me.username.toLowerCase();
        if (_tl3Cache.key === key && Date.now() - _tl3Cache.at < 3000) return _tl3Cache.v;
        let v = null;
        try { const s = GM_getValue("ld_tl3_" + key, ""); v = s ? JSON.parse(s) : null; } catch (_) { v = null; }
        _tl3Cache = { key: key, at: Date.now(), v: v };
        return v;
    }

    function isLowTL() { return me.trustLevel !== null && me.trustLevel <= 1; }

    function creditBalKey(u) { return CREDIT.BALPREFIX + (normUser(u) || "unknown"); }
    function readCreditCache(u) {
        try {
            const v = JSON.parse(gmGet(creditBalKey(u), "null"));
            if (v && v.day === todayStr() && v.v) return v;
        } catch (_) {}
        return null;
    }
    function writeCreditCache(u, val) { gmSet(creditBalKey(u), JSON.stringify({ v: val, at: Date.now(), day: todayStr() })); }

    function fmtLdc(n) {
        const v = Number(n);
        if (!isFinite(v)) return "";
        return v.toFixed(2).replace(/\.?0+$/, "");
    }
    async function creditUserInfo(timeout) {
        const r = await gmFetch(CREDIT.HOST + "/api/v1/oauth/user-info", {
            headers: { "X-Requested-With": "XMLHttpRequest" }, timeout: timeout || CREDIT.API_TIMEOUT
        });
        const finalUrl = String(r.finalUrl || "");
        if (r.status === 401 || r.status === 403 || /\/login(?:\?|$)/.test(finalUrl)) {
            const e = new Error("Credit 未登录"); e.needLogin = true; throw e;
        }
        let b; try { b = JSON.parse(String(r.responseText || "").replace(/^﻿/, "")); }
        catch (_) { const e = new Error("Credit 返回非JSON"); e.needLogin = true; throw e; }
        if (!b || r.status < 200 || r.status >= 300 || b.error_msg) throw new Error((b && b.error_msg) || ("HTTP " + r.status));
        const d = b && b.data;
        if (!d || d.available_balance === undefined || d.available_balance === null) throw new Error("缺少 available_balance");
        return { username: normUser(d.username), id: Number(d.id) || 0, balance: fmtLdc(d.available_balance) };
    }

    function uuid4() {

        try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
        const b = new Uint8Array(16);
        try { crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
    }
    async function creditCodeLogin() {
        const st = uuid4();
        const authUrl = CONNECT_HOST + "/oauth2/authorize?client_id=" + encodeURIComponent(CREDIT.CLIENT_ID) +
            "&nonce=" + encodeURIComponent(st) +
            "&redirect_uri=" + encodeURIComponent(CREDIT.REDIRECT) +
            "&response_type=code&scope=" + encodeURIComponent(CREDIT.SCOPE) +
            "&state=" + encodeURIComponent(st);
        const a = await gmFetch(authUrl, { headers: { "Accept": "text/html,application/xhtml+xml" }, timeout: 15000 });
        if (a.status >= 400 || CF_CHALLENGE_RE.test(a.responseText || "")) {
            throw arNonJsonError(a, a.finalUrl);
        }

        let cs = paramsFrom(a.finalUrl) || paramsFromText(a.responseText);
        if (!cs) {

            if (detectNoOauth(a.responseText)) throw noOauthError();
            const ap = parseApprove(a.responseText);
            if (!ap) throw new Error("授权页无允许链接(Linux DO登录态可能失效)");
            const approved = await gmFetch(new URL(ap, CONNECT_HOST).href, {
                headers: { "Accept": "text/html,application/xhtml+xml" }, timeout: 15000
            });
            cs = paramsFrom(approved.finalUrl) || paramsFromText(approved.responseText);
        }
        if (!cs) throw new Error("授权完成但没返回code");
        if (String(cs.state) !== String(st)) throw new Error("授权 state 不匹配，请重新登录。");

        await gmFetch(CREDIT.REDIRECT + "?code=" + encodeURIComponent(cs.code) + "&state=" + encodeURIComponent(cs.state), {
            headers: { "Accept": "text/html,application/xhtml+xml" }, timeout: 15000
        }).catch(function () {});
        return await creditUserInfo(CREDIT.API_TIMEOUT);
    }

    function creditForegroundLogin() {
        return new Promise(function (resolve, reject) {
            let handle = null;
            try { handle = GM_openInTab(CREDIT.HOST + "/home?ldh_credit_auto=1", { active: true, insert: true, setParent: true }); }
            catch (_) { handle = null; }
            if (!handle) { reject(new Error("无法打开标签")); return; }
            let settled = false, checking = false;
            const user = me.username;
            function done(error, info) {
                if (settled) return;
                settled = true; clearInterval(iv); clearTimeout(deadline);
                try { handle.close(); } catch (_) {}
                if (error) reject(error); else resolve(info);
            }
            const deadline = setTimeout(function () { done(new Error("授权超时，请完成网页验证后重试。")); }, CREDIT.TAB_TIMEOUT);
            const iv = setInterval(function () {
                if (getNoOauth(user)) { done(noOauthError()); return; }
                if (handle.closed) { done(new Error("授权标签已关闭。")); return; }
                if (checking || settled) return;
                checking = true;
                creditUserInfo(CREDIT.API_TIMEOUT).then(function (info) {
                    done(null, info);
                }).catch(function () {}).finally(function () { checking = false; });
            }, 1000);
        });
    }

    let creditJob = null;
    function refreshCredit(manual) {
        if (!creditJob) creditJob = refreshCreditOnce(manual).finally(function () { creditJob = null; });
        return creditJob;
    }
    async function refreshCreditOnce(manual) {
        if (idleSuspended && !manual) return;
        const u = me.username;
        if (!u) return;

        if (!manual && getNoOauth(u)) { ldc = { state: "nooauth", value: "", msg: NO_OAUTH_MSG }; return; }

        if (!manual) {
            const cache = readCreditCache(u);
            if (cache) { ldc = { state: "ok", value: cache.v, msg: "" }; render(); return; }
        }
        ldc = { state: "loading", value: "", msg: "读取中…" }; render();

        let info = null;
        try { info = await creditUserInfo(CREDIT.API_TIMEOUT); }
        catch (e) {
            if (!e || !e.needLogin) { ldc = { state: "fail", value: "", msg: (e && e.message) || "读取失败" }; render(); return; }

            try { info = await creditCodeLogin(); }
            catch (e2) {

                if (e2 && e2.noOauth) {
                    saveNoOauth(u, "credit", me.trustLevel);
                    ldc = { state: "nooauth", value: "", msg: NO_OAUTH_MSG };
                    render(); return;
                }

                if (!me.username) { ldc = { state: "fail", value: "", msg: "未登录 LINUX DO" }; render(); return; }
                if (!manual && !acquireTabLock()) {
                    ldc = { state: "fail", value: "", msg: "另一个标签正在登录，稍后重试" }; render(); return;
                }
                ldc = { state: "loading", value: "", msg: "打开标签登录中…" }; render();
                try { info = await creditForegroundLogin(); }
                catch (e3) {
                    ldc = { state: "fail", value: "", msg: "纯代码:" + ((e2 && e2.message) || e2) + " / 标签:" + ((e3 && e3.message) || e3) };
                    render(); return;
                }
                finally { if (!manual) releaseTabLock(); }
            }
        }
        if (!info) return;

        if (info.username && normUser(u) && info.username !== normUser(u)) {
            ldc = { state: "mismatch", value: "", msg: "论坛 @" + u + " / Credit @" + info.username };
            render(); return;
        }
        writeCreditCache(u, info.balance);
        ldc = { state: "ok", value: info.balance, msg: "" };
        render();
    }

    async function fetchSummary(username) {
        const r = await fetchTimed("/u/" + encodeURIComponent(username) + "/summary.json", {
            credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" }
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const b = await r.json();
        const s = b && b.user_summary;
        if (!s || s.can_see_summary_stats === false) throw new Error("无权限查看摘要");
        return {
            visitDays: Number(s.days_visited) || 0,
            timeRead: Number(s.time_read) || 0,
            topicsEntered: Number(s.topics_entered) || 0,
            postsRead: Number(s.posts_read_count) || 0,
            topicsCreated: Number(s.topic_count) || 0,
            postsCreated: Number(s.post_count) || 0
        };
    }
    function fmtK(v) { v = Number(v) || 0; return v < 1000 ? String(v) : (v / 1000).toFixed(1).replace(/\.0$/, "") + "k"; }

    function fmtDur(sec) {
        sec = Math.max(0, Number(sec) || 0);
        const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
              m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        if (d > 0) return h > 0 ? d + "天" + h + "小时" : d + "天";
        if (h > 0) return m > 0 ? h + "小时" + m + "分" : h + "小时";
        if (m > 0) return m + "分钟";
        return s + "秒";
    }
    function loadSummary(force) {
        const user = me.username;
        if (!user) return Promise.resolve();
        const key = "ldh_summary_" + normUser(user), cached = readJson(key, null);
        if (!force && cached && cached.data && Date.now() - cached.at >= 0 && Date.now() - cached.at < SYNC_THROTTLE_MS) {
            summary = cached.data; summaryState = "ok"; render(); return Promise.resolve();
        }
        if (summaryState === "loading") return Promise.resolve();
        summaryState = "loading"; render();
        return fetchSummary(user).then(function (s) {
            writeJson(key, { at: Date.now(), data: s });
            if (me.username !== user) return;
            summary = s; summaryState = "ok"; render();
        }).catch(function () {
            if (me.username !== user) return;
            summary = null; summaryState = "fail"; render();
        });
    }

    function syncViaXhr(onFail) {
        if (typeof GM_xmlhttpRequest !== "function") { onFail("nogrant"); return; }
        syncState = "syncing"; render();
        GM_xmlhttpRequest({
            method: "GET", url: "https://connect.linux.do/", timeout: 15000,
            headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Referer": "https://connect.linux.do/", "User-Agent": navigator.userAgent },
            onload: function (resp) {
                const html = resp.responseText || "";
                if (CF_CHALLENGE_RE.test(html) && !/tl3-ring|empty-state/.test(html)) { onFail("cf"); return; }
                let doc; try { doc = new DOMParser().parseFromString(html, "text/html"); } catch (_) { onFail("err"); return; }
                const data = parseConnectRoot(doc);
                if (resp.status < 200 || resp.status >= 300) { onFail("err"); return; }
                if (data && data.account && normUser(data.account) !== normUser(me.username)) { onFail("otheruser"); return; }
                if (data && storeTL3(data, me.username)) { _tl3Cache = { key: "", at: 0, v: null }; syncAt = Date.now(); syncState = readTL3() ? "ok" : "otheruser"; render(); }
                else { onFail("empty"); }
            },
            onerror: function () { onFail("err"); },
            ontimeout: function () { onFail("err"); }
        });
    }
    function openConnectTab() {

        syncState = "opening"; render();

        const rawTL3 = function () {
            if (!me.username) return null;
            try { const s = GM_getValue("ld_tl3_" + me.username.toLowerCase(), ""); return s ? JSON.parse(s) : null; } catch (_) { return null; }
        };
        const before = (function () { const r = rawTL3(); return (r && r.at) || 0; })();
        const url = "https://connect.linux.do/#ldhsync=" + encodeURIComponent(me.username || "");
        let handle = null;
        try { if (typeof GM_openInTab === "function") handle = GM_openInTab(url, { active: false, insert: true, setParent: true }); } catch (_) {}
        if (!handle) { syncState = "popupblock"; render(); return; }
        let n = 0;
        const iv = setInterval(function () {
            n++;
            const r = rawTL3();
            if (r && (r.at || 0) !== before) {
                clearInterval(iv); _tl3Cache = { key: "", at: 0, v: null };
                syncAt = Date.now(); syncState = "ok"; render();
                try { if (handle.close) handle.close(); } catch (_) {}
            }
            else if (n > 14) { clearInterval(iv); try { if (handle.close) handle.close(); } catch (_) {} syncState = "empty"; render(); }
        }, 1500);
    }

    let oauthRetrying = false;
    async function retryOauth() {
        const u = me.username;
        if (!u || oauthRetrying || arState === "running" || creditJob) return;
        oauthRetrying = true;
        clearNoOauth(u);
        ldc = { state: "loading", value: "", msg: "重新检查授权权限…" };
        arState = "idle"; arText = "重新检查授权权限…"; arBal = "";
        render();
        try { await refreshCredit(true); } catch (_) {}
        try { await runArCheckin(true); } catch (_) {}
        oauthRetrying = false;
        if (getNoOauth(u)) {
            ldhToast(NO_OAUTH_MSG + "，LDC / Agent / Any 保持停用。", "error");
        } else if (ldc.state === "ok" || arState === "ok") {
            ldhToast("授权权限已恢复，LDC / Agent / Any 重新启用。", "success");
        } else {
            ldhToast("授权重试尚未成功，请查看 LDC / Agent 的错误提示。", "error");
        }
        render();
    }
    function sync() {

        if (!me.username) return;
        if (isLowTL()) { loadSummary(true); return; }
        if (syncState === "syncing" || syncState === "opening") return;
        syncViaXhr(function (reason) {
            syncState = reason; render();
            if (reason !== "otheruser") openConnectTab();
        });
    }

    function recentTimings() {
        const entries = readJson(COMMON.REQLOG_KEY, []), now = Date.now();
        return Array.isArray(entries) ? entries.filter(function (t) { return Number.isFinite(t) && t <= now && now - t < COMMON.WINDOW_MS; }) : [];
    }
    function logTimingReq() { const a = recentTimings(); a.push(Date.now()); writeJson(COMMON.REQLOG_KEY, a); }
    function recentTimingCount() { return recentTimings().length; }
    function budgetHit() {
        const M = MODES[activeMode];
        if (!M || M.noLimit) return false;
        return recentTimingCount() >= COMMON.HARD_STOP || sent.timingReq >= M.safety;
    }
    function minutesUntilBelow(target) {
        const now = Date.now(); const arr = recentTimings().sort(function (a, b) { return a - b; });
        if (arr.length <= target) return 0;
        return Math.max(1, Math.ceil((arr[arr.length - target - 1] + COMMON.WINDOW_MS - now) / 60000));
    }

    function schedule(T) {
        const M = MODES[activeMode];
        const remTime = Math.max(0, T - elapsed());
        const remReplies = Math.max(0, plan.replies - sent.replies);
        const remTopics = Math.max(0, plan.topics - sent.topics);
        let minReq = Math.max(Math.ceil(remTime / GAP_MAX_MS), remTopics, 1);
        if (M && !M.fullRandom) {
            const left = Math.max(1, M.safety - 5 - sent.timingReq);
            minReq = Math.max(1, Math.min(minReq, left));
        }
        const avg = remTime / minReq;
        let interval, cap, estReq, batchOverride = null;
        if (M && M.fullRandom) {
            cap = clamp(Math.round(avg * 2), GAP_MIN_MS, GAP_MAX_MS);
            interval = randInt(GAP_MIN_MS, cap);
            estReq = Math.max(1, Math.round(remTime / Math.max(1, cap / 2)));
        } else {
            const room = Math.max(1, M.safety - 5);
            const rr = Math.max(0, plan.replies - sent.replies);
            const rt = Math.max(0, plan.topics - sent.topics);
            const reqForPosts = rr > 0 ? Math.ceil(rr / COMMON.MAX_BATCH) : 0;
            const needReq = Math.max(rt, reqForPosts, 1);
            const budgetReq = Math.max(1, Math.min(needReq, room - sent.timingReq));
            batchOverride = rr > 0 ? Math.ceil(rr / budgetReq) : 1;
            batchOverride = clamp(batchOverride, 1, COMMON.MAX_BATCH);
            const overhead = rt * COMMON.TOPIC_OVERHEAD_MS;
            const usable = Math.max(0, remTime - overhead);
            const avgGap = usable / budgetReq;
            const lo = clamp(Math.round(avgGap * 0.4), GAP_MIN_MS, GAP_MAX_MS);
            const hi = clamp(Math.round(avgGap * 1.6), lo, GAP_MAX_MS);
            interval = randInt(lo, hi);
            cap = hi;
            estReq = minReq;
        }
        let batch = batchOverride !== null ? batchOverride : (remReplies > 0 ? Math.round(remReplies / estReq) : 1);
        batch = clamp(batch, 1, COMMON.MAX_BATCH);
        return { batch: batch, interval: interval, remReq: estReq, remTime: remTime, cap: cap };
    }

    function csrfMeta() { const m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute("content") : ""; }
    async function getCsrf(signal) { let t = csrfMeta(); if (t) return t; try { const r = await fetchTimed("/session/csrf.json", { signal: signal, credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); if (r.ok) t = (await r.json()).csrf || ""; } catch (_) {} return t; }

    async function getUser(signal) {
        try {
            const r = await fetchTimed("/session/current.json", { signal: signal, credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } });
            if (!r.ok) return { username: "", trustLevel: null };
            const u = (await r.json()).current_user;
            if (u) {
                const tl = (u.trust_level === undefined || u.trust_level === null) ? null : Number(u.trust_level);
                return { username: String(u.username || ""), trustLevel: (tl === null || isNaN(tl)) ? null : tl };
            }
        } catch (_) {}
        return { username: "", trustLevel: null };
    }
    async function enterTopic(id) {
        try {
            const r = await engineFetch("/t/" + id + ".json?track_visit=true&forceLoad=true", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest", "Discourse-Logged-In": "true", "Discourse-Present": "true", "Discourse-Track-View": "true", "Discourse-Track-View-Topic-Id": String(id), "X-CSRF-Token": csrf } });
            if (!r.ok) return { ok: false }; const d = await r.json();
            return { ok: true, highest: Number(d.highest_post_number || (d.post_stream && d.post_stream.stream ? d.post_stream.stream.length : 0) || 0), lastRead: Number(d.last_read_post_number || (d.topic_user && d.topic_user.last_read_post_number) || 0) };
        } catch (_) { return { ok: false }; }
    }
    async function postTimings(id, nums) {
        const p = new URLSearchParams(); p.set("topic_id", String(id)); let total = 0;
        nums.forEach(function (n) { const ms = randInt(COMMON.MSECS_MIN, COMMON.MSECS_MAX); total += ms; p.set("timings[" + n + "]", String(ms)); });
        p.set("topic_time", String(total));
        let resp, body = "", ra = "", ct = "";
        try { resp = await engineFetch("/topics/timings", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", "Discourse-Present": "true" }, body: p.toString() }); }
        catch (e) { return { kind: "neterr" }; }
        try { ra = resp.headers.get("Retry-After") || ""; } catch (_) {}
        try { ct = resp.headers.get("Content-Type") || ""; } catch (_) {}
        try { body = await resp.text(); } catch (_) {}
        return { kind: classify(resp.status, body, ra, ct), retryMs: retryDelay(ra, body) };
    }
    function retryDelay(ra, body) {
        const value = String(ra || "").trim();
        const header = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now()) || 0;
        let seconds = 0;
        try { seconds = Math.max(0, Number(JSON.parse(body).extras.wait_seconds) || 0); } catch (_) {}
        return Math.max(header, seconds * 1000);
    }
    function classify(status, body, ra, ct) {
        if (CF_CHALLENGE_RE.test(body || "")) return "cloudflare";
        if (status >= 200 && status < 300) return /text\/html/i.test(ct || "") ? "other" : "ok";
        if (status === 401 || status === 403) return "auth_error";
        if (status === 429) { const delay = retryDelay(ra, body); return (delay >= COMMON.HARD_BLOCK_RETRY_THRESHOLD * 1000 || /slow down/i.test(body || "") || (delay === 0 && /text\/plain/i.test(ct || ""))) ? "discourse_hard" : "discourse_soft"; }
        if (status >= 500) return "server_error";
        return "other";
    }
    function reactionState(data) {
        if (!data || typeof data !== "object") return null;
        const actions = Array.isArray(data.actions_summary) ? data.actions_summary : null;
        if (data.current_user_reaction || data.current_user_used_main_reaction === true ||
            (actions && actions.some(function (a) { return a.id === 2 && a.acted === true; }))) return true;
        return ("current_user_reaction" in data || "current_user_used_main_reaction" in data || actions) ? false : null;
    }
    async function getReacted(postId) {
        try {
            const r = await engineFetch("/posts/" + postId + ".json", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } });
            return r.ok ? reactionState(await r.json()) : null;
        } catch (_) { return null; }
    }
    async function likeToggle(postId) {
        try {
            const r = await engineFetch("/discourse-reactions/posts/" + postId + "/custom-reactions/" + COMMON.LIKE_REACTION + "/toggle.json", { method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", "Discourse-Logged-In": "true", "Discourse-Present": "true" } });
            let reacted = null;
            try { reacted = reactionState(await r.json()); } catch (_) {}
            return { status: r.status, reacted: reacted };
        } catch (_) { return { status: 0, reacted: null }; }
    }
    function parseNames(text) {
        const seen = new Set(), names = [];
        accountFileLines(text).forEach(function (line, i) {
            if (!line.trim() || /^\s*(?:#|\/\/)/.test(line)) return;
            let name;
            try { name = loginCredentials(line).username; }
            catch (_) { throw new Error("账号文件第 " + (i + 1) + " 行格式不正确。"); }
            if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) throw new Error("第 " + (i + 1) + " 行需填写论坛用户名，点赞不能使用邮箱。");
            const key = normUser(name);
            if (!seen.has(key)) { seen.add(key); names.push(name); }
        });
        return names;
    }
    async function loadNames() {
        try {
            const names = parseNames(await loginReadAccounts(engineController ? engineController.signal : undefined));
            if (!names.length) throw new Error("账号文件没有可用用户名。");
            return names;
        } catch (e) {
            if (!abort) { endNote = "已跳过点赞：" + (e.message || "私库读取失败"); render(); }
            return [];
        }
    }
    async function fetchUserPosts(u) {
        async function one(f) { try { const r = await engineFetch("/user_actions.json?username=" + encodeURIComponent(u) + "&filter=" + f + "&limit=30&offset=0", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d.user_actions) ? d.user_actions : []; } catch (_) { return []; } }
        const items = (await one(4)).concat(await one(5)), out = [], seen = new Set();
        items.forEach(function (it) { if (!it || it.deleted || it.hidden || !it.topic_id || !it.post_id) return; if (!it.username || String(it.username).toLowerCase() !== u.toLowerCase()) return; const k = it.topic_id + ":" + it.post_id; if (seen.has(k)) return; seen.add(k); out.push({ topicId: String(it.topic_id), postId: String(it.post_id) }); });
        return shuffle(out);
    }

    const TOPIC_SOURCES = [
        "/top.json?period=all", "/top.json?period=yearly", "/top.json?period=quarterly",
        "/top.json?period=monthly", "/latest.json?order=posts", "/latest.json"
    ];
    const pool = {
        queue: [], seen: new Set(), src: 0, page: 0, exhausted: false,
        reset: function () { this.queue = []; this.seen = new Set(); this.src = 0; this.page = 0; this.exhausted = false; }
    };
    async function listTopics(url) {
        try { const r = await engineFetch(url, { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); if (!r.ok) return []; const topics = ((await r.json()).topic_list || {}).topics; return Array.isArray(topics) ? topics : []; } catch (_) { return []; }
    }
    async function refillPool(minPosts) {
        let rounds = 0;
        const M = MODES[activeMode];
        while (pool.queue.length < 40 && rounds < 40 && !pool.exhausted && !abort && (!M || elapsed() < totalMs(M))) {
            rounds++;
            const base = TOPIC_SOURCES[pool.src];
            const url = base + (base.indexOf("?") >= 0 ? "&" : "?") + "per_page=50&page=" + pool.page;
            const raw = await listTopics(url);
            if (abort) return false;
            const fresh = [];
            raw.forEach(function (t) {
                const id = t && t.id ? String(t.id) : "";
                if (!id || pool.seen.has(id)) return;
                const h = Number(t.highest_post_number || t.posts_count || 0);
                if (h >= minPosts && Number(t.last_read_post_number || 0) < h) { pool.seen.add(id); fresh.push(id); }
            });
            pool.queue = pool.queue.concat(shuffle(fresh));
            pool.src++;
            if (pool.src >= TOPIC_SOURCES.length) {
                pool.src = 0; pool.page++;
                if (pool.page > 30) pool.exhausted = true;
            }
            await sleep(randInt(150, 350));
        }
        return pool.queue.length > 0;
    }
    async function nextTopic(minPosts) {
        if (!pool.queue.length) { const ok = await refillPool(minPosts); if (!ok) return ""; }
        return pool.queue.shift() || "";
    }

    let likeSlots = [], likeNames = [], likeNameIdx = 0, likeCands = [], likeDead = false;
    function buildLikeSlots(T, n) {
        const a = [];
        for (let i = 0; i < n; i++) a.push(randInt(Math.round(T * 0.02), Math.round(T * 0.95)));
        a.sort(function (x, y) { return x - y; });
        return a;
    }
    async function doOneLike() {
        for (let guard = 0; guard < 10 && !abort && !likeDead; guard++) {
            if (!likeCands.length) {
                if (likeNameIdx >= likeNames.length) { likeDead = true; return false; }
                likeCands = await fetchUserPosts(likeNames[likeNameIdx++]);
                await sleep(randInt(400, 800));
                continue;
            }
            const c = likeCands.shift();
            if (handledLikeTopics.has(c.topicId)) continue;
            const reacted = await getReacted(c.postId);
            if (abort) return false;
            if (reacted !== false) { handledLikeTopics.add(c.topicId); await sleep(250); continue; }
            const result = await likeToggle(c.postId);
            if (abort) return false;
            const code = result.status;
            if (code >= 200 && code < 300) {
                handledLikeTopics.add(c.topicId);
                const confirmed = result.reacted === null ? await getReacted(c.postId) : result.reacted;
                if (confirmed === true) { sent.likes++; render(); return true; }
            }
            await sleep(randInt(600, 1100));
            if (code === 429) { likeDead = true; likeSlots = []; endNote = "点赞被限流"; return false; }
            if (code === 401 || code === 403) { likeDead = true; likeSlots = []; endNote = "点赞失败：登录已失效或没有权限"; return false; }
        }
        return false;
    }
    async function maybeLike() {
        while (likeSlots.length && !likeDead && !abort && elapsed() >= likeSlots[0]) {
            likeSlots.shift();
            await doOneLike();
        }
    }

    async function engine(mode) {
        const M = MODES[mode];
        const T = totalMs(M);
        const signal = engineController.signal;
        me = await getUser(signal);
        if (abort) return finish("stopped", stopReason || "已停止");
        if (!me.username) return finish("未登录", "未登录");
        gmSet(LD_USER_KEY, normUser(me.username));
        csrf = await getCsrf(signal);
        if (abort) return finish("stopped", stopReason || "已停止");
        if (!csrf) return finish("无CSRF", "无CSRF");

        plan.topics = randInt(M.topics[0], M.topics[1]);
        plan.replies = randInt(M.replies[0], M.replies[1]);
        plan.likes = randInt(M.likes[0], M.likes[1]);
        render();

        likeSlots = []; likeNames = []; likeNameIdx = 0; likeCands = []; likeDead = false;
        if (plan.likes > 0) {
            likeSlots = buildLikeSlots(T, plan.likes);
            likeNames = shuffle((await loadNames()).filter(function (n) { return n && n.toLowerCase() !== me.username.toLowerCase(); }));
            if (!likeNames.length) likeDead = true;
        }
        if (abort) return finish("stopped", stopReason || "已停止");

        pool.reset();

        while (!abort && elapsed() < T) {
            if (budgetHit()) { endNote = "本窗口达上限"; break; }
            await maybeLike();
            if (abort || elapsed() >= T) break;

            const tid = await nextTopic(M.minPosts);
            if (abort || elapsed() >= T) break;
            if (!tid) {
                const s = schedule(T);
                await sleep(Math.min(s.interval, 5000));
                if (pool.exhausted) { pool.reset(); }
                continue;
            }

            const meta = await enterTopic(tid);
            if (abort || elapsed() >= T) break;
            await sleep(randInt(COMMON.ENTER_MIN, COMMON.ENTER_MAX));
            if (!meta.ok || meta.highest < 2) continue;

            const remTopics = Math.max(1, plan.topics - sent.topics);
            const remReplies = Math.max(0, plan.replies - sent.replies);
            let want = Math.round((remReplies / remTopics) * (0.8 + Math.random() * 0.4));
            want = Math.max(1, Math.min(want, remReplies));

            const start = Math.max(2, meta.lastRead + 1);
            const end = Math.min(meta.highest, start + want - 1);
            if (end < start) continue;
            const nums = []; for (let n = start; n <= end; n++) nums.push(n);

            let readThis = false, p = 0;
            while (p < nums.length && !abort && elapsed() < T) {
                if (budgetHit()) { endNote = "本窗口达上限"; break; }
                await maybeLike();
                if (abort || elapsed() >= T) break;

                const s = schedule(T);
                const take = Math.max(1, Math.min(s.batch, nums.length - p));
                const batch = nums.slice(p, p + take);
                if (!batch.length) break;
                sent.timingReq++;
                logTimingReq();
                const res = await postTimings(tid, batch);
                if (abort) break;
                if (res.kind === "ok") {
                    consecCf = 0; consecutiveErrors = 0;
                    sent.replies += batch.length;
                    if (!readThis) { sent.topics++; readThis = true; }
                    render();
                    p += batch.length;
                    await sleep(Math.min(s.interval, Math.max(0, T - elapsed())));
                } else if (res.kind === "discourse_hard") {
                    return finish("限流", "服务器要求暂停，已停止，请稍后再试。");
                } else if (res.kind === "auth_error") {
                    return finish("登录失效", "登录已失效或没有权限，请重新登录。");
                } else if (res.kind === "cloudflare") {
                    consecCf++; if (consecCf >= COMMON.MAX_CONSEC_CF) return finish("验证", "连续遇到验证页面，已停止，请先在网页完成验证。");
                    await sleep(COMMON.CF_BACKOFF_MS);
                } else if (res.kind === "discourse_soft") {
                    await sleep(Math.min(Math.max(8000, res.retryMs || 0), Math.max(0, T - elapsed())));
                } else {
                    consecutiveErrors++;
                    if (consecutiveErrors >= 5) return finish("网络异常", "连续请求失败，已停止，请检查网络或稍后重试。");
                    await sleep(1500);
                }
            }
        }
        finish(abort ? "stopped" : "done", abort ? (stopReason || "已停止") : "");
    }

    function finish(reason, note) {
        const M = MODES[activeMode]; const used = M ? Math.min(elapsed(), totalMs(M)) : elapsed();
        running = false; finishedOnce = true; if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
        if (engineController) { engineController.abort(); engineController = null; }
        wakeAll();
        frozenTimer = "⏱ " + mmss(used); if (note) endNote = note; activeMode = "";
        writeJson("ld_helper_last", { at: Date.now(), sent: { topics: sent.topics, replies: sent.replies, likes: sent.likes }, frozen: frozenTimer, endNote: endNote });
        restoreButtons();
        resumeIdleWork();
        render();
    }
    function startMode(mode) {

        if (running) { if (mode === activeMode) stopEngine(); return; }
        const M = MODES[mode];
        if (!M) return;
        if (!M.noLimit) {
            const rc = recentTimingCount();
            if (rc >= COMMON.REFUSE_START) { banMsg = "⛔ 本窗口已发" + rc + "次，约" + minutesUntilBelow(COMMON.SAFE_RESUME) + "分钟后再来"; finishedOnce = false; render(); return; }
        }
        banMsg = ""; endNote = ""; frozenTimer = ""; running = true; abort = false; activeMode = mode; startedAt = Date.now(); consecCf = 0;
        engineController = new AbortController(); consecutiveErrors = 0; stopReason = "";
        sent.topics = 0; sent.replies = 0; sent.likes = 0; sent.timingReq = 0; handledLikeTopics.clear();
        plan.topics = 0; plan.replies = 0; plan.likes = 0;
        suspendIdleWork();
        markButtons(mode); if (uiTimer) clearInterval(uiTimer); uiTimer = setInterval(render, 1000); render();
        engine(mode).catch(function (e) { finish("异常", "异常:" + (e && e.message || e)); });
    }

    function arSuccessText() {
        return gmGet(AR.REWARDKEY, "") === todayStr() ? "签到成功" : "今日登录签到已处理，接口未确认新增签到奖励";
    }
    function runArCheckin(force) {
        if (!me.username) return Promise.resolve();
        if (arState === "running") return Promise.resolve();
        if (idleSuspended && !force) return Promise.resolve();

        if (!force && getNoOauth(me.username)) {
            arState = "nooauth"; arText = NO_OAUTH_MSG; arBal = "";
            return Promise.resolve();
        }
        const today = todayStr();
        const signedToday = gmGet(AR.DAYKEY, "") === today;
        const balToday = gmGet(AR.BALDAY, "") === today;

        if (!force && signedToday && balToday) {

            const saved = loadArNote();
            if (saved && saved.bal) { arState = saved.state; arText = saved.text; arBal = saved.bal; }
            else { arState = "ok"; arText = arSuccessText(); arBal = gmGet(AR.BALKEY, "") || ""; }
            render(); return Promise.resolve();
        }

        if (!force && signedToday) {

            arState = "running"; arText = "读取余额中…"; arBal = ""; render();
            return arBalance(null, { retries: 3 }).then(function (bal) {
                arState = "ok"; arText = arSuccessText(); arBal = bal;
                gmSet(AR.BALKEY, bal); gmSet(AR.BALDAY, today);
                saveArNote(arState, arText, arBal);
                render();
            }).catch(function (e) {

                arState = "pending"; arBal = "";
                arText = "今日登录签到已处理，余额读取失败：" + ((e && e.message) || e) + "，点击重试";
                saveArNote("pending", arText, "");
                render();
            });
        }

        arState = "running"; arText = "签到中…"; arBal = ""; render();

        return arCheckin(function (s) { arText = s; }, force).then(function (r) {
            if (r && r.checkedIn) gmSet(AR.REWARDKEY, today);
            const checkinText = arSuccessText();

            gmSet(AR.DAYKEY, today);

            return arBalance(r && r.user, { waitFirst: 800, retries: 3 }).then(function (bal) {
                arState = "ok"; arText = checkinText; arBal = bal;
                gmSet(AR.BALKEY, bal); gmSet(AR.BALDAY, today);
                saveArNote(arState, arText, arBal);
                render();
            }).catch(function (e) {
                arState = "pending"; arBal = "";
                arText = "今日登录签到已处理，余额读取失败：" + ((e && e.message) || e) + "，点击重试";
                saveArNote("pending", arText, "");
                render();
            });
        }).catch(function (e) {

            if (e && e.noOauth) {
                saveNoOauth(me.username, "agentrouter", me.trustLevel);
                arState = "nooauth"; arText = NO_OAUTH_MSG; arBal = "";
                render(); return;
            }
            arState = "fail"; arText = (e && e.message) || String(e); arBal = "";
            saveArNote("fail", arText, "");
            render();
        });
    }

    function pullSideBalance() {
        if (idleSuspended) return;
        if (getNoOauth(me.username)) return;

        try {
            const v = JSON.parse(gmGet(AR.SIDEKEY, "null"));
            if (!v || !v.bal) return;
            if (Date.now() - Number(v.at || 0) > 30 * 60 * 1000) return;
            if (v.bal === arBal) return;
            arBal = v.bal;
            gmSet(AR.BALKEY, v.bal); gmSet(AR.BALDAY, todayStr());

            if (arState === "pending") { arState = "ok"; arText = arSuccessText(); }
            if (arState === "ok") saveArNote(arState, arText, arBal);
            render();
        } catch (_) {}
    }

    function mSpan(label, m) { if (!m) return ""; const ok = (m.c || 0) >= (m.r || 0); return '<span style="color:' + (ok ? "#8fe0b0" : "#ff8a8a") + ';">' + label + fmtNum(m.c) + "/" + fmtNum(m.r) + "</span>"; }

    function complianceFor(row) {
        const raw = readTL3();
        if (!raw || raw.locked || !raw.compliance) return "";
        const c = raw.compliance, v = [];
        if (row === 2) {
            if (c.reported_posts > 0) v.push("被举报" + c.reported_posts);
        } else {
            if (c.users_reported > 0) v.push("举报" + c.users_reported);
            if (c.muted > 0) v.push("禁言" + c.muted);
            if (c.banned > 0) v.push("封禁" + c.banned);
        }
        return v.length ? ' <span style="color:#ff8a8a;">⚠' + v.join(" ") + "</span>" : "";
    }
    function rowsForPanel() {

        if (isLowTL()) {
            if (summary) {
                return [
                    "访问" + summary.visitDays + "天 阅读时间" + fmtDur(summary.timeRead) + " 浏览话题" + fmtK(summary.topicsEntered),
                    "已读帖子" + fmtK(summary.postsRead) + " 创建话题" + summary.topicsCreated + " 创建帖子" + summary.postsCreated
                ];
            }
            if (summaryState === "loading") return ["摘要读取中…", ""];
            return ["摘要读取失败，点⟳重试", ""];
        }

        const raw = readTL3();
        if (!raw) {
            const s = syncState === "syncing" ? "（后台同步中…）" : syncState === "opening" ? "（正在打开 connect 同步…）" : syncState === "popupblock" ? "（弹窗被拦，允许本站弹窗后再点⟳）" : syncState === "otheruser" ? "（connect 登录的是别的账号，用本号登录）" : syncState === "nogrant" ? "（缺跨域权限，去油猴放行 connect）" : "（点右上 ⟳ 同步，会自动开一次 connect）";
            return ["等级3 未同步", s];
        }
        if (raw.locked) return ["等级0/1 未到2级，暂时看不到进度", "达到2级后 connect 才显示明细"];
        const m = raw.metrics || {};
        const c2 = complianceFor(2), c3 = complianceFor(3);

        const A = c2
            ? [mSpan("访", m.visit_days), mSpan("题", m.topics_viewed), mSpan("帖", m.posts_viewed), mSpan("复", m.topics_replied)].filter(Boolean).join(" ")
            : [mSpan("访问", m.visit_days), mSpan("话题", m.topics_viewed), mSpan("帖子", m.posts_viewed), mSpan("回复", m.topics_replied)].filter(Boolean).join(" ");
        const B = c3
            ? [mSpan("赞", m.likes_given), mSpan("获", m.likes_received), mSpan("赞天", m.liked_days), mSpan("赞人", m.liked_by_users)].filter(Boolean).join(" ")
            : [mSpan("点赞", m.likes_given), mSpan("获赞", m.likes_received), mSpan("获赞天数", m.liked_days), mSpan("获赞用户", m.liked_by_users)].filter(Boolean).join(" ");
        return [(A || "等级3 数据不全，去 connect 刷新") + c2, (B || "—") + c3];
    }

    const SP3 = "&nbsp;&nbsp; ";

    function tlBadge() {
        if (!me.username) return "";
        const tl = me.trustLevel;
        if (tl === null) return '<span style="color:#aaa;">' + SP3 + 'TL?</span>';
        return '<span style="color:#8fe0b0;">' + SP3 + "TL" + tl + "</span>";
    }

    function ldcSpan() {
        if (!me.username) return "";
        const base = '<span id="ldh_ldc" style="cursor:pointer;';

        if (!oauthRetrying && getNoOauth(me.username)) {
            return base + 'color:#ff8a8a;" title="' + esc(NO_OAUTH_MSG + "，已停止请求。点标题栏 ⟳ 可强制重试一次") + '">' + SP3 + "LDC：失败</span>";
        }
        if (ldc.state === "ok") {
            return base + 'color:#8fe0b0;" title="' + esc(ldc.msg || "可用 LINUX DO Credits，点击刷新") + '">' + SP3 + "LDC：" + esc(ldc.value) + "</span>";
        }
        if (ldc.state === "loading") return base + 'color:#e0c060;" title="' + esc(ldc.msg || "读取中") + '">' + SP3 + "LDC：获取中</span>";
        if (ldc.state === "mismatch") return base + 'color:#ff8a8a;" title="' + esc(ldc.msg) + '">' + SP3 + "LDC：账号不符</span>";
        if (ldc.state === "fail") return base + 'color:#ff8a8a;" title="' + esc(ldc.msg || "读取失败，点击重试") + '">' + SP3 + "LDC：失败</span>";
        return base + 'color:#888;" title="点击读取 Credit 积分">' + SP3 + "LDC：获取中</span>";
    }

    function arSpan() {
        if (!me.username) return "";
        const base = '<span id="ldh_arbal" style="cursor:pointer;';
        if (!oauthRetrying && getNoOauth(me.username)) {
            return base + 'color:#ff8a8a;" title="' + esc(NO_OAUTH_MSG + "，已停止请求。点标题栏 ⟳ 可强制重试一次") + '">' + SP3 + "Agent：失败</span>";
        }
        if (arState === "running") return base + 'color:#e0c060;" title="' + esc(arText || "签到中") + '">' + SP3 + "Agent：获取中</span>";
        if (arState === "pending") return base + 'color:#e0c060;" title="' + esc(arText || "签到已成功，余额读取失败，点击重试") + '">' + SP3 + "Agent：待刷新</span>";
        if (arState === "fail") return base + 'color:#ff8a8a;" title="' + esc(arText || "签到失败") + '">' + SP3 + "Agent：失败</span>";
        if (arState === "ok" && arBal) return base + 'color:#8fe0b0;" title="' + esc(arText + "；点击重新登录签到") + '">' + SP3 + "Agent：" + esc(arBal) + "</span>";
        if (arState === "ok") return base + 'color:#e0c060;" title="今日登录签到已处理，余额读取中">' + SP3 + "Agent：获取中</span>";
        return base + 'color:#888;" title="点击签到">' + SP3 + "Agent：获取中</span>";
    }

    const START_FAIL = ["未登录", "无CSRF"];
    function progressText() {
        const g = function (v) { return '<span style="color:#888;">/' + v + "</span>"; };
        if (running) {
            const goal = plan.topics ? g(plan.topics) : "";
            const goalR = plan.replies ? g(plan.replies) : "";
            const goalL = plan.likes ? g(plan.likes) : "";
            return "刷帖中：主题 " + sent.topics + goal + " 丨 回复 " + sent.replies + goalR + " 丨 点赞 " + sent.likes + goalL;
        }
        return "脚本结束：主题 " + sent.topics + " 丨 回复 " + sent.replies + " 丨 点赞 " + sent.likes;
    }

    const ERR_MAXLEN = 22;
    function collectErrors() {
        const list = [];

        if (arState === "fail") list.push({ t: "Agent：" + (arText || "签到失败"), full: arText || "签到失败" });
        if (ldc.state === "fail") list.push({ t: "LDC：" + (ldc.msg || "读取失败"), full: ldc.msg || "读取失败" });
        else if (ldc.state === "mismatch") list.push({ t: "LDC：账号不符", full: ldc.msg || "论坛账号与 Credit 账号不同" });
        if (getAnyBan(me.username)) list.push({ t: "any：已被封禁", full: "AnyRouter 账号已被封禁" });
        if (!isLowTL() && !readTL3() && (syncState === "cf" || syncState === "err" || syncState === "empty" || syncState === "nogrant" || syncState === "otheruser" || syncState === "popupblock")) {
            list.push({ t: "等级同步失败", full: "connect 等级进度同步失败（syncState=" + syncState + "）" });
        }
        if (isLowTL() && summaryState === "fail") list.push({ t: "摘要读取失败", full: "summary.json 读取失败" });
        return list;
    }
    function errorLine() {
        const list = collectErrors();
        if (!list.length) return "";
        const joined = list.map(function (x) { return x.t; }).join(" / ");

        const full = list.map(function (x) {
            return (x.full && x.t.indexOf(x.full) < 0) ? x.t + "（" + x.full + "）" : x.t;
        }).join("\n");
        const shown = joined.length > ERR_MAXLEN ? joined.slice(0, ERR_MAXLEN) + "…" : joined;
        return '<span style="color:#ff8a8a;" title="' + esc(full) + '">' + esc(shown) + "</span>";
    }
    function render() {
        const r1 = document.getElementById("ldh_r1"); if (!r1) return;
        const M = MODES[activeMode];
        const timer = running && M ? "⏱ " + mmss(Math.min(elapsed(), totalMs(M))) : frozenTimer;

        const nameHtml = me.username ? esc(me.username) : '<span style="color:#ff8a8a;">未登录</span>';
        if (running) {
            let t = document.getElementById("ldh_timer");
            if (t) { t.textContent = timer; }
            else {
                r1.innerHTML = nameHtml + tlBadge() + ldcSpan() + arSpan() +
                    '<span id="ldh_timer" style="float:right;color:#8fe0b0;margin-left:8px;">' + timer + "</span>";
            }
        } else {
            r1.innerHTML = nameHtml + tlBadge() + ldcSpan() + arSpan() +
                '<span id="ldh_timer" style="float:right;color:#8fe0b0;margin-left:8px;">' + timer + "</span>";

            if (getNoOauth(me.username)) r1.setAttribute("data-nooauth", "1");
            else r1.removeAttribute("data-nooauth");

            const bindLdc = document.getElementById("ldh_ldc");
            if (bindLdc) bindLdc.addEventListener("click", function () { refreshCredit(true); });
            const bindAr = document.getElementById("ldh_arbal");
            if (bindAr) bindAr.addEventListener("click", function () {

                runArCheckin(arState !== "pending");
            });
        }

        if (!running) {
            const rows = rowsForPanel();
            document.getElementById("ldh_r2").innerHTML = rows[0];
            document.getElementById("ldh_r3").innerHTML = rows[1];
        }

        const r4 = document.getElementById("ldh_r4");
        r4.title = endNote || "";
        const notice = document.getElementById("ldh_notice");
        if (notice) { notice.textContent = endNote; notice.hidden = !endNote; }
        if (running || finishedOnce) {

            const showNote = !running && endNote && START_FAIL.indexOf(endNote) >= 0;
            const note = showNote ? ' <span style="color:#ff8a8a;">·' + esc(endNote) + "</span>" : "";
            r4.innerHTML = progressText() + note;
        } else if (banMsg) {
            r4.innerHTML = '<span style="color:#ff8a8a;">' + esc(banMsg) + "</span>";
        } else {

            r4.innerHTML = errorLine();
        }

        if (running) return;

        const sy = document.getElementById("ldh_sync");
        if (sy) {
            if (isLowTL()) {
                sy.textContent = summaryState === "loading" ? "读取中…" : summary ? "✓摘要" : "⟳摘要";
                sy.style.color = summaryState === "fail" ? "#ff8a8a" : "#8fe0b0";
            } else {
                const failed = (syncState === "cf" || syncState === "err" || syncState === "empty" || syncState === "login" || syncState === "nogrant" || syncState === "otheruser" || syncState === "popupblock");
                const hasData = !!readTL3();
                sy.textContent = (syncState === "syncing" || syncState === "opening") ? "同步中…" : (failed && !hasData) ? "⟳重试" : (syncState === "ok" || hasData) ? "✓已同步" : "⟳同步";
                sy.style.color = (failed && !hasData) ? "#ff8a8a" : "#8fe0b0";
            }
        }

        const nb = document.getElementById("ldh_any");
        if (nb) {
            const ban = getAnyBan(me.username);
            if (ban) { nb.textContent = "Any!"; nb.style.background = "#b42318"; nb.title = "AnyRouter：" + ban.message + "\n点击=清除封禁标记并重试登录"; }
            else { nb.textContent = "Any"; nb.style.background = anyState === "running" ? "#a07d2a" : "#666"; nb.title = "AnyRouter"; }
        }
    }
    function markButtons(mode) {
        MODE_KEYS.forEach(function (m) {
            const b = document.getElementById("ldh_" + m); if (!b) return;
            if (m === mode) { b.textContent = "停止"; b.style.background = "#8a3a3a"; b.disabled = false; b.style.opacity = "1"; }
            else { b.disabled = true; b.style.opacity = "0.5"; }
        });
    }
    function restoreButtons() {
        MODE_KEYS.forEach(function (m) {
            const b = document.getElementById("ldh_" + m); if (!b) return;
            b.textContent = MODES[m].name; b.disabled = false; b.style.opacity = "1"; b.style.background = MODES[m].color;
        });
    }

    let manualMin = false, composerMin = false;
    const PANEL_DEF = { left: "16px", bottom: "18px" };
    function resetPos(p) {
        if (!p) return;
        try { sessionStorage.removeItem("ldh_pos"); } catch (_) {}
        p.style.left = PANEL_DEF.left;
        p.style.top = "auto";
        p.style.bottom = PANEL_DEF.bottom;
    }

    function applyMin() {
        const body = document.getElementById("ldh_body"), ic = document.getElementById("ldh_min"), p = document.getElementById("ldh_panel");
        const collapsed = manualMin || composerMin;
        if (body) body.style.display = collapsed ? "none" : "block";
        if (ic) ic.textContent = collapsed ? "＋" : "－";
        if (p) {
            if (composerMin) {
                p.style.transform = "none";
                const r = p.getBoundingClientRect();
                const shift = Math.max(0, Math.min(UI.COMPOSER_SHIFT, window.innerWidth - r.right - 4));
                p.style.transform = "translateX(" + shift + "px)";
            } else { p.style.transform = "none"; }
        }
    }
    function toggleMin() { manualMin = !manualMin; try { sessionStorage.setItem("ldh_min", manualMin ? "1" : "0"); } catch (_) {} applyMin(); }
    function savePos(p) { try { sessionStorage.setItem("ldh_pos", JSON.stringify({ left: p.style.left, bottom: p.style.bottom })); } catch (_) {} }
    function restorePos(p) {
        try {
            const q = JSON.parse(sessionStorage.getItem("ldh_pos") || "null");
            if (!q || !q.left || !q.bottom) return;
            const L = parseFloat(q.left), B = parseFloat(q.bottom);
            if (!isFinite(L) || !isFinite(B) || L < 0 || B < 0 ||
                L > window.innerWidth - 60 || B > window.innerHeight - 24) { resetPos(p); return; }
            p.style.left = q.left; p.style.bottom = q.bottom; p.style.top = "auto";
        } catch (_) { resetPos(p); }
    }
    function enableDrag(p, handle) {
        let armed = false, dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        const THRESH = 3;
        handle.addEventListener("mousedown", function (e) {
            if (e.target.closest("button") || e.target.closest("a")) return;
            if (e.target.closest("#ldh_sync") || e.target.closest("#ldh_min")) return;
            if (e.button !== 0) return;
            const r = p.getBoundingClientRect();
            ox = r.left;
            oy = window.innerHeight - r.bottom;
            sx = e.clientX; sy = e.clientY;
            armed = true; dragging = false;
        });
        document.addEventListener("mousemove", function (e) {
            if (!armed) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!dragging) { if (Math.abs(dx) < THRESH && Math.abs(dy) < THRESH) return; dragging = true; }
            let nx = ox + dx, nb = oy - dy;
            nx = Math.max(0, Math.min(window.innerWidth - 60, nx));
            nb = Math.max(0, Math.min(window.innerHeight - 24, nb));
            p.style.left = nx + "px";
            p.style.bottom = nb + "px";
        });
        document.addEventListener("mouseup", function () {
            if (armed && dragging) savePos(p);
            armed = false; dragging = false;
        });
    }
    function composerOpen() {
        const root = document.querySelector("#reply-control");
        return !!root && root.classList.contains("open") && (root.classList.contains("composer-action-create-topic") || root.classList.contains("composer-action-reply"));
    }

    let composerMo = null, composerTimer = null;
    function watchComposer() {
        if (composerMo) return;
        function syncC() { const open = composerOpen(); if (open !== composerMin) { composerMin = open; applyMin(); } }
        composerMo = new MutationObserver(function () {
            if (composerTimer) return;
            composerTimer = setTimeout(function () { composerTimer = null; syncC(); }, 150);
        });
        try { composerMo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] }); } catch (_) {}
        syncC();
    }
    function stopWatchComposer() {
        if (composerMo) { try { composerMo.disconnect(); } catch (_) {} composerMo = null; }
        if (composerTimer) { clearTimeout(composerTimer); composerTimer = null; }
    }

    let idleSuspended = false;
    function suspendIdleWork() {
        idleSuspended = true;
        stopWatchComposer();
        if (composerMin) { composerMin = false; applyMin(); }
    }
    function resumeIdleWork() {
        idleSuspended = false;
        watchComposer();
    }

    const INVITE = {
        TIMEOUT_MS: 20000,
        URL_RE: /^https:\/\/linux\.do\/invites\/[A-Za-z0-9_-]+(?:[/?#].*)?$/i,
        NOT_LOGIN: "尚未登录 Linux.do，请登录后再试。",
        NO_PERM: "无邀请权限，当前账号不能获取邀请链接。"
    };

    const LDH_TOAST_ID = "ldh_toast";
    let inviteBusy = false, ldhToastTimer = null;

    function ldhToast(msg, type, sticky) {
        let box = document.getElementById(LDH_TOAST_ID);
        if (!box) {
            box = document.createElement("div");
            box.id = LDH_TOAST_ID;
            box.addEventListener("click", function () { ldhToastHide(); });
            document.body.appendChild(box);
        }
        const bg = type === "error" ? "#c62828" : type === "info" ? "#4a5568" : "#16883d";
        box.style.cssText = "position:fixed;left:50%;bottom:76px;z-index:2147483647;transform:translateX(-50%);" +
            "box-sizing:border-box;width:max-content;max-width:min(780px,calc(100vw - 32px));" +
            "padding:11px 16px;border-radius:8px;color:#fff;background:" + bg + ";" +
            "box-shadow:0 4px 18px rgba(0,0,0,.28);font-size:14px;line-height:1.55;" +
            "text-align:center;overflow-wrap:anywhere;cursor:pointer;";
        box.textContent = msg;
        box.hidden = false;
        if (ldhToastTimer) { clearTimeout(ldhToastTimer); ldhToastTimer = null; }
        if (!sticky) ldhToastTimer = setTimeout(ldhToastHide, type === "error" ? 15000 : 9000);
    }
    function ldhToastHide() {
        if (ldhToastTimer) { clearTimeout(ldhToastTimer); ldhToastTimer = null; }
        const box = document.getElementById(LDH_TOAST_ID);
        if (box) box.hidden = true;
    }

    function inviteFetch(url, options) {
        return fetchTimed(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, options || {}))
            .catch(function (e) { throw new Error(/超时/.test(e.message || "") ? "请求超时，请检查网络后重试。" : "网络错误，请检查网络后重试。"); });
    }
    async function inviteRead(resp) {
        let text = "";
        try { text = await resp.text(); } catch (_) {}
        let data = null;
        try { data = JSON.parse(text); } catch (_) {}
        return { data: data, text: text };
    }

    function inviteErrMsg(data, text, status) {
        const cands = (Array.isArray(data && data.errors) ? data.errors : [])
            .concat([data && data.error, data && data.message, data && data.failed, data && data.exception]);
        for (let i = 0; i < cands.length; i++) {
            const s = String(cands[i] == null ? "" : cands[i]).replace(/\s+/g, " ").trim();
            if (s) return s;
        }
        const plain = String(text || "").replace(/\s+/g, " ").trim();
        if (plain && plain.charAt(0) !== "<") return plain.slice(0, 300);
        if (status === 401) return INVITE.NOT_LOGIN;
        if (status === 403 || status === 404) return INVITE.NO_PERM;
        return "Linux.do 请求失败（HTTP " + status + "）。";
    }
    function inviteUrlOf(v) {
        const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
        return INVITE.URL_RE.test(s) ? s : "";
    }

    async function inviteCurrentUser() {
        const r = await inviteFetch("/session/current.json", {
            headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" }
        });
        if (r.status === 401 || r.status === 404) throw new Error(INVITE.NOT_LOGIN);
        const rd = await inviteRead(r);
        if (!r.ok) throw new Error(inviteErrMsg(rd.data, rd.text, r.status));
        const u = (rd.data && (rd.data.current_user || rd.data.currentUser)) || null;
        const name = String((u && (u.username_lower || u.username)) || "").trim().toLowerCase();
        if (!name) throw new Error(INVITE.NOT_LOGIN);
        return { username: name, staff: !!(u && u.staff) };
    }

    function invitePickPending(list) {
        if (!Array.isArray(list)) return "";
        for (let i = 0; i < list.length; i++) {
            const it = list[i], link = inviteUrlOf(it && it.link);
            if (!link) continue;
            if (it.expired || it.revoked || it.invalidated_at || it.revoked_at) continue;
            const expires = it.expires_at ? Date.parse(it.expires_at) : null;
            if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) continue;
            const used = Number(it.redemption_count == null ? 0 : it.redemption_count);
            const max = Number(it.max_redemptions_allowed == null ? 1 : it.max_redemptions_allowed);
            if (Number.isFinite(used) && Number.isFinite(max) && used >= 0 && used < max) return link;
        }
        return "";
    }
    async function invitePending(username) {
        const url = "/u/" + encodeURIComponent(username) + "/invited.json?filter=pending&offset=0";
        const r = await inviteFetch(url, {
            headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" }
        });

        if (r.status === 403 || r.status === 404) throw new Error(INVITE.NO_PERM);
        const rd = await inviteRead(r);
        if (!r.ok) throw new Error(inviteErrMsg(rd.data, rd.text, r.status));
        return Array.isArray(rd.data && rd.data.invites) ? rd.data.invites : [];
    }

    function invitePad2(n) { return String(n).padStart(2, "0"); }

    function inviteExpiresAt(days) {
        const d = new Date(Date.now() + days * 24 * 3600 * 1000);
        const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", abs = Math.abs(off);
        return d.getFullYear() + "-" + invitePad2(d.getMonth() + 1) + "-" + invitePad2(d.getDate()) + " " +
            invitePad2(d.getHours()) + ":" + invitePad2(d.getMinutes()) +
            sign + invitePad2(Math.floor(abs / 60)) + ":" + invitePad2(abs % 60);
    }

    function inviteSiteSettings() {
        try {
            const el = document.querySelector("#data-preloaded");
            const pre = el ? JSON.parse(el.getAttribute("data-preloaded") || el.textContent || "") : null;
            const s = pre && pre.siteSettings;
            return (typeof s === "string" ? JSON.parse(s) : s) || {};
        } catch (_) { return {}; }
    }
    async function inviteCreate(user) {

        const token = await getCsrf();
        if (!token) throw new Error("没有读取到 CSRF Token，请刷新页面后重试。");

        const s = inviteSiteSettings();
        const days = Math.max(1, Number(s.invite_expiry_days) || 1);
        const limit = Number(user.staff ? s.invite_link_max_redemptions_limit : s.invite_link_max_redemptions_limit_users);
        const maxRedemptions = (isFinite(limit) && limit > 0) ? Math.min(limit, user.staff ? 100 : 10) : 1;

        const body = new URLSearchParams();
        body.set("max_redemptions_allowed", String(maxRedemptions));
        body.set("expires_at", inviteExpiresAt(days));
        body.set("skip_email", "true");
        body.set("domain", "");

        const r = await inviteFetch("/invites", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-CSRF-Token": token,
                "X-Requested-With": "XMLHttpRequest"
            },
            body: body.toString()
        });
        const rd = await inviteRead(r);

        if (!r.ok) throw new Error(inviteErrMsg(rd.data, rd.text, r.status));

        const direct = inviteUrlOf(rd.data && rd.data.link);
        if (direct) return direct;

        const back = invitePickPending(await invitePending(user.username));
        if (back) return back;
        throw new Error("邀请已提交，但响应里没有完整邀请链接。");
    }

    async function inviteCopy(text) {
        if (typeof GM_setClipboard === "function") {
            try { GM_setClipboard(text, "text"); return; } catch (_) {}
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try { await navigator.clipboard.writeText(text); return; } catch (_) {}
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:0;";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
        ta.remove();
        if (!ok) throw new Error("浏览器拒绝写入剪贴板");
    }

    async function runInvite(btn) {
        if (inviteBusy) return;
        inviteBusy = true;
        if (btn) { btn.disabled = true; btn.style.opacity = "0.5"; btn.style.cursor = "wait"; }
        ldhToast("正在获取邀请链接…", "info");
        try {
            const user = await inviteCurrentUser();
            let link = invitePickPending(await invitePending(user.username));
            let created = false;
            if (!link) {

                ldhToast("没有找到未使用的待处理邀请，正在检查生成资格和冷却时间…", "info");
                link = await inviteCreate(user);
                created = true;
            }

            try {
                await inviteCopy(link);
                const head = created ? "已生成新的邀请链接" : "已提取未使用的待处理邀请";
                ldhToast(head + "，并已复制到剪贴板：" + link, "success");
            } catch (ce) {
                ldhToast("复制到剪贴板失败，请手动复制：" + link + "（点击关闭）", "error", true);
                console.error("[LDH] 邀请：复制失败", ce);
            }
        } catch (e) {
            const msg = String((e && e.message) || e || "").replace(/\s+/g, " ").trim();
            ldhToast(msg || "获取邀请链接失败。", "error");
            console.error("[LDH] 邀请", e);
        } finally {
            inviteBusy = false;
            if (btn) { btn.disabled = false; btn.style.opacity = "1"; btn.style.cursor = "pointer"; }
        }
    }

    let forumUserJob = null;
    function refreshForumUser(force) {
        if (forumUserJob) return force ? forumUserJob.then(function () { return refreshForumUser(); }) : forumUserJob;
        forumUserJob = getUser().then(function (u) {
            const oldUser = currentLdUser(), user = normUser(u.username);
            if (normUser(me.username) !== user) {
                summary = null; summaryState = "idle"; syncState = "idle";
                _tl3Cache = { key: "", at: 0, v: null };
                ldc = { state: "idle", value: "", msg: "" };
                arState = "idle"; arText = ""; arBal = "";
            }
            me = u;
            if (!user) { render(); return; }
            if (oldUser && oldUser !== user) {
                [AR.DAYKEY, AR.REWARDKEY, AR.NOTEKEY, AR.UIDKEY, AR.BALKEY, AR.BALDAY, AR.SIDEKEY, AR.FLOW, AR.AUTOKEY].forEach(gmDel);
            }
            gmSet(LD_USER_KEY, user);
            const saved = loadArNote();
            if (saved && arState !== "running") { arState = saved.state; arText = saved.text; arBal = saved.bal; }
            render();
            if (isLowTL()) loadSummary(false);
            else {
                const cached = readTL3();
                if (!cached || Date.now() - Number(cached.at || 0) > SYNC_THROTTLE_MS) sync();
            }
            setTimeout(function () {
                if (normUser(me.username) !== user || isLoginView()) return;
                refreshCredit(false).catch(function () {}).then(function () {
                    if (normUser(me.username) === user && !isLoginView()) return runArCheckin(false);
                }).catch(function () {});
            }, 1200);
        }).finally(function () { forumUserJob = null; });
        return forumUserJob;
    }

    function createUI() {
        if (document.getElementById("ldh_panel")) return;
        const p = document.createElement("div"); p.id = "ldh_panel";

        p.style.cssText = "position:fixed;bottom:18px;left:16px;z-index:999999;background:rgba(18,18,18,0.86);color:#fff;" +
            "padding:2px " + UI.PAD_X + "px 9px " + UI.PAD_X + "px;border-radius:9px;width:" + UI.WIDTH + "px;box-sizing:border-box;" +
            "max-width:calc(100vw - 32px);" +
            "font-size:10px;line-height:14px;box-shadow:0 6px 16px rgba(0,0,0,0.4);overflow:visible;";
        const rowCss = "white-space:normal;overflow-wrap:anywhere;min-height:14px;";
        const btnCss = "flex:1;padding:8px 2px;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:11px;white-space:nowrap;";
        const smallBtnCss = "padding:3px 5px;border:none;border-radius:4px;cursor:pointer;font-size:9px;margin-left:4px;white-space:nowrap;flex-shrink:0;";
        p.innerHTML =
            '<div id="ldh_title" style="display:flex;flex-wrap:wrap;gap:2px 4px;justify-content:space-between;align-items:center;cursor:move;min-height:20px;padding:4px 0 0 0;line-height:1.6;overflow:visible;">' +
            '<span style="font-weight:bold;font-size:10px;white-space:nowrap;flex-shrink:0;">⚡ LINUX DO 助手</span>' +
            '<span style="display:flex;align-items:center;white-space:nowrap;flex-shrink:0;">' +

            '<button id="ldh_invite" style="' + smallBtnCss + 'background:#1677ff;color:#fff;" title="查询未使用的待处理邀请；没有就直接创建，并复制完整链接">邀请</button>' +
            '<button id="ldh_any" style="' + smallBtnCss + 'background:#666;color:#fff;" title="AnyRouter">Any</button>' +
            '<span id="ldh_sync" style="cursor:pointer;font-size:9px;color:#8fe0b0;margin-left:6px;" title="同步等级进度">⟳同步</span>' +
            '<span id="ldh_min" style="cursor:pointer;margin-left:6px;font-size:12px;color:#ccc;">－</span>' +
            '</span>' +
            '</div>' +
            '<div id="ldh_body">' +
            '<div style="display:flex;gap:5px;margin:3px 0 7px 0;">' +
            '<button id="ldh_daily" style="' + btnCss + 'background:' + MODES.daily.color + ';">日常维护</button>' +
            '<button id="ldh_fast"  style="' + btnCss + 'background:' + MODES.fast.color + ';">快速升级</button>' +
            '<button id="ldh_idle"  style="' + btnCss + 'background:' + MODES.idle.color + ';">日常挂机</button>' +
            '</div>' +

            '<div id="ldh_r1" style="' + rowCss + 'font-size:9px;"></div>' +
            '<div id="ldh_r2" style="' + rowCss + 'font-size:9px;"></div>' +
            '<div id="ldh_r3" style="' + rowCss + 'font-size:9px;"></div>' +
            '<div id="ldh_r4" style="' + rowCss + 'margin-top:2px;font-size:9px;"></div>' +
            '<div id="ldh_notice" role="status" hidden style="font-size:10px;line-height:1.4;color:#ffb4ab;overflow-wrap:anywhere;margin-top:3px;"></div>' +
            '</div>';
        document.body.appendChild(p);
        MODE_KEYS.forEach(function (m) { document.getElementById("ldh_" + m).addEventListener("click", function () { startMode(m); }); });
        document.getElementById("ldh_sync").addEventListener("click", function () {

            if (getNoOauth(me.username)) retryOauth();
            sync();
        });
        document.getElementById("ldh_min").addEventListener("click", function () { toggleMin(); });
        document.getElementById("ldh_invite").addEventListener("click", function () { runInvite(this); });
        document.getElementById("ldh_any").addEventListener("click", function () {

            if (getNoOauth(me.username)) {
                ldhToast(NO_OAUTH_MSG + "，AnyRouter 登录必然被拒。点 ⟳ 可强制重试一次。", "error");
                return;
            }

            if (getAnyBan(me.username)) clearAnyBan(me.username);
            anyState = "running"; render(); anyOpenTab();
            setTimeout(function () { anyState = "idle"; render(); }, 3000);
        });
        enableDrag(p, document.getElementById("ldh_title"));
        restorePos(p);
        let rzTimer = null;
        window.addEventListener("resize", function () {
            if (rzTimer) clearTimeout(rzTimer);
            rzTimer = setTimeout(function () { rzTimer = null; resetPos(p); applyMin(); }, 200);
        });
        try { manualMin = sessionStorage.getItem("ldh_min") === "1"; } catch (_) {}
        applyMin();
        watchComposer();

        render();
        window.addEventListener("beforeunload", function (e) { if (running) { e.preventDefault(); e.returnValue = ""; return ""; } });
        refreshForumUser();

        window.addEventListener("focus", pullSideBalance);
        document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") pullSideBalance(); });
    }

    // 登录助手：保持文件实际行号，空行不重排。
    function loginLineNumber(value) {
        const text = String(value == null ? "" : value).trim();
        const n = Number(text);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < 1) {
            throw new Error("请输入大于 0 的整数行号，例如 1。");
        }
        return n;
    }

    function loginCredentials(line) {
        const value = String(line || "").replace(/^\uFEFF/, "").trim();

        const match = value.match(/^([^\s+]+)(?:[ \t]+([^\r\n]+)|\+([^\r\n]+))$/);
        if (!match || /[\r\n\u0000]/.test(value) || /^(?:#|\/\/)/.test(value)) {
            throw new Error("格式应为：用户名 密码，或用户名+密码；一次只能填写一行。");
        }
        const username = stripAt(match[1]), password = (match[2] || match[3] || "").trim();
        if (!/^[A-Za-z0-9_.@-]+$/.test(username) || !password) throw new Error("账号或密码格式不正确。");
        return { username: username, password: password };
    }

    function accountFileLines(text) {
        text = String(text || "").replace(/^\uFEFF/, "");
        if (!text.trim()) throw new Error("账号文件为空。");
        if (/^\s*[<{\[]/.test(text)) throw new Error("获取到的不是账号文本，请检查私库文件内容。");
        if (text.length > 2 * 1024 * 1024) throw new Error("账号文件过大，请使用小于 2 MB 的文本文件。");
        const lines = text.split(/\r\n|\n|\r/);

        if (lines[lines.length - 1] === "") lines.pop();
        return lines;
    }

    function loginAccountAt(text, number) {
        number = loginLineNumber(number);
        const lines = accountFileLines(text);
        if (number > lines.length) throw new Error("行号超出范围，文件共有 " + lines.length + " 行。");
        if (!lines[number - 1].trim()) throw new Error("第 " + number + " 行为空，请换一个行号。");
        try { return loginCredentials(lines[number - 1]); }
        catch (_) { throw new Error("第 " + number + " 行格式不正确，应为：用户名 密码，或用户名+密码。"); }
    }

    function githubToken(edit) {
        const saved = String(gmGet(GITHUB_TOKEN_KEY, "") || "").trim();
        if (saved && !edit && !/\s/.test(saved)) return saved;
        const input = window.prompt("请输入 GitHub 个人访问令牌（只需填写一次）。\n令牌保存在当前浏览器的油猴存储中，不写入脚本。\n请授予 Personal-Backup 仓库的 Contents 读取权限。", "");
        if (input === null) return "";
        const token = input.trim();
        if (!token || /\s/.test(token)) throw new Error("令牌不能为空，也不能包含空格或换行，请粘贴完整令牌。");
        try {
            GM_setValue(GITHUB_TOKEN_KEY, token);
            if (gmGet(GITHUB_TOKEN_KEY, "") !== token) throw new Error();
        } catch (_) { throw new Error("令牌保存失败，请检查油猴的存储权限后重试。"); }
        return token;
    }

    function initGithubTokenMenu() {
        if (typeof GM_registerMenuCommand !== "function") return;
        GM_registerMenuCommand("设置 / 更换 GitHub 令牌", function () {
            try {
                if (githubToken(true)) window.alert("令牌已保存。下次读取账号或点赞名单时自动使用，无需修改脚本。");
            } catch (e) { window.alert(e.message); }
        });
    }

    function loginReadAccounts(signal) {
        return new Promise(function (resolve, reject) {
            if (signal && signal.aborted) { reject(new DOMException("请求已取消", "AbortError")); return; }
            if (typeof GM_xmlhttpRequest !== "function") {
                reject(new Error("缺少跨域请求权限，请在脚本管理器中更新完整脚本。")); return;
            }
            let token;
            try { token = githubToken(false); }
            catch (e) { reject(e); return; }
            if (!token) { reject(new Error("未设置 GitHub 令牌，已取消读取。再次执行操作时可重新输入。")); return; }
            let handle = null, done = false;
            function settle(error, value) {
                if (done) return;
                done = true;
                if (signal) signal.removeEventListener("abort", cancel);
                if (error) reject(error); else resolve(value);
            }
            function cancel() {
                if (done) return;
                settle(new DOMException("请求已取消", "AbortError"));
                try { if (handle) handle.abort(); } catch (_) {}
            }
            if (signal && signal.aborted) { cancel(); return; }
            if (signal) signal.addEventListener("abort", cancel, { once: true });
            try { handle = GM_xmlhttpRequest({
                method: "GET",
                url: ACCOUNTS_API + "&_ldh=" + Date.now(),
                headers: { "Accept": "application/vnd.github.raw+json", "Authorization": "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" },
                anonymous: true,
                redirect: "error",
                timeout: 20000,
                onload: function (r) {
                    if (done) return;
                    let error = "";
                    if (r.status === 401) {
                        if (String(gmGet(GITHUB_TOKEN_KEY, "") || "").trim() === token) gmDel(GITHUB_TOKEN_KEY);
                        error = "GitHub 令牌无效、已过期或已撤销。请再次执行操作以重新输入，或通过油猴菜单更换令牌。";
                    }
                    else if (r.status === 429 || (r.status === 403 && /^x-ratelimit-remaining:\s*0\s*$/im.test(r.responseHeaders || ""))) error = "GitHub 请求频率受限，请稍后重试。";
                    else if (r.status === 403) error = "令牌没有读取权限，请授予 Personal-Backup 仓库的 Contents 读取权限。";
                    else if (r.status === 404) error = "找不到私库文件，请检查仓库、main 分支、文件路径及令牌授权范围。";
                    if (r.status < 200 || r.status >= 300) {
                        settle(new Error(error || "获取账号文件失败（HTTP " + r.status + "）。")); return;
                    }
                    try {
                        const final = new URL(r.finalUrl || ACCOUNTS_API), expected = new URL(ACCOUNTS_API);
                        if (final.origin !== expected.origin || final.pathname !== expected.pathname) throw new Error("账号请求发生了意外跳转，请检查网络。");
                        if (/^content-type:\s*text\/html\b/im.test(r.responseHeaders || "")) throw new Error("获取到的是网页，请稍后重试。");
                        const text = String(r.responseText || "");
                        accountFileLines(text);
                        settle(null, text);
                    } catch (e) {
                        settle(new Error(e.message || "账号文件读取失败。"));
                    }
                },
                onerror: function () { settle(new Error("读取私库失败，请检查网络及 api.github.com 跨域权限。")); },
                ontimeout: function () { settle(new Error("获取账号文件超时，请重试。")); },
                onabort: cancel
            }); } catch (_) { settle(new Error("无法发起私库请求，请检查脚本管理器的跨域权限。")); }
        });
    }

    function hcaptchaFrame() {
        const params = new URLSearchParams(location.hash.slice(1));
        if (window.parent === window || params.get("host") !== "linux.do" || params.get("frame") !== "checkbox") return;
        let activeId = "", handledId = "", automatic = false;
        function report(state) {
            try { window.parent.postMessage({ type: HC.message, id: activeId, state: state }, "https://linux.do"); } catch (_) {}
        }
        function handled(state) { handledId = activeId; report(state); }
        document.addEventListener("click", function (e) {
            if (!activeId || activeId === handledId || automatic || !(e.target instanceof Element)) return;
            if (e.target.closest("#anchor") && !e.target.closest('a,[class*="logo"],[class*="link"]')) handled("manual");
        }, true);
        window.addEventListener("message", function (e) {
            const data = e.data;
            if (e.source !== window.parent || e.origin !== "https://linux.do" || !data || data.type !== HC.message ||
                typeof data.id !== "string" || !data.id || data.id.length > 100) return;
            if (data.action === "cancel") { if (activeId === data.id) activeId = ""; return; }
            if (data.action !== "click") return;
            activeId = data.id;
            if (handledId === activeId) { report("handled"); return; }
            const box = document.querySelector('#checkbox[role="checkbox"]');
            if (!box) return;
            if (box.getAttribute("aria-checked") === "true") { handled("checked"); return; }
            if (box.tabIndex < 0 && !box.hasAttribute("disabled")) { handled("busy"); return; }
            const style = window.getComputedStyle(box);
            if (document.visibilityState === "hidden" || !box.getClientRects().length || box.tabIndex !== 0 ||
                box.getAttribute("aria-checked") !== "false" || box.matches('[disabled],[aria-disabled="true"]') ||
                style.visibility !== "visible" || style.opacity === "0") return;
            automatic = true;
            try { box.click(); handled("clicked"); } finally { automatic = false; }
        });
    }

    function loginFields() {
        const username = document.querySelector("#login-account-name");
        const password = document.querySelector("#login-account-password");
        return username && password ? { username: username, password: password } : null;
    }

    function isLoginView() {
        if (/^\/login(?:\/|$)/.test(location.pathname)) return true;

        const fields = loginFields();
        return !!(fields && fields.username.getClientRects().length && fields.password.getClientRects().length);
    }

    function waitForLoginFields(isCurrent) {
        return new Promise(function (resolve, reject) {
            const started = Date.now();
            function check() {
                if (!isCurrent()) { resolve(null); return; }
                const fields = loginFields();
                if (fields && !fields.username.matches(":disabled") && !fields.password.matches(":disabled") &&
                    !fields.username.readOnly && !fields.password.readOnly) { resolve(fields); return; }
                if (Date.now() - started >= 10000) {
                    reject(new Error("没有找到可填写的账号/密码输入框，请等登录表单加载后重试。")); return;
                }
                setTimeout(check, 100);
            }
            check();
        });
    }

    function fillLoginFields(fields, account) {

        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        [[fields.username, account.username], [fields.password, account.password]].forEach(function (pair) {
            setter.call(pair[0], pair[1]);
            pair[0].dispatchEvent(new Event("input", { bubbles: true }));
            pair[0].dispatchEvent(new Event("change", { bubbles: true }));
        });
        fields.password.focus({ preventScroll: true });
    }

    async function submitLogin(fields, account, isCurrent) {
        const started = Date.now();
        // 留时间让页面接收 input/change，随后等待登录按钮可用。
        await sleep(150);
        while (isCurrent()) {
            if (!fields.username.isConnected || !fields.password.isConnected ||
                fields.username.value !== account.username || fields.password.value !== account.password) {
                throw new Error("登录表单已变化，已取消自动提交，请确认账号后重试。");
            }
            const button = document.querySelector("#login-button");
            if (button && button.getClientRects().length &&
                !button.matches(':disabled,[aria-disabled="true"],[aria-busy="true"]')) {
                button.click();
                return "submitted";
            }
            if (Date.now() - started >= 10000) return "blocked";
            await sleep(100);
        }
        return "cancelled";
    }

    function initLoginPage() {
        let panel = null, root = null, busy = false, generation = 0, active = false, request = null;
        let mainCreated = false, hiddenMain = null, mainDisplay = "", scheduled = null;
        let captchaJob = null, captchaLoginId = 0, captchaNote = "";
        let focusCleanup = null;
        const captchaDialogSelector = '.d-modal__container,.modal-inner-container,[role="dialog"],dialog,.modal';

        function focusLoginLine() {
            if (focusCleanup) focusCleanup();
            if (!/^\/login\/?$/.test(location.pathname)) return;
            const field = root.getElementById("ldh_login_line");
            let pending = null, restores = 0;
            function release() {
                clearTimeout(pending); clearTimeout(expiry);
                document.removeEventListener("focusin", regain, true);
                document.removeEventListener("pointerdown", choose, true);
                document.removeEventListener("keydown", choose, true);
                if (focusCleanup === release) focusCleanup = null;
            }
            function focus() {
                pending = null;
                if (!panel.isConnected || busy || !isLoginView() || field.disabled || root.getElementById("ldh_login_body").hidden) { release(); return; }
                field.focus({ preventScroll: true });
            }
            function regain(e) {
                if (e.target.id !== "login-account-name" || pending !== null) return;
                if (++restores > 3) { release(); return; }
                pending = setTimeout(focus, 0);
            }
            function choose(e) {
                if (!e.composedPath().includes(field) || e.key === "Tab" || e.key === "Escape") release();
            }
            const expiry = setTimeout(release, 5000);
            focusCleanup = release;
            document.addEventListener("focusin", regain, true);
            document.addEventListener("pointerdown", choose, true);
            document.addEventListener("keydown", choose, true);
            focus();
        }

        function sendCaptcha(frame, action, id) {
            try { if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: HC.message, action: action, id: id }, HC.origin); } catch (_) {}
        }
        function stopCaptcha() {
            if (captchaJob) sendCaptcha(captchaJob.frame, "cancel", captchaJob.id);
            captchaJob = null;
        }
        function stopCaptchaCheckbox() {
            captchaJob.checkboxDone = true;
            sendCaptcha(captchaJob.frame, "cancel", captchaJob.id);
        }
        function captchaVisible(el) {
            if (!el || !el.isConnected || !el.getClientRects().length || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
            for (let node = el; node; node = node.parentElement) {
                const style = window.getComputedStyle(node);
                if (style.display === "none" || style.visibility !== "visible" || style.opacity === "0") return false;
            }
            return true;
        }
        function findCaptchaFrame() {
            return Array.from(document.querySelectorAll("iframe[src]")).find(function (el) {
                try {
                    const url = new URL(el.src), params = new URLSearchParams(url.hash.slice(1));
                    return url.origin === HC.origin && /\/static\/hcaptcha\.html$/.test(url.pathname) &&
                        params.get("host") === "linux.do" && params.get("frame") === "checkbox" &&
                        captchaVisible(el);
                } catch (_) { return false; }
            });
        }
        function captchaDialog(frame) { return frame && frame.closest(captchaDialogSelector); }
        function isVerifyButton(el) { return /^(?:验证|驗證|verify)$/i.test(String(el.textContent || el.value || el.getAttribute("aria-label") || "").trim()); }
        function pollCaptcha() {
            if (!captchaJob) return;
            const job = captchaJob, fields = loginFields();
            if (!isLoginView() || job.generation !== generation || (job.modal && !captchaVisible(job.modal)) ||
                (job.fields && fields && (fields.username !== job.fields.username || fields.password !== job.fields.password ||
                    fields.username.value !== job.values[0] || fields.password.value !== job.values[1]))) {
                stopCaptcha(); return;
            }
            if (Date.now() >= job.until) {
                stopCaptcha();
                if (job.modal && panel.isConnected) status("自动等待验证已结束，请手动点击网页的「验证」按钮。");
                return;
            }
            if (document.visibilityState === "hidden") return;
            const frame = findCaptchaFrame(), modal = captchaDialog(frame);
            if (modal && modal !== job.initialModal) {
                if (job.modal && job.modal !== modal) { stopCaptcha(); return; }
                job.modal = modal;
            }
            if (frame && frame.contentWindow) {
                if (job.frame && job.frame !== frame) sendCaptcha(job.frame, "cancel", job.id);
                job.frame = frame;
            }
            if (job.modal) {
                const buttons = Array.from(job.modal.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]'))
                    .filter(function (el) { return isVerifyButton(el) && captchaVisible(el); });
                const button = buttons.length === 1 ? buttons[0] : null;
                if (button) {
                    const blocked = button.matches(':disabled,[disabled],[aria-disabled="true"],[aria-busy="true"],.is-loading,.btn-loading') ||
                        window.getComputedStyle(button).pointerEvents === "none";
                    if (blocked) job.sawDisabled = true;
                    const response = job.modal.querySelector('[name="h-captcha-response"]');
                    // 由网站解除禁用，或已有验证通过状态，才提交；不处理图片题里的按钮。
                    if (!blocked && (job.sawDisabled || job.verified || (response && String(response.value || "").trim()))) {
                        stopCaptcha();
                        captchaNote = "已点击网页「验证」，等待登录结果…";
                        status(captchaNote);
                        button.click(); return;
                    }
                }
            }
            if (!job.checkboxDone && Date.now() >= job.checkboxUntil) {
                stopCaptchaCheckbox();
                if (job.frame && panel.isConnected) {
                    captchaNote = "验证码自动点击未确认，请手动勾选「我是真实访客」；完成后自动点击网页「验证」。";
                    status(captchaNote);
                }
            }
            if (!job.checkboxDone && frame && frame.contentWindow) sendCaptcha(frame, "click", job.id);
        }
        function armCaptcha(id) {
            if (captchaLoginId === id) return;
            stopCaptcha(); captchaLoginId = id; captchaNote = "";
            const fields = loginFields(), now = Date.now();
            captchaJob = {
                id: now.toString(36) + Math.random().toString(36).slice(2), generation: id,
                until: now + 300000, checkboxUntil: now + 90000, frame: null, checkboxDone: false,
                modal: null, initialModal: captchaDialog(findCaptchaFrame()), sawDisabled: false, verified: false,
                fields: fields, values: fields && [fields.username.value, fields.password.value]
            };
            setTimeout(pollCaptcha, 0);
        }
        window.addEventListener("message", function (e) {
            const data = e.data;
            if (!captchaJob || captchaJob.checkboxDone || e.origin !== HC.origin || !captchaJob.frame || e.source !== captchaJob.frame.contentWindow ||
                !data || data.type !== HC.message || data.id !== captchaJob.id ||
                ["clicked", "manual", "checked", "handled", "busy"].indexOf(data.state) < 0) return;
            captchaJob.verified = data.state === "checked";
            stopCaptchaCheckbox();
            captchaNote = data.state === "checked" ? "验证框已勾选，等待网页「验证」按钮可用后自动提交。" :
                data.state === "busy" ? "验证码正在处理，请完成可能出现的图片题，完成后自动点击网页「验证」。" :
                "已点击「我是真实访客」。图片题请手动完成，完成后自动点击网页「验证」。";
            if (panel.isConnected && isLoginView()) status(captchaNote);
            schedule();
        });
        function manualCaptchaAction(e) {
            if (!captchaJob || !(e.target instanceof Element)) return;
            const modal = captchaJob.modal || captchaDialog(findCaptchaFrame());
            if (!modal || modal === captchaJob.initialModal || !modal.contains(e.target)) return;
            const button = e.target.closest('button,input[type="submit"],input[type="button"],[role="button"]');
            if (e.type !== "submit" && !button) return;
            stopCaptcha();
            captchaNote = e.type === "submit" || isVerifyButton(button) ? "已手动提交验证，等待登录结果…" : "已停止自动提交验证。";
            if (panel.isConnected && isLoginView()) status(captchaNote);
        }
        document.addEventListener("click", manualCaptchaAction, true);
        document.addEventListener("submit", manualCaptchaAction, true);
        document.addEventListener("keydown", function (e) { if (e.key === "Escape" && captchaJob) stopCaptcha(); }, true);

        function status(message, error) {
            const el = root.getElementById("ldh_login_status");
            el.textContent = message;
            el.style.color = error ? "#ffb4ab" : "#b7e6c5";
        }
        function setBusy(value) {
            if (value && focusCleanup) focusCleanup();
            busy = value;
            ["ldh_login_line", "ldh_login_fetch", "ldh_login_btn"].forEach(function (id) {
                root.getElementById(id).disabled = value;
            });
            root.getElementById("ldh_login_body").setAttribute("aria-busy", String(value));
        }
        function isCurrent(id) { return id === generation && panel.isConnected && isLoginView(); }

        async function run(source) {
            if (busy) return;
            let number;
            if (source === "file") {
                try { number = loginLineNumber(root.getElementById("ldh_login_line").value); }
                catch (e) { status(e.message, true); return; }
            }
            const id = ++generation, initial = loginFields();
            const original = initial && [initial.username.value, initial.password.value];
            let submitted = false;
            stopCaptcha();
            function onSubmit(e) {
                if (!isCurrent(id) || !(e.target instanceof Element)) return;
                const button = e.type === "click" && e.target.closest("#login-button");
                if ((button && !button.matches(':disabled,[aria-disabled="true"]')) ||
                    (e.type === "submit" && e.target.contains(document.querySelector("#login-account-name")))) {
                    submitted = true;
                    armCaptcha(id);
                    if (request) request.abort();
                }
            }
            document.addEventListener("click", onSubmit, true);
            document.addEventListener("submit", onSubmit, true);
            setBusy(true);
            status(source === "file" ? "正在获取第 " + number + " 行…" : "正在读取剪贴板…");
            try {
                let account;
                if (source === "file") {
                    request = new AbortController();
                    account = loginAccountAt(await loginReadAccounts(request.signal), number);
                    request = null;
                } else {
                    let text;
                    try { text = await navigator.clipboard.readText(); }
                    catch (_) { throw new Error("读取剪贴板失败，可改用行号获取，或检查剪贴板权限。"); }
                    account = loginCredentials(text);
                }
                if (!isCurrent(id) || submitted) return;
                status("正在等待登录表单…");
                const fields = await waitForLoginFields(function () { return isCurrent(id) && !submitted; });
                if (!fields || !isCurrent(id) || submitted) return;
                if (initial && (fields.username !== initial.username || fields.password !== initial.password ||
                    fields.username.value !== original[0] || fields.password.value !== original[1])) {
                    throw new Error("等待期间登录表单已变化，已取消填写和提交，请确认账号后重试。");
                }
                fillLoginFields(fields, account);
                armCaptcha(id);
                status("已填写" + (source === "file" ? "第 " + number + " 行，" : "，") + "正在等待登录按钮…");
                const result = await submitLogin(fields, account, function () { return isCurrent(id) && !submitted; });
                if (result === "submitted") submitted = true;
                if (isCurrent(id) && result === "blocked") status("已填写，但登录按钮暂不可用。请完成页面验证后点击网页的登录按钮。");
            } catch (e) {
                if (isCurrent(id) && !submitted) status(e.message || "操作失败，请重试。", true);
            } finally {
                document.removeEventListener("click", onSubmit, true);
                document.removeEventListener("submit", onSubmit, true);
                if (id === generation) {
                    request = null; setBusy(false);
                    if (!submitted) stopCaptcha();
                    if (submitted && isCurrent(id)) status(captchaNote || "已提交登录，等待验证码出现后自动勾选；图片题请手动完成，完成后自动点击网页「验证」。");
                }
            }
        }

        function createPanel() {
            panel = document.createElement("div");
            panel.id = "ldh_login_panel";

            panel.style.cssText = "all:initial;position:fixed!important;left:8px!important;bottom:8px!important;" +
                "z-index:2147483647!important;display:block!important;width:320px!important;" +
                "max-width:calc(100vw - 16px)!important;margin:0!important;padding:0!important;";
            root = panel.attachShadow({ mode: "open" });
            root.innerHTML = '<style>' +
                ':host{color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}' +
                'section{font:13px/1.5 system-ui,sans-serif;color:#fff;background:#202923;border:1px solid #51705b;' +
                'border-radius:10px;box-shadow:0 4px 18px #0005;max-height:calc(100vh - 16px);max-height:calc(100dvh - 16px);overflow:auto;overflow-wrap:anywhere}' +
                'header{position:sticky;top:0;z-index:1;background:#202923;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px}' +
                'strong{font-size:13px;min-width:0}button,input{font:inherit;border-radius:6px;min-width:0}' +
                'button{background:#347b48;color:#fff;border:1px solid #6b9977;padding:6px 10px;cursor:pointer}' +
                'button:disabled,input:disabled{opacity:.55;cursor:wait}button:focus-visible,input:focus-visible{outline:2px solid #b7e6c5;outline-offset:2px}' +
                '#ldh_login_toggle{flex:none;padding:3px 8px;background:transparent}' +
                '#ldh_login_body{padding:0 10px 10px}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
                'input{flex:1 1 52px;width:64px;background:#fff;color:#17241b;border:1px solid #b6c6bb;padding:6px 8px}' +
                '#ldh_login_btn{width:100%;margin-top:8px;background:#384c3e}' +
                '#ldh_login_status{margin:8px 0 0;font-size:12px;color:#b7e6c5}' +
                '</style><section aria-label="LINUX DO 登录助手">' +
                '<header><strong>LINUX DO 登录助手</strong><button id="ldh_login_toggle" type="button" aria-controls="ldh_login_body" aria-expanded="true">收起</button></header>' +
                '<div id="ldh_login_body"><div class="row">' +
                '<label for="ldh_login_line">行号</label><input id="ldh_login_line" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="例如 1" autocomplete="off" aria-label="账号文件行号">' +
                '<button id="ldh_login_fetch" type="button">获取并登录</button></div>' +
                '<button id="ldh_login_btn" type="button">剪贴板登录</button>' +
                '<p id="ldh_login_status" role="status" aria-live="polite">输入行号后按 Enter，或点「获取并登录」，自动填写并提交。</p>' +
                '</div></section>';
            root.getElementById("ldh_login_fetch").addEventListener("click", function () { run("file"); });
            root.getElementById("ldh_login_btn").addEventListener("click", function () { run("clipboard"); });
            root.getElementById("ldh_login_line").addEventListener("keydown", function (e) {
                if (e.key === "Enter" && !e.isComposing) {
                    e.preventDefault(); e.stopPropagation();
                    if (!e.repeat) run("file");
                }
            });
            root.getElementById("ldh_login_toggle").addEventListener("click", function () {
                const body = root.getElementById("ldh_login_body");
                body.hidden = !body.hidden;
                this.textContent = body.hidden ? "展开" : "收起";
                this.setAttribute("aria-expanded", String(!body.hidden));
            });
        }

        function reconcile() {
            scheduled = null;
            if (!document.body) return;
            const nextActive = isLoginView();
            if (nextActive) {
                if (!active && running) stopEngine();
                if (!panel) createPanel();
                const mounted = !panel.isConnected;
                if (mounted) document.body.appendChild(panel);
                if (!active || mounted) focusLoginLine();
                const main = document.getElementById("ldh_panel");
                if (main && hiddenMain !== main) {
                    hiddenMain = main; mainDisplay = main.style.display; main.style.display = "none";
                }
            } else {
                if (focusCleanup) focusCleanup();
                if (active) {
                    ++generation;
                    if (request) { request.abort(); request = null; }
                    setBusy(false);
                    status("输入行号后按 Enter，或点「获取并登录」，自动填写并提交。");
                }
                if (panel && panel.isConnected) panel.remove();
                if (hiddenMain) { hiddenMain.style.display = mainDisplay; hiddenMain = null; }
                if (!mainCreated) { mainCreated = true; createUI(); }
                else if (active) refreshForumUser(true);
            }
            active = nextActive;
            pollCaptcha();
        }
        function schedule() {
            if (scheduled === null) scheduled = setTimeout(reconcile, 80);
        }
        const observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "aria-hidden", "disabled", "aria-disabled", "aria-busy"]
        });
        window.addEventListener("resize", schedule);
        window.addEventListener("popstate", schedule);
        window.addEventListener("pageshow", schedule);
        window.addEventListener("focus", schedule);
        document.addEventListener("visibilitychange", schedule);

        setInterval(function () {
            if (active !== isLoginView() || (active && !panel.isConnected)) schedule();
            pollCaptcha();
        }, 1000);
        reconcile();
    }
    function boot() { initGithubTokenMenu(); initLoginPage(); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
