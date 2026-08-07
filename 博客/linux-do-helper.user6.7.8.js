// ==UserScript==
// @name         LINUX DO 助手（日常维护 / 快速升级 · 含等级3进度）
// @namespace    http://tampermonkey.net/
// @version      6.7.8
// @description  三个按钮：日常维护(3分钟)、快速升级(10分钟)、日常挂机(500分钟)。点赞与刷帖交错、匀速铺满整个运行时长，全程不空转；每次上传间隔在配置区间内真随机(默认0-60秒)，保证被计入阅读时长。正计时。面板4行固定。等级3进度：后台自动跨域抓 connect(不用打开网页)+定时刷新+手动同步，按当前登录用户分开存(多账号各看各的)。集成 AgentRouter 每日自动签到(纯代码) 与 AnyRouter 一键登录。按实测规律避开~200次/窗口的24h硬封（日常挂机不受该限制）。
// @match        https://linux.do/*
// @match        https://connect.linux.do/*
// @match        https://agentrouter.org/*
// @match        https://anyrouter.top/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      connect.linux.do
// @connect      agentrouter.org
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";
    if (window.top !== window.self) return;

    /* ============================================================
     * ⚙ 配置区（全部区间均为闭区间，含首尾两个数值）
     * ============================================================ */
    const CFG = {
        // ---- 日常维护 ----
        DAILY_MINUTES: 3,              // 运行时间（分钟）
        DAILY_TOPICS:  [10, 25],       // 主题数量
        DAILY_REPLIES: [200, 250],     // 帖子数量
        DAILY_LIKES:   [1, 3],         // 点赞数量

        // ---- 快速升级 ----
        FAST_MINUTES:  10,             // 运行时间（分钟）
        FAST_TOPICS:   [50, 100],      // 主题数量
        FAST_REPLIES:  [2000, 3000],   // 帖子数量
        FAST_LIKES:    [3, 5],         // 点赞数量

        // ---- 日常挂机 ----
        IDLE_MINUTES:  500,            // 运行时间（分钟）
        IDLE_TOPICS:   [200, 500],     // 主题数量
        IDLE_REPLIES:  [2000, 5000],   // 帖子数量
        IDLE_LIKES:    [0, 0],         // 点赞数量

        // ---- 全局：每次向服务器上传阅读进度(timings)的间隔（秒）----
        // 每一次上传的间隔都在这个区间内【均匀真随机】抽取，所以第1次可能隔 8 秒、
        // 第2次隔 47 秒、第3次隔 21 秒，每次都不同，不会出现"每次都无限接近上限"的雷同模式。
        // 注意：间隔必须 >0 且 <100 秒才会被 Discourse 计入总阅读时间，上限别写太大。
        // 实际上限会自动收窄：若"剩余主题数"要求发更多次请求，脚本会压低上限保证跑完计划量；
        // 帖子数不够时每次只传 1 楼，也绝不提前收工，全程铺满到最后一秒。
        REQ_GAP_SEC:   [0, 60]
    };
    /* ==================== 配置区结束 ==================== */

    // ============ 共享工具 ============
    function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
    function fmtNum(n) { n = Number(n) || 0; return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(n); }
    function stripAt(s) { return String(s || "").replace(/^@/, "").trim(); }
    function normUser(s) { return stripAt(s).toLowerCase(); }
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
    // 从一个 document/解析出的 DOM 里抽等级3数据（connect 页面 与 后台抓取 共用）
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

    /* ============================================================
     * AgentRouter / AnyRouter 集成
     * ============================================================ */
    const AR = {
        HOST: "https://agentrouter.org",
        CLIENT_ID: "KZUecGfhhDZMVnv8UtEdhOhf9sNOhqVX",
        FLOW: "ar_tab_flow",          // 跨页面状态机（兜底流程用）
        DAYKEY: "ar_last_ok_day",     // 当天签到成功的日期戳（本地日期字符串）
        NOTEKEY: "ar_checkin_note",   // 当天签到状态（按日期存储，包含state和note）
        UIDKEY: "ar_user_id",         // New-API-User 头所需的用户ID（登录后自动学习并持久化）
        AUTOKEY: "ar_auto_login_ts"   // 主动访问自动登录的节流时间戳
    };
    const ANY = {
        HOST: "https://anyrouter.top",
        CLIENT_ID_FB: "8w2uZtoWH9AUXrZr1qeCEEmvXLafea3c",
        FLOW: "anyrouter_login_flow_v1",
        TTL: 3 * 60 * 1000,
        AUTOKEY: "any_auto_login_ts"
    };
    const CONNECT_HOST = "https://connect.linux.do";
    const AUTO_LOGIN_COOLDOWN = 10 * 60 * 1000;   // 主动访问自动登录：10分钟内不重复

    function todayStr() {
        const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    function gmGet(k, fb) { try { return GM_getValue(k, fb); } catch (_) { return fb; } }
    function gmSet(k, v) { try { GM_setValue(k, v); } catch (_) {} }
    function gmDel(k) { try { GM_deleteValue(k); } catch (_) {} }

    // AR 签到状态持久化：按日期存储 state 和 note
    function saveArNote(state, note) {
        try {
            const data = { date: todayStr(), state: state, note: note };
            gmSet(AR.NOTEKEY, JSON.stringify(data));
        } catch (_) {}
    }
    function loadArNote() {
        try {
            const data = JSON.parse(gmGet(AR.NOTEKEY, "null"));
            if (data && data.date === todayStr()) return { state: data.state, note: data.note };
        } catch (_) {}
        return null;
    }

    // 主动访问自动登录的节流：10分钟内同一站点不重复触发
    function autoLoginAllowed(key) { return Date.now() - Number(gmGet(key, 0) || 0) > AUTO_LOGIN_COOLDOWN; }
    function markAutoLogin(key) { gmSet(key, Date.now()); }

    // ---- 跨域请求（GM）----
    // AgentRouter(New-API) 后端强制校验 New-API-User 头，缺失会报"未提供 New-Api-User"
    let AR_UID = Number(gmGet(AR.UIDKEY, 0)) || 0;
    function setArUid(id) { id = Number(id) || 0; if (id > 0 && id !== AR_UID) { AR_UID = id; gmSet(AR.UIDKEY, id); } }
    function arWait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function arResponseHeader(r, name) {
        const m = String(r.responseHeaders || "").match(new RegExp("^" + name + ":\\s*(.+)$", "im"));
        return m ? m[1].trim() : "";
    }
    function arBodyPreview(t) {
        return String(t || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    }
    // 把"返回非JSON"细分成可判断的原因，否则验证页/登录页/网关错误全都长一个样
    function arNonJsonError(r, url) {
        const text = String(r.responseText || ""), status = Number(r.status) || 0;
        const preview = arBodyPreview(text), finalUrl = String(r.finalUrl || url || "");
        if (/just a moment|cf-chl|cloudflare|attention required|verify you are human/i.test(text)) {
            const e = new Error("被验证页拦截"); e.cf = true; return e;
        }
        if (/bad gateway|service unavailable|gateway timeout|upstream/i.test(text) || [502, 503, 504].indexOf(status) >= 0) {
            return new Error("AR服务临时异常(HTTP " + (status || "未知") + ")");
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
            // New-API-User 只发给 agentrouter.org，不能泄露给 connect.linux.do
            let host = ""; try { host = new URL(url).hostname; } catch (_) {}
            if (host === "agentrouter.org" && opts.userHeader !== false && AR_UID > 0) h["New-API-User"] = String(AR_UID);
            const ex = opts.headers || {};
            Object.keys(ex).forEach(function (k) { h[k] = ex[k]; });
            GM_xmlhttpRequest({
                method: opts.method || "GET", url: url, headers: h,
                withCredentials: true, timeout: 20000,
                onload: function (r) { resolve(r); },
                onerror: function () { reject(new Error("网络错误")); },
                ontimeout: function () { reject(new Error("请求超时")); }
            });
        });
    }
    async function gmJson(url, opts) {
        const r = await gmFetch(url, opts);
        const text = String(r.responseText || "").replace(/^﻿/, "").trim();
        let b; try { b = JSON.parse(text); } catch (_) { throw arNonJsonError(r, url); }
        if (r.status >= 400 || b.success === false) throw new Error(b.message || ("HTTP " + r.status));
        return b;
    }
    // 只对网络类抖动重试；OAuth code 是一次性的，绝不重试回调
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

    // ---- AgentRouter：纯代码 OAuth ----
    function paramsFrom(u) { try { const x = new URL(u); const c = x.searchParams.get("code"), s = x.searchParams.get("state"); if (c && s) return { code: c, state: s }; } catch (_) {} return null; }
    function paramsFromText(t) {
        const c = (t || "").match(/[?&]code=([^&"'\s]+)/), s = (t || "").match(/[?&]state=([^&"'\s]+)/);
        return (c && s) ? { code: decodeURIComponent(c[1]), state: decodeURIComponent(s[1]) } : null;
    }
    function parseApprove(html) {
        try {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const links = Array.prototype.slice.call(doc.querySelectorAll('a[href^="/oauth2/approve/"]'));
            const yes = links.find(function (a) { return (a.textContent || "").replace(/\s+/g, "") === "允许"; }) || links[0];
            return yes ? yes.getAttribute("href") : null;
        } catch (_) { const m = (html || "").match(/\/oauth2\/approve\/[A-Za-z0-9_\-]+/); return m ? m[0] : null; }
    }
    // withLogout=true 为每日签到（先退出再登录才会触发签到）；false 仅补登录态
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
        if (a.status >= 400 || /just a moment|cf-chl|cloudflare|attention required/i.test(a.responseText || "")) throw arNonJsonError(a, a.finalUrl);
        // 授权页可能已直接带回 code/state（此前已授权过），否则再点一次"允许"
        let cs = paramsFrom(a.finalUrl) || paramsFromText(a.responseText);
        if (!cs) {
            const ap = parseApprove(a.responseText);
            if (!ap) throw new Error("授权页无允许链接(Linux DO登录态可能失效)");
            say("点击允许…");
            const approved = await gmFetch(new URL(ap, CONNECT_HOST).href, {
                userHeader: false, headers: { "Accept": "text/html,application/xhtml+xml" }
            });
            cs = paramsFrom(approved.finalUrl) || paramsFromText(approved.responseText);
        }
        if (!cs) throw new Error("授权完成但没返回code/state");
        // 关键：签到结果只在这个回调里（data.checked_in），不能吞掉错误也不能重试(code一次性)
        say("提交签到回调…");
        const cb = await gmJson(AR.HOST + "/api/oauth/linuxdo?code=" + encodeURIComponent(cs.code) +
            "&state=" + encodeURIComponent(cs.state) + "&mode=login", { userHeader: false });
        if (!cb || !cb.data || !cb.data.id) throw new Error("回调成功但缺少用户信息");
        setArUid(cb.data.id);             // 先拿到 UID，后续 self 请求才带得上头
        say("读取账户…");
        const self = await gmJsonRetry(AR.HOST + "/api/user/self", { userHeader: true }, 1);
        if (!self || !self.data || !self.data.id) throw new Error("仍未登录");
        setArUid(self.data.id);
        // checked_in 只在 OAuth 回调里返回，/api/user/self 没有这个字段
        return { user: self.data, checkedIn: cb.data.checked_in === true, source: "code" };
    }

    // 兜底：纯代码被验证页拦住时，后台静默走站点原生 OAuth（只后台，不切前台）
    function arFallbackTab(say) {
        return new Promise(function (resolve, reject) {
            gmSet(AR.FLOW, { step: "start", ts: Date.now() });
            let handle = null;
            try { handle = GM_openInTab(AR.HOST + "/login?ar_auto=1", { active: false, insert: true, setParent: true }); }
            catch (e) { gmDel(AR.FLOW); reject(new Error("无法打开后台授权标签")); return; }
            if (!handle) { gmDel(AR.FLOW); reject(new Error("无法打开后台授权标签")); return; }
            say("后台授权兜底中…");
            const started = Date.now();
            const iv = setInterval(function () {
                const flow = gmGet(AR.FLOW, null);
                if (flow && flow.step === "done") {
                    clearInterval(iv); gmDel(AR.FLOW); try { handle.close(); } catch (_) {}
                    if (flow.error) reject(new Error(flow.error));
                    else resolve({ checkedIn: flow.checkedIn === true, source: "tab" });
                } else if (Date.now() - started > 3 * 60 * 1000) {
                    // 超时一律关标签，绝不留在前台干扰你的自动按键
                    clearInterval(iv); gmDel(AR.FLOW); try { handle.close(); } catch (_) {}
                    reject(new Error("后台授权超时(可能需人工过验证)"));
                }
            }, 700);
        });
    }

    async function arCheckin(say) {
        try { return await arOAuth(say, true); }
        catch (e) {
            const msg = (e && e.message) || String(e);
            say("纯代码失败:" + msg);
            try {
                const r = await arFallbackTab(say);
                if (!r.user) { try { const s = await gmJsonRetry(AR.HOST + "/api/user/self", { userHeader: true }, 1); r.user = s && s.data; } catch (_) {} }
                return r;
            } catch (e2) {
                throw new Error(msg + " / 兜底:" + ((e2 && e2.message) || e2));
            }
        }
    }


    // ---- AnyRouter：状态机 + 自动登录 ----
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
    // 同源检测登录态（在对应站点页面内调用）
    async function siteLoggedIn() {
        const u = getStoredUser();
        if (!u) return false;
        try {
            const r = await fetch("/api/user/self", { credentials: "include", cache: "no-store", headers: { "New-API-User": String(u.id) } });
            const b = await r.json();
            return !!(r.ok && b.success !== false && b.data && b.data.id);
        } catch (_) { return false; }
    }
    // 主动访问时只在首页/登录页触发
    function isEntryPath() { const p = location.pathname; return p === "/" || p === "" || p === "/login"; }

    // ================= agentrouter.org 分支 =================
    if (location.hostname === "agentrouter.org") {
        // 只要本站已登录，就把 user.id 学下来，供 linux.do 侧请求带 New-API-User 头
        (function () { const u = getStoredUser(); if (u && u.id) setArUid(u.id); })();
        let flow = gmGet(AR.FLOW, null);
        if (flow && (!flow.ts || Date.now() - flow.ts > 3 * 60 * 1000)) { gmDel(AR.FLOW); flow = null; }
        if (flow) {
            // 兜底状态机（由 linux.do 侧发起）
            (async function () {
                const stored = getStoredUser();
                if (flow.step === "authorizing") {
                    // AgentRouter 是单页应用，跳到 /console 未必重新加载页面，
                    // 只检查一次会永远等不到完成 → 必须持续观察
                    const finishIfReady = function () {
                        const cur = getStoredUser();
                        if (!cur || location.pathname.indexOf("/console") !== 0) return false;
                        if (cur.id) setArUid(cur.id);
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
                        await fetch("/api/user/logout", { credentials: "include", cache: "no-store", headers: headers }).catch(function () {});
                        localStorage.removeItem("user");
                        const resp = await fetch("/api/oauth/state?mode=login", { credentials: "include", cache: "no-store" });
                        const txt = await resp.text();
                        let b; try { b = JSON.parse(txt); } catch (_) { throw new Error("页面流程返回非JSON(HTTP " + resp.status + ")"); }
                        if (!resp.ok || b.success === false || !b.data) throw new Error(b.message || ("HTTP " + resp.status));
                        location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + AR.CLIENT_ID + "&state=" + encodeURIComponent(b.data));
                    } catch (e) { gmSet(AR.FLOW, { step: "done", ts: Date.now(), error: (e && e.message) || String(e) }); }
                }
            })();
        } else if (isEntryPath()) {
            // 主动访问：未登录则自动登录（10分钟节流），仅登录不计入签到
            (async function () {
                if (!autoLoginAllowed(AR.AUTOKEY)) return;
                if (await siteLoggedIn()) return;
                markAutoLogin(AR.AUTOKEY);
                try {
                    const b = await (await fetch("/api/oauth/state?mode=login", { credentials: "include", cache: "no-store" })).json();
                    if (b && b.data) {
                        location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + AR.CLIENT_ID + "&state=" + encodeURIComponent(b.data));
                    }
                } catch (_) {}
            })();
        }
        return;
    }

    // ================= anyrouter.top 分支 =================
    if (location.hostname === "anyrouter.top") {
        const f = anyGetFlow();
        if (f) {
            // 由 Any 按钮发起的流程
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
                    gmDel(ANY.FLOW);
                    if (location.pathname.indexOf("/console") !== 0) location.replace(ANY.HOST + "/console");
                    return;
                }
                gmSet(ANY.FLOW, JSON.stringify({ step: "authorizing", ts: Date.now() }));
                await anyStartOAuth();
            })();
        } else if (isEntryPath()) {
            // 主动访问：未登录则自动登录（10分钟节流）
            (async function () {
                if (!autoLoginAllowed(ANY.AUTOKEY)) return;
                if (await siteLoggedIn()) return;
                markAutoLogin(ANY.AUTOKEY);
                await anyStartOAuth();
            })();
        }
        return;
    }
    async function anyStartOAuth() {
        try {
            const sres = await fetch("/api/status", { credentials: "include", cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; });
            const cid = (sres && sres.data && sres.data.linuxdo_client_id) || ANY.CLIENT_ID_FB;
            const st = await fetch("/api/oauth/state", { credentials: "include", cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; });
            const state = st && st.data;
            if (!state) return;
            location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + encodeURIComponent(cid) + "&state=" + encodeURIComponent(state));
        } catch (_) {}
    }

    // ================= connect.linux.do 分支：OAuth 自动点“允许” + 等级3抓取 =================
    if (location.hostname === "connect.linux.do") {
        // 有 AR/ANY 流程在跑时，授权页自动点“允许”，不走等级3逻辑
        const oauthPending = !!gmGet(AR.FLOW, null) || !!anyGetFlow() ||
                             (Date.now() - Number(gmGet(AR.AUTOKEY, 0) || 0) < 60000) ||
                             (Date.now() - Number(gmGet(ANY.AUTOKEY, 0) || 0) < 60000);
        if (oauthPending && location.pathname === "/oauth2/authorize") {
            const clickAllow = function () {
                const links = Array.prototype.slice.call(document.querySelectorAll('a[href^="/oauth2/approve/"]'));
                const allow = links.find(function (a) { return (a.textContent || "").replace(/\s+/g, "") === "允许" && a.getClientRects().length > 0; });
                if (!allow) return false;
                allow.click(); return true;
            };
            if (!clickAllow()) {
                const ob = new MutationObserver(function () { if (clickAllow()) ob.disconnect(); });
                try { ob.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
                setTimeout(function () { ob.disconnect(); }, 30000);
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
                toast(okStore ? (d.locked ? "等级0/1：未到2级，已记录 ✔" : "✅ 等级3进度已同步") : "等级0/1：没读到账号，回 linux.do 点 ⟳ 重试");
                if (autoClose && okStore) setTimeout(function () { try { window.close(); } catch (_) {} }, 1000);
            } else if (tries > 25) { clearInterval(iv); if (autoClose) setTimeout(function () { try { window.close(); } catch (_) {} }, 500); }
        }, 800);
        return;
    }

    // ======================= linux.do 分支 =======================
    const COMMON = {
        MSECS_MIN: 800, MSECS_MAX: 1400,
        FLOOR_INTERVAL: 800,                 // 物理最小间隔，防止把服务器打爆（CFG.REQ_GAP_SEC[0]=0 时生效）
        MAX_BATCH: 60,                       // 单次 timings 最多带多少楼
        TOPIC_OVERHEAD_MS: 2300,             // 每进一个新主题的固定开销(请求往返+ENTER sleep)，用于时间预算
        ENTER_MIN: 700, ENTER_MAX: 1200,
        HARD_BLOCK_RETRY_THRESHOLD: 600, CF_BACKOFF_MS: 10000, MAX_CONSEC_CF: 5,
        LIKE_REACTION: "heart",
        GITHUB_LIST_URL: "https://raw.githubusercontent.com/cler1818/Note/refs/heads/main/name.txt",
        WHITELIST_CACHE_KEY: "ld_helper_whitelist",
        REQLOG_KEY: "ld_helper_reqlog", WINDOW_MS: 60 * 60 * 1000,
        WARN_REQ: 130, REFUSE_START: 165, HARD_STOP: 185, SAFE_RESUME: 120,
        TL3_SYNC_INTERVAL_MS: 30 * 60 * 1000
    };
    const GAP_MIN_MS = Math.max(COMMON.FLOOR_INTERVAL, Math.round(CFG.REQ_GAP_SEC[0] * 1000));
    const GAP_MAX_MS = Math.max(GAP_MIN_MS + 1000, Math.round(CFG.REQ_GAP_SEC[1] * 1000));

    const MODES = {
        daily: { key: "daily", name: "日常维护", color: "#2f6f3e", minutes: CFG.DAILY_MINUTES, topics: CFG.DAILY_TOPICS, replies: CFG.DAILY_REPLIES, likes: CFG.DAILY_LIKES, minPosts: 5, safety: 160,      noLimit: false },
        fast:  { key: "fast",  name: "快速升级", color: "#33507a", minutes: CFG.FAST_MINUTES,  topics: CFG.FAST_TOPICS,  replies: CFG.FAST_REPLIES,  likes: CFG.FAST_LIKES,  minPosts: 5, safety: 175,      noLimit: false },
        idle:  { key: "idle",  name: "日常挂机", color: "#6a4b8a", minutes: CFG.IDLE_MINUTES,  topics: CFG.IDLE_TOPICS,  replies: CFG.IDLE_REPLIES,  likes: CFG.IDLE_LIKES,  minPosts: 8,  safety: Infinity, noLimit: true,  fullRandom: true  }
    };
    const MODE_KEYS = ["daily", "fast", "idle"];
    function totalMs(M) { return M.minutes * 60 * 1000; }

    let running = false, abort = false, activeMode = "", startedAt = 0, csrf = "", consecCf = 0, uiTimer = null;
    let finishedOnce = false, frozenTimer = "", banMsg = "", endNote = "";
    let syncState = "idle", syncAt = 0;
    let arState = "idle", arNote = "";      // idle|running|ok|fail —— Agent 按钮状态
    let anyState = "idle";                  // idle|running —— Any 按钮状态
    let me = { username: "" };

    // ---- AR 每日签到：面板建好后调用（每天一次，失败不记录当天，刷新可重跑）----
    function runArCheckin(force) {
        if (arState === "running") return;
        const today = todayStr();
        if (!force && gmGet(AR.DAYKEY, "") === today) { arState = "ok"; render(); return; }
        arState = "running"; arNote = ""; render();
        arCheckin(function (s) { arNote = s; render(); }).then(function (r) {
            // 如实显示：checked_in 为准，登录成功不等于签到成功
            if (r && r.checkedIn) {
                gmSet(AR.DAYKEY, today);
                arState = "ok"; arNote = "✓服务器确认签到成功";
            } else {
                gmSet(AR.DAYKEY, today);
                arState = "ok"; arNote = "已登录，今日无新奖励(可能已签到)";
            }
            saveArNote(arState, arNote);
            render();
        }).catch(function (e) {
            // 失败不写 DAYKEY，刷新页面即可重跑
            arState = "fail"; arNote = "AR失败:" + ((e && e.message) || e);
            saveArNote("fail", arNote);
            render();
        });
    }
    let plan = { topics: 0, replies: 0, likes: 0 };
    const sent = { topics: 0, replies: 0, likes: 0, timingReq: 0 };
    const handledLikeTopics = new Set();

    function elapsed() { return startedAt ? Date.now() - startedAt : 0; }
    function readJson(k, fb) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? fb : v; } catch (_) { return fb; } }
    function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
    function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    function readTL3() { if (!me.username) return null; try { const s = GM_getValue("ld_tl3_" + me.username.toLowerCase(), ""); return s ? JSON.parse(s) : null; } catch (_) { return null; } }

    // ---- 后台同步等级3 ----
    let triedForeground = false;
    function syncViaXhr(onFail) {
        if (typeof GM_xmlhttpRequest !== "function") { onFail("nogrant"); return; }
        syncState = "syncing"; render();
        GM_xmlhttpRequest({
            method: "GET", url: "https://connect.linux.do/", timeout: 15000,
            headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Referer": "https://connect.linux.do/", "User-Agent": navigator.userAgent },
            onload: function (resp) {
                const html = resp.responseText || "";
                if (/just a moment|__cf_chl|cf-browser-verification|attention required/i.test(html) && !/tl3-ring|empty-state/.test(html)) { onFail("cf"); return; }
                let doc; try { doc = new DOMParser().parseFromString(html, "text/html"); } catch (_) { onFail("err"); return; }
                const data = parseConnectRoot(doc);
                if (data && storeTL3(data, me.username)) { syncAt = Date.now(); syncState = readTL3() ? "ok" : "otheruser"; render(); }
                else { onFail("empty"); }
            },
            onerror: function () { onFail("err"); },
            ontimeout: function () { onFail("err"); }
        });
    }
    function openConnectTab(active) {
        syncState = "opening"; render();
        const before = (function () { const r = readTL3(); return (r && r.at) || 0; })();
        const url = "https://connect.linux.do/#ldhsync=" + encodeURIComponent(me.username || "");
        let handle = null;
        try { if (typeof GM_openInTab === "function") handle = GM_openInTab(url, { active: !!active, insert: true, setParent: true }); } catch (_) {}
        if (!handle) { try { handle = window.open(url, "ldh_sync"); } catch (_) {} }
        if (!handle) { syncState = "popupblock"; render(); return; }
        let n = 0;
        const iv = setInterval(function () {
            n++;
            const r = readTL3();
            if (r && (r.at || 0) !== before) { clearInterval(iv); syncAt = Date.now(); syncState = "ok"; render(); try { if (handle.close) handle.close(); } catch (_) {} }
            else if (n > 14) { clearInterval(iv); try { if (handle.close) handle.close(); } catch (_) {} if (active === false && !triedForeground) { triedForeground = true; openConnectTab(true); } else { syncState = "empty"; render(); } }
        }, 1500);
    }
    function sync() {
        if (syncState === "syncing" || syncState === "opening") return;
        triedForeground = false;
        syncViaXhr(function () { openConnectTab(false); });
    }

    // ---- 频率窗口 ----
    function logTimingReq() { const a = readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return Date.now() - t < COMMON.WINDOW_MS; }); a.push(Date.now()); writeJson(COMMON.REQLOG_KEY, a); }
    function recentTimingCount() { return readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return Date.now() - t < COMMON.WINDOW_MS; }).length; }
    function budgetHit() {
        const M = MODES[activeMode];
        if (!M || M.noLimit) return false;                 // 日常挂机：不做频率检查
        return recentTimingCount() >= COMMON.HARD_STOP || sent.timingReq >= M.safety;
    }
    function minutesUntilBelow(target) {
        const now = Date.now(); const arr = readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return now - t < COMMON.WINDOW_MS; }).sort(function (a, b) { return a - b; });
        if (arr.length <= target) return 0;
        return Math.max(1, Math.ceil((arr[arr.length - target - 1] + COMMON.WINDOW_MS - now) / 60000));
    }

    /* ---- 核心调度：间隔真随机 + 全程铺满 ----
     * cap     = 本次可用的间隔上限。取 min(GAP_MAX, 2 × 剩余时间 ÷ 最少请求数)。
     *           乘 2 是因为 [0,cap] 均匀分布的期望是 cap/2，这样平均下来正好铺满剩余时间。
     *           「最少请求数」= max(剩余主题数, 剩余时间÷GAP_MAX)，保证计划的主题数能跑完。
     * interval= 在 [GAP_MIN, cap] 内【均匀真随机】抽取 —— 每次都不同，不会雷同贴着上限。
     * batch   = 剩余帖子数 ÷ 预估剩余请求数，最低 1 楼（帖子不够就每次只传 1 楼，不硬凑大包）。
     * 因为每次都用「当前剩余时间/剩余量」重算，跑快跑慢都会自动纠偏，
     * 一定铺满到最后一秒，不会提前跑完再空转。
     */
    function schedule(T) {
        const M = MODES[activeMode];                           // 从全局取，engine 里的 M 在此不可见
        const remTime = Math.max(0, T - elapsed());
        const remReplies = Math.max(0, plan.replies - sent.replies);
        const remTopics = Math.max(0, plan.topics - sent.topics);
        // 至少要发这么多次：既要满足"间隔不超过 GAP_MAX"，也要够把剩下的主题跑完
        let minReq = Math.max(Math.ceil(remTime / GAP_MAX_MS), remTopics, 1);
        // 短模式：剩余请求数不得超过 safety 余额，否则间隔会被压得越来越短直到撞上限
        if (M && !M.fullRandom) {
            const left = Math.max(1, M.safety - 5 - sent.timingReq);
            minReq = Math.max(1, Math.min(minReq, left));
        }
        const avg = remTime / minReq;                          // 铺满剩余时间所需的平均间隔
        let interval, cap, estReq, batchOverride = null;
        if (M && M.fullRandom) {
            // 日常挂机：时间充裕，间隔在 [下限, cap] 内均匀真随机。
            // 均匀分布期望为 cap/2，故 cap 取 2×avg，平均下来正好铺满。
            cap = clamp(Math.round(avg * 2), GAP_MIN_MS + 200, GAP_MAX_MS);
            interval = randInt(GAP_MIN_MS, cap);
            estReq = Math.max(1, Math.round(remTime / Math.max(1, cap / 2)));
        } else {
            // 日常维护/快速升级：跟原脚本一致，只保证「单轮请求总数 ≤ safety」，
            // 不看每小时频率（跨次运行由 1 小时窗口的 165/185 负责）。
            // 由 safety 倒推每次至少带多少楼：
            //   总请求 ≈ 主题数 + 帖子数/batch ≤ safety  →  batch ≥ 帖子数/(safety-主题数)
            const room = Math.max(1, M.safety - 5);                 // 可用请求预算
            const rr = Math.max(0, plan.replies - sent.replies);
            const rt = Math.max(0, plan.topics - sent.topics);
            // 还需要多少次请求：帖子要拆几次 + 每个未完成主题至少 1 次
            const reqForPosts = rr > 0 ? Math.ceil(rr / COMMON.MAX_BATCH) : 0;
            const needReq = Math.max(rt, reqForPosts, 1);
            const budgetReq = Math.max(1, Math.min(needReq, room - sent.timingReq));
            // 每次带多少楼：把剩余帖子摊到剩余请求上
            batchOverride = rr > 0 ? Math.ceil(rr / budgetReq) : 1;
            batchOverride = clamp(batchOverride, 1, COMMON.MAX_BATCH);
            // 间隔 = (剩余时间 - 剩余主题的固定开销) ÷ 剩余请求数，再随机拖动
            // 每进一个新主题要花 ~2.3 秒(请求往返+固定sleep)，不预留会导致时间超支跑不满
            const overhead = rt * COMMON.TOPIC_OVERHEAD_MS;
            const usable = Math.max(0, remTime - overhead);
            const avgGap = usable / budgetReq;
            const lo = Math.max(GAP_MIN_MS, Math.round(avgGap * 0.4));
            const hi = Math.max(lo + 500, Math.min(GAP_MAX_MS, Math.round(avgGap * 1.6)));
            interval = randInt(lo, hi);                              // 间隔仍每次随机
            cap = hi;
            estReq = minReq;
        }
        let batch = batchOverride !== null ? batchOverride
                  : (remReplies > 0 ? Math.round(remReplies / estReq) : 1);
        batch = clamp(batch, 1, COMMON.MAX_BATCH);            // 帖子不够就每次只传 1 楼
        return { batch: batch, interval: interval, remReq: estReq, remTime: remTime, cap: cap };
    }

    // ---- API ----
    function csrfMeta() { const m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute("content") : ""; }
    async function getCsrf() { let t = csrfMeta(); if (t) return t; try { const r = await fetch("/session/csrf.json", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); t = (await r.json()).csrf || ""; } catch (_) {} return t; }
    async function getUser() { try { const r = await fetch("/session/current.json", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); const u = (await r.json()).current_user; if (u) return { username: String(u.username || "") }; } catch (_) {} return { username: "" }; }
    async function enterTopic(id) {
        try {
            const r = await fetch("/t/" + id + ".json?track_visit=true&forceLoad=true", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest", "Discourse-Logged-In": "true", "Discourse-Present": "true", "Discourse-Track-View": "true", "Discourse-Track-View-Topic-Id": String(id), "X-CSRF-Token": csrf } });
            if (!r.ok) return { ok: false }; const d = await r.json();
            return { ok: true, highest: Number(d.highest_post_number || (d.post_stream && d.post_stream.stream ? d.post_stream.stream.length : 0) || 0), lastRead: Number(d.last_read_post_number || (d.topic_user && d.topic_user.last_read_post_number) || 0) };
        } catch (_) { return { ok: false }; }
    }
    async function postTimings(id, nums) {
        const p = new URLSearchParams(); p.set("topic_id", String(id)); let total = 0;
        nums.forEach(function (n) { const ms = randInt(COMMON.MSECS_MIN, COMMON.MSECS_MAX); total += ms; p.set("timings[" + n + "]", String(ms)); });
        p.set("topic_time", String(total));
        let resp, body = "", ra = "", ct = "";
        try { resp = await fetch("/topics/timings", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", "Discourse-Present": "true" }, body: p.toString() }); }
        catch (e) { return { kind: "neterr" }; }
        try { ra = resp.headers.get("Retry-After") || ""; } catch (_) {}
        try { ct = resp.headers.get("Content-Type") || ""; } catch (_) {}
        try { body = await resp.text(); } catch (_) {}
        return { kind: classify(resp.status, body, ra, ct) };
    }
    function classify(status, body, ra, ct) {
        if (status >= 200 && status < 300) return "ok";
        if (/just a moment|cf-browser-verification|__cf_chl|attention required|cloudflare/i.test(body || "")) return "cloudflare";
        if (status === 429) { const hw = /^\d+(\.\d+)?$/.test((ra || "").trim()) ? Number(ra) : 0; let bw = 0; try { bw = Number(JSON.parse(body).extras.wait_seconds) || 0; } catch (_) {} return (hw >= COMMON.HARD_BLOCK_RETRY_THRESHOLD || /slow down/i.test(body || "") || (Math.max(hw, bw) === 0 && /text\/plain/i.test(ct || ""))) ? "discourse_hard" : "discourse_soft"; }
        if (status >= 500) return "server_error";
        return "other";
    }
    async function getReacted(postId) { try { const r = await fetch("/posts/" + postId + ".json", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); if (!r.ok) return false; const d = await r.json(); return !!(d.current_user_reaction || d.current_user_used_main_reaction); } catch (_) { return false; } }
    async function likeToggle(postId) { try { const r = await fetch("/discourse-reactions/posts/" + postId + "/custom-reactions/" + COMMON.LIKE_REACTION + "/toggle.json", { method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "Accept": "*/*", "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", "Discourse-Logged-In": "true", "Discourse-Present": "true" } }); return r.status; } catch (_) { return 0; } }
    function parseNames(t) { const seen = new Set(), out = []; String(t || "").split(/\r?\n/).forEach(function (l) { const n = l.replace(/^﻿/, "").trim(); if (!n || n[0] === "#" || n.startsWith("//")) return; const k = n.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push(n); }); return out; }
    async function loadNames() { try { const r = await fetch(COMMON.GITHUB_LIST_URL, { cache: "no-store" }); if (!r.ok) throw 0; const n = parseNames(await r.text()); if (n.length) { writeJson(COMMON.WHITELIST_CACHE_KEY, n); return n; } throw 0; } catch (_) { const c = readJson(COMMON.WHITELIST_CACHE_KEY, []); return Array.isArray(c) ? c : []; } }
    async function fetchUserPosts(u) {
        async function one(f) { try { const r = await fetch("/user_actions.json?username=" + encodeURIComponent(u) + "&filter=" + f + "&limit=30&offset=0", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d.user_actions) ? d.user_actions : []; } catch (_) { return []; } }
        const items = (await one(4)).concat(await one(5)), out = [], seen = new Set();
        items.forEach(function (it) { if (!it || it.deleted || it.hidden || !it.topic_id || !it.post_id) return; if (!it.username || String(it.username).toLowerCase() !== u.toLowerCase()) return; const k = it.topic_id + ":" + it.post_id; if (seen.has(k)) return; seen.add(k); out.push({ topicId: String(it.topic_id), postId: String(it.post_id) }); });
        return shuffle(out);
    }

    /* ---- 主题池：按需分页拉取，够挂机模式取几百个主题 ---- */
    const TOPIC_SOURCES = [
        "/top.json?period=all", "/top.json?period=yearly", "/top.json?period=quarterly",
        "/top.json?period=monthly", "/latest.json?order=posts", "/latest.json"
    ];
    const pool = {
        queue: [], seen: new Set(), src: 0, page: 0, exhausted: false,
        reset: function () { this.queue = []; this.seen = new Set(); this.src = 0; this.page = 0; this.exhausted = false; }
    };
    async function listTopics(url) {
        try { const r = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); return ((await r.json()).topic_list || {}).topics || []; } catch (_) { return []; }
    }
    async function refillPool(minPosts) {
        let rounds = 0;
        // 目标：池子里至少攒够剩余还需要的主题数（上限 120），避免主题跑不满
        const M = MODES[activeMode];
        const stillNeed = M ? Math.max(0, plan.topics - sent.topics) : 40;
        const target = Math.max(40, Math.min(120, stillNeed + 20));
        while (pool.queue.length < target && rounds < 40 && !pool.exhausted && !abort) {
            rounds++;
            const base = TOPIC_SOURCES[pool.src];
            const url = base + (base.indexOf("?") >= 0 ? "&" : "?") + "per_page=50&page=" + pool.page;
            const raw = await listTopics(url);
            const fresh = [];
            raw.forEach(function (t) {
                const id = t && t.id ? String(t.id) : "";
                if (!id || pool.seen.has(id)) return;
                const h = Number(t.highest_post_number || t.posts_count || 0);
                if (h >= minPosts && Number(t.last_read_post_number || 0) < h) { pool.seen.add(id); fresh.push(id); }
            });
            pool.queue = pool.queue.concat(shuffle(fresh));
            // 本源这一页没货了就换下一个源；所有源都轮过一遍再翻页
            if (raw.length < 10 || !fresh.length) {
                pool.src++;
                if (pool.src >= TOPIC_SOURCES.length) {
                    pool.src = 0; pool.page++;
                    if (pool.page > 30) pool.exhausted = true;
                }
            }
            await sleep(randInt(150, 350));
        }
        return pool.queue.length > 0;
    }
    async function nextTopic(minPosts) {
        if (!pool.queue.length) { const ok = await refillPool(minPosts); if (!ok) return ""; }
        return pool.queue.shift() || "";
    }

    /* ---- 点赞：预先随机分配到整个运行时长上的时间点，到点插入 ---- */
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
            if (await getReacted(c.postId)) { handledLikeTopics.add(c.topicId); await sleep(250); continue; }
            const code = await likeToggle(c.postId);
            await sleep(randInt(600, 1100));
            if (code >= 200 && code < 300) { sent.likes++; handledLikeTopics.add(c.topicId); render(); return true; }
            if (code === 429) { likeDead = true; likeSlots = []; endNote = "点赞被限流"; return false; }
        }
        return false;
    }
    async function maybeLike() {
        while (likeSlots.length && !likeDead && !abort && elapsed() >= likeSlots[0]) {
            likeSlots.shift();
            await doOneLike();
        }
    }

    // ---- 引擎：点赞与刷帖交错，匀速铺满整个运行时长 ----
    async function engine(mode) {
        const M = MODES[mode];
        const T = totalMs(M);
        me = await getUser(); if (!me.username) return finish("未登录", "未登录");
        csrf = await getCsrf(); if (!csrf) return finish("无CSRF", "无CSRF");

        plan.topics = randInt(M.topics[0], M.topics[1]);
        plan.replies = randInt(M.replies[0], M.replies[1]);
        plan.likes = randInt(M.likes[0], M.likes[1]);
        render();

        // 点赞排期
        likeSlots = []; likeNames = []; likeNameIdx = 0; likeCands = []; likeDead = false;
        if (plan.likes > 0) {
            likeSlots = buildLikeSlots(T, plan.likes);
            likeNames = shuffle((await loadNames()).filter(function (n) { return n && n.toLowerCase() !== me.username.toLowerCase(); }));
            if (!likeNames.length) likeDead = true;
        }

        pool.reset();

        // 主循环：一直跑到时间到，中途不空转
        while (!abort && elapsed() < T) {
            if (budgetHit()) { endNote = "本窗口达上限"; break; }
            await maybeLike();
            if (abort || elapsed() >= T) break;

            const tid = await nextTopic(M.minPosts);
            if (!tid) {
                // 主题池暂时枯竭：等一个调度间隔再试，不提前收工
                const s = schedule(T);
                await sleep(Math.min(s.interval, 5000));
                if (pool.exhausted) { pool.reset(); }
                continue;
            }

            const meta = await enterTopic(tid);
            await sleep(randInt(COMMON.ENTER_MIN, COMMON.ENTER_MAX));
            if (!meta.ok || meta.highest < 2) continue;

            // 本主题读多少楼 = 剩余帖子 ÷ 剩余主题（严格按配额摊，不被 batch 抬高）
            const remTopics = Math.max(1, plan.topics - sent.topics);
            const remReplies = Math.max(0, plan.replies - sent.replies);
            let want = Math.round((remReplies / remTopics) * (0.8 + Math.random() * 0.4));
            want = Math.max(1, Math.min(want, remReplies));      // 至少1楼，且不超剩余配额

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
                const res = await postTimings(tid, batch);
                if (res.kind === "ok") {
                    consecCf = 0; logTimingReq();
                    sent.replies += batch.length;
                    if (!readThis) { sent.topics++; readThis = true; }
                    render();
                    p += batch.length;
                    await sleep(s.interval);
                } else if (res.kind === "discourse_hard") {
                    return finish("24h封禁", "该号24h封禁中");
                } else if (res.kind === "cloudflare") {
                    consecCf++; if (consecCf >= COMMON.MAX_CONSEC_CF) break;
                    await sleep(COMMON.CF_BACKOFF_MS);
                } else if (res.kind === "discourse_soft") {
                    await sleep(8000);
                } else {
                    await sleep(1500);
                }
            }
        }
        // 收尾：把剩余没到点的点赞补掉（正常情况下 likeSlots 已排到 95% 处，这里几乎不会触发）
        while (likeSlots.length && !likeDead && !abort) { likeSlots.shift(); await doOneLike(); }
        finish("done");
    }

    function finish(reason, note) {
        const M = MODES[activeMode]; const used = M ? Math.min(elapsed(), totalMs(M)) : elapsed();
        running = false; finishedOnce = true; if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
        frozenTimer = "⏱ " + mmss(used); if (note) endNote = note; activeMode = "";
        writeJson("ld_helper_last", { at: Date.now(), sent: { topics: sent.topics, replies: sent.replies, likes: sent.likes }, frozen: frozenTimer, endNote: endNote });
        restoreButtons(); render();
    }
    function startMode(mode) {
        if (running) { if (mode === activeMode) abort = true; return; }
        const M = MODES[mode];
        if (!M.noLimit) {                                   // 日常挂机跳过启动前的频率检查
            const rc = recentTimingCount();
            if (rc >= COMMON.REFUSE_START) { banMsg = "⛔ 本窗口已发" + rc + "次，约" + minutesUntilBelow(COMMON.SAFE_RESUME) + "分钟后再来"; finishedOnce = false; render(); return; }
        }
        banMsg = ""; endNote = ""; frozenTimer = ""; running = true; abort = false; activeMode = mode; startedAt = Date.now(); consecCf = 0;
        arNote = "";                                        // 开始刷帖：第4行让位给刷帖进度
        sent.topics = 0; sent.replies = 0; sent.likes = 0; sent.timingReq = 0; handledLikeTopics.clear();
        plan.topics = 0; plan.replies = 0; plan.likes = 0;
        markButtons(mode); if (uiTimer) clearInterval(uiTimer); uiTimer = setInterval(render, 1000); render();
        engine(mode).catch(function (e) { finish("异常", "异常:" + (e && e.message || e)); });
    }

    // ---- UI ----
    function mSpan(label, m) { if (!m) return ""; const ok = (m.c || 0) >= (m.r || 0); return '<span style="color:' + (ok ? "#8fe0b0" : "#ff8a8a") + ';">' + label + fmtNum(m.c) + "/" + fmtNum(m.r) + "</span>"; }
    function tl3Rows() {
        const raw = readTL3();
        if (!raw) {
            const s = syncState === "syncing" ? "（后台同步中…）" : syncState === "opening" ? "（正在打开 connect 同步…）" : syncState === "popupblock" ? "（弹窗被拦，允许本站弹窗后再点⟳）" : syncState === "otheruser" ? "（connect 登录的是别的账号，用本号登录）" : syncState === "nogrant" ? "（缺跨域权限，去油猴放行 connect）" : "（点右上 ⟳ 同步，会自动开一次 connect）";
            return ["等级3 未同步", s];
        }
        if (raw.locked) return ["等级0/1 未到2级，暂时看不到进度", "达到2级后 connect 才显示明细"];
        const m = raw.metrics || {};
        const A = [mSpan("访问", m.visit_days), mSpan("话题", m.topics_viewed), mSpan("帖子", m.posts_viewed), mSpan("回复", m.topics_replied)].filter(Boolean).join(" ");
        const B = [mSpan("点赞", m.likes_given), mSpan("获赞", m.likes_received), mSpan("获赞天数", m.liked_days), mSpan("获赞用户", m.liked_by_users)].filter(Boolean).join(" ");
        return [A || "等级3 数据不全，去 connect 刷新", B || "—"];
    }
    function complianceTag() {
        const raw = readTL3();
        if (!raw || raw.locked || !raw.compliance) return "";
        const c = raw.compliance, v = [];
        if (c.reported_posts > 0) v.push("被举报" + c.reported_posts);
        if (c.users_reported > 0) v.push("举报" + c.users_reported);
        if (c.muted > 0) v.push("禁言" + c.muted);
        if (c.banned > 0) v.push("封禁" + c.banned);
        return v.length ? ' <span style="color:#ff8a8a;">⚠' + v.join(" ") + "</span>" : "";
    }
    function render() {
        const r1 = document.getElementById("ldh_r1"); if (!r1) return;
        const M = MODES[activeMode];
        const timer = running && M ? "⏱ " + mmss(Math.min(elapsed(), totalMs(M))) : frozenTimer;
        r1.innerHTML = (me.username || "未登录") + complianceTag() + '<span style="float:right;color:#8fe0b0;">' + timer + "</span>";
        const rows = tl3Rows();
        document.getElementById("ldh_r2").innerHTML = rows[0];
        document.getElementById("ldh_r3").innerHTML = rows[1];
        const r4 = document.getElementById("ldh_r4");
        const word = running ? (M ? M.name + "中" : "正在运行") : (finishedOnce ? "脚本结束" : "准备就绪");
        if (banMsg && !running && !finishedOnce) r4.innerHTML = '<span style="color:#ff8a8a;">' + banMsg + "</span>";
        else if (!running && !finishedOnce && arNote) {
            // 未跑刷帖时，第4行显示 Agent 签到状态（当天有效，刷新后仍在）
            const col = arState === "ok" ? "#8fe0b0" : arState === "fail" ? "#ff8a8a" : arState === "running" ? "#e0c060" : "#ccc";
            r4.innerHTML = '<span style="color:' + col + ';">Agent：' + arNote + "</span>";
        }
        else {
            const goal = running && plan.topics ? '<span style="color:#888;">/' + plan.topics + "</span>" : "";
            const goalR = running && plan.replies ? '<span style="color:#888;">/' + plan.replies + "</span>" : "";
            const goalL = running && plan.likes ? '<span style="color:#888;">/' + plan.likes + "</span>" : "";
            r4.innerHTML = word + "：主题 " + sent.topics + goal + " 丨 回复 " + sent.replies + goalR + " 丨 点赞 " + sent.likes + goalL + (endNote ? ' <span style="color:#ff8a8a;">·' + endNote + "</span>" : "");
        }
        const sy = document.getElementById("ldh_sync");
        if (sy) { const failed = (syncState === "cf" || syncState === "err" || syncState === "empty" || syncState === "login" || syncState === "nogrant" || syncState === "otheruser" || syncState === "popupblock"); const hasData = !!readTL3(); sy.textContent = (syncState === "syncing" || syncState === "opening") ? "同步中…" : (failed && !hasData) ? "⟳重试" : (syncState === "ok" || hasData) ? "✓已同步" : "⟳同步"; sy.style.color = (failed && !hasData) ? "#ff8a8a" : "#8fe0b0"; }
        // Agent 按钮：灰=未签到 黄=签到中 绿=已签到 红=失败(可点重试)
        const ab = document.getElementById("ldh_ar");
        if (ab) {
            if (arState === "running") { ab.textContent = "Agent…"; ab.style.background = "#a07d2a"; }
            else if (arState === "ok") { ab.textContent = "✓Agent"; ab.style.background = "#2f6f3e"; }
            else if (arState === "fail") { ab.textContent = "Agent!"; ab.style.background = "#8a3a3a"; }
            else { ab.textContent = "Agent"; ab.style.background = "#666"; }
        }
        const nb = document.getElementById("ldh_any");
        if (nb) { nb.style.background = anyState === "running" ? "#a07d2a" : "#666"; }
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
    const PANEL_SCALE = "scale(0.9)";
    const PANEL_DEF = { left: "16px", bottom: "18px" };
    // 回到默认位置（底部距离保持 18px 不变）
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
            // 注意：必须始终带上 scale(0.9)，否则躲避输入框时面板会突然放大
            if (composerMin) {
                p.style.transform = PANEL_SCALE;
                const r = p.getBoundingClientRect();
                const shift = Math.max(0, Math.min(280, window.innerWidth - r.right - 4));
                p.style.transform = PANEL_SCALE + " translateX(" + shift + "px)";
            }
            else { p.style.transform = PANEL_SCALE; }
        }
    }
    function toggleMin() { manualMin = !manualMin; try { sessionStorage.setItem("ldh_min", manualMin ? "1" : "0"); } catch (_) {} applyMin(); }
    function savePos(p) { try { sessionStorage.setItem("ldh_pos", JSON.stringify({ left: p.style.left, bottom: p.style.bottom })); } catch (_) {} }
    function restorePos(p) {
        try {
            const q = JSON.parse(sessionStorage.getItem("ldh_pos") || "null");
            if (!q || !q.left || !q.bottom) return;
            // 越界校验：还原小窗后旧坐标可能落在视口外，会导致面板"消失"
            const L = parseFloat(q.left), B = parseFloat(q.bottom);
            if (!isFinite(L) || !isFinite(B) ||
                L < 0 || B < 0 ||
                L > window.innerWidth - 60 || B > window.innerHeight - 24) {
                resetPos(p); return;
            }
            p.style.left = q.left; p.style.bottom = q.bottom; p.style.top = "auto";
        } catch (_) { resetPos(p); }
    }
    function enableDrag(p, handle) {
        // 关键：面板是 transform-origin:bottom left + scale(0.9)。
        // 若把定位从 bottom 切成 top，缩放收缩方向会翻转，面板会瞬间下移约 10% 高度。
        // 所以全程只改 left/bottom，绝不写 top/bottom:auto；且移动超过阈值才算拖拽，
        // 单纯点一下标题栏不做任何事。
        let armed = false, dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        const THRESH = 3;
        handle.addEventListener("mousedown", function (e) {
            if (e.target.closest("button") || e.target.closest("a")) return;
            if (e.target.closest("#ldh_sync") || e.target.closest("#ldh_min")) return;
            if (e.button !== 0) return;
            const r = p.getBoundingClientRect();
            ox = r.left;
            oy = window.innerHeight - r.bottom;      // 记录当前 bottom 距离
            sx = e.clientX; sy = e.clientY;
            armed = true; dragging = false;
        });
        document.addEventListener("mousemove", function (e) {
            if (!armed) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!dragging) {
                if (Math.abs(dx) < THRESH && Math.abs(dy) < THRESH) return;   // 还没到阈值：当作单击
                dragging = true;
            }
            let nx = ox + dx;
            let nb = oy - dy;                        // 鼠标下移 → bottom 变小
            nx = Math.max(0, Math.min(window.innerWidth - 60, nx));
            nb = Math.max(0, Math.min(window.innerHeight - 24, nb));
            p.style.left = nx + "px";
            p.style.bottom = nb + "px";              // 始终锚定底部，基点不变
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
    function watchComposer() {
        function syncC() { const open = composerOpen(); if (open !== composerMin) { composerMin = open; applyMin(); } }
        let t = null;
        const mo = new MutationObserver(function () { if (t) return; t = setTimeout(function () { t = null; syncC(); }, 150); });
        try { mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] }); } catch (_) {}
        syncC();
    }
    function createUI() {
        if (document.getElementById("ldh_panel")) return;
        const p = document.createElement("div"); p.id = "ldh_panel";
        p.style.cssText = "position:fixed;bottom:18px;left:16px;z-index:999999;background:rgba(18,18,18,0.86);color:#fff;padding:2px 12px 10px 12px;border-radius:10px;width:252px;font-size:11px;line-height:16px;box-shadow:0 6px 16px rgba(0,0,0,0.4);transform:scale(0.9);transform-origin:bottom left;overflow:visible;";
        const rowCss = "white-space:nowrap;overflow:hidden;min-height:15px;";
        const btnCss = "flex:1;padding:9px 2px;border:none;border-radius:7px;color:#fff;cursor:pointer;font-size:12px;white-space:nowrap;";
        const smallBtnCss = "padding:3px 6px;border:none;border-radius:4px;cursor:pointer;font-size:10px;margin-left:4px;";
        p.innerHTML =
            '<div id="ldh_title" style="display:flex;justify-content:space-between;align-items:center;cursor:move;min-height:22px;padding:5px 0 0 0;line-height:1.6;overflow:visible;">' +
            '<span style="font-weight:bold;">⚡ LINUX DO 助手</span>' +
            '<span style="display:flex;align-items:center;">' +
            '<button id="ldh_ar" style="' + smallBtnCss + 'background:#666;color:#fff;" title="Agent">Agent</button>' +
            '<button id="ldh_any" style="' + smallBtnCss + 'background:#666;color:#fff;" title="AnyRouter">Any</button>' +
            '<span id="ldh_sync" style="cursor:pointer;font-size:10px;color:#8fe0b0;margin-left:6px;">⟳同步</span>' +
            '<span id="ldh_min" style="cursor:pointer;margin-left:6px;font-size:13px;color:#ccc;">－</span>' +
            '</span>' +
            '</div>' +
            '<div id="ldh_body">' +
            '<div style="display:flex;gap:6px;margin:3px 0 8px 0;">' +
            '<button id="ldh_daily" style="' + btnCss + 'background:' + MODES.daily.color + ';">日常维护</button>' +
            '<button id="ldh_fast"  style="' + btnCss + 'background:' + MODES.fast.color + ';">快速升级</button>' +
            '<button id="ldh_idle"  style="' + btnCss + 'background:' + MODES.idle.color + ';">日常挂机</button>' +
            '</div>' +
            '<div id="ldh_r1" style="' + rowCss + '"></div>' +
            '<div id="ldh_r2" style="' + rowCss + 'font-size:10px;"></div>' +
            '<div id="ldh_r3" style="' + rowCss + 'font-size:10px;"></div>' +
            '<div id="ldh_r4" style="' + rowCss + 'margin-top:2px;"></div>' +
            '</div>';
        document.body.appendChild(p);
        MODE_KEYS.forEach(function (m) { document.getElementById("ldh_" + m).addEventListener("click", function () { startMode(m); }); });
        document.getElementById("ldh_sync").addEventListener("click", function () { sync(); });
        document.getElementById("ldh_min").addEventListener("click", function () { toggleMin(); });
        document.getElementById("ldh_ar").addEventListener("click", function () { runArCheckin(true); });
        document.getElementById("ldh_any").addEventListener("click", function () { anyState = "running"; render(); anyOpenTab(); setTimeout(function () { anyState = "idle"; render(); }, 3000); });
        enableDrag(p, document.getElementById("ldh_title"));
        restorePos(p);
        // 窗口尺寸一变（最大化/还原/拉伸边缘）→ 回默认位置，防止跑到角落或消失
        let rzTimer = null;
        window.addEventListener("resize", function () {
            if (rzTimer) clearTimeout(rzTimer);
            rzTimer = setTimeout(function () { rzTimer = null; resetPos(p); applyMin(); }, 200);
        });
        manualMin = sessionStorage.getItem("ldh_min") === "1"; applyMin();
        watchComposer();
        // 新开页面不再恢复上次的刷帖结束信息，第4行留给 Agent 签到状态
        // 恢复当天的 AR 签到状态（零点~23:59 有效，刷新/重开都显示）
        const saved = loadArNote();
        if (saved) { arState = saved.state; arNote = saved.note; }

        render();
        // 运行中误关页面时提醒一下（尤其是 500 分钟的日常挂机）
        window.addEventListener("beforeunload", function (e) { if (running) { e.preventDefault(); e.returnValue = ""; return ""; } });
        getUser().then(function (u) {
            me = u; render();
            if (me.username && !sessionStorage.getItem("ldh_autosync")) {
                sessionStorage.setItem("ldh_autosync", "1");
                const lastTs = Number(localStorage.getItem("ldh_autosync_ts") || 0);
                if (Date.now() - lastTs > 5 * 60 * 1000) { localStorage.setItem("ldh_autosync_ts", String(Date.now())); sync(); }
            }
        });
        // AgentRouter 每日自动签到：打开 linux.do 即触发，每天一次，失败不记录当天(刷新可重跑)
        setTimeout(function () { runArCheckin(false); }, 2500);
    }
    function initLoginPage() {
        function waitFor(sel, cb) { let el = document.querySelector(sel); if (el) return cb(el); let waited = 0; const iv = setInterval(function () { el = document.querySelector(sel); if (el) { clearInterval(iv); cb(el); } else if ((waited += 200) >= 12000) clearInterval(iv); }, 200); }
        waitFor("h1.login-title", function (titleEl) {
            if (document.getElementById("ldh_login_btn")) return;
            const btn = document.createElement("button");
            btn.id = "ldh_login_btn"; btn.textContent = "登陆";
            btn.style.cssText = "margin:8px 0;padding:6px 14px;cursor:pointer;font-size:14px;white-space:nowrap;border-radius:6px;border:1px solid rgba(0,0,0,0.2);background:#2f6f3e;color:#fff;";
            titleEl.insertAdjacentElement("afterend", btn);
            btn.addEventListener("click", async function () {
                let text = "";
                try { text = await navigator.clipboard.readText(); } catch (e) { alert("读取剪贴板失败，请允许剪贴板权限后重试"); return; }
                const parts = String(text || "").trim().split(/\s+/);
                if (parts.length < 2) { alert("剪贴板格式应为：账号 密码（用空格分隔）"); return; }
                const u = document.querySelector("#login-account-name"), pw = document.querySelector("#login-account-password");
                if (!u || !pw) { alert("没找到账号/密码输入框"); return; }
                u.focus(); u.value = parts[0]; u.dispatchEvent(new Event("input", { bubbles: true }));
                pw.focus(); pw.value = parts[1]; pw.dispatchEvent(new Event("input", { bubbles: true }));
                const lb = document.querySelector("#login-button");
                if (lb) setTimeout(function () { lb.click(); }, 300); else alert("没找到登录按钮");
            });
        });
    }
    function boot() { if (/^\/login/.test(location.pathname)) initLoginPage(); else createUI(); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
