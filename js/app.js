/* PinVideoBoard — приложение */
(function () {
  'use strict';

  var CFG = window.__PVB_CONFIG;
  var V = window.__PVB_VIDEOS;
  var GH = window.__PVB_API;
  var VIEW_KEY = 'pvb-view';
  var COLOR_KEY = 'pvb-color';
  var PALETTE = ['#4a9eff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39c5cf', '#db61a2', '#8b949e'];
  var DEFAULT_COLUMNS = [
    { name: 'Смотреть позже', color: '#4a9eff' },
    { name: 'Смотрю', color: '#d29922' },
    { name: 'Просмотрено', color: '#3fb950' }
  ];

  // ---------- хелперы ----------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // монохром: цвет колонки -> оттенок серого по яркости (колонки остаются различимыми)
  function hexToGray(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    var y = Math.round(0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255));
    y = Math.max(100, Math.min(200, y));
    var g = y.toString(16);
    if (g.length < 2) g = '0' + g;
    return '#' + g + g + g;
  }

  function monoColor(hex) {
    return state.color ? hex : hexToGray(hex);
  }

  function toast(msg, type, opts) {
    opts = opts || {};
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    if (opts.linkText) {
      var link = document.createElement('span');
      link.className = 'toast-link';
      link.textContent = opts.linkText;
      link.addEventListener('click', function () {
        if (opts.onLink) opts.onLink();
        el.remove();
      });
      el.appendChild(link);
    }
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, opts.timeout || 4500);
  }

  // confirmDialog(text, {yes, no, extra}) -> Promise<'yes'|'no'|'extra'|null>
  function confirmDialog(text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var modal = $('#confirm-modal');
      $('#confirm-text').textContent = text;
      var yes = $('#confirm-yes'), no = $('#confirm-no');
      yes.textContent = opts.yes || 'Да';
      no.textContent = opts.no || 'Отмена';
      var prevExtra = $('#confirm-extra');
      if (prevExtra) prevExtra.remove();
      if (opts.extra) {
        var extra = document.createElement('button');
        extra.id = 'confirm-extra';
        extra.className = 'ghost-btn';
        extra.textContent = opts.extra;
        extra.addEventListener('click', done('extra'));
        no.parentNode.insertBefore(extra, no);
      }
      function done(val) {
        return function () {
          cleanup();
          closeModal(modal);
          resolve(val);
        };
      }
      function cleanup() {
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
      }
      var onYes = done('yes'), onNo = done('no');
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      // клик по backdrop/крестика считается отменой
      var onClosed = function (e) {
        var t = e.target;
        if (t.closest && t.closest('#confirm-yes, #confirm-no, #confirm-extra')) return;
        if (t.closest && t.closest('.modal-body')) return; // отмена — только клик по фону
        cleanup();
        resolve('no');
      };
      modal.addEventListener('click', onClosed, { once: true });
      openModal(modal);
    });
  }

  // ---------- состояние ----------

  var state = {
    data: window.__PVB_DATA || { version: 1, updatedAt: null, boards: [] },
    remoteSha: null,
    view: localStorage.getItem(VIEW_KEY) === 'kanban' ? 'kanban' : 'grid',
    color: false,
    board: 'all',
    q: '',
    tag: '',
    provider: '',
    sort: 'new',
    user: null,
    persisting: false,
    renderedIds: [],
    selecting: false,
    selected: [],
    playerList: [],
    playerIdx: -1,
    resolveMeta: null
  };

  var editorCtx = { tileId: null, boardId: null, columnId: null };
  var colCtx = { boardId: null, colId: null };
  var boardCtx = { boardId: null };
  var dnd = { tileId: null, colId: null, index: -1 };

  // ---------- доступ к данным ----------

  function boards() { return state.data.boards || []; }

  function findBoard(id) {
    for (var i = 0; i < boards().length; i++) if (boards()[i].id === id) return boards()[i];
    return null;
  }

  function currentBoard() {
    if (state.board !== 'all') return findBoard(state.board);
    return null;
  }

  function columnOf(board, colId) {
    if (!board) return null;
    var cols = board.columns || [];
    for (var i = 0; i < cols.length; i++) if (cols[i].id === colId) return cols[i];
    return null;
  }

  function allTiles() {
    var out = [];
    boards().forEach(function (b) {
      (b.tiles || []).forEach(function (t) { out.push({ tile: t, board: b }); });
    });
    return out;
  }

  function findTile(id) {
    var res = null;
    boards().forEach(function (b) {
      (b.tiles || []).forEach(function (t) { if (t.id === id) res = { tile: t, board: b }; });
    });
    return res;
  }

  function canEdit() { return GH.canEdit() && !state.persisting; }

  function tilesOf(board, colId) {
    return (board.tiles || []).filter(function (t) { return t.columnId === colId; });
  }

  // ---------- фильтрация и сортировка ----------

  function filteredTiles() {
    var q = state.q.trim().toLowerCase();
    var list = allTiles().filter(function (e) {
      if (state.board !== 'all' && e.board.id !== state.board) return false;
      if (state.provider && e.tile.provider !== state.provider) return false;
      if (state.tag) {
        var tags = (e.tile.tags || []).map(function (s) { return String(s).toLowerCase(); });
        if (tags.indexOf(state.tag.toLowerCase()) < 0) return false;
      }
      if (q) {
        var hay = [e.tile.title, e.tile.note, (e.tile.tags || []).join(' ')].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    list.sort(function (a, b) {
      if (state.sort === 'title') return String(a.tile.title || '').localeCompare(String(b.tile.title || ''), 'ru');
      // числовое сравнение времени (Date.parse) — устойчиво к любым форматам дат
      var da = Date.parse(a.tile.addedAt || '') || 0;
      var db2 = Date.parse(b.tile.addedAt || '') || 0;
      return state.sort === 'old' ? (da - db2) : (db2 - da);
    });
    return list;
  }

  function hasActiveFilters() {
    return !!(state.board !== 'all' || state.q.trim() || state.tag || state.provider || state.sort !== 'new');
  }

  function resetFilters() {
    state.board = 'all';
    state.q = '';
    state.tag = '';
    state.provider = '';
    state.sort = 'new';
    $('#search').value = '';
    $('#search-clear').hidden = true;
    $('#f-tag').value = '';
    $('#f-provider').value = '';
    $('#f-sort').value = 'new';
    renderAll();
  }

  // ---------- persist ----------

  function persist(label) {
    if (!GH.canEdit()) {
      toast('Нет прав на редактирование — войдите как владелец', 'warn');
      return Promise.resolve(false);
    }
    if (state.persisting) {
      toast('Подождите — идёт сохранение предыдущего изменения', 'warn');
      return Promise.resolve(false);
    }
    state.persisting = true;
    state.data.updatedAt = new Date().toISOString();
    var expectedSha = state.remoteSha;
    return GH.save(state.data, expectedSha, label).then(function (res) {
      state.persisting = false;
      if (res && res.conflict) { handleConflict(res.conflict, label); return false; }
      if (res && res.dev) {
        toast('Сохранено локально (dev-режим)');
        return true;
      }
      if (res && res.noop) return true;
      state.remoteSha = res && res.sha ? res.sha : state.remoteSha;
      startDeployWatch();
      return true;
    }).catch(function (err) {
      state.persisting = false;
      toast(err.message || 'Ошибка сохранения', 'err');
      return false;
    });
  }

  function handleConflict(conflict, label) {
    confirmDialog(
      'Данные в репозитории изменились не из этого браузера. Что сделать с вашими локальными изменениями?',
      { yes: 'Перезаписать моими', extra: 'Загрузить удалённые', no: 'Отмена' }
    ).then(function (choice) {
      if (choice === 'yes') {
        state.persisting = true;
        GH.overwrite(state.data, conflict.sha, label).then(function (res) {
          state.persisting = false;
          state.remoteSha = res && res.sha ? res.sha : state.remoteSha;
          startDeployWatch();
        }).catch(function (err) {
          state.persisting = false;
          toast(err.message || 'Ошибка сохранения', 'err');
        });
      } else if (choice === 'extra') {
        if (conflict.data) {
          state.data = conflict.data;
          state.remoteSha = conflict.sha;
          toast('Загружена версия из репозитория (локальные изменения отброшены)', 'warn');
          renderAll();
        } else {
          toast('Не удалось разобрать удалённые данные', 'err');
        }
      }
    });
  }

  // ---------- рендер: шапка ----------

  function renderTabs() {
    var tabs = $('#tabs');
    var counts = { all: allTiles().length };
    boards().forEach(function (b) { counts[b.id] = (b.tiles || []).length; });
    var html = '';
    html += tabHTML('all', 'Все', counts.all);
    boards().forEach(function (b) {
      html += tabHTML(b.id, b.name, counts[b.id]);
    });
    if (GH.canEdit()) {
      html += '<button class="tab-add" id="tab-add" title="Новая доска">+ доска</button>';
    }
    tabs.innerHTML = html;
  }

  function tabHTML(id, name, count) {
    return '<button class="tab' + (state.board === id ? ' active' : '') + '" data-board="' + esc(id) + '">' +
      esc(name) + ' <span class="count">' + count + '</span></button>';
  }

  function buildFilterOptions() {
    var prov = $('#f-provider');
    var tags = {};
    var providers = {};
    allTiles().forEach(function (e) {
      providers[e.tile.provider] = true;
      (e.tile.tags || []).forEach(function (t) { if (t) tags[String(t)] = true; });
    });
    var provKeys = Object.keys(providers).sort();
    var tagKeys = Object.keys(tags).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    fillSelect(prov, provKeys.map(function (p) { return { v: p, label: V.providerLabel(p) }; }), state.provider);
    fillSelect($('#f-tag'), tagKeys.map(function (t) { return { v: t, label: t }; }), state.tag);
    // если выбранное значение пропало из данных — синхронизируем состояние
    state.provider = prov.value || '';
    state.tag = $('#f-tag').value || '';
  }

  function fillSelect(sel, items, current) {
    var first = sel.options[0];
    var prev = current;
    sel.innerHTML = '';
    sel.appendChild(first);
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.v;
      o.textContent = it.label;
      if (it.v === prev) o.selected = true;
      sel.appendChild(o);
    });
    // сброс selection, если значение больше не существует
    if (sel.selectedIndex <= 0 && prev) sel.value = '';
  }

  function renderStats() {
    var n = allTiles().length;
    var nb = boards().length;
    var s = n + ' ' + plural(n, 'видео', 'видео', 'видео') + ' · ' + nb + ' ' + plural(nb, 'доска', 'доски', 'досок');
    if (GH.isLocalDev()) s += ' · dev-режим (сохранение в локальный файл)';
    $('#meta-stats').textContent = s;
    $('#f-reset').hidden = !hasActiveFilters();
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // ---------- рендер: галерея ----------

  function renderGallery() {
    var list = filteredTiles();
    state.renderedIds = list.map(function (e) { return e.tile.id; });
    var grid = $('#gallery');
    grid.innerHTML = list.map(cardHTML).join('');
    // пустое состояние актуально только для вида «Сетка»
    var empty = $('#empty');
    if (state.view === 'grid' && !list.length) {
      empty.hidden = false;
      $('#empty-text').textContent = allTiles().length
        ? 'По выбранным фильтрам ничего не найдено'
        : 'Здесь появятся видео, когда владелец добавит их';
      $('#empty-reset').hidden = !allTiles().length;
    } else {
      empty.hidden = true;
    }
  }

  function cardHTML(e) {
    var t = e.tile;
    var col = columnOf(e.board, t.columnId);
    var color = col ? monoColor(col.color) : null;
    var style = '';
    if (color) style += '--c:' + esc(color) + ';--c-bg:' + hexToRgba(color, 0.14) + ';';

    var isSelected = state.selecting && state.selected.indexOf(t.id) >= 0;
    var checkHTML = state.selecting
      ? '<button class="card-check' + (isSelected ? ' checked' : '') + '" data-check="' + esc(t.id) + '" title="Выбрать">✓</button>'
      : '';

    var thumbs = V.thumbFallbacks(t);
    var thumbHTML;
    if (thumbs.length) {
      thumbHTML = '<div class="card-thumb-wrap"><img class="card-thumb" src="' + esc(thumbs[0]) +
        '" alt="" loading="lazy" data-fb="' + esc(thumbs.slice(1).join('|')) + '">' +
        '<span class="card-play"><span>▶</span></span>' +
        (V.fmtDuration(t.duration) ? '<span class="card-chip-duration">' + esc(V.fmtDuration(t.duration)) + '</span>' : '') +
        '</div>';
    } else {
      thumbHTML = '<div class="card-thumb-wrap ph"><div class="ph-glyph">▶</div>' +
        '<span class="card-play"><span>▶</span></span>' +
        (V.fmtDuration(t.duration) ? '<span class="card-chip-duration">' + esc(V.fmtDuration(t.duration)) + '</span>' : '') +
        '</div>';
    }

    var chips = '<span class="chip chip-provider">' + esc(V.providerLabel(t.provider)) + '</span>';
    if (col) chips += '<span class="chip chip-column">' + esc(col.name) + '</span>';
    if (state.board === 'all') chips += '<span class="chip">' + esc(e.board.name) + '</span>';

    var tagHTML = '';
    (t.tags || []).slice(0, 3).forEach(function (tag) {
      tagHTML += '<span class="card-tag">' + esc(tag) + '</span>';
    });

    var actions = '';
    if (GH.canEdit()) {
      actions = '<span class="card-actions">' +
        '<button class="icon-btn" data-act="edit" data-id="' + esc(t.id) + '" title="Изменить">✎</button>' +
        '<button class="icon-btn danger" data-act="del" data-id="' + esc(t.id) + '" title="Удалить">✕</button>' +
        '</span>';
    }

    return '<article class="card' + (isSelected ? ' selected' : '') + '" data-id="' + esc(t.id) + '" style="' + style + '">' +
      thumbHTML +
      checkHTML +
      actions +
      '<div class="card-body">' +
      '<h3 class="card-title">' + esc(t.title || 'Без названия') + '</h3>' +
      '<div class="card-chips">' + chips + '</div>' +
      (tagHTML ? '<div class="card-tags">' + tagHTML + '</div>' : '') +
      '</div></article>';
  }

  // fallback-цепочка превью (ошибки <img> не всплывают — ловим на capture)
  function onImgError(e) {
    var img = e.target;
    if (!img || !img.tagName || img.tagName.toLowerCase() !== 'img') return;
    var fb = (img.getAttribute('data-fb') || '').split('|').filter(Boolean);
    if (fb.length) {
      img.src = fb.shift();
      img.setAttribute('data-fb', fb.join('|'));
      return;
    }
    if (img.id === 'tile-preview-img') { img.hidden = true; return; }
    var wrap = img.parentNode;
    if (wrap && wrap.classList.contains('card-thumb-wrap')) {
      wrap.classList.add('ph');
      img.remove();
      var g = document.createElement('div');
      g.className = 'ph-glyph';
      g.textContent = '▶';
      wrap.insertBefore(g, wrap.firstChild);
      return;
    }
    // превью в канбане: img лежит прямо в .kb-card
    if (img.classList.contains('kb-card-thumb')) {
      var ph = document.createElement('div');
      ph.className = 'kb-card-ph';
      ph.textContent = '▶';
      img.parentNode.replaceChild(ph, img);
    }
  }

  // ---------- рендер: канбан ----------

  function renderKanban() {
    var kanban = $('#kanban');
    if (state.board === 'all') {
      if (boards().length) state.board = boards()[0].id;
      else { kanban.innerHTML = '<div class="empty"><div class="empty-mark">▷</div><p>Нет ни одной доски</p></div>'; return; }
    }
    var b = findBoard(state.board);
    if (!b) { state.board = 'all'; renderKanban(); return; }
    state.renderedIds = (b.tiles || []).map(function (t) { return t.id; });

    var edit = GH.canEdit();
    var html = '<div class="kb-head">' +
      '<h2 class="kb-title">' + esc(b.name) + '</h2>' +
      '<span class="kb-sub">' + (b.tiles || []).length + ' видео · ' + (b.columns || []).length + ' колонок</span>' +
      '<span class="spacer"></span>' +
      (edit ? boardEditButtonsHTML(b) : '') +
      '</div>';

    html += '<div class="kb-cols">';
    (b.columns || []).forEach(function (c) {
      html += columnHTML(b, c, edit);
    });
    if (edit) html += '<button class="kb-add-col" id="kb-add-col">+ колонка</button>';
    html += '</div>';

    kanban.innerHTML = html;

    if (edit) {
      var addCol = $('#kb-add-col');
      if (addCol) addCol.addEventListener('click', function () { openColumnModal(null, b.id); });
      var addTile = $('#kb-add-tile');
      if (addTile) addTile.addEventListener('click', function () { openTileModal(null, { boardId: state.board }); });
    }
  }

  function boardEditButtonsHTML(b) {
    return '<button class="icon-btn" id="kb-board-menu" title="Меню доски">⋮</button>' +
      '<button class="add-btn" id="kb-add-tile"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>Добавить видео</button>';
  }

  function columnHTML(b, c, edit) {
    var tiles = tilesOf(b, c.id);
    var cCol = monoColor(c.color);
    var style = '--c:' + esc(cCol) + ';--c-bg:' + hexToRgba(cCol, 0.14) + ';';
    var html = '<section class="kb-col" data-col="' + esc(c.id) + '" style="' + style + '">' +
      '<header class="kb-col-head">' +
      '<span class="kb-col-dot"></span>' +
      '<span class="kb-col-name">' + esc(c.name) + '</span>' +
      '<span class="kb-count">' + tiles.length + '</span>' +
      (edit ? '<button class="icon-btn kb-menu-btn" data-colmenu="' + esc(c.id) + '" title="Меню колонки">⋮</button>' : '') +
      '</header>' +
      '<div class="kb-cards">';
    tiles.forEach(function (t) {
      html += kbCardHTML(b, c, t, edit);
    });
    if (edit) html += '<button class="kb-add-card" data-addcard="' + esc(c.id) + '">+ видео</button>';
    html += '</div></section>';
    return html;
  }

  function kbCardHTML(b, c, t, edit) {
    var thumbs = V.thumbFallbacks(t);
    var dur = V.fmtDuration(t.duration);
    var thumbHTML = thumbs.length
      ? '<img class="kb-card-thumb" src="' + esc(thumbs[0]) + '" alt="" loading="lazy" data-fb="' + esc(thumbs.slice(1).join('|')) + '">'
      : '<div class="kb-card-ph">▶</div>';
    var isSelected = edit && state.selecting && state.selected.indexOf(t.id) >= 0;
    return '<article class="kb-card' + (isSelected ? ' selected' : '') + '" data-id="' + esc(t.id) + '"' + (edit && !state.selecting ? ' draggable="true"' : '') + '>' +
      thumbHTML +
      (edit && state.selecting ? '<button class="kb-card-check' + (isSelected ? ' checked' : '') + '" data-check="' + esc(t.id) + '" title="Выбрать">✓</button>' : '') +
      (edit ? '<button class="icon-btn kb-card-menu" data-cardmenu="' + esc(t.id) + '" title="Меню карточки">⋮</button>' : '') +
      '<div class="kb-card-body">' +
      '<h4 class="kb-card-title">' + esc(t.title || 'Без названия') + '</h4>' +
      '<div class="kb-card-meta">' +
      '<span>' + esc(V.providerLabel(t.provider)) + '</span>' +
      (dur ? '<span>·</span><span>' + esc(dur) + '</span>' : '') +
      '</div></div></article>';
  }

  // kanban click delegation
  function onKanbanClick(e) {
    var card = e.target.closest('.kb-card');
    var cardMenuBtn = e.target.closest('[data-cardmenu]');
    var colMenuBtn = e.target.closest('[data-colmenu]');
    var addCardBtn = e.target.closest('[data-addcard]');

    if (addCardBtn) {
      var colId = addCardBtn.getAttribute('data-addcard');
      openTileModal(null, { boardId: state.board, columnId: colId });
      return;
    }
    if (colMenuBtn) {
      e.stopPropagation(); // не давать документному «клик мимо меню» закрыть его сразу
      var rect = colMenuBtn.getBoundingClientRect();
      showColumnMenu(colMenuBtn.getAttribute('data-colmenu'), rect.left, rect.bottom + 4);
      return;
    }
    if (cardMenuBtn) {
      e.stopPropagation();
      var r = cardMenuBtn.getBoundingClientRect();
      showCardMenu(cardMenuBtn.getAttribute('data-cardmenu'), r.left, r.bottom + 4);
      return;
    }
    var checkBtn = e.target.closest('[data-check]');
    if (checkBtn) {
      e.stopPropagation();
      toggleSelected(checkBtn.getAttribute('data-check'));
      return;
    }
    if (card && state.selecting) {
      e.stopPropagation();
      toggleSelected(card.getAttribute('data-id'));
      return;
    }
    if (card) {
      openPlayer(card.getAttribute('data-id'));
    }
  }

  function showCardMenu(tileId, x, y) {
    var found = findTile(tileId);
    if (!found) return;
    var b = found.board;
    var items = [
      { label: 'Открыть', action: function () { openPlayer(tileId); } },
      { label: 'Изменить', action: function () { openTileModal(tileId, null); } },
      '-'
    ];
    (b.columns || []).forEach(function (c) {
      if (c.id === found.tile.columnId) return;
      items.push({
        label: '→ ' + c.name,
        color: monoColor(c.color),
        action: function () { moveTile(tileId, c.id, tilesOf(b, c.id).length); }
      });
    });
    items.push('-', { label: 'Удалить', danger: true, action: function () { deleteTile(tileId); } });
    showMenu(items, x, y);
  }

  // ---------- индикатор публикации Pages ----------

  // После коммита опрашиваем живой data/db.js (?t= — мимо кэша): как только
  // origin отдаёт наш updatedAt — Pages собрался и задеплоился.
  var deployWatch = null;

  function startDeployWatch() {
    var updatedAt = state.data.updatedAt;
    if (deployWatch && deployWatch.updatedAt === updatedAt) return; // уже следим за этой версией
    if (deployWatch) { // пересохранение во время сборки — перенацеливаем на свежий коммит
      clearInterval(deployWatch.animTimer);
      clearInterval(deployWatch.pollTimer);
    }
    deployWatch = { updatedAt: updatedAt, start: Date.now(), done: false };
    $('#deploy-widget').hidden = false;
    $('#deploy-status').textContent = 'Коммит отправлен — Pages собирает…';
    $('#deploy-actions').hidden = true;
    $('#deploy-fill').style.width = '6%';
    $('#deploy-elapsed').textContent = '0 с';
    deployWatch.animTimer = setInterval(function () {
      var el = Date.now() - deployWatch.start;
      // ползём к 95% по экспоненте: 20с ~37%, 45с ~63%, 90с ~86%; 100% только по факту деплоя
      var pct = Math.min(95, Math.round(100 * (1 - Math.exp(-el / 40000))));
      $('#deploy-fill').style.width = pct + '%';
      $('#deploy-elapsed').textContent = Math.round(el / 1000) + ' с';
      if (!deployWatch.done && el > 240000) {
        $('#deploy-status').textContent = 'Сборка затянулась — проверьте статус Pages';
        $('#deploy-actions').hidden = false;
      }
    }, 200);
    deployWatch.pollTimer = setInterval(pollDeploy, 6000);
    pollDeploy();
  }

  function pollDeploy() {
    if (!deployWatch || deployWatch.done) return;
    fetch(CFG.dataPath + '?t=' + Date.now(), { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!deployWatch || deployWatch.done || !text) return;
        var remote;
        try { remote = GH.parseText(text); } catch (e) { return; }
        if (remote && remote.updatedAt === deployWatch.updatedAt) {
          deployWatch.done = true;
          clearInterval(deployWatch.animTimer);
          clearInterval(deployWatch.pollTimer);
          var secs = Math.round((Date.now() - deployWatch.start) / 1000);
          $('#deploy-fill').style.width = '100%';
          $('#deploy-status').textContent = 'Опубликовано ✓ — изменения на сайте';
          $('#deploy-elapsed').textContent = 'за ' + secs + ' с';
          setTimeout(function () {
            if (deployWatch && deployWatch.done) closeDeployWidget();
          }, 5000);
        }
      })
      .catch(function () { /* сеть — повторим по таймеру */ });
  }

  function closeDeployWidget() {
    if (deployWatch) {
      clearInterval(deployWatch.animTimer);
      clearInterval(deployWatch.pollTimer);
      deployWatch = null;
    }
    $('#deploy-widget').hidden = true;
  }

  // ---------- массовый выбор ----------

  function setSelecting(on) {
    state.selecting = on;
    if (!on) state.selected = [];
    document.body.classList.toggle('selecting', on);
    $('#select-bar').hidden = !on;
    updateSelectBar();
    renderAll();
  }

  function updateSelectBar() {
    $('#sel-count').textContent = 'Выбрано: ' + state.selected.length;
  }

  function toggleSelected(id) {
    var i = state.selected.indexOf(id);
    if (i >= 0) state.selected.splice(i, 1);
    else state.selected.push(id);
    updateSelectBar();
    // обновить карточки точечно, без полного рендера (не дёргаем lazy-превью)
    var on = state.selected.indexOf(id) >= 0;
    $all('.card[data-id="' + id + '"], .kb-card[data-id="' + id + '"]').forEach(function (el) {
      el.classList.toggle('selected', on);
      var chk = el.querySelector('.card-check, .kb-card-check');
      if (chk) chk.classList.toggle('checked', on);
    });
  }

  function deleteSelectedTiles() {
    if (!state.selected.length) return;
    var n = state.selected.length;
    confirmDialog('Удалить выбранные видео (' + n + ' ' + plural(n, 'шт.', 'шт.', 'шт.') + ')? Одним коммитом — один билд Pages.')
      .then(function (choice) {
        if (choice !== 'yes') return;
        var removed = []; // {board, tile, idx} — для отката
        state.selected.forEach(function (id) {
          var found = findTile(id);
          if (!found) return;
          var tiles = found.board.tiles || [];
          var idx = tiles.indexOf(found.tile);
          if (idx >= 0) { tiles.splice(idx, 1); removed.push({ board: found.board, tile: found.tile, idx: idx }); }
        });
        var label = 'массовое удаление: ' + removed.length + ' ' + plural(removed.length, 'видео', 'видео', 'видео');
        persist(label).then(function (ok) {
          if (ok) {
            toast('Удалено ' + removed.length + ' — Pages обновится через ~1 мин');
            setSelecting(false);
            renderAll();
            return;
          }
          // откат: вернуть плитки на исходные позиции (по каждой доске — с конца)
          var byBoard = {};
          removed.forEach(function (r) { (byBoard[r.board.id] = byBoard[r.board.id] || []).push(r); });
          Object.keys(byBoard).forEach(function (bid) {
            byBoard[bid].sort(function (a, b) { return b.idx - a.idx; }).forEach(function (r) {
              var tiles = r.board.tiles || [];
              tiles.splice(Math.min(r.idx, tiles.length), 0, r.tile);
            });
          });
          renderAll();
          toast('Удаление не сохранено — плитки возвращены на место', 'err');
        });
      });
  }

  function deleteTile(tileId) {
    var found = findTile(tileId);
    if (!found) return;
    confirmDialog('Удалить видео «' + (found.tile.title || 'без названия') + '»?')
      .then(function (choice) {
        if (choice !== 'yes') return;
        var tiles = found.board.tiles || [];
        var idx = tiles.indexOf(found.tile);
        tiles.splice(idx, 1);
        persist('доска «' + found.board.name + '»: удалено — ' + (found.tile.title || '')).then(function (ok) {
          if (ok) { renderAll(); return; }
          // сохранение не прошло (конликт/сеть) — возвращаем плитку на место
          if (tiles.indexOf(found.tile) < 0) tiles.splice(Math.min(idx, tiles.length), 0, found.tile);
          renderAll();
          toast('Удаление не сохранено — плитка возвращена на место', 'err');
        });
      });
  }

  function showColumnMenu(colId, x, y) {
    var b = findBoard(state.board);
    var c = b ? columnOf(b, colId) : null;
    if (!b || !c) return;
    var items = [
      { label: 'Переименовать / цвет', action: function () { openColumnModal(colId); } },
      { label: 'Добавить видео', action: function () { openTileModal(null, { boardId: b.id, columnId: colId }); } },
      '-',
      { label: 'Удалить колонку', danger: true, action: function () { deleteColumn(b.id, colId); } }
    ];
    showMenu(items, x, y);
  }

  function onBoardMenuClick(e) {
    var btn = e.target.closest('#kb-board-menu');
    if (!btn) return;
    e.stopPropagation(); // см. комментарий в onKanbanClick
    var rect = btn.getBoundingClientRect();
    var items = [
      { label: 'Переименовать доску', action: function () { openBoardModal(state.board); } },
      '-',
      { label: 'Удалить доску', danger: true, action: function () { deleteBoard(state.board); } }
    ];
    showMenu(items, rect.left, rect.bottom + 4);
  }

  function deleteColumn(boardId, colId) {
    var b = findBoard(boardId);
    var c = b ? columnOf(b, colId) : null;
    if (!b || !c) return;
    var n = tilesOf(b, colId).length;
    confirmDialog(
      n ? 'Удалить колонку «' + c.name + '»? Её ' + n + ' ' + plural(n, 'видео', 'видео', 'видео') +
        ' переместится в первую оставшуюся колонку.'
        : 'Удалить колонку «' + c.name + '»?'
    ).then(function (choice) {
      if (choice !== 'yes') return;
      var cols = b.columns || [];
      var rest = cols.filter(function (x) { return x.id !== colId; });
      var fallback = rest.length ? rest[0].id : null;
      if (fallback) {
        (b.tiles || []).forEach(function (t) { if (t.columnId === colId) t.columnId = fallback; });
      } else {
        b.tiles = (b.tiles || []).filter(function (t) { t.columnId !== colId; });
      }
      b.columns = rest;
      persist('доска «' + b.name + '»: удалена колонка «' + c.name + '»').then(function (ok) {
        if (ok) renderAll();
      });
    });
  }

  function deleteBoard(boardId) {
    var b = findBoard(boardId);
    if (!b) return;
    confirmDialog('Удалить доску «' + b.name + '» вместе с ' + (b.tiles || []).length + ' видео?')
      .then(function (choice) {
        if (choice !== 'yes') return;
        state.data.boards = boards().filter(function (x) { return x.id !== boardId; });
        state.board = 'all';
        persist('удалена доска «' + b.name + '»').then(function (ok) {
          if (ok) renderAll();
        });
      });
  }

  // ---------- drag & drop ----------

  function findKbList(el) {
    return el.closest ? el.closest('.kb-cards') : null;
  }

  function onKanbanDragStart(e) {
    var card = e.target.closest ? e.target.closest('.kb-card') : null;
    if (!card || !GH.canEdit()) { e.preventDefault(); return; }
    dnd.tileId = card.getAttribute('data-id');
    dnd.colId = null;
    dnd.index = -1;
    card.classList.add('dragging');
    try {
      e.dataTransfer.setData('text/plain', dnd.tileId);
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { /* ignore */ }
  }

  function onKanbanDragOver(e) {
    if (!dnd.tileId) return;
    var list = findKbList(e.target);
    if (!list) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // убрать старые индикаторы
    $all('.drop-indicator').forEach(function (n) { n.remove(); });

    var col = list.closest('.kb-col');
    var colId = col ? col.getAttribute('data-col') : null;

    // вычислить позицию вставки по вертикали курсора
    var cards = $all('.kb-card', list).filter(function (c) { return !c.classList.contains('dragging'); });
    var index = cards.length;
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }

    // вставить индикатор
    var ind = document.createElement('div');
    ind.className = 'drop-indicator';
    if (index < cards.length) list.insertBefore(ind, cards[index]);
    else list.appendChild(ind);
    // индикатор не должен попадать после кнопки «+ видео»
    var addBtn = list.querySelector('.kb-add-card');
    if (addBtn && ind.previousElementSibling === addBtn) {
      list.insertBefore(ind, addBtn);
    }

    dnd.colId = colId;
    dnd.index = index;

    $all('.kb-col').forEach(function (c) {
      c.classList.toggle('drag-over', c === col);
    });
  }

  function onKanbanDrop(e) {
    if (!dnd.tileId || !dnd.colId || dnd.index < 0) { cleanupDnd(); return; }
    e.preventDefault();
    var tileId = dnd.tileId, colId = dnd.colId, index = dnd.index;
    cleanupDnd();
    moveTile(tileId, colId, index);
  }

  function cleanupDnd() {
    $all('.drop-indicator').forEach(function (n) { n.remove(); });
    $all('.kb-col.drag-over').forEach(function (n) { n.classList.remove('drag-over'); });
    $all('.kb-card.dragging').forEach(function (n) { n.classList.remove('dragging'); });
    dnd.tileId = null; dnd.colId = null; dnd.index = -1;
  }

  function moveTile(tileId, colId, index) {
    var found = findTile(tileId);
    if (!found) return;
    var b = found.board;
    var t = found.tile;
    if (t.columnId === colId) {
      // проверим, меняется ли позиция внутри колонки
      var cur = tilesOf(b, colId).map(function (x) { return x.id; });
      if (cur[Math.min(index, cur.length - 1)] === tileId || cur.indexOf(tileId) === index) {
        renderKanban();
        return;
      }
    }
    var tiles = b.tiles || [];
    var i = tiles.indexOf(t);
    if (i >= 0) tiles.splice(i, 1);
    t.columnId = colId;
    var idx = 0, insertAt = tiles.length;
    for (var k = 0; k < tiles.length; k++) {
      if (tiles[k].columnId === colId) {
        if (idx === index) { insertAt = k; break; }
        idx++;
      }
    }
    tiles.splice(insertAt, 0, t);
    var col = columnOf(b, colId);
    var label = 'доска «' + b.name + '»: «' + (t.title || 'без названия') + '» → ' + (col ? col.name : colId);
    persist(label).then(function (ok) {
      if (ok) { renderKanban(); renderTabs(); renderStats(); buildFilterOptions(); }
      else renderKanban(); // откат отображения при ошибке сохранения
    });
  }

  // ---------- контекстное меню ----------

  var menuItems = null;

  function showMenu(items, x, y) {
    menuItems = items;
    var menu = $('#menu');
    var html = '';
    items.forEach(function (it, i) {
      if (it === '-') { html += '<div class="menu-sep"></div>'; return; }
      html += '<button class="menu-item' + (it.danger ? ' danger' : '') + '" data-idx="' + i + '">' +
        (it.color ? '<span class="menu-color" style="background:' + esc(it.color) + '"></span>' : '') +
        esc(it.label) + '</button>';
    });
    menu.innerHTML = html;
    menu.hidden = false;
    var r = menu.getBoundingClientRect();
    var maxX = window.innerWidth - r.width - 8;
    var maxY = window.innerHeight - r.height - 8;
    menu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
  }

  function closeMenu() {
    $('#menu').hidden = true;
    menuItems = null;
  }

  function onMenuClick(e) {
    var btn = e.target.closest('.menu-item');
    if (!btn) return;
    var idx = parseInt(btn.getAttribute('data-idx'), 10);
    var it = menuItems && menuItems[idx];
    closeMenu();
    if (it && it.action) it.action();
  }

  // ---------- модалки (базовые) ----------

  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (!$all('.modal').some(function (m) { return !m.hidden; })) {
      document.body.classList.remove('modal-open');
    }
    if (modal.id === 'player-modal') stopPlayer();
  }

  function closeAllModals() {
    $all('.modal').forEach(function (m) { m.hidden = true; });
    document.body.classList.remove('modal-open');
    stopPlayer();
  }

  // ---------- модальный плеер ----------

  function openPlayer(tileId) {
    var list = state.renderedIds;
    if (!list.length) {
      var found = findTile(tileId);
      list = found ? [found.tile.id] : [];
    }
    var idx = list.indexOf(tileId);
    if (idx < 0) { list = [tileId]; idx = 0; }
    state.playerList = list;
    state.playerIdx = idx;
    renderPlayer();
    openModal($('#player-modal'));
  }

  function renderPlayer() {
    var entry = findTile(state.playerList[state.playerIdx]);
    if (!entry) { closeModal($('#player-modal')); return; }
    var t = entry.tile;
    var col = columnOf(entry.board, t.columnId);

    $('#player-title').textContent = t.title || 'Без названия';
    var badges = '<span class="chip chip-provider">' + esc(V.providerLabel(t.provider)) + '</span>';
    if (col) badges += '<span class="chip chip-column" style="--c:' + esc(monoColor(col.color)) + '">' + esc(col.name) + '</span>';
    badges += '<span class="chip">' + esc(entry.board.name) + '</span>';
    $('#player-badges').innerHTML = badges;

    var link = $('#player-src-link');
    link.href = t.url || '#';

    var stage = $('#player-stage');
    var embed = V.embedUrl(t);
    stage.innerHTML = '';
    if (t.provider === 'direct' && t.url) {
      var video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.src = t.url;
      stage.appendChild(video);
    } else if (embed) {
      var iframe = document.createElement('iframe');
      iframe.src = embed;
      iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
      iframe.allowFullscreen = true;
      stage.appendChild(iframe);
    } else {
      var block = document.createElement('div');
      block.className = 'player-stage-block';
      block.innerHTML = '<div>Этот хостинг не разрешает встраивание видео.<br>Откройте его по ссылке:</div>';
      var a = document.createElement('a');
      a.href = t.url || '#';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = t.url || 'открыть';
      block.appendChild(a);
      stage.appendChild(block);
    }

    $('#player-prev').hidden = state.playerList.length < 2;
    $('#player-next').hidden = state.playerList.length < 2;
  }

  function playerNav(step) {
    var n = state.playerList.length;
    if (n < 2) return;
    state.playerIdx = (state.playerIdx + step + n) % n;
    renderPlayer();
  }

  function stopPlayer() {
    var stage = $('#player-stage');
    if (stage) stage.innerHTML = '';
    state.playerList = [];
    state.playerIdx = -1;
  }

  // ---------- редактор плитки ----------

  function openTileModal(tileId, preset) {
    editorCtx = { tileId: tileId || null, boardId: null, columnId: null };
    state.resolveMeta = null;

    var modal = $('#tile-modal');
    $('#tile-modal-title').textContent = tileId ? 'Изменить видео' : 'Добавить видео';
    $('#tile-delete').hidden = !tileId;
    $('#tile-save').disabled = false;

    // доски
    var boardSel = $('#tile-board');
    boardSel.innerHTML = '';
    boards().forEach(function (b) {
      var o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.name;
      boardSel.appendChild(o);
    });
    if (!boards().length) {
      toast('Сначала создайте доску', 'warn');
      return;
    }

    if (tileId) {
      var found = findTile(tileId);
      if (!found) return;
      var t = found.tile;
      editorCtx.boardId = found.board.id;
      editorCtx.columnId = t.columnId;
      $('#tile-url').value = t.url || '';
      $('#tile-title').value = t.title || '';
      $('#tile-tags').value = (t.tags || []).join(', ');
      $('#tile-note').value = t.note || '';
      boardSel.value = found.board.id;
      fillColumnSelect(found.board.id, t.columnId);
      var info = { provider: t.provider, vid: t.vid, vk: t.vk, url: t.url };
      showTilePreview(info, t.thumb, t.title);
      $('#tile-resolve-status').hidden = true;
    } else {
      var bId = (preset && preset.boardId) || (state.board !== 'all' ? state.board : boards()[0].id);
      if (!findBoard(bId)) bId = boards()[0].id;
      editorCtx.boardId = bId;
      editorCtx.columnId = (preset && preset.columnId) || (tilesOfOrder(findBoard(bId))[0] ? findBoard(bId).columns[0].id : null);
      $('#tile-url').value = '';
      $('#tile-title').value = '';
      $('#tile-tags').value = '';
      $('#tile-note').value = '';
      boardSel.value = bId;
      fillColumnSelect(bId, editorCtx.columnId);
      $('#tile-preview').hidden = true;
      $('#tile-resolve-status').hidden = true;
    }
    openModal(modal);
    setTimeout(function () { $('#tile-url').focus(); }, 50);
  }

  function tilesOfOrder(board) {
    return board ? (board.columns || []) : [];
  }

  function fillColumnSelect(boardId, selected) {
    var b = findBoard(boardId);
    var sel = $('#tile-column');
    sel.innerHTML = '';
    var cols = b ? (b.columns || []) : [];
    cols.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === selected) o.selected = true;
      sel.appendChild(o);
    });
    if (!cols.length) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '— нет колонок —';
      sel.appendChild(o0);
    }
  }

  function showTilePreview(info, thumb, title) {
    var prev = $('#tile-preview');
    $('#tile-preview-provider').textContent = V.providerLabel(info.provider);
    var img = $('#tile-preview-img');
    var thumbs = thumb ? [thumb] : [];
    if (info.provider === 'youtube' && info.vid) {
      thumbs = ['https://i.ytimg.com/vi/' + info.vid + '/maxresdefault.jpg',
        'https://i.ytimg.com/vi/' + info.vid + '/hqdefault.jpg'];
    }
    if (thumbs.length) {
      img.src = thumbs[0];
      img.setAttribute('data-fb', thumbs.slice(1).join('|'));
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    prev.hidden = false;
  }

  function onTileResolve() {
    var url = $('#tile-url').value.trim();
    var status = $('#tile-resolve-status');
    var btn = $('#tile-resolve');
    if (!url) {
      status.hidden = false;
      status.className = 'resolve-status err';
      status.textContent = 'Вставьте ссылку на видео.';
      return;
    }
    var info = V.parse(url);
    if (!info) {
      status.hidden = false;
      status.className = 'resolve-status err';
      status.textContent = 'Не похоже на ссылку на видео. Пример: https://www.youtube.com/watch?v=…';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Определяю…';
    V.resolve(url).then(function (meta) {
      btn.disabled = false;
      btn.textContent = 'Определить';
      state.resolveMeta = meta;
      showTilePreview(meta, meta.thumb, meta.title);
      var known = !!meta.title;
      if (known) {
        var autoTitle = $('#tile-title');
        if (!autoTitle.value.trim() || autoTitle.dataset.auto === '1') {
          autoTitle.value = meta.title;
          autoTitle.dataset.auto = '1';
        }
        status.hidden = false;
        status.className = 'resolve-status ok';
        status.textContent = 'Название получено' + (meta.source ? ' (' + meta.source + ')' : '') +
          (meta.duration ? ', длительность ' + V.fmtDuration(meta.duration) : '') + '. Можно сохранить.';
      } else {
        status.hidden = false;
        status.className = 'resolve-status warn';
        status.textContent = 'Название получить не удалось — введите его вручную. Превью' +
          (meta.provider === 'youtube' ? ' подтянется из YouTube.' : ' будет заглушка.');
      }
    });
  }

  function onTileSave() {
    var url = $('#tile-url').value.trim();
    if (!url) { toast('Укажите ссылку на видео', 'warn'); return; }
    var meta = state.resolveMeta;
    var parsed = V.parse(url);
    if (!parsed) { toast('Ссылка не распознана как видео', 'warn'); return; }
    var bId = $('#tile-board').value;
    var colId = $('#tile-column').value;
    var b = findBoard(bId);
    if (!b || !colId) { toast('Выберите доску и колонку', 'warn'); return; }

    var tags = $('#tile-tags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    var t;
    if (editorCtx.tileId) {
      var found = findTile(editorCtx.tileId);
      if (!found) return;
      t = found.tile;
      if (found.board.id !== bId) {
        // перенос между досками
        found.board.tiles = (found.board.tiles || []).filter(function (x) { return x.id !== t.id; });
        b.tiles = b.tiles || [];
        b.tiles.push(t);
      }
    } else {
      t = { id: uid('t'), addedAt: new Date().toISOString() };
      b.tiles = b.tiles || [];
      b.tiles.push(t);
    }

    t.columnId = colId;
    t.url = parsed.url;
    t.provider = parsed.provider;
    t.vid = parsed.vid || null;
    t.vk = parsed.vk || null;
    t.title = $('#tile-title').value.trim() || (meta && meta.title) || 'Без названия';
    t.thumb = (meta && meta.thumb) || t.thumb || null;
    if (meta && meta.duration) t.duration = meta.duration;
    t.tags = tags;
    t.note = $('#tile-note').value.trim();

    var isNew = !editorCtx.tileId;
    var label = 'доска «' + b.name + '»: ' + (isNew ? '+1 видео — ' : 'правка — ') + t.title;
    persist(label).then(function (ok) {
      if (ok) {
        closeModal($('#tile-modal'));
        renderAll();
        if (state.view === 'kanban') renderKanban();
      }
    });
  }

  function onTileDelete() {
    if (!editorCtx.tileId) return;
    var found = findTile(editorCtx.tileId);
    if (!found) return;
    confirmDialog('Удалить видео «' + (found.tile.title || 'без названия') + '»?')
      .then(function (choice) {
        if (choice !== 'yes') return;
        var tiles = found.board.tiles || [];
        var idx = tiles.indexOf(found.tile);
        tiles.splice(idx, 1);
        var label = 'доска «' + found.board.name + '»: удалено — ' + (found.tile.title || '');
        persist(label).then(function (ok) {
          closeModal($('#tile-modal'));
          if (ok) { renderAll(); return; }
          // откат при несохранении
          if (tiles.indexOf(found.tile) < 0) tiles.splice(Math.min(idx, tiles.length), 0, found.tile);
          renderAll();
          toast('Удаление не сохранено — плитка возвращена на место', 'err');
        });
      });
  }

  // ---------- редактор колонки ----------

  function openColumnModal(colId, boardId) {
    colCtx = { boardId: boardId || (state.board !== 'all' ? state.board : boards()[0].id), colId: colId || null };
    var b = findBoard(colCtx.boardId);
    if (!b) return;
    var c = colId ? columnOf(b, colId) : null;
    $('#column-modal-title').textContent = c ? 'Колонка «' + c.name + '»' : 'Новая колонка';
    $('#column-name').value = c ? c.name : '';
    $('#column-delete').hidden = !c;
    var pal = $('#column-palette');
    pal.innerHTML = '';
    var active = c ? c.color : PALETTE[0];
    PALETTE.forEach(function (hex) {
      var btn = document.createElement('button');
      btn.className = 'palette-swatch' + (hex === active ? ' active' : '');
      btn.style.background = hex;
      btn.setAttribute('data-hex', hex);
      pal.appendChild(btn);
    });
    openModal($('#column-modal'));
    setTimeout(function () { $('#column-name').focus(); }, 50);
  }

  function onPaletteClick(e) {
    var sw = e.target.closest('.palette-swatch');
    if (!sw) return;
    $all('.palette-swatch').forEach(function (n) { n.classList.remove('active'); });
    sw.classList.add('active');
  }

  function onColumnSave() {
    var b = findBoard(colCtx.boardId);
    if (!b) return;
    var name = $('#column-name').value.trim();
    if (!name) { toast('Введите название колонки', 'warn'); return; }
    var sw = $('#column-palette .palette-swatch.active');
    var color = sw ? sw.getAttribute('data-hex') : PALETTE[0];
    if (colCtx.colId) {
      var c = columnOf(b, colCtx.colId);
      if (c) { c.name = name; c.color = color; }
      persist('доска «' + b.name + '»: колонка «' + name + '»').then(function (ok) {
        if (ok) { closeModal($('#column-modal')); renderAll(); }
      });
    } else {
      b.columns = b.columns || [];
      b.columns.push({ id: uid('c'), name: name, color: color });
      persist('доска «' + b.name + '»: + колонка «' + name + '»').then(function (ok) {
        if (ok) { closeModal($('#column-modal')); renderAll(); }
      });
    }
  }

  // ---------- модалка доски ----------

  function openBoardModal(boardId) {
    boardCtx = { boardId: boardId || null };
    var b = boardId ? findBoard(boardId) : null;
    $('#board-modal-title').textContent = b ? 'Доска «' + b.name + '»' : 'Новая доска';
    $('#board-name').value = b ? b.name : '';
    $('#board-delete').hidden = !b;
    $('#board-save').textContent = b ? 'Сохранить' : 'Создать';
    openModal($('#board-modal'));
    setTimeout(function () { $('#board-name').focus(); }, 50);
  }

  function onBoardSave() {
    var name = $('#board-name').value.trim();
    if (!name) { toast('Введите название доски', 'warn'); return; }
    if (boardCtx.boardId) {
      var b = findBoard(boardCtx.boardId);
      if (!b) return;
      b.name = name;
      persist('доска переименована в «' + name + '»').then(function (ok) {
        if (ok) { closeModal($('#board-modal')); renderAll(); }
      });
    } else {
      var nb = {
        id: uid('b'),
        name: name,
        createdAt: new Date().toISOString(),
        columns: DEFAULT_COLUMNS.map(function (c) { return { id: uid('c'), name: c.name, color: c.color }; }),
        tiles: []
      };
      state.data.boards = boards().concat([nb]);
      state.board = nb.id;
      persist('доска «' + name + '»: создана').then(function (ok) {
        if (ok) {
          closeModal($('#board-modal'));
          renderAll();
          toast('Доска «' + name + '» создана');
        }
      });
    }
  }

  // ---------- вход / сессия ----------

  function openLoginModal() {
    var authed = !!state.user;
    $('#login-form').hidden = authed;
    $('#login-session').hidden = !authed;
    if (authed) $('#login-user').textContent = state.user;
    $('#login-error').hidden = true;
    $('#login-token').value = '';
    openModal($('#login-modal'));
    if (!authed) setTimeout(function () { $('#login-token').focus(); }, 50);
  }

  function onLoginSubmit() {
    var token = $('#login-token').value.trim();
    var errBox = $('#login-error');
    var btn = $('#login-submit');
    errBox.hidden = true;
    if (!token) {
      errBox.textContent = 'Вставьте токен.';
      errBox.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Проверяю…';
    GH.loginWithToken(token).then(function (u) {
      btn.disabled = false;
      btn.textContent = 'Войти';
      state.user = u.login;
      updateAuthUi();
      toast('Вы вошли как ' + u.login);
      closeModal($('#login-modal'));
      return loadRemoteData().then(function () { renderAll(); });
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Войти';
      errBox.textContent = err.message || 'Не удалось проверить токен';
      errBox.hidden = false;
    });
  }

  function onLogout() {
    GH.logout();
    state.user = null;
    state.remoteSha = null;
    updateAuthUi();
    closeModal($('#login-modal'));
    toast('Вы вышли. Редактирование отключено.');
    renderAll();
  }

  function applyColorMode() {
    document.body.classList.toggle('color', state.color);
    $('#color-toggle').title = state.color ? 'Монохромный вид' : 'Показать цвет';
    $('#color-toggle').classList.toggle('active', state.color);
  }

  function updateAuthUi() {
    var authed = !!state.user;
    var body = document.body;
    body.classList.toggle('authed', authed);
    var btn = $('#auth-btn');
    btn.classList.toggle('authed', authed);
    $('#auth-label').textContent = authed ? state.user : 'Войти';
    var edit = GH.canEdit();
    $('#add-btn').hidden = !edit;
    $('#select-btn').hidden = !edit;
    if (!edit && state.selecting) setSelecting(false);
  }

  function loadRemoteData() {
    if (!state.user) return Promise.resolve();
    return GH.loadRemote().then(function (res) {
      if (res && res.data) {
        state.data = res.data;
        state.remoteSha = res.sha;
        if (state.board !== 'all' && !findBoard(state.board)) state.board = 'all';
      } else if (res && res.data === null) {
        state.remoteSha = null;
        toast('В репозитории нет data/db.js — будет создан при первом сохранении', 'warn');
      }
    }).catch(function (err) {
      toast('Не удалось загрузить данные из репозитория: ' + err.message, 'err');
    });
  }

  // ---------- обновление данных (⟳) ----------

  function onRefresh() {
    if (state.user) {
      loadRemoteData().then(function () {
        renderAll();
        toast('Данные обновлены из репозитория');
      });
      return;
    }
    // гость: перезагрузить script-глобал с cache-busting
    var old = document.getElementById('pvb-data-script');
    if (old) old.remove();
    var s = document.createElement('script');
    s.id = 'pvb-data-script';
    s.src = CFG.dataPath + '?t=' + Date.now();
    s.onload = function () {
      state.data = window.__PVB_DATA;
      if (state.board !== 'all' && !findBoard(state.board)) state.board = 'all';
      renderAll();
      toast('Данные обновлены');
    };
    s.onerror = function () { toast('Не удалось загрузить данные', 'err'); };
    document.head.appendChild(s);
  }

  // ---------- общий рендер ----------

  function renderAll() {
    if (state.view === 'kanban') {
      $('#gallery').hidden = true;
      $('#kanban').hidden = false;
      $('#view-grid').classList.remove('active');
      $('#view-kanban').classList.add('active');
    } else {
      $('#gallery').hidden = false;
      $('#kanban').hidden = true;
      $('#view-grid').classList.add('active');
      $('#view-kanban').classList.remove('active');
    }
    renderTabs();
    buildFilterOptions();
    renderStats();
    if (state.view === 'kanban') renderKanban();
    else renderGallery();
  }

  // ---------- события ----------

  function bindEvents() {
    // вкладки досок (+ кнопка новой доски)
    $('#tabs').addEventListener('click', function (e) {
      var add = e.target.closest('.tab-add');
      if (add) { openBoardModal(null); return; }
      var tab = e.target.closest('.tab');
      if (!tab) return;
      state.board = tab.getAttribute('data-board');
      renderAll();
    });

    // поиск
    $('#search').addEventListener('input', debounce(function () {
      state.q = $('#search').value;
      $('#search-clear').hidden = !$('#search').value;
      if (state.view === 'kanban') { renderGallery(); state.renderedIds = filteredTiles().map(function (e) { return e.tile.id; }); }
      else renderGallery();
      renderStats();
    }, 160));
    $('#search-clear').addEventListener('click', function () {
      $('#search').value = '';
      state.q = '';
      $('#search-clear').hidden = true;
      renderGallery();
      renderStats();
    });

    // фильтры
    $('#f-provider').addEventListener('change', function () {
      state.provider = $('#f-provider').value;
      renderAll();
    });
    $('#f-tag').addEventListener('change', function () {
      state.tag = $('#f-tag').value;
      renderAll();
    });
    $('#f-sort').addEventListener('change', function () {
      state.sort = $('#f-sort').value;
      renderAll();
    });
    $('#f-reset').addEventListener('click', resetFilters);
    $('#empty-reset').addEventListener('click', resetFilters);

    // вид
    $('#view-grid').addEventListener('click', function () { setView('grid'); });
    $('#view-kanban').addEventListener('click', function () { setView('kanban'); });

    // прочие кнопки шапки
    $('#refresh-btn').addEventListener('click', onRefresh);
    $('#select-btn').addEventListener('click', function () { setSelecting(!state.selecting); });
    $('#sel-all').addEventListener('click', function () {
      state.selected = state.renderedIds.slice();
      updateSelectBar();
      renderAll();
    });
    $('#sel-delete').addEventListener('click', deleteSelectedTiles);
    $('#sel-cancel').addEventListener('click', function () { setSelecting(false); });
    $('#deploy-close').addEventListener('click', closeDeployWidget);
    $('#color-toggle').addEventListener('click', function () {
      state.color = !state.color;
      try { localStorage.setItem(COLOR_KEY, state.color ? '1' : '0'); } catch (e) { /* ignore */ }
      applyColorMode();
      renderAll();
    });
    $('#add-btn').addEventListener('click', function () { openTileModal(null, null); });
    $('#auth-btn').addEventListener('click', openLoginModal);

    // галерея
    $('#gallery').addEventListener('click', onGalleryClick);
    $('#gallery').addEventListener('error', onImgError, true);

    // канбан
    var kanban = $('#kanban');
    kanban.addEventListener('click', function (e) {
      onKanbanClick(e);
      onBoardMenuClick(e);
      var actBtn = e.target.closest('[data-act]');
      if (actBtn) onCardAction(actBtn.getAttribute('data-act'), actBtn.getAttribute('data-id'));
    });
    kanban.addEventListener('dragstart', onKanbanDragStart);
    kanban.addEventListener('dragover', onKanbanDragOver);
    kanban.addEventListener('drop', onKanbanDrop);
    kanban.addEventListener('dragend', cleanupDnd);
    kanban.addEventListener('error', onImgError, true);

    // меню
    $('#menu').addEventListener('click', onMenuClick);
    document.addEventListener('click', function (e) {
      if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu();
    });

    // закрытие модалок по [data-close] и Esc
    document.addEventListener('click', function (e) {
      var closer = e.target.closest('[data-close]');
      if (closer) {
        var m = closer.closest('.modal');
        if (m) closeModal(m);
      }
    });

    // плеер
    $('#player-close').addEventListener('click', function () { closeModal($('#player-modal')); });
    $('#player-prev').addEventListener('click', function () { playerNav(-1); });
    $('#player-next').addEventListener('click', function () { playerNav(1); });
    $('#player-sizes').addEventListener('click', function (e) {
      var b = e.target.closest('.seg-btn');
      if (!b) return;
      var sz = b.getAttribute('data-sz');
      var body = $('#player-body');
      body.classList.remove('sz-30', 'sz-50', 'sz-full');
      body.classList.add(sz === '30' ? 'sz-30' : sz === 'full' ? 'sz-full' : 'sz-50');
      $all('#player-sizes .seg-btn').forEach(function (n) {
        n.classList.toggle('active', n === b);
      });
    });

    // редактор плитки
    $('#tile-resolve').addEventListener('click', onTileResolve);
    $('#tile-save').addEventListener('click', onTileSave);
    $('#tile-delete').addEventListener('click', onTileDelete);
    $('#tile-board').addEventListener('change', function () {
      fillColumnSelect($('#tile-board').value, null);
    });
    $('#tile-url').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onTileResolve(); }
    });

    // редактор колонки
    $('#column-palette').addEventListener('click', onPaletteClick);
    $('#column-save').addEventListener('click', onColumnSave);
    $('#column-delete').addEventListener('click', function () {
      deleteColumn(colCtx.boardId, colCtx.colId);
    });

    // доска
    $('#board-save').addEventListener('click', onBoardSave);
    $('#board-delete').addEventListener('click', function () {
      closeModal($('#board-modal'));
      deleteBoard(boardCtx.boardId);
    });

    // вход
    $('#login-submit').addEventListener('click', onLoginSubmit);
    $('#login-token').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onLoginSubmit(); }
    });
    $('#logout-btn').addEventListener('click', onLogout);

    // клавиатура
    document.addEventListener('keydown', function (e) {
      var playerOpen = !$('#player-modal').hidden;
      if (e.key === 'Escape') {
        if (!$('#menu').hidden) { closeMenu(); return; }
        var open = $all('.modal').filter(function (m) { return !m.hidden; });
        if (open.length) { closeModal(open[open.length - 1]); return; }
        if (state.selecting) { setSelecting(false); return; }
      }
      if (e.key === '/' && !playerOpen) {
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
          e.preventDefault();
          $('#search').focus();
        }
        return;
      }
      if (playerOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        playerNav(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });
  }

  function onGalleryClick(e) {
    var actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      onCardAction(actBtn.getAttribute('data-act'), actBtn.getAttribute('data-id'));
      return;
    }
    var checkBtn = e.target.closest('[data-check]');
    if (checkBtn) {
      toggleSelected(checkBtn.getAttribute('data-check'));
      return;
    }
    var card = e.target.closest('.card');
    if (card) {
      if (state.selecting) { toggleSelected(card.getAttribute('data-id')); return; }
      openPlayer(card.getAttribute('data-id'));
    }
  }

  function onCardAction(act, tileId) {
    if (act === 'edit') openTileModal(tileId, null);
    else if (act === 'del') deleteTile(tileId);
  }

  function setView(v) {
    state.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* ignore */ }
    renderAll();
  }

  // ---------- запуск ----------

  function boot() {
    bindEvents();
    state.color = localStorage.getItem(COLOR_KEY) === '1';
    applyColorMode();
    updateAuthUi();
    // отладочный доступ к индикатору публикации — только на localhost (DEV_MODE)
    if (GH.isLocalDev()) {
      window.__PVB_DEBUG = { startDeployWatch: startDeployWatch, closeDeployWidget: closeDeployWidget };
    }

    // data/db.js грузим динамически с cache-busting: Pages кэширует до 10 минут,
    // и после коммита статичный тег ?v=1 мог отдать устаревшие данные
    if (window.__PVB_DATA) {
      bootWithData();
      return;
    }
    var s = document.createElement('script');
    s.src = CFG.dataPath + '?t=' + Date.now();
    s.onload = function () {
      state.data = window.__PVB_DATA || state.data;
      bootWithData();
    };
    s.onerror = function () {
      $('#meta-stats').textContent = 'Не удалось загрузить данные (data/db.js). Проверьте соединение и обновите страницу.';
      bootWithData(); // обработчики всё равно вешаем, пустые состояния покажутся сами
    };
    document.head.appendChild(s);
  }

  function bootWithData() {
    renderAll();
    GH.restoreSession().then(function (u) {
      if (u) {
        state.user = u.login;
        updateAuthUi();
        loadRemoteData().then(renderAll);
      }
    });
  }

  boot();
})();
