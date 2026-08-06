// ==UserScript==
// @name         AnyRouter 自动登录
// @namespace    https://anyrouter.top/
// @version      1.0.0
// @description  在 linux.do 显示 AnyRouter 登录按钮，并自动完成 LinuxDo 授权登录
// @match        https://linux.do/*
// @match        https://connect.linux.do/oauth2/*
// @match        https://anyrouter.top/*
// @run-at       document-idle
// @noframes
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  const ANYROUTER = 'https://anyrouter.top';
  const LINUXDO_CONNECT = 'https://connect.linux.do';
  const CLIENT_ID_FALLBACK = '8w2uZtoWH9AUXrZr1qeCEEmvXLafea3c';
  const FLOW_KEY = 'anyrouter_login_flow_v1';
  const FLOW_TTL = 3 * 60 * 1000;

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function getFlow() {
    const flow = GM_getValue(FLOW_KEY, null);
    if (!flow) return null;
    if (!flow.ts || Date.now() - flow.ts > FLOW_TTL) {
      GM_deleteValue(FLOW_KEY);
      return null;
    }
    return flow;
  }

  function finishFlow() {
    GM_deleteValue(FLOW_KEY);
  }

  function getStoredUser() {
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      return user && user.id ? user : null;
    } catch {
      return null;
    }
  }

  async function fetchJson(path, attempts = 8) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(path, {
          credentials: 'include',
          cache: 'no-store',
        });
        const body = await response.json();
        if (response.ok && body && body.success !== false) return body;
      } catch {}
      await delay(500);
    }
    return null;
  }

  async function hasValidAnyRouterSession() {
    const user = getStoredUser();
    if (!user) return false;

    try {
      const response = await fetch('/api/user/self', {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'New-API-User': String(user.id) },
      });
      const body = await response.json();
      return response.ok && body.success === true && !!body.data?.id;
    } catch {
      return false;
    }
  }

  async function beginLinuxDoLogin() {
    const flow = getFlow();
    if (!flow) return;

    GM_setValue(FLOW_KEY, {
      step: 'authorizing',
      ts: Date.now(),
    });

    const [status, stateResult] = await Promise.all([
      fetchJson('/api/status'),
      fetchJson('/api/oauth/state'),
    ]);
    const clientId = status?.data?.linuxdo_client_id || CLIENT_ID_FALLBACK;
    const state = stateResult?.data;
    if (!clientId || !state) return;

    location.replace(
      `${LINUXDO_CONNECT}/oauth2/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&state=${encodeURIComponent(state)}`,
    );
  }

  function monitorAnyRouterLogin() {
    const timer = setInterval(() => {
      const flow = getFlow();
      if (!flow) {
        clearInterval(timer);
        return;
      }
      if (
        flow.step === 'callback' &&
        location.pathname.startsWith('/console') &&
        getStoredUser()
      ) {
        finishFlow();
        clearInterval(timer);
      }
    }, 300);

    setTimeout(() => clearInterval(timer), FLOW_TTL);
  }

  async function initAnyRouter() {
    if (!getFlow()) return;
    monitorAnyRouterLogin();

    if (location.pathname === '/oauth/linuxdo') {
      GM_setValue(FLOW_KEY, {
        step: 'callback',
        ts: Date.now(),
      });
      return;
    }

    if (await hasValidAnyRouterSession()) {
      finishFlow();
      if (!location.pathname.startsWith('/console')) {
        location.replace(ANYROUTER + '/console');
      }
      return;
    }

    await beginLinuxDoLogin();
  }

  function initLinuxDoConnect() {
    if (!getFlow() || location.pathname !== '/oauth2/authorize') return;

    const clickAllow = () => {
      const links = [...document.querySelectorAll('a[href^="/oauth2/approve/"]')];
      const allow = links.find(link =>
        (link.textContent || '').replace(/\s+/g, '') === '允许' &&
        link.getClientRects().length > 0,
      );
      if (!allow) return false;
      allow.click();
      return true;
    };

    if (clickAllow()) return;

    const observer = new MutationObserver(() => {
      if (clickAllow()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
  }

  function initLinuxDoButton() {
    if (document.getElementById('anyrouter-auto-login-button')) return;

    const button = document.createElement('button');
    button.id = 'anyrouter-auto-login-button';
    button.type = 'button';
    button.textContent = 'ANY';
    button.title = '登录 AnyRouter';
    button.setAttribute('aria-label', '登录 AnyRouter');
    Object.assign(button.style, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      zIndex: '999999',
      width: '54px',
      height: '54px',
      padding: '0',
      border: '1px solid rgba(255,255,255,.25)',
      borderRadius: '50%',
      background: '#111827',
      color: '#ffffff',
      font: '700 12px/1 system-ui, sans-serif',
      letterSpacing: '0',
      cursor: 'pointer',
      boxShadow: '0 5px 16px rgba(0,0,0,.28)',
    });

    button.addEventListener('click', () => {
      GM_setValue(FLOW_KEY, {
        step: 'open',
        ts: Date.now(),
      });
      GM_openInTab(ANYROUTER + '/console', {
        active: true,
        insert: true,
        setParent: true,
      });
    });

    document.body.appendChild(button);
  }

  if (location.hostname === 'linux.do') initLinuxDoButton();
  else if (location.hostname === 'connect.linux.do') initLinuxDoConnect();
  else if (location.hostname === 'anyrouter.top') initAnyRouter();
})();
