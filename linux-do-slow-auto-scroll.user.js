// ==UserScript==
// @name         Linux.do 随机帖子连续自动翻页
// @namespace    https://linux.do/
// @version      3.0.1
// @description  随机打开高回复帖子并连续自动翻页，帖子到底后更换下一篇。
// @match        https://linux.do/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    topPagesToScan: 5,
    minimumReplies: 1000,
    maximumRuntime: 60 * 60 * 1000,
    requestTimeout: 15000,
    minScreenRatio: 0.88,
    maxScreenRatio: 0.98,
    minWait: 1500,
    maxWait: 4000,
    minScrollDuration: 650,
    maxScrollDuration: 1200,
    longPauseChance: 0.12,
    minLongPause: 4000,
    maxLongPause: 8000,
    bottomThreshold: 4,
    bottomConfirmDelay: 2000,
    bottomConfirmChecks: 3,
    dragThreshold: 5,
    viewportMargin: 6,
  };

  const BUTTON_ID = 'linux-do-random-topic-scroll-button';
  const STORAGE_KEY = 'linux-do-random-topic-scroll-state-v3';
  const POSITION_KEY = 'linux-do-random-topic-scroll-position-v1';

  let running = false;
  let fetching = false;
  let navigating = false;
  let state = readState();
  let timerId = null;
  let deadlineTimerId = null;
  let animationFrameId = null;
  let statusTimerId = null;
  let statusMessage = '';
  let operationToken = 0;
  const activeFetchControllers = new Set();

  function randomInteger(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function randomNumber(min, max) {
    return Math.random() * (max - min) + min;
  }

  function secureRandomIndex(length) {
    if (!Number.isInteger(length) || length <= 0) {
      throw new Error('没有可以随机选择的帖子');
    }

    if (!window.crypto || !window.crypto.getRandomValues) {
      return Math.floor(Math.random() * length);
    }

    const range = 0x100000000;
    const limit = Math.floor(range / length) * length;
    const values = new Uint32Array(1);
    let value;

    do {
      window.crypto.getRandomValues(values);
      value = values[0];
    } while (value >= limit);

    return value % length;
  }

  function uniquePositiveIntegers(values) {
    if (!Array.isArray(values)) return [];

    return Array.from(
      new Set(
        values
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      )
    );
  }

  function readState() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const candidateIds = uniquePositiveIntegers(parsed.candidateIds);
      const visitedIds = uniquePositiveIntegers(parsed.visitedIds);
      const targetId = Number(parsed.targetId);
      const deadline = Number(parsed.deadline);

      if (
        !Number.isInteger(targetId) ||
        targetId <= 0 ||
        !Number.isFinite(deadline) ||
        typeof parsed.targetUrl !== 'string' ||
        candidateIds.length === 0
      ) {
        window.sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }

      return {
        targetId,
        targetUrl: parsed.targetUrl,
        deadline,
        candidateIds,
        visitedIds,
      };
    } catch (error) {
      console.warn('[Linux.do 自动翻页] 无法读取运行状态：', error);
      return null;
    }
  }

  function writeState(nextState) {
    state = nextState;

    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    } catch (error) {
      console.warn('[Linux.do 自动翻页] 无法保存运行状态：', error);
    }
  }

  function clearState() {
    state = null;

    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn('[Linux.do 自动翻页] 无法清除运行状态：', error);
    }
  }

  function readButtonPosition() {
    try {
      const raw = window.localStorage.getItem(POSITION_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const left = Number(parsed.left);
      const top = Number(parsed.top);

      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { left, top };
    } catch (error) {
      return null;
    }
  }

  function saveButtonPosition(button) {
    try {
      window.localStorage.setItem(
        POSITION_KEY,
        JSON.stringify({
          left: Number.parseFloat(button.style.left),
          top: Number.parseFloat(button.style.top),
        })
      );
    } catch (error) {
      console.warn('[Linux.do 自动翻页] 无法保存按钮位置：', error);
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function placeButton(button, left, top) {
    const maximumLeft =
      window.innerWidth - button.offsetWidth - CONFIG.viewportMargin;
    const maximumTop =
      window.innerHeight - button.offsetHeight - CONFIG.viewportMargin;

    button.style.left =
      `${clamp(left, CONFIG.viewportMargin, maximumLeft)}px`;
    button.style.top =
      `${clamp(top, CONFIG.viewportMargin, maximumTop)}px`;
    button.style.right = 'auto';
  }

  function restoreButtonPosition(button) {
    const saved = readButtonPosition();
    if (!saved) return;
    placeButton(button, saved.left, saved.top);
  }

  function makeButtonDraggable(button) {
    let dragData = null;
    let suppressNextClick = false;

    button.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;

      const rect = button.getBoundingClientRect();
      dragData = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        dragging: false,
      };

      button.setPointerCapture(event.pointerId);
    });

    button.addEventListener('pointermove', (event) => {
      if (!dragData || event.pointerId !== dragData.pointerId) return;

      const deltaX = event.clientX - dragData.startX;
      const deltaY = event.clientY - dragData.startY;

      if (
        !dragData.dragging &&
        Math.hypot(deltaX, deltaY) < CONFIG.dragThreshold
      ) {
        return;
      }

      dragData.dragging = true;
      event.preventDefault();
      placeButton(
        button,
        dragData.startLeft + deltaX,
        dragData.startTop + deltaY
      );
    });

    function finishDrag(event) {
      if (!dragData || event.pointerId !== dragData.pointerId) return;

      if (dragData.dragging) {
        suppressNextClick = event.type === 'pointerup';
        saveButtonPosition(button);
        event.preventDefault();
      }

      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }

      dragData = null;
    }

    button.addEventListener('pointerup', finishDrag);
    button.addEventListener('pointercancel', finishDrag);

    button.addEventListener('click', (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      handleButtonClick();
    });

    window.addEventListener('resize', () => {
      if (button.style.right !== 'auto') return;

      placeButton(
        button,
        Number.parseFloat(button.style.left) || CONFIG.viewportMargin,
        Number.parseFloat(button.style.top) || CONFIG.viewportMargin
      );
      saveButtonPosition(button);
    });
  }

  function getCurrentTopicId() {
    const match = window.location.pathname.match(
      /^\/t\/(?:topic|[^/]+)\/(\d+)(?:\/|$)/
    );

    return match ? Number(match[1]) : null;
  }

  function isCurrentTarget() {
    const currentTopicId = getCurrentTopicId();
    return Boolean(
      state &&
      currentTopicId !== null &&
      currentTopicId === Number(state.targetId)
    );
  }

  function hasExpired() {
    return Boolean(state && Date.now() >= Number(state.deadline));
  }

  function getPageHeight() {
    return Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
  }

  function getMaximumScrollTop() {
    return Math.max(0, getPageHeight() - window.innerHeight);
  }

  function isAtBottom() {
    return window.scrollY >= getMaximumScrollTop() - CONFIG.bottomThreshold;
  }

  function isSessionActive() {
    return Boolean(running || fetching || navigating || state);
  }

  function clearScrollWork() {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }

    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  function clearDeadlineTimer() {
    if (deadlineTimerId !== null) {
      window.clearTimeout(deadlineTimerId);
      deadlineTimerId = null;
    }
  }

  function abortActiveFetches() {
    for (const controller of activeFetchControllers) {
      controller.abort();
    }
    activeFetchControllers.clear();
  }

  function updateButton() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;

    button.textContent = statusMessage
      ? statusMessage
      : isSessionActive()
        ? '结束'
        : '开始';
    button.title = isSessionActive()
      ? fetching
        ? '正在获取随机帖子，点击结束'
        : '结束本次自动浏览'
      : '随机选择帖子并开始连续自动浏览';
    button.setAttribute('aria-pressed', String(isSessionActive()));
    button.style.backgroundColor = statusMessage
      ? '#dc2626'
      : isSessionActive()
        ? '#d97706'
        : '#2563eb';
    button.style.cursor = 'grab';
  }

  function showTemporaryStatus(message, duration = 2500) {
    if (statusTimerId !== null) {
      window.clearTimeout(statusTimerId);
    }

    statusMessage = message;
    updateButton();

    statusTimerId = window.setTimeout(() => {
      statusTimerId = null;
      statusMessage = '';
      updateButton();
    }, duration);
  }

  function stopSession(reason) {
    operationToken += 1;
    running = false;
    fetching = false;
    navigating = false;
    clearScrollWork();
    clearDeadlineTimer();
    abortActiveFetches();
    clearState();
    updateButton();

    if (reason === 'timeout') {
      console.info('[Linux.do 自动翻页] 已运行一小时，自动结束。');
    } else if (reason === 'manual') {
      console.info('[Linux.do 自动翻页] 已手动结束。');
    }
  }

  function scheduleDeadlineStop() {
    clearDeadlineTimer();

    if (!state) return;

    const remaining = Number(state.deadline) - Date.now();
    if (remaining <= 0) {
      stopSession('timeout');
      return;
    }

    deadlineTimerId = window.setTimeout(() => {
      deadlineTimerId = null;
      stopSession('timeout');
    }, remaining);
  }

  function scheduleNextScroll(delay) {
    if (!running) return;

    timerId = window.setTimeout(() => {
      timerId = null;
      performScrollStep();
    }, delay);
  }

  function smoothScrollTo(targetTop, duration, onComplete) {
    const startTop = window.scrollY;
    const distance = targetTop - startTop;
    const startTime = performance.now();

    function animate(currentTime) {
      if (!running) return;

      const progress = Math.min(1, (currentTime - startTime) / duration);
      const easedProgress = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      window.scrollTo(0, startTop + distance * easedProgress);

      if (progress < 1) {
        animationFrameId = window.requestAnimationFrame(animate);
      } else {
        animationFrameId = null;
        onComplete();
      }
    }

    animationFrameId = window.requestAnimationFrame(animate);
  }

  function chooseNextTopic() {
    if (!state || state.candidateIds.length === 0) {
      throw new Error('候选帖子列表为空');
    }

    const currentId = Number(state.targetId);
    let visitedIds = uniquePositiveIntegers(state.visitedIds);
    let availableIds = state.candidateIds.filter(
      (topicId) => topicId !== currentId && !visitedIds.includes(topicId)
    );

    // 全部浏览过后重新开始一轮，但仍尽量避免连续打开同一篇。
    if (availableIds.length === 0) {
      visitedIds = currentId ? [currentId] : [];
      availableIds = state.candidateIds.filter(
        (topicId) => topicId !== currentId
      );
    }

    // 如果候选池确实只有一篇，则允许重新打开这一篇。
    if (availableIds.length === 0) {
      availableIds = [...state.candidateIds];
      visitedIds = [];
    }

    const nextId = availableIds[secureRandomIndex(availableIds.length)];
    return {
      nextId,
      visitedIds: uniquePositiveIntegers([...visitedIds, nextId]),
    };
  }

  function goToNextTopic() {
    if (!state || hasExpired()) {
      stopSession('timeout');
      return;
    }

    running = false;
    clearScrollWork();

    try {
      const selection = chooseNextTopic();
      const targetUrl = new URL(
        `/t/topic/${selection.nextId}`,
        window.location.origin
      ).toString();

      writeState({
        ...state,
        targetId: selection.nextId,
        targetUrl,
        visitedIds: selection.visitedIds,
      });

      navigating = true;
      updateButton();
      window.location.assign(targetUrl);
    } catch (error) {
      console.error('[Linux.do 自动翻页] 无法选择下一篇帖子：', error);
      stopSession('error');
      showTemporaryStatus('切换失败');
    }
  }

  function confirmBottom(stableChecks = 0, previousHeight = getPageHeight()) {
    if (!running) return;

    timerId = window.setTimeout(() => {
      timerId = null;

      if (!running) return;
      if (hasExpired()) {
        stopSession('timeout');
        return;
      }

      const currentHeight = getPageHeight();
      const pageGrew =
        currentHeight > previousHeight + CONFIG.bottomThreshold;

      if (pageGrew || !isAtBottom()) {
        performScrollStep();
        return;
      }

      const nextStableChecks = stableChecks + 1;
      if (nextStableChecks >= CONFIG.bottomConfirmChecks) {
        goToNextTopic();
        return;
      }

      confirmBottom(nextStableChecks, currentHeight);
    }, CONFIG.bottomConfirmDelay);
  }

  function performScrollStep() {
    if (!running) return;

    if (hasExpired()) {
      stopSession('timeout');
      return;
    }

    if (document.hidden) {
      scheduleNextScroll(1000);
      return;
    }

    if (isAtBottom()) {
      confirmBottom();
      return;
    }

    const maximumScrollTop = getMaximumScrollTop();
    const distance = Math.round(
      window.innerHeight * randomNumber(
        CONFIG.minScreenRatio,
        CONFIG.maxScreenRatio
      )
    );
    const targetTop = Math.min(maximumScrollTop, window.scrollY + distance);
    const duration = randomInteger(
      CONFIG.minScrollDuration,
      CONFIG.maxScrollDuration
    );

    smoothScrollTo(targetTop, duration, () => {
      if (!running) return;

      if (isAtBottom()) {
        confirmBottom();
        return;
      }

      let wait = randomInteger(CONFIG.minWait, CONFIG.maxWait);
      if (Math.random() < CONFIG.longPauseChance) {
        wait += randomInteger(CONFIG.minLongPause, CONFIG.maxLongPause);
      }

      scheduleNextScroll(wait);
    });
  }

  function beginScrolling() {
    if (!state || hasExpired()) {
      stopSession('timeout');
      return;
    }

    if (!isCurrentTarget()) {
      navigating = true;
      updateButton();
      window.location.assign(state.targetUrl);
      return;
    }

    navigating = false;
    running = true;
    updateButton();
    scheduleDeadlineStop();
    scheduleNextScroll(300);
  }

  function getReplyCount(topic) {
    const postsCount = Number(topic && topic.posts_count);
    if (Number.isFinite(postsCount)) {
      return Math.max(0, postsCount - 1);
    }

    const replyCount = Number(topic && topic.reply_count);
    return Number.isFinite(replyCount) ? Math.max(0, replyCount) : 0;
  }

  async function collectEligibleTopics(currentOperationToken) {
    const topicsById = new Map();
    let successfulPages = 0;

    for (let page = 0; page < CONFIG.topPagesToScan; page += 1) {
      if (currentOperationToken !== operationToken) {
        throw new DOMException('操作已取消', 'AbortError');
      }

      const url = new URL('/top.json', window.location.origin);
      url.searchParams.set('period', 'all');
      url.searchParams.set('page', String(page));

      const controller = new AbortController();
      activeFetchControllers.add(controller);
      const requestTimer = window.setTimeout(() => {
        controller.abort();
      }, CONFIG.requestTimeout);

      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `排行榜第 ${page + 1} 页请求失败：${response.status}`
          );
        }

        const data = await response.json();
        const topics =
          data && data.topic_list && Array.isArray(data.topic_list.topics)
            ? data.topic_list.topics
            : [];

        successfulPages += 1;

        for (const topic of topics) {
          const topicId = Number(topic && topic.id);
          if (
            Number.isInteger(topicId) &&
            getReplyCount(topic) > CONFIG.minimumReplies
          ) {
            topicsById.set(topicId, {
              id: topicId,
              title: String(topic.title || ''),
              replies: getReplyCount(topic),
            });
          }
        }
      } catch (error) {
        if (error && error.name === 'AbortError') {
          if (currentOperationToken !== operationToken) throw error;
        } else {
          console.warn('[Linux.do 自动翻页] 排行榜读取失败：', error);
        }
      } finally {
        window.clearTimeout(requestTimer);
        activeFetchControllers.delete(controller);
      }
    }

    if (successfulPages === 0) {
      throw new Error('无法读取 Linux.do 排行榜');
    }

    return Array.from(topicsById.values());
  }

  async function startNewSession() {
    const currentOperationToken = ++operationToken;
    const sessionDeadline = Date.now() + CONFIG.maximumRuntime;

    fetching = true;
    updateButton();

    try {
      const candidates = await collectEligibleTopics(currentOperationToken);

      if (currentOperationToken !== operationToken) return;
      if (candidates.length === 0) {
        throw new Error('排行榜前五页没有回复数大于 1000 的帖子');
      }

      const selected = candidates[secureRandomIndex(candidates.length)];
      const candidateIds = uniquePositiveIntegers(
        candidates.map((topic) => topic.id)
      );
      const targetUrl = new URL(
        `/t/topic/${selected.id}`,
        window.location.origin
      ).toString();

      writeState({
        targetId: selected.id,
        targetUrl,
        deadline: sessionDeadline,
        candidateIds,
        visitedIds: [selected.id],
      });

      console.info(
        `[Linux.do 自动翻页] 从 ${candidates.length} 个候选帖子中随机选择：`,
        selected.title,
        `回复数：${selected.replies}`
      );

      fetching = false;
      navigating = true;
      updateButton();
      window.location.assign(targetUrl);
    } catch (error) {
      if (currentOperationToken !== operationToken) return;

      console.error('[Linux.do 自动翻页] 随机选择帖子失败：', error);
      fetching = false;
      clearState();
      updateButton();
      showTemporaryStatus('获取失败');
    }
  }

  function handleButtonClick() {
    if (isSessionActive()) {
      stopSession('manual');
      return;
    }

    startNewSession();
  }

  function createButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '开始';
    button.title = '随机选择帖子并开始连续自动浏览';
    button.setAttribute('aria-label', '开始或结束随机帖子自动浏览');
    button.setAttribute('aria-pressed', 'false');

    Object.assign(button.style, {
      position: 'fixed',
      top: '18px',
      right: '18px',
      zIndex: '2147483647',
      minWidth: '82px',
      height: '38px',
      padding: '0 16px',
      border: '1px solid rgba(255, 255, 255, 0.35)',
      borderRadius: '9px',
      backgroundColor: '#2563eb',
      color: '#ffffff',
      fontFamily:
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '14px',
      fontWeight: '600',
      lineHeight: '36px',
      textAlign: 'center',
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.22)',
      cursor: 'grab',
      userSelect: 'none',
      touchAction: 'none',
    });

    button.addEventListener('mouseenter', () => {
      button.style.filter = 'brightness(1.08)';
    });

    button.addEventListener('mouseleave', () => {
      button.style.filter = 'none';
    });

    document.body.appendChild(button);
    restoreButtonPosition(button);
    makeButtonDraggable(button);
  }

  function initialize() {
    createButton();

    if (!state) {
      updateButton();
      return;
    }

    if (hasExpired()) {
      stopSession('timeout');
      return;
    }

    scheduleDeadlineStop();

    if (isCurrentTarget()) {
      beginScrolling();
      return;
    }

    navigating = true;
    updateButton();
    window.location.assign(state.targetUrl);
  }

  initialize();
})();
