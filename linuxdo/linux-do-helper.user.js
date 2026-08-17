// ==UserScript==
// @name         LINUX DO 助手
// @namespace    http://tampermonkey.net/
// @version      1.0.5
// @description  论坛刷帖三模式 + 等级/积分面板 + AgentRouter 签到 + AnyRouter/Credit 自动登录
// @author       cler1818
// @homepageURL  https://github.com/cler1818/Note
// @downloadURL  https://github.com/cler1818/Note/raw/refs/heads/main/linuxdo/linux-do-helper.user.js
// @updateURL    https://github.com/cler1818/Note/raw/refs/heads/main/linuxdo/linux-do-helper.user.js
// @match        https://linux.do/*
// @match        https://connect.linux.do/*
// @match        https://credit.linux.do/*
// @match        https://agentrouter.org/*
// @match        https://anyrouter.top/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      linux.do
// @connect      connect.linux.do
// @connect      credit.linux.do
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
        DAILY_LIKES:   [1, 1],         // 点赞数量

        // ---- 快速升级 ----
        FAST_MINUTES:  10,             // 运行时间（分钟）
        FAST_TOPICS:   [50, 100],      // 主题数量
        FAST_REPLIES:  [2000, 3000],   // 帖子数量
        FAST_LIKES:    [1, 1],         // 点赞数量

        // ---- 日常挂机 ----
        IDLE_MINUTES:  1000,           // 运行时间（分钟）
        IDLE_TOPICS:   [200, 500],     // 主题数量
        IDLE_REPLIES:  [2000, 5000],   // 帖子数量
        IDLE_LIKES:    [0, 0],         // 点赞数量

        // ---- 全局：每次向服务器上传阅读进度(timings)的间隔（秒）----
        // 每一次上传的间隔都在这个区间内【均匀真随机】抽取，所以第1次可能隔 8 秒、
        // 第2次隔 47 秒、第3次隔 21 秒，每次都不同，不会出现"每次都无限接近上限"的雷同模式。
        // 注意：间隔必须 >0 且 <100 秒才会被 Discourse 计入总阅读时间，上限别写太大。
        REQ_GAP_SEC:   [0, 60]
    };
    /* ==================== 配置区结束 ==================== */

    /* ============================================================
     * 面板尺寸（v6.7.10：删除 scale(0.9)，改为原生尺寸）
     * 旧版是 270px 再 scale(0.9)，实际视觉宽 243px；
     * 现在直接写 265px 实宽，字号按旧值 ×0.9 折算，视觉接近但不再缩放。
     * ============================================================ */
    const UI = {
        WIDTH: 265,                     // 面板实宽(px)，含 padding（box-sizing:border-box）
        PAD_X: 8                        // 左右内边距
    };
    UI.COMPOSER_SHIFT = UI.WIDTH * 2;   // 遇到发帖/回复框时右移 2 个面板宽（跟随 WIDTH，改宽度不用改两处）

    // ============ 共享工具 ============
    function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
    /* 可中断 sleep：点「停止」后立即返回，不用等这一轮 60 秒的间隔跑完。
     * 旧版用裸 setTimeout，abort 后仍要等计时器自然到期，
     * 挂机模式下最长要等一分钟才有反应 —— 这就是"点停止后半天缓不过来"的原因。
     * 所有等待都注册到 wakers 里，abortAll() 一次性唤醒并清空。 */
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
    /* 自然天固定按东八区(UTC+8 北京时间)计算，不跟随浏览器本地时区。
     * 起因：指纹浏览器常把环境时区设成美西等地(实测环境91为 America/Los_Angeles，
     *       比北京慢15小时)。若用 new Date() 取本地日期，脚本算出的"今天"会比
     *       北京时间落后一天，导致当天签到被"今天已签过"的锁挡住，白等15小时。
     * 实现：用 Date.now()(UTC毫秒)加8小时偏移后取 UTC 字段，完全绕开本地时区，
     *       也不依赖 toLocaleString 的时区数据库(部分指纹浏览器会篡改它)。 */
    function todayStr() {
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    }
    function gmGet(k, fb) { try { return GM_getValue(k, fb); } catch (_) { return fb; } }
    function gmSet(k, v) { try { GM_setValue(k, v); } catch (_) {} }
    function gmDel(k) { try { GM_deleteValue(k); } catch (_) {} }

    /* ============================================================
     * 站点常量
     * ============================================================ */
    const CONNECT_HOST = "https://connect.linux.do";
    const AUTO_LOGIN_COOLDOWN = 10 * 60 * 1000;   // 主动访问自动登录：10分钟内不重复
    const SYNC_THROTTLE_MS = 10 * 60 * 1000;      // 等级进度/摘要：跨标签 10 分钟内不重复拉取

    const AR = {
        HOST: "https://agentrouter.org",
        CLIENT_ID: "KZUecGfhhDZMVnv8UtEdhOhf9sNOhqVX",
        FLOW: "ar_tab_flow",          // 跨页面状态机（兜底流程用）
        DAYKEY: "ar_last_ok_day",     // 当天签到成功的日期戳（本地日期字符串）
        NOTEKEY: "ar_checkin_note",   // 当天签到状态（按日期存储）
        UIDKEY: "ar_user_id",         // New-API-User 头所需的用户ID
        BALKEY: "ar_balance",         // 余额缓存(全局，单账号)
        BALDAY: "ar_balance_day",     // 余额成功获取的日期戳 —— 和签到分开记，
                                      // 这样"签到成功但余额没读到"时，下次只补查余额、不重复签到
        AUTOKEY: "ar_auto_login_ts",  // 主动访问自动登录的节流时间戳
        SIDEKEY: "ar_side_login_v1",  // 别的标签页手动登录后回写余额，供论坛面板读取
        TAB_TIMEOUT: 30 * 1000        // 前台标签兜底的超时
    };
    const ANY = {
        HOST: "https://anyrouter.top",
        CLIENT_ID: "8w2uZtoWH9AUXrZr1qeCEEmvXLafea3c",
        FLOW: "anyrouter_login_flow_v1",
        TTL: 3 * 60 * 1000,
        AUTOKEY: "any_auto_login_ts",
        BANPREFIX: "anyrouter_ban_"   // + 规范化后的 LD 用户名
    };
    const CREDIT = {
        HOST: "https://credit.linux.do",
        CLIENT_ID: "EQepJmrayDhYMykHHouVF9mgcBwdoXcy",
        REDIRECT: "https://credit.linux.do/login",
        SCOPE: "openid profile email",
        BALPREFIX: "credit_bal_",     // + 规范化后的 LD 用户名 → {v, at, day}
        API_TIMEOUT: 8000,            // 直接读余额的超时
        TAB_TIMEOUT: 30 * 1000        // 前台标签兜底的超时（拿到数据就提前关）
    };
    // 前台标签互斥锁：多个论坛标签同时失败时，只让一个去开标签，避免同时弹一堆
    const TABLOCK_KEY = "ldh_fg_tab_lock";
    const TABLOCK_TTL = 40 * 1000;    // 略大于 TAB_TIMEOUT，持锁者异常退出后自动过期
    function acquireTabLock() {
        const now = Date.now(), cur = Number(gmGet(TABLOCK_KEY, 0)) || 0;
        if (now - cur < TABLOCK_TTL) return false;
        gmSet(TABLOCK_KEY, now); return true;
    }
    function releaseTabLock() { gmDel(TABLOCK_KEY); }

    /* ---- OAuth client_id 白名单 ----
     * 只对下面三个已确认的应用自动点「允许」。绝不放开成"所有应用"：
     * 那样任何网站都能把你导到 connect 授权页，在你看清之前拿走 LINUX DO 身份。 */
    const OAUTH_ALLOW = [AR.CLIENT_ID, ANY.CLIENT_ID, CREDIT.CLIENT_ID];
    function clientAllowed(id) { return !!id && OAUTH_ALLOW.indexOf(id) >= 0; }

    // 主动访问自动登录的节流：10分钟内同一站点不重复触发
    function autoLoginAllowed(key) { return Date.now() - Number(gmGet(key, 0) || 0) > AUTO_LOGIN_COOLDOWN; }
    function markAutoLogin(key) { gmSet(key, Date.now()); }

    /* ============================================================
     * 通用：等待并点击（Q3=a / Q4=a / Q9）
     * ============================================================ */
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
                // 后台标签(visibilityState=hidden)里布局可能还没算，getClientRects() 会是 0；
                // 此时不能因为"看不见"就不点，否则 Credit 的后台自动登录永远走不完。
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
    // Q4=a：模糊匹配。按钮文本同时含 linux 和 do，并带登录动词（继续/登录/login/continue/sign in）
    function normText(el) { return String((el && el.textContent) || "").replace(/\s+/g, " ").trim(); }
    function looksLikeLdLoginBtn(el) {
        const t = normText(el);
        if (!t || t.length > 40) return false;
        const s = t.toLowerCase().replace(/[\s_\-]+/g, "");
        if (s.indexOf("linux") < 0) return false;
        // "linuxdo" 连写、或 linux 后面紧跟 do
        if (!/linuxdo/.test(s)) return false;
        return /继续|登录|登陆|login|continue|signin|sign in|授权/i.test(t);
    }
    function findLdLoginBtn() {
        // 后台标签里布局未计算，getClientRects() 恒为 0；此时放宽可见性判断
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

    /* ============================================================
     * 跨域请求工具（GM）
     * ============================================================ */
    /* AgentRouter 的 New-API-User 头 —— 必须每次从 GM 存储现读，不能缓存在内存里。
     * 原因：兜底流程是在【另一个标签页】(agentrouter.org) 里完成登录并写入 UID 的，
     * 论坛这边的脚本早就启动了，内存变量停留在启动那一刻的旧值(通常是 0)，
     * 于是请求不带这个头 → 服务器回「未提供 New-Api-User」。
     * 刷新论坛后脚本重启、重新读到 UID 就好了 —— 这正是"刷新一下立马就好"的真正原因。 */
    function arUid() { return Number(gmGet(AR.UIDKEY, 0)) || 0; }
    function setArUid(id) { id = Number(id) || 0; if (id > 0 && id !== arUid()) gmSet(AR.UIDKEY, id); }
    // 兜底标签页登录完成后，UID 的写入和本页读取之间有几百毫秒空档，这里等它出现
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
    // 把"返回非JSON"细分成可判断的原因，否则验证页/登录页/网关错误全都长一个样
    function arNonJsonError(r, url) {
        const text = String(r.responseText || ""), status = Number(r.status) || 0;
        const preview = arBodyPreview(text), finalUrl = String(r.finalUrl || url || "");
        if (/just a moment|cf-chl|cloudflare|attention required|verify you are human/i.test(text)) {
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
            // New-API-User 只发给 agentrouter.org，不能泄露给别的站点
            let host = ""; try { host = new URL(url).hostname; } catch (_) {}
            if (host === "agentrouter.org" && opts.userHeader !== false) {
                const uid = arUid();                 // 现读，别用启动时的旧值
                if (uid > 0) h["New-API-User"] = String(uid);
            }
            const ex = opts.headers || {};
            Object.keys(ex).forEach(function (k) { h[k] = ex[k]; });
            GM_xmlhttpRequest({
                method: opts.method || "GET", url: url, headers: h,
                withCredentials: true, timeout: Number(opts.timeout) || 20000,
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

    /* ============================================================
     * 等级3（connect）数据解析
     * ============================================================ */
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

    /* ============================================================
     * AR 签到状态持久化（Q12=a：三段式，手动登录只覆盖余额）
     * ============================================================ */
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

    /* ============================================================
     * AnyRouter 封禁状态（按 LD 用户名分开存，Q7）
     * ============================================================ */
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
    // 当前登录的 LD 用户名（跨站点共享，供 anyrouter 分支识别账号）
    const LD_USER_KEY = "ldh_current_ld_user";
    function currentLdUser() { return normUser(gmGet(LD_USER_KEY, "")); }

    /* ============================================================
     * AgentRouter：纯代码 OAuth
     * ============================================================ */
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
        setArUid(cb.data.id);
        say("读取账户…");
        const self = await gmJsonRetry(AR.HOST + "/api/user/self", { userHeader: true }, 1);
        if (!self || !self.data || !self.data.id) throw new Error("仍未登录");
        setArUid(self.data.id);
        return { user: self.data, checkedIn: cb.data.checked_in === true, source: "code" };
    }
    /* 兜底：纯代码被 Cloudflare 验证页拦住时，开【前台】标签走站点原生 OAuth。
     * 用前台不用后台，是因为后台标签被 Chrome 节流后 React 应用起不来，
     * 流程永远走不完 —— 这也是"后台总失败、一激活标签就成功"的原因。
     * 拿到结果立刻关标签，最长 30 秒。 */
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
                if (flow && flow.step === "done") {
                    clearInterval(iv); gmDel(AR.FLOW); try { handle.close(); } catch (_) {}
                    if (flow.error) reject(new Error(flow.error));
                    else resolve({ checkedIn: flow.checkedIn === true, source: "tab" });
                } else if (Date.now() - started > AR.TAB_TIMEOUT) {
                    clearInterval(iv); gmDel(AR.FLOW); try { handle.close(); } catch (_) {}
                    reject(new Error("授权超时(可能需人工过验证)"));
                }
            }, 700);
        });
    }
    /* ---- 余额查询：quota / quota_per_unit = 美元 ----
     * 关键时序问题：GM_xmlhttpRequest 完成 OAuth 回调后，服务器返回的 Set-Cookie
     * 写进浏览器 Cookie jar 需要一点时间。回调一返回就立刻查余额，请求往往还没带上
     * 新 Cookie，服务器直接回 401 —— 这就是"签到成功但余额读取失败、刷新一下又好了"的原因。
     * 所以这里：先等一会儿让 Cookie 落地，再查；失败了按 1s/2s/3s 递增重试。
     * 另外绝不再把错误吞成空字符串 —— 真实原因要能显示到面板 tooltip 上。 */
    const AR_QPD_FALLBACK = 500000;
    async function arBalance(userData, opts) {
        opts = opts || {};
        const waitFirst = opts.waitFirst || 0;      // 首次查询前的等待（刚跑完 OAuth 时用）
        const retries = opts.retries === undefined ? 3 : opts.retries;
        if (waitFirst > 0) await arWait(waitFirst);

        let u = userData, lastErr = null;
        // userData 来自 OAuth 回调时可能已经带 quota，省一次请求
        if (!u || typeof u.quota === "undefined") {
            // 没有 UID 就必然被拒（「未提供 New-Api-User」），先等一会儿看它写进来没有
            if (arUid() <= 0) await waitArUid(3000);
            if (arUid() <= 0) throw new Error("尚未取得 AgentRouter 账号ID，点击重试");
            for (let i = 0; i <= retries; i++) {
                try {
                    const s = await gmJson(AR.HOST + "/api/user/self", { userHeader: true });
                    u = s && s.data;
                    if (u && typeof u.quota !== "undefined") { lastErr = null; break; }
                    lastErr = new Error("返回里没有 quota 字段");
                } catch (e) { lastErr = e; }
                if (i < retries) await arWait(1000 * (i + 1));   // 1s → 2s → 3s
            }
        }
        if (!u || typeof u.quota === "undefined") {
            throw lastErr || new Error("读不到账户额度");
        }
        let qpd = AR_QPD_FALLBACK;
        try {
            const st = await gmJson(AR.HOST + "/api/status", { userHeader: false });
            qpd = (st && st.data && Number(st.data.quota_per_unit)) || AR_QPD_FALLBACK;
        } catch (_) {}                                // 汇率取不到用默认值，不影响主流程
        if (!(qpd > 0)) qpd = AR_QPD_FALLBACK;
        return "$" + (Number(u.quota) / qpd).toFixed(2);
    }
    async function arCheckin(say, manualTrigger) {
        try { return await arOAuth(say, true); }
        catch (e) {
            const msg = (e && e.message) || String(e);
            say("纯代码失败:" + msg);
            // 前台标签会抢焦点，同一时刻只允许一个标签开（手动触发不受限）
            if (!manualTrigger && !acquireTabLock()) throw new Error(msg + " / 另一个标签正在授权");
            try {
                const r = await arFallbackTab(say);
                /* 兜底标签页里的脚本刚把 UID 写进 GM 存储，这边要等它可读再查账户，
                 * 否则请求不带 New-API-User 头，服务器直接回「未提供 New-Api-User」。 */
                say("等待账号ID…");
                await waitArUid(3000);
                if (!r.user) {
                    try { const s = await gmJsonRetry(AR.HOST + "/api/user/self", { userHeader: true }, 1); r.user = s && s.data; } catch (_) {}
                }
                return r;
            } catch (e2) {
                throw new Error(msg + " / 兜底:" + ((e2 && e2.message) || e2));
            } finally {
                if (!manualTrigger) releaseTabLock();
            }
        }
    }

    /* ============================================================
     * AnyRouter 工具
     * ============================================================ */
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
            const r = await fetch("/api/user/self", { credentials: "include", cache: "no-store", headers: { "New-API-User": String(u.id) } });
            const b = await r.json();
            return !!(r.ok && b.success !== false && b.data && b.data.id);
        } catch (_) { return false; }
    }
    function isEntryPath() { const p = location.pathname; return p === "/" || p === "" || p === "/login"; }

    // ================= agentrouter.org 分支 =================
    if (location.hostname === "agentrouter.org") {
        /* ---- 空白页自愈 ---- */
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

        // Q12=a：手动登录成功后，把余额回写给论坛面板（只覆盖余额，不动签到结论）
        function arReportSideBalance() {
            const u = getStoredUser();
            if (!u || !u.id) return;
            fetch("/api/status", { credentials: "include", cache: "no-store" })
                .then(function (r) { return r.json(); })
                .then(function (st) {
                    const qpd = (st && st.data && Number(st.data.quota_per_unit)) || AR_QPD_FALLBACK;
                    return fetch("/api/user/self", { credentials: "include", cache: "no-store", headers: { "New-API-User": String(u.id) } })
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
                    /* 判定登录完成：只要 localStorage 里有了 user.id 就算成功。
                     * 不再强求落点是 /console —— AgentRouter 登录后的落点会变
                     * (实测有 /console/token)，写死路径会让流程永远等不到。
                     * 必须先写 UID 再标 done：论坛那边收到 done 后立刻要用这个 ID
                     * 去查余额，顺序反了就会拿到「未提供 New-Api-User」。 */
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
            // 主动访问：未登录则自动登录（F1：先点按钮，2秒没点到回退纯代码；10分钟节流）
            (async function () {
                if (await siteLoggedIn()) { arReportSideBalance(); return; }
                if (!autoLoginAllowed(AR.AUTOKEY)) return;
                markAutoLogin(AR.AUTOKEY);
                const clicked = await waitAndClick(findLdLoginBtn, 2000);
                if (clicked) return;                       // 交给站点自己跳转
                try {
                    const b = await (await fetch("/api/oauth/state?mode=login", { credentials: "include", cache: "no-store" })).json();
                    if (b && b.data) location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + AR.CLIENT_ID + "&state=" + encodeURIComponent(b.data));
                } catch (_) {}
            })();
        } else {
            /* 其它页面（/console、/console/token…）：已登录就把余额回写给论坛面板。
             * AgentRouter 是单页应用，路由切换不会重新执行脚本，而你登录后落点未必是
             * 首页 —— 所以这里多探几次，只要哪一次检测到登录态就回写，然后停手。 */
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

    // ================= anyrouter.top 分支 =================
    if (location.hostname === "anyrouter.top") {
        const LD_U = currentLdUser();
        // Q13：封禁检测（[role=alert] 文本含"用户已被封禁"，MutationObserver 实时监听）
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
                if (getAnyBan(LD_U)) { console.warn("[LDH] AnyRouter 已封禁，跳过自动登录"); gmDel(ANY.FLOW); return; }
                gmSet(ANY.FLOW, JSON.stringify({ step: "authorizing", ts: Date.now() }));
                await anyStartOAuth();
            })();
        } else if (isEntryPath()) {
            (async function () {
                if (await siteLoggedIn()) { clearAnyBan(LD_U); return; }
                if (getAnyBan(LD_U)) { console.warn("[LDH] AnyRouter 已封禁，跳过自动登录"); return; }
                if (!autoLoginAllowed(ANY.AUTOKEY)) return;
                markAutoLogin(ANY.AUTOKEY);
                // 公告弹窗可能挡住登录按钮
                const close = Array.prototype.slice.call(document.querySelectorAll("button")).find(function (b) { return normText(b) === "关闭公告" && b.getClientRects().length; })
                           || document.querySelector('button[aria-label="close"]');
                if (close && close.getClientRects().length) { try { close.click(); } catch (_) {} }
                const clicked = await waitAndClick(findLdLoginBtn, 2000);
                if (clicked) return;
                await anyStartOAuth();
            })();
        }
        return;
    }
    async function anyStartOAuth() {
        try {
            const sres = await fetch("/api/status", { credentials: "include", cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; });
            const cid = (sres && sres.data && sres.data.linuxdo_client_id) || ANY.CLIENT_ID;
            const st = await fetch("/api/oauth/state", { credentials: "include", cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; });
            const state = st && st.data;
            if (!state) return;
            location.replace(CONNECT_HOST + "/oauth2/authorize?response_type=code&client_id=" + encodeURIComponent(cid) + "&state=" + encodeURIComponent(state));
        } catch (_) {}
    }

    // ================= credit.linux.do 分支 =================
    if (location.hostname === "credit.linux.do") {
        /* Credit 是 Next.js SPA：/home 未登录时是【客户端路由】跳到 /login，
         * 页面不会重新加载，document-end 时看 pathname 还停在 /home。
         * 所以不能只判断一次路径，必须持续观察登录表单出现。
         * 停止条件：URL 出现 code（已回调）、或已跳到 /home、或超时 90 秒。 */
        (function creditAutoLogin() {
            const started = Date.now();
            let termsDone = false, loginClicked = false, stopped = false;
            const bg = document.visibilityState === "hidden";
            const seen = function (el) { return bg || el.getClientRects().length > 0; };

            function stop() { if (stopped) return; stopped = true; try { ob.disconnect(); } catch (_) {} clearInterval(iv); }
            function step() {
                if (stopped) return;
                if (Date.now() - started > CREDIT.TAB_TIMEOUT) { stop(); return; }
                // 已经拿到 code（OAuth 回调中）→ 交给站点自己处理，绝不能再点登录
                if (new URLSearchParams(location.search).has("code")) { stop(); return; }
                // 已经进 /home 说明登录完成
                if (location.pathname.indexOf("/home") === 0 && !document.querySelector("#terms")) return;

                // A. 先勾条款（是 button[role=checkbox]，不是 input）
                if (!termsDone) {
                    const t = document.querySelector('#terms[role="checkbox"], #terms');
                    if (t) {
                        if (t.getAttribute("aria-checked") === "true" || t.getAttribute("data-state") === "checked") {
                            termsDone = true;
                        } else if (seen(t)) {
                            try { t.click(); } catch (_) {}
                            return;                       // 点完这一轮就返回，下一轮再看是否已勾上
                        }
                    }
                }
                // B. 条款勾上后再点登录按钮（模糊匹配，兼容"使用 LINUX DO 登录"）
                if (termsDone && !loginClicked) {
                    const b = findLdLoginBtn();
                    if (b && seen(b)) { try { b.click(); loginClicked = true; } catch (_) {} }
                }
            }
            const ob = new MutationObserver(step);
            try { ob.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "data-state"] }); } catch (_) {}
            const iv = setInterval(step, 400);
            step();
        })();
        return;
    }

    // ================= connect.linux.do 分支 =================
    if (location.hostname === "connect.linux.do") {
        if (location.pathname === "/oauth2/authorize") {
            // 只对白名单里的三个应用自动点「允许」；其它应用一律不碰，由你自己决定
            const cid = new URLSearchParams(location.search).get("client_id") || "";
            if (clientAllowed(cid)) {
                // 后台标签(hidden)里 getClientRects() 恒为 0，不能拿"看不见"当不点的理由
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

    // ======================= linux.do 分支 =======================
    const COMMON = {
        MSECS_MIN: 800, MSECS_MAX: 1400,
        FLOOR_INTERVAL: 800,
        MAX_BATCH: 60,
        TOPIC_OVERHEAD_MS: 2300,
        ENTER_MIN: 700, ENTER_MAX: 1200,
        HARD_BLOCK_RETRY_THRESHOLD: 600, CF_BACKOFF_MS: 10000, MAX_CONSEC_CF: 5,
        LIKE_REACTION: "heart",
        GITHUB_LIST_URL: "https://raw.githubusercontent.com/cler1818/Note/refs/heads/main/linuxdo/name.txt",
        WHITELIST_CACHE_KEY: "ld_helper_whitelist",
        REQLOG_KEY: "ld_helper_reqlog", WINDOW_MS: 60 * 60 * 1000,
        WARN_REQ: 130, REFUSE_START: 165, HARD_STOP: 185, SAFE_RESUME: 120
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
    let arState = "idle", arText = "", arBal = "";
    let anyState = "idle";
    let me = { username: "", trustLevel: null };
    let summary = null, summaryState = "idle";     // TL0/1 的摘要统计
    let ldc = { state: "idle", value: "", msg: "" };

    let plan = { topics: 0, replies: 0, likes: 0 };
    const sent = { topics: 0, replies: 0, likes: 0, timingReq: 0 };
    const handledLikeTopics = new Set();

    function elapsed() { return startedAt ? Date.now() - startedAt : 0; }
    function readJson(k, fb) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? fb : v; } catch (_) { return fb; } }
    function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
    function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    /* readTL3 / getAnyBan 在 render 里每秒被调用多次，而 render 在刷帖时每秒跑一遍。
     * 直接读 GM 存储 + JSON.parse 的话，500 分钟挂机会产生数万次同步读，明显拖慢页面。
     * 这里做 3 秒的内存缓存；写入方（storeTL3 / saveAnyBan / clearAnyBan）负责失效。 */
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
    // Q5：TL0/1 时 connect 拿不到明细，跳过同步；trust_level 未知(TL?)时仍同步
    function isLowTL() { return me.trustLevel !== null && me.trustLevel <= 1; }

    /* ============================================================
     * Credit 积分（Q6=a / Q7=90s / Q15 / Q11）
     * ============================================================ */
    function creditBalKey(u) { return CREDIT.BALPREFIX + (normUser(u) || "unknown"); }
    function readCreditCache(u) {
        try {
            const v = JSON.parse(gmGet(creditBalKey(u), "null"));
            if (v && v.day === todayStr() && v.v) return v;   // 跨天自动作废
        } catch (_) {}
        return null;
    }
    function writeCreditCache(u, val) { gmSet(creditBalKey(u), JSON.stringify({ v: val, at: Date.now(), day: todayStr() })); }
    // toFixed(2) 后去掉尾随 0 → 1215.90 → 1215.9；1200.00 → 1200
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
        if (r.status >= 400 || b.error_msg) throw new Error(b.error_msg || ("HTTP " + r.status));
        const d = b && b.data;
        if (!d || d.available_balance === undefined || d.available_balance === null) throw new Error("缺少 available_balance");
        return { username: normUser(d.username), id: Number(d.id) || 0, balance: fmtLdc(d.available_balance) };
    }

    /* ---- Credit 纯代码 OAuth（不开任何标签页）----
     * 实测 GET /api/v1/oauth/state 返回 404，说明 state/nonce 是登录页前端自己生成的 UUID
     * （此前抓包也确认两者是同一个 UUID）。所以这里自己生成一个，直接走授权流程：
     *   生成UUID → GM请求 connect 授权页 → 解析"允许"链接 → GM请求它拿到 code
     *   → GM请求 credit 回调种 Cookie → 读余额
     * 全程 5 个跨域请求，2~3 秒完成，完全不受后台标签节流影响。 */
    function uuid4() {
        // crypto.randomUUID 在部分旧内核里没有，退化到 getRandomValues 手拼
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
        if (a.status >= 400 || /just a moment|cf-chl|cloudflare|attention required/i.test(a.responseText || "")) {
            throw arNonJsonError(a, a.finalUrl);
        }
        // 之前授权过的话，授权页会直接 302 带回 code；否则要再点一次"允许"
        let cs = paramsFrom(a.finalUrl) || paramsFromText(a.responseText);
        if (!cs) {
            const ap = parseApprove(a.responseText);
            if (!ap) throw new Error("授权页无允许链接(Linux DO登录态可能失效)");
            const approved = await gmFetch(new URL(ap, CONNECT_HOST).href, {
                headers: { "Accept": "text/html,application/xhtml+xml" }, timeout: 15000
            });
            cs = paramsFrom(approved.finalUrl) || paramsFromText(approved.responseText);
        }
        if (!cs) throw new Error("授权完成但没返回code");
        // 回调到 Credit 让它种下登录 Cookie（这一步是页面路由，返回 HTML 也算正常）
        await gmFetch(CREDIT.REDIRECT + "?code=" + encodeURIComponent(cs.code) + "&state=" + encodeURIComponent(cs.state), {
            headers: { "Accept": "text/html,application/xhtml+xml" }, timeout: 15000
        }).catch(function () {});
        return await creditUserInfo(CREDIT.API_TIMEOUT);
    }

    /* ---- 前台标签兜底 ----
     * 纯代码失败（多半是 Credit 的回调必须由前端 JS 完成）时，开一个前台标签让站点自己跑完。
     * 用前台是因为后台标签会被 Chrome 节流：Next.js 的 JS 根本跑不完，登录按钮不会渲染。
     * 拿到余额立刻关闭，最长 30 秒。 */
    function creditForegroundLogin() {
        return new Promise(function (resolve, reject) {
            let handle = null;
            try { handle = GM_openInTab(CREDIT.HOST + "/home?ldh_credit_auto=1", { active: true, insert: true, setParent: true }); }
            catch (_) { handle = null; }
            if (!handle) { reject(new Error("无法打开标签")); return; }
            const started = Date.now();
            const iv = setInterval(function () {
                if (Date.now() - started > CREDIT.TAB_TIMEOUT) {
                    clearInterval(iv); try { handle.close(); } catch (_) {}
                    reject(new Error("超时")); return;
                }
                creditUserInfo(CREDIT.API_TIMEOUT).then(function (info) {
                    clearInterval(iv); try { handle.close(); } catch (_) {}
                    resolve(info);
                }).catch(function () { /* 还没登录完，继续等 */ });
            }, 1000);
        });
    }

    /* 刷新 LDC 积分
     *   当天成功过 → 直接吃缓存，一个请求都不发
     *   否则       → 纯代码；失败再开前台标签（受互斥锁保护，手动点击不受限）
     *   失败不锁定当天，下次打开论坛重新走一遍 */
    async function refreshCredit(manual) {
        if (idleSuspended && !manual) return;    // 刷帖期间不发任何 Credit 请求
        const u = me.username;
        if (!u) return;

        if (!manual) {
            const cache = readCreditCache(u);
            if (cache) { ldc = { state: "ok", value: cache.v, msg: "" }; render(); return; }
        }
        ldc = { state: "loading", value: "", msg: "读取中…" }; render();

        let info = null;
        try { info = await creditUserInfo(CREDIT.API_TIMEOUT); }
        catch (e) {
            if (!e || !e.needLogin) { ldc = { state: "fail", value: "", msg: (e && e.message) || "读取失败" }; render(); return; }
            // 未登录 → 先试纯代码
            try { info = await creditCodeLogin(); }
            catch (e2) {
                // 纯代码也不行 → 前台标签兜底。没登录论坛时开了也是白开
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
        // 账号核对：论坛和 Credit 登录的不是同一个号时，绝不把别人的余额当成你的
        if (info.username && normUser(u) && info.username !== normUser(u)) {
            ldc = { state: "mismatch", value: "", msg: "论坛 @" + u + " / Credit @" + info.username };
            render(); return;
        }
        writeCreditCache(u, info.balance);
        ldc = { state: "ok", value: info.balance, msg: "" };
        render();
    }

    /* ============================================================
     * summary.json（TL0/1 专用，需求 10）
     * ============================================================ */
    async function fetchSummary(username) {
        const r = await fetch("/u/" + encodeURIComponent(username) + "/summary.json", {
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
    // Q11：1天9小时 → 9小时46分 → 46分钟 → 35秒
    function fmtDur(sec) {
        sec = Math.max(0, Number(sec) || 0);
        const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
              m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        if (d > 0) return h > 0 ? d + "天" + h + "小时" : d + "天";
        if (h > 0) return m > 0 ? h + "小时" + m + "分" : h + "小时";
        if (m > 0) return m + "分钟";
        return s + "秒";
    }
    function loadSummary() {
        if (!me.username) return;
        summaryState = "loading"; render();
        fetchSummary(me.username).then(function (s) { summary = s; summaryState = "ok"; render(); })
            .catch(function () { summary = null; summaryState = "fail"; render(); });
    }

    // ---- 后台同步等级3（I2：删除前台兜底）----
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
                if (data && storeTL3(data, me.username)) { _tl3Cache = { key: "", at: 0, v: null }; syncAt = Date.now(); syncState = readTL3() ? "ok" : "otheruser"; render(); }
                else { onFail("empty"); }
            },
            onerror: function () { onFail("err"); },
            ontimeout: function () { onFail("err"); }
        });
    }
    function openConnectTab() {
        // I2：只后台开，不做前台兜底
        syncState = "opening"; render();
        // 轮询要拿"最新写入时间"来判断后台标签是否已完成，必须绕过 readTL3 的 3 秒缓存
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
    function sync() {
        // Q9=b：TL0/1 时 ⟳ 改成刷新 summary.json
        if (isLowTL()) { loadSummary(); return; }
        if (syncState === "syncing" || syncState === "opening") return;
        syncViaXhr(function () { openConnectTab(); });
    }

    // ---- 频率窗口 ----
    function logTimingReq() { const a = readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return Date.now() - t < COMMON.WINDOW_MS; }); a.push(Date.now()); writeJson(COMMON.REQLOG_KEY, a); }
    function recentTimingCount() { return readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return Date.now() - t < COMMON.WINDOW_MS; }).length; }
    function budgetHit() {
        const M = MODES[activeMode];
        if (!M || M.noLimit) return false;
        return recentTimingCount() >= COMMON.HARD_STOP || sent.timingReq >= M.safety;
    }
    function minutesUntilBelow(target) {
        const now = Date.now(); const arr = readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return now - t < COMMON.WINDOW_MS; }).sort(function (a, b) { return a - b; });
        if (arr.length <= target) return 0;
        return Math.max(1, Math.ceil((arr[arr.length - target - 1] + COMMON.WINDOW_MS - now) / 60000));
    }

    /* ---- 核心调度：间隔真随机 + 全程铺满 ---- */
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
            cap = clamp(Math.round(avg * 2), GAP_MIN_MS + 200, GAP_MAX_MS);
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
            const lo = Math.max(GAP_MIN_MS, Math.round(avgGap * 0.4));
            const hi = Math.max(lo + 500, Math.min(GAP_MAX_MS, Math.round(avgGap * 1.6)));
            interval = randInt(lo, hi);
            cap = hi;
            estReq = minReq;
        }
        let batch = batchOverride !== null ? batchOverride : (remReplies > 0 ? Math.round(remReplies / estReq) : 1);
        batch = clamp(batch, 1, COMMON.MAX_BATCH);
        return { batch: batch, interval: interval, remReq: estReq, remTime: remTime, cap: cap };
    }

    // ---- API ----
    function csrfMeta() { const m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute("content") : ""; }
    async function getCsrf() { let t = csrfMeta(); if (t) return t; try { const r = await fetch("/session/csrf.json", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); t = (await r.json()).csrf || ""; } catch (_) {} return t; }
    // A1(b)：真实等级取 trust_level
    async function getUser() {
        try {
            const r = await fetch("/session/current.json", { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } });
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

    /* ---- 主题池 ---- */
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

    /* ---- 点赞 ---- */
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

    // ---- 引擎 ----
    async function engine(mode) {
        const M = MODES[mode];
        const T = totalMs(M);
        me = await getUser(); if (!me.username) return finish("未登录", "未登录");
        gmSet(LD_USER_KEY, normUser(me.username));
        csrf = await getCsrf(); if (!csrf) return finish("无CSRF", "无CSRF");

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

        pool.reset();

        while (!abort && elapsed() < T) {
            if (budgetHit()) { endNote = "本窗口达上限"; break; }
            await maybeLike();
            if (abort || elapsed() >= T) break;

            const tid = await nextTopic(M.minPosts);
            if (!tid) {
                const s = schedule(T);
                await sleep(Math.min(s.interval, 5000));
                if (pool.exhausted) { pool.reset(); }
                continue;
            }

            const meta = await enterTopic(tid);
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
        while (likeSlots.length && !likeDead && !abort) { likeSlots.shift(); await doOneLike(); }
        finish("done");
    }

    function finish(reason, note) {
        const M = MODES[activeMode]; const used = M ? Math.min(elapsed(), totalMs(M)) : elapsed();
        running = false; finishedOnce = true; if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
        frozenTimer = "⏱ " + mmss(used); if (note) endNote = note; activeMode = "";
        writeJson("ld_helper_last", { at: Date.now(), sent: { topics: sent.topics, replies: sent.replies, likes: sent.likes }, frozen: frozenTimer, endNote: endNote });
        restoreButtons();
        resumeIdleWork();          // 运行期被冻结的观察器/后台任务，收工后恢复
        render();
    }
    function startMode(mode) {
        // 再点一次同一个按钮 = 停止。wakeAll() 让正在 sleep 的调度立刻醒来，
        // 不必等剩余间隔（挂机模式最长 60 秒）跑完，点了就有反应。
        if (running) { if (mode === activeMode) { abort = true; wakeAll(); } return; }
        const M = MODES[mode];
        if (!M.noLimit) {
            const rc = recentTimingCount();
            if (rc >= COMMON.REFUSE_START) { banMsg = "⛔ 本窗口已发" + rc + "次，约" + minutesUntilBelow(COMMON.SAFE_RESUME) + "分钟后再来"; finishedOnce = false; render(); return; }
        }
        banMsg = ""; endNote = ""; frozenTimer = ""; running = true; abort = false; activeMode = mode; startedAt = Date.now(); consecCf = 0;
        sent.topics = 0; sent.replies = 0; sent.likes = 0; sent.timingReq = 0; handledLikeTopics.clear();
        plan.topics = 0; plan.replies = 0; plan.likes = 0;
        suspendIdleWork();         // 刷帖期间只做刷帖，其它全停
        markButtons(mode); if (uiTimer) clearInterval(uiTimer); uiTimer = setInterval(render, 1000); render();
        engine(mode).catch(function (e) { finish("异常", "异常:" + (e && e.message || e)); });
    }

    /* ============================================================
     * AR 每日签到
     * 签到和余额【分开锁定】：
     *   DAYKEY 记"今天签过了"，BALDAY 记"今天余额读到了"。
     *   AgentRouter 一天只给一次奖励，所以签过就绝不重签；
     *   余额没读到只补查余额，不再白跑一遍完整 OAuth。
     * 三种进入路径：
     *   两个都锁定了     → 一个请求都不发，直接吃缓存
     *   只签到锁定了     → 只补查余额（不退出登录、不重新授权）
     *   都没锁定         → 走完整签到流程
     * 手动点 R1 的 Agent 文字 = force，强制重签 + 刷新余额，不受任何限制。
     * ============================================================ */
    function runArCheckin(force) {
        if (arState === "running") return;
        if (idleSuspended && !force) return;       // 刷帖期间不跑签到
        const today = todayStr();
        const signedToday = gmGet(AR.DAYKEY, "") === today;
        const balToday = gmGet(AR.BALDAY, "") === today;

        if (!force && signedToday && balToday) {
            // 两件事今天都成了：直接读缓存，零请求
            const saved = loadArNote();
            if (saved && saved.bal) { arState = saved.state; arText = saved.text; arBal = saved.bal; }
            else { arState = "ok"; arText = "签到成功"; arBal = gmGet(AR.BALKEY, "") || ""; }
            render(); return;
        }

        if (!force && signedToday) {
            // 今天已签到，只是余额没读到 —— 只补查余额，绝不重复签到
            arState = "running"; arText = "读取余额中…"; arBal = ""; render();
            arBalance(null, { retries: 3 }).then(function (bal) {
                arState = "ok"; arText = "签到成功"; arBal = bal;
                gmSet(AR.BALKEY, bal); gmSet(AR.BALDAY, today);
                saveArNote(arState, arText, arBal);
                render();
            }).catch(function (e) {
                // 签到本身是成功的，只是余额读不到 → 待刷新，不是失败
                arState = "pending"; arBal = "";
                arText = "签到已成功，余额读取失败：" + ((e && e.message) || e) + "，点击重试";
                saveArNote("pending", arText, "");
                render();
            });
            return;
        }

        arState = "running"; arText = "签到中…"; arBal = ""; render();
        // 内部进度(退出登录/获取state/…)只进 arText 供 tooltip 用，面板固定显示"签到中…"
        arCheckin(function (s) { arText = s; }, force).then(function (r) {
            // 签到这一步已经成功，先把它锁住，后面余额失败也不用重签
            gmSet(AR.DAYKEY, today);
            /* 关键：GM 请求完成 OAuth 回调后，Set-Cookie 写进浏览器还需要一点时间。
             * 立刻查余额多半会 401（这就是"刷新一下就好了"的原因），所以先等 800ms。 */
            return arBalance(r && r.user, { waitFirst: 800, retries: 3 }).then(function (bal) {
                arState = "ok"; arText = "签到成功"; arBal = bal;
                gmSet(AR.BALKEY, bal); gmSet(AR.BALDAY, today);
                saveArNote(arState, arText, arBal);
                render();
            }).catch(function (e) {
                arState = "pending"; arBal = "";
                arText = "签到已成功，余额读取失败：" + ((e && e.message) || e) + "，点击重试";
                saveArNote("pending", arText, "");
                render();
            });
        }).catch(function (e) {
            arState = "fail"; arText = (e && e.message) || String(e); arBal = "";
            saveArNote("fail", arText, "");
            render();
        });
    }
    // 在 AgentRouter 标签页手动登录后回写的余额：切回论坛时取一次，只覆盖余额
    function pullSideBalance() {
        if (idleSuspended) return;
        try {
            const v = JSON.parse(gmGet(AR.SIDEKEY, "null"));
            if (!v || !v.bal) return;
            if (Date.now() - Number(v.at || 0) > 30 * 60 * 1000) return;
            if (v.bal === arBal) return;
            arBal = v.bal;
            gmSet(AR.BALKEY, v.bal); gmSet(AR.BALDAY, todayStr());
            // 你在 AgentRouter 标签手动登录后拿到了余额，"待刷新"就该转成成功
            if (arState === "pending") { arState = "ok"; arText = "签到成功"; }
            if (arState === "ok") saveArNote(arState, arText, arBal);
            render();
        } catch (_) {}
    }

    /* ============================================================
     * UI
     * ============================================================ */
    function mSpan(label, m) { if (!m) return ""; const ok = (m.c || 0) >= (m.r || 0); return '<span style="color:' + (ok ? "#8fe0b0" : "#ff8a8a") + ';">' + label + fmtNum(m.c) + "/" + fmtNum(m.r) + "</span>"; }
    // C3：被举报→r2 末尾，举报用户/禁言/封禁→r3 末尾；仅 >0 时显示（C2=a）
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
        // 需求 10：TL0/1 显示 summary.json 六项（方案 C2，两行写全标签）
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
        // TL2+ / TL?：走 connect 等级3进度
        const raw = readTL3();
        if (!raw) {
            const s = syncState === "syncing" ? "（后台同步中…）" : syncState === "opening" ? "（正在打开 connect 同步…）" : syncState === "popupblock" ? "（弹窗被拦，允许本站弹窗后再点⟳）" : syncState === "otheruser" ? "（connect 登录的是别的账号，用本号登录）" : syncState === "nogrant" ? "（缺跨域权限，去油猴放行 connect）" : "（点右上 ⟳ 同步，会自动开一次 connect）";
            return ["等级3 未同步", s];
        }
        if (raw.locked) return ["等级0/1 未到2级，暂时看不到进度", "达到2级后 connect 才显示明细"];
        const m = raw.metrics || {};
        const c2 = complianceFor(2), c3 = complianceFor(3);
        /* 举报项只在 >0 时出现(C2=a)，此时行会变长：
         *   r2 + "⚠被举报3"        = 252px（可用 249px，溢出 3px）
         *   r3 + "⚠举报2 禁言1 封禁1" = 298px（溢出 49px，会把"封禁1"整个吃掉）
         * 举报/禁言/封禁恰恰是最该看清的，所以这两行一旦挂上举报项就把指标标签缩写，
         * 省下 30~40px。没有举报时(绝大多数情况)标签保持全称，显示完全不变。 */
        const A = c2
            ? [mSpan("访", m.visit_days), mSpan("题", m.topics_viewed), mSpan("帖", m.posts_viewed), mSpan("复", m.topics_replied)].filter(Boolean).join(" ")
            : [mSpan("访问", m.visit_days), mSpan("话题", m.topics_viewed), mSpan("帖子", m.posts_viewed), mSpan("回复", m.topics_replied)].filter(Boolean).join(" ");
        const B = c3
            ? [mSpan("赞", m.likes_given), mSpan("获", m.likes_received), mSpan("赞天", m.liked_days), mSpan("赞人", m.liked_by_users)].filter(Boolean).join(" ")
            : [mSpan("点赞", m.likes_given), mSpan("获赞", m.likes_received), mSpan("获赞天数", m.liked_days), mSpan("获赞用户", m.liked_by_users)].filter(Boolean).join(" ");
        return [(A || "等级3 数据不全，去 connect 刷新") + c2, (B || "—") + c3];
    }
    /* ---- R1 布局 ----
     * 用户名   TL3   LDC：1215.9   Agent：$129.11              ⏱计时
     * 四段之间各三个空格（两个 &nbsp; + 一个普通空格，纯空格会被 HTML 合并）。
     * 实测(可用 249px)：10px 字号要 275px 放不下，降到 9px 后是 248px 刚好。
     * 所以 R1 用 9px（面板 CSS 里已同步）。 */
    const SP3 = "&nbsp;&nbsp; ";
    // 等级徽章：一律绿色；取不到 trust_level 显示 TL? 灰；未登录时整个不显示
    function tlBadge() {
        if (!me.username) return "";
        const tl = me.trustLevel;
        if (tl === null) return '<span style="color:#aaa;">' + SP3 + 'TL?</span>';
        return '<span style="color:#8fe0b0;">' + SP3 + "TL" + tl + "</span>";
    }
    // LDC 三态：LDC：获取中 / LDC：1215.9 / LDC：失败
    function ldcSpan() {
        if (!me.username) return "";
        const base = '<span id="ldh_ldc" style="cursor:pointer;';
        if (ldc.state === "ok") {
            return base + 'color:#8fe0b0;" title="' + esc(ldc.msg || "可用 LINUX DO Credits，点击刷新") + '">' + SP3 + "LDC：" + esc(ldc.value) + "</span>";
        }
        if (ldc.state === "loading") return base + 'color:#e0c060;" title="' + esc(ldc.msg || "读取中") + '">' + SP3 + "LDC：获取中</span>";
        if (ldc.state === "mismatch") return base + 'color:#ff8a8a;" title="' + esc(ldc.msg) + '">' + SP3 + "LDC：账号不符</span>";
        if (ldc.state === "fail") return base + 'color:#ff8a8a;" title="' + esc(ldc.msg || "读取失败，点击重试") + '">' + SP3 + "LDC：失败</span>";
        return base + 'color:#888;" title="点击读取 Credit 积分">' + SP3 + "LDC：获取中</span>";
    }
    /* R1 上的 Agent 四态：
     *   获取中   黄  正在签到或读余额
     *   $129.11  绿  签到+余额都到手
     *   待刷新   黄  签到确实成功了，只是余额没读到（点击可只补查余额）
     *   失败     红  签到本身失败，tooltip 里有具体原因 */
    function arSpan() {
        if (!me.username) return "";
        const base = '<span id="ldh_arbal" style="cursor:pointer;';
        if (arState === "running") return base + 'color:#e0c060;" title="' + esc(arText || "签到中") + '">' + SP3 + "Agent：获取中</span>";
        if (arState === "pending") return base + 'color:#e0c060;" title="' + esc(arText || "签到已成功，余额读取失败，点击重试") + '">' + SP3 + "Agent：待刷新</span>";
        if (arState === "fail") return base + 'color:#ff8a8a;" title="' + esc(arText || "签到失败") + '">' + SP3 + "Agent：失败</span>";
        if (arState === "ok" && arBal) return base + 'color:#8fe0b0;" title="点击强制重新签到">' + SP3 + "Agent：" + esc(arBal) + "</span>";
        if (arState === "ok") return base + 'color:#e0c060;" title="签到成功，余额读取中">' + SP3 + "Agent：获取中</span>";
        return base + 'color:#888;" title="点击签到">' + SP3 + "Agent：获取中</span>";
    }
    /* ---- r4 文案（实测宽度均在 249px 内，9px 字号）----
     *   ① 未跑刷帖   Agent：签到成功 · 余额 $129.11          134px
     *   ② 刷帖中     刷帖中：主题 1/16 丨 回复 13/210 丨 点赞 0/3   191~234px
     *   ③ 刷帖结束   脚本结束：主题 1 丨 回复 13 丨 点赞 0      184px（不带 Agent，带上会溢出 12px）
     *   ④ 未登录     脚本结束：主题 0 丨 回复 0 丨 点赞 0 ·未登录  184px
     * 运行中的异常（本窗口达上限 / 24h封禁 / 点赞被限流）一律不显示，
     * 只有"启动失败"类（未登录 / 无CSRF）才追加到 ③ 后面。 */
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
    /* ---- r4 错误汇总 ----
     * 平时完全空白；一旦哪里出错就把所有错误用 " / " 拼起来显示。
     * 超过 22 字截断加省略号，完整内容进 tooltip（249px 放不下长错误信息）。
     * Agent 的余额单独显示在 R1，所以这里只在它【失败或待刷新】时才补一条错误。 */
    const ERR_MAXLEN = 22;
    function collectErrors() {
        const list = [];
        /* R1 上只显示了状态词（Agent：失败 / LDC：失败），看不出为什么失败，
         * 所以 R4 这里补带原因的完整说明。"待刷新"R1 已经说清楚了，不重复。 */
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
        // tooltip 给完整信息：t 已经包含详情时就不再重复贴 full
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

        // ---- r1：运行期只刷计时，用户名/等级/积分都不重算(不读 GM，不重建 DOM) ----
        // 没登录时 r1 直接标红提示，和 r4 的 ·未登录 呼应
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
            // r1 每次都由 innerHTML 重建，旧节点连同监听一起丢弃，这里必须重新绑定
            const bindLdc = document.getElementById("ldh_ldc");
            if (bindLdc) bindLdc.addEventListener("click", function () { refreshCredit(true); });
            const bindAr = document.getElementById("ldh_arbal");
            if (bindAr) bindAr.addEventListener("click", function () {
                /* 待刷新 = 今天已经签到成功、只差余额。这时点一下不该重新走一遍
                 * 完整 OAuth（会白白退出再登录），走 force=false 让它只补查余额。 */
                runArCheckin(arState !== "pending");
            });
        }

        // ---- r2/r3：运行期完全冻结（rowsForPanel 会读 GM 存储，每秒读一次太贵）----
        if (!running) {
            const rows = rowsForPanel();
            document.getElementById("ldh_r2").innerHTML = rows[0];
            document.getElementById("ldh_r3").innerHTML = rows[1];
        }

        // ---- r4 ----
        const r4 = document.getElementById("ldh_r4");
        if (running || finishedOnce) {
            // 只有"启动失败"才显示原因；运行中的异常一律不显示
            const showNote = !running && endNote && START_FAIL.indexOf(endNote) >= 0;
            const note = showNote ? ' <span style="color:#ff8a8a;">·' + esc(endNote) + "</span>" : "";
            r4.innerHTML = progressText() + note;
        } else if (banMsg) {
            r4.innerHTML = '<span style="color:#ff8a8a;">' + esc(banMsg) + "</span>";
        } else {
            // 平时完全空白，只在真出错时才显示（Agent 余额在 R1，不在这里重复）
            r4.innerHTML = errorLine();
        }

        // ---- 标题栏按钮：运行期不更新（会读 GM 存储）----
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
        // 封禁时 Any 按钮变红
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
    // H2：删除 scale(0.9)，右移量 = 2 × 面板宽
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
    /* 发帖框观察器：监听整个 documentElement 的 class 变化，
     * Discourse 页面 class 抖动很频繁，刷帖时这个观察器会持续触发回调 —— 所以运行期要停掉。 */
    let composerMo = null, composerTimer = null;
    function watchComposer() {
        if (composerMo) return;
        function syncC() { const open = composerOpen(); if (open !== composerMin) { composerMin = open; applyMin(); } }
        composerMo = new MutationObserver(function () {
            if (composerTimer) return;
            composerTimer = setTimeout(function () { composerTimer = null; syncC(); }, 150);
        });
        try { composerMo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] }); } catch (_) {}
        syncC();
    }
    function stopWatchComposer() {
        if (composerMo) { try { composerMo.disconnect(); } catch (_) {} composerMo = null; }
        if (composerTimer) { clearTimeout(composerTimer); composerTimer = null; }
    }

    /* ---- 运行期冻结 ----
     * 点下刷帖按钮后，页面上只该跑刷帖本身。这里把所有"闲时工作"停掉：
     *   · 发帖框观察器（运行期你不会去发帖）
     *   · Credit 积分刷新、AR 签到、别处登录的余额回写
     *   · 面板收起状态复位（composerMin 归位，否则面板会保持躲避位置）
     * 收工后 resumeIdleWork() 原样恢复。 */
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

    function createUI() {
        if (document.getElementById("ldh_panel")) return;
        const p = document.createElement("div"); p.id = "ldh_panel";
        // H2：265px 实宽、无 scale、内边距 8px、字号按旧值 ×0.9
        p.style.cssText = "position:fixed;bottom:18px;left:16px;z-index:999999;background:rgba(18,18,18,0.86);color:#fff;" +
            "padding:2px " + UI.PAD_X + "px 9px " + UI.PAD_X + "px;border-radius:9px;width:" + UI.WIDTH + "px;box-sizing:border-box;" +
            "font-size:10px;line-height:14px;box-shadow:0 6px 16px rgba(0,0,0,0.4);overflow:visible;";
        const rowCss = "white-space:nowrap;overflow:hidden;min-height:14px;";
        const btnCss = "flex:1;padding:8px 2px;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:11px;white-space:nowrap;";
        const smallBtnCss = "padding:3px 5px;border:none;border-radius:4px;cursor:pointer;font-size:9px;margin-left:4px;";
        p.innerHTML =
            '<div id="ldh_title" style="display:flex;justify-content:space-between;align-items:center;cursor:move;min-height:20px;padding:4px 0 0 0;line-height:1.6;overflow:visible;">' +
            '<span style="font-weight:bold;font-size:10px;">⚡ LINUX DO 助手</span>' +
            '<span style="display:flex;align-items:center;">' +
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
            // R1 有四段内容，10px 放不下(275px>249px)，9px 才够(248px)
            '<div id="ldh_r1" style="' + rowCss + 'font-size:9px;"></div>' +
            '<div id="ldh_r2" style="' + rowCss + 'font-size:9px;"></div>' +
            '<div id="ldh_r3" style="' + rowCss + 'font-size:9px;"></div>' +
            '<div id="ldh_r4" style="' + rowCss + 'margin-top:2px;font-size:9px;"></div>' +
            '</div>';
        document.body.appendChild(p);
        MODE_KEYS.forEach(function (m) { document.getElementById("ldh_" + m).addEventListener("click", function () { startMode(m); }); });
        document.getElementById("ldh_sync").addEventListener("click", function () { sync(); });
        document.getElementById("ldh_min").addEventListener("click", function () { toggleMin(); });
        document.getElementById("ldh_any").addEventListener("click", function () {
            // Q7：手动点击 = 清除封禁标记并重试
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
        manualMin = sessionStorage.getItem("ldh_min") === "1"; applyMin();
        watchComposer();

        const saved = loadArNote();
        if (saved) { arState = saved.state; arText = saved.text; arBal = saved.bal; }

        render();
        window.addEventListener("beforeunload", function (e) { if (running) { e.preventDefault(); e.returnValue = ""; return ""; } });

        getUser().then(function (u) {
            me = u;
            if (me.username) gmSet(LD_USER_KEY, normUser(me.username));
            render();
            if (!me.username) return;
            // TL0/1 在 connect 上拿不到明细，改拉 summary.json；两者都做 10 分钟节流
            if (isLowTL()) {
                if (!sessionStorage.getItem("ldh_autosum")) {
                    sessionStorage.setItem("ldh_autosum", "1");
                    const lastSum = Number(localStorage.getItem("ldh_autosum_ts") || 0);
                    if (Date.now() - lastSum > SYNC_THROTTLE_MS) { localStorage.setItem("ldh_autosum_ts", String(Date.now())); loadSummary(); }
                    else { loadSummary(); }   // 有节流也要显示一次：读的是本地已有数据，不发请求
                }
            } else if (!sessionStorage.getItem("ldh_autosync")) {
                sessionStorage.setItem("ldh_autosync", "1");
                const lastTs = Number(localStorage.getItem("ldh_autosync_ts") || 0);
                if (Date.now() - lastTs > SYNC_THROTTLE_MS) { localStorage.setItem("ldh_autosync_ts", String(Date.now())); sync(); }
            }
            /* Credit 与 AgentRouter 串行：两个都可能开前台标签抢焦点，
             * 必须等前一个彻底结束（成功/失败/超时）再启动后一个，否则会连弹两个标签。 */
            setTimeout(function () {
                refreshCredit(false).catch(function () {}).then(function () { runArCheckin(false); });
            }, 1200);
        });

        // 切回标签页时读一次别处登录回写的余额
        window.addEventListener("focus", pullSideBalance);
        document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") pullSideBalance(); });
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
