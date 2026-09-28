/* global banks */
(() => {
  const el = id => document.getElementById(id);
  const config = window.SUPABASE_CONFIG || {};
  const modeButtons = ['btnModePercent', 'btnModePower', 'btnModeTwoChar', 'btnModeThreeChar', 'btnModeFourChar'].map(el);
  let db, user = null, progress = new Map(), ready = false, busy = false;
  let queue = [], current = null, activeMode = 'free', generation = 0;
  const extraReviews = new Map();
  let pending = new Map(), draftKey = null, batchId = null;
  function saveDraft() {
    if (!draftKey) return;
    window.sessionStorage.setItem(draftKey, JSON.stringify({
      batchId, queue: queue.map(card => card.id),
      pending: [...pending], extra: [...extraReviews]
    }));
  }
  function draftFor(index, mode) {
    return user && mode !== 'free' ? `qa-round-v1:${user.id}:${index}:${mode}` : null;
  }
  function formatAnswer(card) {
    if (!card.question.includes('如何区分')) return card.answer;
    // 每段“词语：释义”独占一行；共享释义的并列词也分别展示。
    return card.answer.split(/[；\n]+/).filter(Boolean).flatMap(part => {
      const colon = part.indexOf('：');
      if (colon < 0) return [part];
      const words = part.slice(0, colon).trim().split('、');
      return words.map(word => word + '：' + part.slice(colon + 1));
    }).join('\n');
  }
  async function syncRound() {
    if (busy || activeMode === 'free' || queue.length || !pending.size) return;
    busy = true;
    ['btnHome', 'btnRestart', 'btnSync'].forEach(id => el(id).disabled = true);
    el('saveStatus').textContent = '本轮已完成，正在一次性同步…';
    try {
      saveDraft();
      const { data, error } = await db.rpc('record_review_batch', {
        p_batch_id: batchId,
        p_reviews: [...pending].map(([card_id, remembered]) => ({ card_id, remembered }))
      });
      if (error) throw error;
      if (!Array.isArray(data) || data.length !== pending.size ||
          data.some(row => row.user_id !== user.id || !pending.has(row.card_id)) ||
          new Set(data.map(row => row.card_id)).size !== pending.size) {
        throw new Error('未能确认整轮同步结果');
      }
      data.forEach(row => progress.set(row.card_id, row));
      window.sessionStorage.removeItem(draftKey);
      pending.clear(); draftKey = null;
      el('btnSync').classList.add('hidden');
      el('saveStatus').textContent = '本轮全部进度已同步到云端。';
    } catch (error) {
      el('btnSync').classList.remove('hidden');
      el('saveStatus').textContent = '同步失败，本轮记录已保留，请重试：' + errorText(error);
    } finally {
      busy = false;
      ['btnHome', 'btnRestart', 'btnSync'].forEach(id => el(id).disabled = false);
    }
  }
  const timeFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => timeFormatter.format(new Date());
  const errorText = error => error?.message || String(error);
  function cardsFor(bank, mode) {
    return bank.cards.filter(card => {
      const row = progress.get(card.id);
      if (mode === 'free') return true;
      if (mode === 'new') return !row;
      return row && new Date(row.due_at) <= new Date() && timeFormatter.format(new Date(row.last_reviewed_at)) !== today();
    });
  }
  function renderHome() {
    const mode = el('practiceMode').value;
    modeButtons.forEach((button, i) => {
      button.disabled = busy || (mode !== 'free' && !ready);
      const saved = draftFor(i, mode);
      const resume = saved && window.sessionStorage.getItem(saved);
      button.textContent = (resume ? '继续 · ' : '') + banks[i].name + (mode === 'free' || ready ? ` · ${cardsFor(banks[i], mode).length} 题` : '');
    });
    el('btnLogin').classList.toggle('hidden', !!user);
    el('btnLogout').classList.toggle('hidden', !user);
    el('btnLogin').disabled = !db || busy;
    el('btnLogout').disabled = busy;
    el('btnRefresh').disabled = !db || busy;
    el('practiceMode').disabled = busy;
    el('summary').textContent = ready
      ? `今日到期 ${banks.reduce((n, b) => n + cardsFor(b, 'due').length, 0)} 题 · 新题 ${banks.reduce((n, b) => n + cardsFor(b, 'new').length, 0)} 题（按北京时间安排复习）`
      : '自由练习可直接使用；登录并加载进度后开启云端复习。';
  }
  async function refresh() {
    if (!db || busy) return;
    const token = ++generation;
    busy = true; ready = false; renderHome();
    el('accountStatus').textContent = '正在加载云端进度…';
    try {
      const { data, error } = await db.auth.getUser();
      if (error && error.name !== 'AuthSessionMissingError') throw error;
      if (token !== generation) return;
      user = data?.user || null;
      progress = new Map();
      if (!user) {
        el('accountStatus').textContent = '请登录以同步学习进度。';
        return;
      }
      const rows = [];
      for (let offset = 0; ; offset += 1000) {
        const { data: page, error: readError } = await db.from('review_progress').select('*').eq('user_id', user.id).order('card_id').range(offset, offset + 999);
        if (readError) throw readError;
        rows.push(...page);
        if (page.length < 1000) break;
      }
      if (token !== generation) return;
      progress = new Map(rows.map(row => [row.card_id, row]));
      ready = true;
      el('accountStatus').textContent = `已登录：${user.email || user.id} · 云端进度已同步`;
    } catch (error) {
      el('accountStatus').textContent = '加载失败，请点击“刷新进度”重试：' + errorText(error);
    } finally {
      busy = false; renderHome();
    }
  }
  function nextQuestion() {
    el('answerBox').classList.remove('show');
    el('judgeButtons').classList.add('hidden');
    el('btnRestart').classList.toggle('hidden', queue.length > 0);
    el('btnShow').classList.toggle('hidden', !queue.length);
    el('questionLabel').textContent = activeMode === 'free' ? '自由练习' : activeMode === 'new' ? '学习新题' : '今日复习';
    const candidates = queue.length > 1 ? queue.filter(card => card.id !== current?.id) : queue;
    current = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    if (current && extraReviews.has(current.id)) {
      el('questionLabel').textContent += ` · 错题巩固，还需作答 ${extraReviews.get(current.id)} 次`;
    }
    el('questionText').textContent = current?.question || '本轮已完成';
    el('counter').textContent = `剩余 ${queue.length} 题`;
  }
  function goHome() {
    if (busy) return;
    current = null; queue = [];
    extraReviews.clear(); pending.clear(); draftKey = null;
    el('btnSync').classList.add('hidden');
    el('quizScreen').classList.add('hidden');
    el('homeScreen').classList.remove('hidden');
    if (db) refresh(); else renderHome();
  }
  modeButtons.forEach((button, i) => button.addEventListener('click', async () => {
    const mode = el('practiceMode').value;
    if (mode !== 'free') {
      await refresh();
      if (!ready || busy) return;
    }
    activeMode = mode;
    extraReviews.clear();
    pending.clear();
    draftKey = draftFor(i, mode);
    batchId = crypto.randomUUID();
    queue = [...cardsFor(banks[i], mode)];
    const saved = draftKey && window.sessionStorage.getItem(draftKey);
    if (saved) {
      try {
        const draft = JSON.parse(saved);
        const byId = new Map(banks[i].cards.map(card => [card.id, card]));
        if (!draft.batchId || !Array.isArray(draft.queue) || !Array.isArray(draft.pending) || !Array.isArray(draft.extra) ||
            draft.queue.some(id => !byId.has(id)) || draft.pending.some(([id]) => !byId.has(id))) throw new Error('题库已改变或草稿损坏');
        batchId = draft.batchId;
        queue = draft.queue.map(id => byId.get(id));
        pending = new Map(draft.pending);
        draft.extra.forEach(([id, count]) => extraReviews.set(id, count));
      } catch (error) {
        el('accountStatus').textContent = '无法恢复本轮：' + errorText(error);
        return;
      }
    }
    el('btnSync').classList.add('hidden');
    el('homeScreen').classList.add('hidden');
    el('quizScreen').classList.remove('hidden');
    el('saveStatus').textContent = '';
    nextQuestion();
    if (!queue.length && pending.size) await syncRound();
  }));
  el('btnShow').addEventListener('click', () => {
    if (!current || busy) return;
    el('answerText').textContent = formatAnswer(current);
    el('answerBox').classList.add('show');
    el('btnShow').classList.add('hidden');
    el('judgeButtons').classList.remove('hidden');
  });
  async function judge(remembered) {
    if (!current || busy) return;
    const card = current;
    const remaining = extraReviews.get(card.id);
    const before = { queue: [...queue], pending: new Map(pending), extra: new Map(extraReviews) };
    busy = true;
    ['btnCorrect', 'btnWrong', 'btnHome', 'btnRestart'].forEach(id => el(id).disabled = true);
    try {
      if (activeMode !== 'free' && remaining === undefined) {
        pending.set(card.id, remembered);
      }
      if (activeMode === 'free') {
        if (remembered) queue = queue.filter(item => item.id !== card.id);
      } else if (remaining !== undefined) {
        // 巩固作答不覆盖首次遗忘记录，也不因再次答错重新计数。
        if (remaining > 1) {
          extraReviews.set(card.id, remaining - 1);
          el('saveStatus').textContent = `还需巩固 ${remaining - 1} 次，整轮完成后同步。`;
        } else {
          extraReviews.delete(card.id);
          queue = queue.filter(item => item.id !== card.id);
          el('saveStatus').textContent = '两次巩固已完成，整轮同步时安排明天复习。';
        }
      } else if (!remembered) {
        extraReviews.set(card.id, 2);
        el('saveStatus').textContent = '本轮还将出现 2 次，整轮同步时安排明天复习。';
      } else {
        queue = queue.filter(item => item.id !== card.id);
      }
      if (activeMode !== 'free') {
        saveDraft();
        el('saveStatus').textContent = `已暂存 ${pending.size} 题，整轮完成后同步。`;
      }
      nextQuestion();
    } catch (error) {
      queue = before.queue; pending = before.pending; extraReviews.clear();
      before.extra.forEach((count, id) => extraReviews.set(id, count));
      el('saveStatus').textContent = '暂存失败，请勿关闭页面，点击判断按钮重试：' + errorText(error);
    } finally {
      busy = false;
      ['btnCorrect', 'btnWrong', 'btnHome', 'btnRestart'].forEach(id => el(id).disabled = false);
    }
    if (!queue.length && pending.size) await syncRound();
  }
  el('btnSync').addEventListener('click', syncRound);
  el('btnCorrect').addEventListener('click', () => judge(true));
  el('btnWrong').addEventListener('click', () => judge(false));
  el('btnHome').addEventListener('click', goHome);
  el('btnRestart').addEventListener('click', goHome);
  el('practiceMode').addEventListener('change', renderHome);
  el('btnRefresh').addEventListener('click', refresh);
  el('btnLogin').addEventListener('click', async () => {
    busy = true; renderHome();
    try {
      const { error } = await db.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: config.siteUrl } });
      if (error) throw error;
    } catch (error) {
      el('accountStatus').textContent = '登录失败：' + errorText(error);
    } finally { busy = false; renderHome(); }
  });
  el('btnLogout').addEventListener('click', async () => {
    busy = true; renderHome();
    const { error } = await db.auth.signOut({ scope: 'local' });
    busy = false;
    if (error) { el('accountStatus').textContent = '退出失败：' + errorText(error); renderHome(); return; }
    user = null; ready = false; progress.clear(); goHome();
  });
  try {
    if (!config.url || !config.publishableKey || !config.siteUrl) throw new Error('请在 supabase-config.js 填写 Project URL、Publishable key 和网站网址，再按 SUPABASE_SETUP.md 完成配置。');
    if (!config.publishableKey.startsWith('sb_publishable_')) throw new Error('请使用 sb_publishable_ 开头的公开密钥。');
    if (!window.supabase) throw new Error('Supabase SDK 加载失败，请检查网络后刷新。');
    // 不使用 localStorage；登录会话仅保留在当前标签页。
    db = window.supabase.createClient(config.url, config.publishableKey, {
      auth: { storage: window.sessionStorage, persistSession: true, flowType: 'pkce' }
    });
    db.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (user && session?.user.id && session.user.id !== user.id)) {
        generation++; ready = false; user = null; progress.clear(); current = null; queue = [];
        extraReviews.clear(); pending.clear(); draftKey = null;
        el('quizScreen').classList.add('hidden'); el('homeScreen').classList.remove('hidden');
        el('accountStatus').textContent = '登录状态已改变，请重新加载进度。'; renderHome();
      }
    });
    refresh();
  } catch (error) {
    db = null; el('practiceMode').value = 'free';
    el('accountStatus').textContent = errorText(error); renderHome();
  }
})();
