// ==UserScript==
// @name         LINUX DO 助手（日常维护 / 快速升级 · 含等级3进度）
// @namespace    http://tampermonkey.net/
// @version      6.7.2
// @description  两个按钮：日常维护、快速升级。墙钟默认运行3/10分钟，但按目标阅读时长(日常20-60分/快速50-100分)反推每帖上报毫秒，让论坛记录到设定的阅读时长(方案A·按比例，读满即准)。先点赞(白名单·带时间上限)后刷帖(热帖·匀速铺满到正好收尾)。正计时。面板4行固定。等级3进度：后台自动跨域抓 connect(不用打开网页)+定时刷新+手动同步，按当前登录用户分开存(多账号各看各的)。按实测规律避开~200次/窗口的24h硬封。
// @match        https://linux.do/*
// @match        https://connect.linux.do/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      connect.linux.do
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";
    if (window.top !== window.self) return;

    // ============ 顶部可调配置（含首尾，运行时区间内随机取整数） ============
    // —— 日常维护 ——
    const DAILY_READ_MIN = [20, 60];      // 目标阅读时间（分钟）：论坛最终记录的时长
    const DAILY_TOPICS   = [20, 30];      // 主题数量
    const DAILY_REPLIES  = [200, 300];    // 帖子(回复)数量
    const DAILY_LIKES    = [1, 3];        // 点赞数量
    const DAILY_RUN_MIN  = 3;             // 墙钟运行时间（分钟）：脚本实际跑多久
    // —— 快速升级 ——
    const FAST_READ_MIN  = [50, 100];     // 目标阅读时间（分钟）
    const FAST_TOPICS    = [50, 100];     // 主题数量
    const FAST_REPLIES   = [2000, 3000];  // 帖子(回复)数量
    const FAST_LIKES     = [3, 5];        // 点赞数量
    const FAST_RUN_MIN   = 10;            // 墙钟运行时间（分钟）
    // ================================================================

    // ============ 共享工具 ============
    function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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

    // ================= connect.linux.do 分支：抓等级3存 GM，然后结束 =================
    if (location.hostname === "connect.linux.do") {
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
                toast(okStore ? (d.locked ? "等级3：未到2级，已记录 ✔" : "✅ 等级3进度已同步") : "等级3：没读到账号，回 linux.do 点 ⟳ 重试");
                if (autoClose && okStore) setTimeout(function () { try { window.close(); } catch (_) {} }, 1000);
            } else if (tries > 25) { clearInterval(iv); if (autoClose) setTimeout(function () { try { window.close(); } catch (_) {} }, 500); }
        }, 800);
        return;
    }

    // ======================= linux.do 分支 =======================
    const COMMON = {
        MSECS_MIN: 300, MSECS_MAX: 60000,   // 每帖上报毫秒的兜底夹取范围（实际值由目标阅读时长÷计划帖子数反推）
        MIN_INTERVAL: 900, MAX_SPREAD_INTERVAL: 20000,
        ENTER_MIN: 700, ENTER_MAX: 1200,
        HARD_BLOCK_RETRY_THRESHOLD: 600, CF_BACKOFF_MS: 10000, MAX_CONSEC_CF: 5,
        LIKE_REACTION: "heart",
        GITHUB_LIST_URL: "https://raw.githubusercontent.com/cler1818/Note/refs/heads/main/name.txt",
        WHITELIST_CACHE_KEY: "ld_helper_whitelist",
        REQLOG_KEY: "ld_helper_reqlog", WINDOW_MS: 60 * 60 * 1000,
        WARN_REQ: 130, REFUSE_START: 165, HARD_STOP: 185, SAFE_RESUME: 120,
        TL3_SYNC_INTERVAL_MS: 30 * 60 * 1000
    };
    const MODES = {
        daily: { name: "日常维护", runSeconds: DAILY_RUN_MIN * 60, readMin: DAILY_READ_MIN, topics: DAILY_TOPICS, replies: DAILY_REPLIES, likes: DAILY_LIKES, batch: [10, 16], perTopic: [15, 90], safety: 160, likeCapMs: 60000 },
        fast: { name: "快速升级", runSeconds: FAST_RUN_MIN * 60, readMin: FAST_READ_MIN, topics: FAST_TOPICS, replies: FAST_REPLIES, likes: FAST_LIKES, batch: [22, 38], perTopic: [40, 160], safety: 175, likeCapMs: 120000 }
    };

    let running = false, abort = false, activeMode = "", startedAt = 0, csrf = "", consecCf = 0, uiTimer = null;
    let finishedOnce = false, frozenTimer = "", banMsg = "", endNote = "";
    let syncState = "idle", syncAt = 0;
    let me = { username: "" };
    let plan = { topics: 0, replies: 0, likes: 0, readMs: 0, perPostMs: 0 };
    const sent = { topics: 0, replies: 0, likes: 0, timingReq: 0, readMs: 0 };
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

    // (openConnectSync 已并入 sync() / openConnectTab)

    function logTimingReq() { const a = readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return Date.now() - t < COMMON.WINDOW_MS; }); a.push(Date.now()); writeJson(COMMON.REQLOG_KEY, a); }
    function recentTimingCount() { return readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return Date.now() - t < COMMON.WINDOW_MS; }).length; }
    function budgetHit() { return recentTimingCount() >= COMMON.HARD_STOP || sent.timingReq >= MODES[activeMode].safety; }
    function minutesUntilBelow(target) {
        const now = Date.now(); const arr = readJson(COMMON.REQLOG_KEY, []).filter(function (t) { return now - t < COMMON.WINDOW_MS; }).sort(function (a, b) { return a - b; });
        if (arr.length <= target) return 0;
        return Math.max(1, Math.ceil((arr[arr.length - target - 1] + COMMON.WINDOW_MS - now) / 60000));
    }
    function dynamicReadInterval() {
        const M = MODES[activeMode];
        const remReplies = Math.max(0, plan.replies - sent.replies);
        const remReq = Math.max(1, Math.ceil(remReplies / ((M.batch[0] + M.batch[1]) / 2)));
        const remTime = Math.max(0, M.runSeconds * 1000 - elapsed());
        let iv = remTime / remReq;
        iv = Math.max(COMMON.MIN_INTERVAL, Math.min(COMMON.MAX_SPREAD_INTERVAL, iv));
        return Math.round(iv * (0.8 + Math.random() * 0.4));
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
    // 每帖上报毫秒：目标阅读时长 ÷ 计划帖子数（方案A），±15% 随机抖动，最后夹到兜底范围内
    function perPostMs() {
        const base = plan.perPostMs || 1000;
        const ms = Math.round(base * (0.85 + Math.random() * 0.3));
        return Math.max(COMMON.MSECS_MIN, Math.min(COMMON.MSECS_MAX, ms));
    }
    async function postTimings(id, nums) {
        const p = new URLSearchParams(); p.set("topic_id", String(id)); let total = 0;
        nums.forEach(function (n) { const ms = perPostMs(); total += ms; p.set("timings[" + n + "]", String(ms)); });
        p.set("topic_time", String(total));
        let resp, body = "", ra = "", ct = "";
        try { resp = await fetch("/topics/timings", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", "Discourse-Present": "true" }, body: p.toString() }); }
        catch (e) { return { kind: "neterr" }; }
        try { ra = resp.headers.get("Retry-After") || ""; } catch (_) {}
        try { ct = resp.headers.get("Content-Type") || ""; } catch (_) {}
        try { body = await resp.text(); } catch (_) {}
        return { kind: classify(resp.status, body, ra, ct), ms: total };
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
    async function pickTopics(need) {
        async function list(url) { try { const r = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }); return ((await r.json()).topic_list || {}).topics || []; } catch (_) { return []; } }
        let raw = []; const src = ["/top.json?per_page=50", "/top.json?per_page=50&page=1", "/latest.json?order=posts", "/latest.json?order=posts&page=1"];
        for (let i = 0; i < src.length && raw.length < need + 15; i++) raw = raw.concat(await list(src[i]));
        const out = [], seen = new Set();
        raw.forEach(function (t) { const id = t && t.id ? String(t.id) : ""; if (!id || seen.has(id)) return; const h = Number(t.highest_post_number || t.posts_count || 0); if (h >= 20 && Number(t.last_read_post_number || 0) < h) { seen.add(id); out.push(id); } });
        return shuffle(out);
    }

    // ---- 引擎：先点赞 → 再刷帖铺满 ----
    async function engine(mode) {
        const M = MODES[mode];
        me = await getUser(); if (!me.username) return finish("未登录", "未登录");
        csrf = await getCsrf(); if (!csrf) return finish("无CSRF", "无CSRF");
        plan.topics = randInt(M.topics[0], M.topics[1]);
        plan.replies = randInt(M.replies[0], M.replies[1]);
        plan.likes = randInt(M.likes[0], M.likes[1]);
        // 方案A：目标阅读时长在区间内随机，均摊到计划帖子数上得到每帖毫秒
        plan.readMs = randInt(M.readMin[0], M.readMin[1]) * 60000;
        plan.perPostMs = Math.max(1, Math.round(plan.readMs / Math.max(1, plan.replies)));

        await doLikes(plan.likes, Date.now() + M.likeCapMs);           // 阶段1 先点赞

        const topicIds = await pickTopics(plan.topics + 15);           // 阶段2 刷帖铺满
        for (let i = 0; i < topicIds.length; i++) {
            if (abort || elapsed() >= M.runSeconds * 1000) break;
            if (sent.topics >= plan.topics && sent.replies >= plan.replies) break;
            if (budgetHit()) { endNote = "本窗口达上限"; break; }
            const meta = await enterTopic(topicIds[i]);
            await sleep(randInt(COMMON.ENTER_MIN, COMMON.ENTER_MAX));
            if (!meta.ok || meta.highest < 2) continue;
            const remTopics = Math.max(1, plan.topics - sent.topics), remReplies = Math.max(0, plan.replies - sent.replies);
            let want = sent.topics >= plan.topics ? remReplies : Math.round((remReplies / remTopics) * (0.6 + Math.random() * 0.8));
            want = Math.max(M.perTopic[0], Math.min(M.perTopic[1], want || M.perTopic[0]));
            const start = Math.max(2, meta.lastRead + 1), end = Math.min(meta.highest, start + want - 1);
            if (end < start) continue;
            const nums = []; for (let n = start; n <= end; n++) nums.push(n);
            let readThis = false, p = 0;
            while (p < nums.length) {
                if (abort || elapsed() >= M.runSeconds * 1000) break;
                if (sent.topics >= plan.topics && sent.replies >= plan.replies) break;
                if (budgetHit()) { endNote = "本窗口达上限"; break; }
                const batch = nums.slice(p, p + randInt(M.batch[0], M.batch[1]));
                sent.timingReq++;
                const res = await postTimings(topicIds[i], batch);
                if (res.kind === "ok") { consecCf = 0; logTimingReq(); sent.replies += batch.length; sent.readMs += (res.ms || 0); if (!readThis) { sent.topics++; readThis = true; } render(); p += batch.length; await sleep(dynamicReadInterval()); }
                else if (res.kind === "discourse_hard") { return finish("24h封禁", "该号24h封禁中"); }
                else if (res.kind === "cloudflare") { consecCf++; if (consecCf >= COMMON.MAX_CONSEC_CF) break; await sleep(COMMON.CF_BACKOFF_MS); }
                else if (res.kind === "discourse_soft") { await sleep(8000); }
                else { await sleep(1500); }
            }
        }
        while (!abort && elapsed() < M.runSeconds * 1000) await sleep(300);  // 空转到刚好收尾
        finish("done");
    }
    async function doLikes(target, deadline) {
        let names = shuffle((await loadNames()).filter(function (n) { return n && n.toLowerCase() !== me.username.toLowerCase(); }));
        for (let i = 0; i < names.length && sent.likes < target; i++) {
            if (abort || Date.now() >= deadline) break;
            const cands = await fetchUserPosts(names[i]); await sleep(randInt(500, 900));
            for (let j = 0; j < cands.length && sent.likes < target; j++) {
                if (abort || Date.now() >= deadline) break;
                const c = cands[j]; if (handledLikeTopics.has(c.topicId)) continue;
                if (await getReacted(c.postId)) { handledLikeTopics.add(c.topicId); await sleep(300); continue; }
                const code = await likeToggle(c.postId); await sleep(randInt(700, 1200));
                if (code >= 200 && code < 300) { sent.likes++; handledLikeTopics.add(c.topicId); render(); break; }
                if (code === 429) return;
            }
        }
    }

    function finish(reason, note) {
        const M = MODES[activeMode]; const used = M ? Math.min(elapsed(), M.runSeconds * 1000) : elapsed();
        running = false; finishedOnce = true; if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
        frozenTimer = "⏱ " + mmss(used); if (note) endNote = note; activeMode = "";
        writeJson("ld_helper_last", { at: Date.now(), sent: { topics: sent.topics, replies: sent.replies, likes: sent.likes, readMs: sent.readMs }, planReadMs: plan.readMs, frozen: frozenTimer, endNote: endNote });
        restoreButtons(); render();
    }
    function startMode(mode) {
        if (running) { if (mode === activeMode) abort = true; return; }
        const rc = recentTimingCount();
        if (rc >= COMMON.REFUSE_START) { banMsg = "⛔ 本窗口已发" + rc + "次，约" + minutesUntilBelow(COMMON.SAFE_RESUME) + "分钟后再来"; finishedOnce = false; render(); return; }
        banMsg = ""; endNote = ""; frozenTimer = ""; running = true; abort = false; activeMode = mode; startedAt = Date.now(); consecCf = 0;
        sent.topics = 0; sent.replies = 0; sent.likes = 0; sent.timingReq = 0; sent.readMs = 0; handledLikeTopics.clear();
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
        if (raw.locked) return ["等级3 未到2级，暂时看不到进度", "达到2级后 connect 才显示明细"];
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
        const timer = running && M ? "⏱ " + mmss(Math.min(elapsed(), M.runSeconds * 1000)) : frozenTimer;
        r1.innerHTML = (me.username || "未登录") + complianceTag() + '<span style="float:right;color:#8fe0b0;">' + timer + "</span>";
        const rows = tl3Rows();
        document.getElementById("ldh_r2").innerHTML = rows[0];
        document.getElementById("ldh_r3").innerHTML = rows[1];
        const r4 = document.getElementById("ldh_r4");
        const word = running ? "正在运行" : (finishedOnce ? "脚本结束" : "准备就绪");
        if (banMsg && !running && !finishedOnce) r4.innerHTML = '<span style="color:#ff8a8a;">' + banMsg + "</span>";
        else r4.innerHTML = word + "：主题 " + sent.topics + " 丨 回复 " + sent.replies + " 丨 点赞 " + sent.likes + " 丨 读" + Math.round(sent.readMs / 60000) + "分" + (plan.readMs ? "/" + Math.round(plan.readMs / 60000) : "") + (endNote ? ' <span style="color:#ff8a8a;">·' + endNote + "</span>" : "");
        const sy = document.getElementById("ldh_sync");
        if (sy) { const failed = (syncState === "cf" || syncState === "err" || syncState === "empty" || syncState === "login" || syncState === "nogrant" || syncState === "otheruser" || syncState === "popupblock"); const hasData = !!readTL3(); sy.textContent = (syncState === "syncing" || syncState === "opening") ? "同步中…" : (failed && !hasData) ? "⟳重试" : (syncState === "ok" || hasData) ? "✓已同步" : "⟳同步"; sy.style.color = (failed && !hasData) ? "#ff8a8a" : "#8fe0b0"; }
    }
    function markButtons(mode) { ["daily", "fast"].forEach(function (m) { const b = document.getElementById("ldh_" + m); if (!b) return; if (m === mode) { b.textContent = "停止"; b.style.background = "#8a3a3a"; } else { b.disabled = true; b.style.opacity = "0.5"; } }); }
    function restoreButtons() { const a = document.getElementById("ldh_daily"), b = document.getElementById("ldh_fast"); if (a) { a.textContent = "日常维护"; a.disabled = false; a.style.opacity = "1"; a.style.background = "#2f6f3e"; } if (b) { b.textContent = "快速升级"; b.disabled = false; b.style.opacity = "1"; b.style.background = "#33507a"; } }
    let manualMin = false, composerMin = false;
    function applyMin() {
        const body = document.getElementById("ldh_body"), ic = document.getElementById("ldh_min"), p = document.getElementById("ldh_panel");
        const collapsed = manualMin || composerMin;
        if (body) body.style.display = collapsed ? "none" : "block";
        if (ic) ic.textContent = collapsed ? "＋" : "－";
        if (p) {
            if (composerMin) { p.style.transform = ""; const r = p.getBoundingClientRect(); const shift = Math.max(0, Math.min(280, window.innerWidth - r.right - 4)); p.style.transform = "translateX(" + shift + "px)"; }
            else { p.style.transform = ""; }
        }
    }
    function toggleMin() { manualMin = !manualMin; try { sessionStorage.setItem("ldh_min", manualMin ? "1" : "0"); } catch (_) {} applyMin(); }
    function savePos(p) { try { sessionStorage.setItem("ldh_pos", JSON.stringify({ left: p.style.left, top: p.style.top })); } catch (_) {} }
    function restorePos(p) { try { const q = JSON.parse(sessionStorage.getItem("ldh_pos") || "null"); if (q && q.left && q.top) { p.style.left = q.left; p.style.top = q.top; p.style.bottom = "auto"; } } catch (_) {} }
    function enableDrag(p, handle) {
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        handle.addEventListener("mousedown", function (e) {
            if (e.target.closest("#ldh_sync") || e.target.closest("#ldh_min")) return;
            const r = p.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; dragging = true;
            p.style.left = ox + "px"; p.style.top = oy + "px"; p.style.bottom = "auto"; e.preventDefault();
        });
        document.addEventListener("mousemove", function (e) {
            if (!dragging) return;
            let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
            nx = Math.max(0, Math.min(window.innerWidth - 60, nx)); ny = Math.max(0, Math.min(window.innerHeight - 24, ny));
            p.style.left = nx + "px"; p.style.top = ny + "px";
        });
        document.addEventListener("mouseup", function () { if (dragging) { dragging = false; savePos(p); } });
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
        p.style.cssText = "position:fixed;bottom:18px;left:16px;z-index:999999;background:rgba(18,18,18,0.86);color:#fff;padding:10px 12px;border-radius:10px;width:280px;font-size:11px;line-height:16px;box-shadow:0 6px 16px rgba(0,0,0,0.4)";
        const rowCss = "white-space:nowrap;overflow:hidden;min-height:15px;";
        p.innerHTML =
            '<div id="ldh_title" style="display:flex;justify-content:space-between;align-items:center;cursor:move;">' +
            '<span style="font-weight:bold;">⚡ LINUX DO 助手</span>' +
            '<span>' +
            '<span id="ldh_sync" style="cursor:pointer;font-size:10px;color:#8fe0b0;">⟳同步</span>' +
            '<span id="ldh_min" style="cursor:pointer;margin-left:10px;font-size:13px;color:#ccc;">－</span>' +
            '</span>' +
            '</div>' +
            '<div id="ldh_body">' +
            '<div style="display:flex;gap:8px;margin:8px 0;">' +
            '<button id="ldh_daily" style="flex:1;padding:9px 4px;border:none;border-radius:7px;background:#2f6f3e;color:#fff;cursor:pointer;font-size:13px;">日常维护</button>' +
            '<button id="ldh_fast" style="flex:1;padding:9px 4px;border:none;border-radius:7px;background:#33507a;color:#fff;cursor:pointer;font-size:13px;">快速升级</button>' +
            '</div>' +
            '<div id="ldh_r1" style="' + rowCss + '"></div>' +
            '<div id="ldh_r2" style="' + rowCss + 'font-size:10px;"></div>' +
            '<div id="ldh_r3" style="' + rowCss + 'font-size:10px;"></div>' +
            '<div id="ldh_r4" style="' + rowCss + 'margin-top:2px;"></div>' +
            '</div>';
        document.body.appendChild(p);
        document.getElementById("ldh_daily").addEventListener("click", function () { startMode("daily"); });
        document.getElementById("ldh_fast").addEventListener("click", function () { startMode("fast"); });
        document.getElementById("ldh_sync").addEventListener("click", function () { sync(); });
        document.getElementById("ldh_min").addEventListener("click", function () { toggleMin(); });
        enableDrag(p, document.getElementById("ldh_title"));
        restorePos(p);
        manualMin = sessionStorage.getItem("ldh_min") === "1"; applyMin();
        watchComposer();
        const last = readJson("ld_helper_last", null);
        if (last && last.sent) { sent.topics = last.sent.topics; sent.replies = last.sent.replies; sent.likes = last.sent.likes; sent.readMs = last.sent.readMs || 0; plan.readMs = last.planReadMs || 0; finishedOnce = true; frozenTimer = last.frozen || ""; endNote = last.endNote || ""; }
        render();
        getUser().then(function (u) {
            me = u; render();
            if (me.username && !sessionStorage.getItem("ldh_autosync")) {
                sessionStorage.setItem("ldh_autosync", "1");
                const lastTs = Number(localStorage.getItem("ldh_autosync_ts") || 0);
                if (Date.now() - lastTs > 5 * 60 * 1000) { localStorage.setItem("ldh_autosync_ts", String(Date.now())); sync(); }
            }
        });
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
