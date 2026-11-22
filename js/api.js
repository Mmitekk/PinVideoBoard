/* PinVideoBoard — клиент GitHub Contents API (чтение/запись data/db.js) + вход по токену */
(function () {
  'use strict';

  var CFG = window.__PVB_CONFIG;
  var AUTH_KEY = 'pvb-auth';
  var API = 'https://api.github.com';

  // ---------- base64 (utf-8 safe) ----------

  function utf8ToB64(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }
  function b64ToUtf8(s) {
    return decodeURIComponent(escape(atob(String(s).replace(/\s+/g, ''))));
  }

  // ---------- сериализация данных ----------

  function serialize(db) {
    return 'window.__PVB_DATA = ' + JSON.stringify(db, null, 2) + ';\n';
  }
  function parseText(text) {
    var t = String(text).replace(/^\uFEFF/, '');
    var i = t.indexOf('=');
    if (i < 0) throw new Error('data/db.js: не найден оператор присваивания');
    var s = t.slice(i + 1).trim();
    if (s.charAt(s.length - 1) === ';') s = s.slice(0, -1).trim();
    return JSON.parse(s);
  }

  // ---------- сессия ----------

  function readAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeAuth(a) {
    try {
      if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
      else localStorage.removeItem(AUTH_KEY);
    } catch (e) { /* quota — ignore */ }
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    var auth = readAuth();
    var headers = {
      'Accept': 'application/vnd.github+json'
    };
    if (auth && auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        var err = new Error('Токен недействителен (401). Сгенерируйте новый.');
        err.status = 401;
        throw err;
      }
      if (r.status === 403) {
        var err2 = new Error('Нет доступа к репозиторию (403). Токену нужна permission «Contents: Read and write» на репозиторий ' + CFG.repo + '.');
        err2.status = 403;
        throw err2;
      }
      if (!r.ok && r.status !== 404) {
        var err3 = new Error('GitHub API: HTTP ' + r.status);
        err3.status = r.status;
        throw err3;
      }
      return r.status === 404 ? null : r.json();
    });
  }

  function getUser() {
    return apiFetch('/user').then(function (j) {
      if (!j || !j.login) throw new Error('GitHub не вернул логин');
      return { login: j.login, isOwner: j.login.toLowerCase() === String(CFG.owner).toLowerCase() };
    });
  }

  // вход по токену: валидация + проверка владельца
  function loginWithToken(token) {
    token = String(token || '').trim();
    if (!token) return Promise.reject(new Error('Вставьте токен'));
    writeAuth({ token: token, login: null });
    return getUser().then(function (u) {
      if (!u.isOwner) {
        writeAuth(null);
        throw new Error('Токен от аккаунта «' + u.login + '», а владельцем задан «' + CFG.owner + '». Прав на редактирование нет.');
      }
      writeAuth({ token: token, login: u.login, ts: Date.now() });
      return u;
    }).catch(function (err) {
      writeAuth(null);
      throw err;
    });
  }

  function logout() { writeAuth(null); }

  // тихое восстановление сессии при старте
  function restoreSession() {
    var a = readAuth();
    if (!a || !a.token) return Promise.resolve(null);
    return getUser().then(function (u) {
      if (!u.isOwner) { writeAuth(null); return null; }
      writeAuth({ token: a.token, login: u.login, ts: Date.now() });
      return u;
    }).catch(function () {
      return null; // тихо: токен протух или сеть недоступна — работаем как гость
    });
  }

  function currentLogin() {
    var a = readAuth();
    return a && a.login ? a.login : null;
  }

  // ---------- локальный dev-режим ----------

  function isLocalDev() {
    return !!CFG.devMode && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
  }

  function canEdit() {
    if (isLocalDev()) return true;
    return !!(readAuth() && readAuth().login);
  }

  function devSave(text) {
    return fetch('/api/dev-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    }).then(function (r) {
      if (!r.ok) throw new Error('dev-save: HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'dev-save: ошибка записи');
      return { saved: true, dev: true };
    });
  }

  // ---------- Contents API ----------

  function contentsPath() {
    return '/repos/' + CFG.repo + '/contents/' + CFG.dataPath;
  }

  function readRemoteFile() {
    return apiFetch(contentsPath() + '?ref=' + encodeURIComponent(CFG.branch)).then(function (j) {
      if (!j) return null; // файла ещё нет
      return { sha: j.sha, text: b64ToUtf8(j.content) };
    });
  }

  function putFile(text, sha, message) {
    var body = {
      message: message,
      content: utf8ToB64(text),
      branch: CFG.branch
    };
    if (sha) body.sha = sha;
    return apiFetch(contentsPath(), { method: 'PUT', body: body }).then(function (j) {
      return { saved: true, sha: j && j.content ? j.content.sha : null, commit: j && j.commit ? j.commit.html_url : null };
    });
  }

  /**
   * save(db, expectedSha, label)
   *  -> { saved: true, dev?: true, noop?: true, sha?, commit? }
   *  -> { conflict: { data, sha } }   — удалённый файл чужой/новее
   *  -> { created?: ... } не требуется: если файла нет, PUT создаёт его
   */
  function save(db, expectedSha, label) {
    var text = serialize(db);
    if (isLocalDev()) return devSave(text);
    var message = CFG.commitPrefix + ': ' + (label || 'обновление данных');
    return readRemoteFile().then(function (remote) {
      if (!remote) return putFile(text, null, message);
      if (remote.text === text) return { saved: true, noop: true, sha: remote.sha };
      if (!expectedSha || remote.sha !== expectedSha) {
        var remoteData;
        try { remoteData = parseText(remote.text); } catch (e) { remoteData = null; }
        return { conflict: { data: remoteData, sha: remote.sha } };
      }
      return putFile(text, remote.sha, message);
    });
  }

  // перезапись при конфликте (по решению пользователя)
  function overwrite(db, sha, label) {
    if (isLocalDev()) return devSave(serialize(db));
    var message = CFG.commitPrefix + ': ' + (label || 'обновление данных') + ' (перезапись удалённой версии)';
    return putFile(serialize(db), sha, message);
  }

  // загрузка свежих данных с сервера (для владельца — всегда свежее Pages)
  function loadRemote() {
    return readRemoteFile().then(function (remote) {
      if (!remote) return { data: null, sha: null };
      return { data: parseText(remote.text), sha: remote.sha };
    });
  }

  window.__PVB_API = {
    loginWithToken: loginWithToken,
    logout: logout,
    restoreSession: restoreSession,
    currentLogin: currentLogin,
    canEdit: canEdit,
    isLocalDev: isLocalDev,
    save: save,
    overwrite: overwrite,
    loadRemote: loadRemote,
    serialize: serialize,
    parseText: parseText
  };
})();
