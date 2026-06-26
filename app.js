(() => {
  "use strict";

  const STORAGE_KEY = "pt_full_review_stats_v1";

  let queue = [];
  let current = null;
  let historyStack = [];
  let currentPool = [];
  let queueSignature = "";

  const $ = (id) => document.getElementById(id);
  const todayKey = () => new Date().toISOString().slice(0, 10);

  function allQuestions() {
    try {
      if (typeof QUESTIONS !== "undefined" && Array.isArray(QUESTIONS)) return QUESTIONS;
    } catch (e) {}
    return [];
  }

  function defaultStats() {
    return {
      total: 0,
      correct: 0,
      wrong: 0,
      perQuestion: {},
      perLesson: {},
      perType: {},
      daily: {}
    };
  }

  function loadStats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultStats();

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultStats();

      parsed.total = parsed.total || 0;
      parsed.correct = parsed.correct || 0;
      parsed.wrong = parsed.wrong || 0;
      parsed.perQuestion = parsed.perQuestion || {};
      parsed.perLesson = parsed.perLesson || {};
      parsed.perType = parsed.perType || {};
      parsed.daily = parsed.daily || {};

      return parsed;
    } catch (e) {
      console.warn("学習履歴の読み込みに失敗したため、空の履歴で起動します。", e);
      return defaultStats();
    }
  }

  let stats = loadStats();

  function saveStats() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
    } catch (e) {
      console.warn("学習履歴の保存に失敗しました。", e);
    }
  }

  function ensureToday() {
    const key = todayKey();
    if (!stats.daily[key]) {
      stats.daily[key] = { seconds: 0, total: 0, correct: 0, wrong: 0, missed: {}, cleared: {} };
    }
    stats.daily[key].missed = stats.daily[key].missed || {};
    stats.daily[key].cleared = stats.daily[key].cleared || {};
    return stats.daily[key];
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    if (hours > 0) return `${hours}時間${minutes}分`;
    return `${minutes}分`;
  }

  function sumDailySeconds(daysBack) {
    let totalSeconds = 0;
    let totalQuestions = 0;
    const d = new Date();

    for (let i = 0; i < daysBack; i++) {
      const key = d.toISOString().slice(0, 10);
      const day = stats.daily[key];
      if (day) {
        totalSeconds += day.seconds || 0;
        totalQuestions += day.total || 0;
      }
      d.setDate(d.getDate() - 1);
    }

    return { totalSeconds, totalQuestions };
  }

  function sumAllTime() {
    let totalSeconds = 0;
    let totalQuestions = 0;

    for (const day of Object.values(stats.daily || {})) {
      totalSeconds += day.seconds || 0;
      totalQuestions += day.total || 0;
    }

    return {
      totalSeconds,
      totalQuestions: Math.max(totalQuestions, stats.total || 0)
    };
  }

  function calcStreak() {
    let streak = 0;
    const d = new Date();

    for (;;) {
      const key = d.toISOString().slice(0, 10);
      const day = stats.daily[key];

      if (day && ((day.total || 0) > 0 || (day.seconds || 0) >= 60)) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }

    return streak;
  }

  function typeLabel(type) {
    return {
      vocab_ja_pt: "単語（日→葡）",
      vocab_pt_ja: "単語（葡→日）",
      fill: "穴埋め",
      translation: "和訳",
      phrase: "短文・定型文",
      composition: "作文",
      conversation: "会話"
    }[type] || type || "-";
  }

  function buildLessonOptions() {
    const select = $("lessonSelect");
    const questions = allQuestions();

    if (!select) return;

    if (!questions.length) {
      select.innerHTML = `<option value="all">問題データなし</option>`;
      return;
    }

    const lessons = [...new Map(questions.map(q => [q.lesson, q.lessonTitle || q.lesson])).entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    select.innerHTML = `<option value="all">全部</option>` + lessons.map(([id, title]) => {
      return `<option value="${String(id).replaceAll('"', '&quot;')}">${title}</option>`;
    }).join("");
  }

  function getQueueSignature() {
    return [
      $("lessonSelect")?.value || "all",
      $("typeSelect")?.value || "all",
      $("modeSelect")?.value || "normal"
    ].join("|");
  }

  function getFilteredQuestions() {
    const questions = allQuestions();
    const lesson = $("lessonSelect")?.value || "all";
    const type = $("typeSelect")?.value || "all";
    const mode = $("modeSelect")?.value || "normal";

    let pool = questions.filter(q => {
      const lessonMatch = lesson === "all" || q.lesson === lesson;
      const typeMatch = type === "all" || q.type === type;
      return lessonMatch && typeMatch;
    });

    if (mode === "recent") {
      const dates = [...new Set(questions.map(q => q.date).filter(Boolean))]
        .sort()
        .reverse()
        .slice(0, 3);
      pool = pool.filter(q => dates.includes(q.date));
    }

    if (mode === "missed") {
      const today = ensureToday();
      pool = pool.filter(q => today.missed && today.missed[q.id] && !(today.cleared && today.cleared[q.id]));
    }

    return pool;
  }

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  function weightWeak(pool) {
    const remaining = pool.map(q => {
      const r = stats.perQuestion[q.id] || { correct: 0, wrong: 0 };
      const weight = Math.max(1, Math.min(8, 1 + (r.wrong || 0) * 2 - Math.min(r.correct || 0, 2)));
      return { q, weight };
    });

    const ordered = [];

    while (remaining.length) {
      const total = remaining.reduce((sum, item) => sum + item.weight, 0);
      let target = Math.random() * total;
      let idx = 0;

      for (; idx < remaining.length; idx++) {
        target -= remaining[idx].weight;
        if (target <= 0) break;
      }

      ordered.push(remaining[idx].q);
      remaining.splice(idx, 1);
    }

    return ordered;
  }

  function makeQueue(pool) {
    const mode = $("modeSelect")?.value || "normal";
    if (mode === "weak") return weightWeak(pool);
    return shuffle([...pool]);
  }

  function resetQueue() {
    current = null;
    historyStack = [];
    currentPool = getFilteredQuestions();
    queue = makeQueue(currentPool);
    queueSignature = getQueueSignature();
    nextQuestion(false);
    updateDashboard();
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function updatePrevButton() {
    const btn = $("prevBtn");
    if (!btn) return;
    btn.disabled = historyStack.length === 0;
    btn.textContent = historyStack.length === 0 ? "前の問題" : `前の問題（${historyStack.length}）`;
  }

  function renderCurrentQuestion(restartedNow = false) {
    const answerBlock = $("answerBlock");
    if (answerBlock) answerBlock.style.display = "none";
    setText("showBtn", "答えを見る");

    if (!current) {
      setText("question", "この条件では問題がありません。");
      setText("answer", "");
      setText("explanation", "");
      setText("cycleStatus", "");
      return;
    }

    setText("question", current.q || "");
    setText("answer", current.a || "");
    setText("explanation", current.exp || "");

    const explanation = $("explanation");
    const explanationTitle = $("explanationTitle");
    if (explanation) explanation.style.display = current.exp ? "block" : "none";
    if (explanationTitle) explanationTitle.style.display = current.exp ? "block" : "none";

    if (restartedNow) {
      setText("cycleStatus", "この条件の一巡が終わりました。新しい一巡を開始します。");
    } else if (queue.length === 0) {
      setText("cycleStatus", "この条件を一巡しました。");
    } else {
      setText("cycleStatus", `残り ${queue.length}問`);
    }
    updatePrevButton();
  }

  function nextQuestion(rememberCurrent = true) {
    const sig = getQueueSignature();

    if (sig !== queueSignature) {
      currentPool = getFilteredQuestions();
      queue = makeQueue(currentPool);
      queueSignature = sig;
      historyStack = [];
      current = null;
    }

    if (rememberCurrent && current) {
      historyStack.push(current);
      if (historyStack.length > 50) historyStack.shift();
    }

    let restartedNow = false;
    if (queue.length === 0) {
      currentPool = getFilteredQuestions();
      queue = makeQueue(currentPool);
      restartedNow = currentPool.length > 0;
    }

    current = queue.shift() || null;
    renderCurrentQuestion(restartedNow);
  }

  function goPreviousQuestion() {
    if (!historyStack.length) {
      updatePrevButton();
      return;
    }
    if (current) queue.unshift(current);
    current = historyStack.pop();
    renderCurrentQuestion(false);
  }

  function showAnswer() {
    const answerBlock = $("answerBlock");
    if (!answerBlock) return;

    const isOpen = answerBlock.style.display === "block";
    answerBlock.style.display = isOpen ? "none" : "block";
    setText("showBtn", isOpen ? "答えを見る" : "答えを隠す");
  }

  function record(isCorrect) {
    if (!current) return;

    const today = ensureToday();

    stats.total = (stats.total || 0) + 1;
    today.total = (today.total || 0) + 1;

    if (isCorrect) {
      stats.correct = (stats.correct || 0) + 1;
      today.correct = (today.correct || 0) + 1;
      today.cleared[current.id] = true;
      if (today.missed) delete today.missed[current.id];
    } else {
      stats.wrong = (stats.wrong || 0) + 1;
      today.wrong = (today.wrong || 0) + 1;
      today.missed[current.id] = true;
      if (today.cleared) delete today.cleared[current.id];
    }

    const pq = stats.perQuestion[current.id] || { correct: 0, wrong: 0 };
    if (isCorrect) pq.correct = (pq.correct || 0) + 1;
    else pq.wrong = (pq.wrong || 0) + 1;
    stats.perQuestion[current.id] = pq;

    const pl = stats.perLesson[current.lesson] || { correct: 0, wrong: 0, total: 0 };
    pl.total = (pl.total || 0) + 1;
    if (isCorrect) pl.correct = (pl.correct || 0) + 1;
    else pl.wrong = (pl.wrong || 0) + 1;
    stats.perLesson[current.lesson] = pl;

    const pt = stats.perType[current.type] || { correct: 0, wrong: 0, total: 0 };
    pt.total = (pt.total || 0) + 1;
    if (isCorrect) pt.correct = (pt.correct || 0) + 1;
    else pt.wrong = (pt.wrong || 0) + 1;
    stats.perType[current.type] = pt;

    saveStats();
    updateDashboard();

    if (($("modeSelect")?.value || "normal") === "missed") {
      currentPool = getFilteredQuestions();
      queue = queue.filter(q => currentPool.some(p => p.id === q.id));
    }

    nextQuestion();
  }

  function updateDashboard() {
    const today = ensureToday();
    const week = sumDailySeconds(7);
    const all = sumAllTime();

    setText("todayStats", `${today.total || 0}問 / ${formatDuration(today.seconds || 0)}`);
    setText("weekStats", `${week.totalQuestions}問 / ${formatDuration(week.totalSeconds)}`);
    setText("totalStats", `${all.totalQuestions}問 / ${formatDuration(all.totalSeconds)}`);
    setText("streakDays", `${calcStreak()}日`);

    renderWeakAreas();
  }

  function renderWeakAreas() {
    const container = $("weakAreas");
    if (!container) return;

    const questions = allQuestions();
    const rows = Object.entries(stats.perLesson || {}).map(([lesson, r]) => {
      const title = (questions.find(q => q.lesson === lesson) || {}).lessonTitle || lesson;
      const total = r.total || 0;
      const acc = total ? Math.round(((r.correct || 0) / total) * 100) : 0;
      return { title, total, acc, wrong: r.wrong || 0 };
    }).filter(x => x.total >= 3)
      .sort((a, b) => a.acc - b.acc || b.wrong - a.wrong)
      .slice(0, 5);

    if (!rows.length) {
      container.textContent = "まだデータがありません。";
      return;
    }

    container.innerHTML = rows.map(r => `
      <div class="weak-item">
        <span>${r.title}</span>
        <strong>${r.acc}%</strong>
      </div>
    `).join("");
  }

  function resetStats() {
    if (!confirm("学習履歴をリセットしますか？")) return;
    stats = defaultStats();
    saveStats();
    updateDashboard();
    resetQueue();
  }

  function bindEvents() {
    $("applyBtn")?.addEventListener("click", resetQueue);
    $("prevBtn")?.addEventListener("click", goPreviousQuestion);
    $("showBtn")?.addEventListener("click", showAnswer);
    $("correctBtn")?.addEventListener("click", () => record(true));
    $("wrongBtn")?.addEventListener("click", () => record(false));
    $("nextBtn")?.addEventListener("click", nextQuestion);
    $("resetBtn")?.addEventListener("click", resetStats);
  }

  function startTimer() {
    setInterval(() => {
      const today = ensureToday();
      today.seconds = (today.seconds || 0) + 1;
      saveStats();
      updateDashboard();
    }, 1000);
  }

  function init() {
    try {
      buildLessonOptions();
      bindEvents();
      ensureToday();
      updateDashboard();
      resetQueue();
      startTimer();
    } catch (e) {
      console.error("アプリの起動に失敗しました。", e);
      setText("question", "起動エラーが発生しました。index.html / app.js / questions.js の読み込み順を確認してください。");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
