/* PinVideoBoard — разбор ссылок на видео и получение метаданных */
(function () {
  'use strict';

  var PROVIDER_LABEL = {
    youtube: 'YouTube',
    vimeo: 'Vimeo',
    rutube: 'Rutube',
    vk: 'VK',
    direct: 'Файл',
    other: 'Другое'
  };

  // ---------- утилиты ----------

  function fetchJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('timeout')); }
      }, timeoutMs || 8000);
      fetch(url, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (json) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(json); }
      }).catch(function (err) {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });
    });
  }

  function withScheme(url) {
    url = (url || '').trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    return url;
  }

  // ---------- парсеры провайдеров ----------

  var YT_ID = '[A-Za-z0-9_-]{11}';

  function parseYouTube(u) {
    var m;
    // youtu.be/<id>
    if ((m = u.match(new RegExp('^https?://(?:www\\.)?youtu\\.be/(' + YT_ID + ')', 'i')))) return m[1];
    // youtube.com/watch?v=<id> (с дополнительными параметрами тоже: watch?t=1&v=<id>)
    if ((m = u.match(new RegExp('^https?://(?:www\\.|m\\.|music\\.)?(?:youtube(?:-nocookie)?)\\.com/watch\\?(?:[^#]*[?&])?v=(' + YT_ID + ')', 'i')))) return m[1];
    // /shorts/, /embed/, /live/, /v/
    if ((m = u.match(new RegExp('^https?://(?:www\\.|m\\.)?(?:youtube(?:-nocookie)?)\\.com/(?:shorts|embed|live|v)/(' + YT_ID + ')', 'i')))) return m[1];
    return null;
  }

  function parseVimeo(u) {
    var m = u.match(/^https?:\/\/(?:www\.)?(?:player\.)?vimeo\.com\/(?:.*\/)?(\d+)(?:[?#].*)?$/i);
    return m ? m[1] : null;
  }

  function parseRutube(u) {
    var m = u.match(/^https?:\/\/rutube\.ru\/(?:video|play\/embed|shorts|video\/private)\/([0-9a-f]{32})/i);
    return m ? m[1] : null;
  }

  function parseVK(u) {
    var m = u.match(/^https?:\/\/(?:vk\.com|vkvideo\.ru|vkvideo\.com|m\.vk\.com)\/(?:video|clip)(-?\d+)_(\d+)/i);
    return m ? { oid: m[1], id: m[2] } : null;
  }

  function isDirect(u) {
    return /\.(mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(u);
  }

  // parse(url) -> { provider, vid, vk, url } | null (url можно распознать, но провайдер неизвестен -> other)
  function parse(url) {
    var u = withScheme(url);
    if (!u) return null;
    var yt = parseYouTube(u);
    if (yt) return { provider: 'youtube', vid: yt, url: u };
    var vm = parseVimeo(u);
    if (vm) return { provider: 'vimeo', vid: vm, url: u };
    var rt = parseRutube(u);
    if (rt) return { provider: 'rutube', vid: rt, url: u };
    var vk = parseVK(u);
    if (vk) return { provider: 'vk', vk: vk, url: u };
    if (isDirect(u)) return { provider: 'direct', vid: null, url: u };
    // незнакомый хост — всё равно разрешим сохранить как «другое»
    return { provider: 'other', vid: null, url: u };
  }

  // каноническая ссылка для резолверов oEmbed (повышает шанс ответа)
  function canonicalUrl(info) {
    if (info.provider === 'youtube' && info.vid) return 'https://www.youtube.com/watch?v=' + info.vid;
    if (info.provider === 'vimeo' && info.vid) return 'https://vimeo.com/' + info.vid;
    if (info.provider === 'rutube' && info.vid) return 'https://rutube.ru/video/' + info.vid + '/';
    return info.url;
  }

  // ---------- резолверы метаданных ----------

  function noembedMeta(info) {
    return fetchJSON('https://noembed.com/embed?url=' + encodeURIComponent(canonicalUrl(info)), 8000)
      .then(function (r) {
        if (!r || r.error || !r.title) throw new Error('noembed: пусто');
        return { title: r.title, thumb: r.thumbnail_url || null, source: 'noembed' };
      });
  }

  function vimeoMeta(info) {
    return fetchJSON('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(canonicalUrl(info)), 8000)
      .then(function (r) {
        if (!r || !r.title) throw new Error('vimeo: пусто');
        return { title: r.title, thumb: r.thumbnail_url || null, duration: r.duration || 0, source: 'vimeo' };
      });
  }

  function rutubeMeta(info) {
    return fetchJSON('https://rutube.ru/api/oembed/?url=' + encodeURIComponent(canonicalUrl(info)) + '&format=json', 8000)
      .then(function (r) {
        if (!r || !r.title) throw new Error('rutube: пусто');
        return { title: r.title, thumb: r.thumbnail_url || null, source: 'rutube' };
      });
  }

  function tryDevDuration(vid) {
    if (typeof window === 'undefined' || !window.location) return Promise.resolve(0);
    var h = window.location.hostname;
    if (h !== '127.0.0.1' && h !== 'localhost') return Promise.resolve(0);
    return fetchJSON('/api/dev-duration?vid=' + encodeURIComponent(vid), 4000)
      .then(function (r) { return (r && r.duration) ? Number(r.duration) : 0; })
      .catch(function () { return 0; });
  }

  // название YouTube без API-ключа: скрытый плеер IFrame API, getVideoData().title
  var ytApiLoading = false;
  function ensureYtApi(cb) {
    if (window.YT && window.YT.Player) return cb(window.YT);
    if (!document.getElementById('pvb-yt-api')) {
      ytApiLoading = true;
      var s = document.createElement('script');
      s.id = 'pvb-yt-api';
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = function () { ytApiLoading = false; };
      document.head.appendChild(s);
    }
    var t0 = Date.now();
    (function wait() {
      if (window.YT && window.YT.Player) { ytApiLoading = false; return cb(window.YT); }
      if (Date.now() - t0 > 10000) return cb(null);
      setTimeout(wait, 200);
    })();
  }

  function ytApiMeta(info) {
    return new Promise(function (resolve) {
      var finished = false;
      var timer = setTimeout(function () { finish(null); }, 15000);
      function finish(val) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(val);
      }
      ensureYtApi(function (YT) {
        if (!YT) return finish(null);
        var host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:180px;visibility:hidden;';
        document.body.appendChild(host);
        var player = null;
        function cleanup() {
          try { if (player && player.destroy) player.destroy(); } catch (e) { /* ignore */ }
          try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (e) { /* ignore */ }
        }
        try {
          player = new YT.Player(host, {
            videoId: info.vid,
            playerVars: { disablekb: 1, mute: 1, autoplay: 0 },
            events: {
              onReady: function () {
                var checkCount = 0;
                function check() {
                  try {
                    var d = player.getVideoData ? player.getVideoData() : null;
                    var dur = 0;
                    try { dur = Math.round(player.getDuration() || 0); } catch (e) {}
                    if (dur > 0 || checkCount >= 8) {
                      cleanup();
                      finish((d && d.title) || dur ? { title: d ? d.title : '', duration: dur, source: 'yt-api' } : null);
                      return;
                    }
                  } catch (e) {
                    cleanup();
                    finish(null);
                    return;
                  }
                  checkCount++;
                  setTimeout(check, 250);
                }
                check();
              },
              onError: function () { cleanup(); finish(null); }
            }
          });
        } catch (e) { cleanup(); finish(null); }
      });
    });
  }

  // resolve(url) -> Promise<{ title, thumb, duration, provider, vid, vk, url, source } | null>
  // null = распознать не удалось совсем (ссылка не похожа на видео)
  function resolve(url) {
    var info = parse(url);
    if (!info || !info.url) return Promise.resolve(null);

    function ok(meta) {
      meta.provider = info.provider;
      meta.vid = info.vid || null;
      meta.vk = info.vk || null;
      meta.url = info.url;
      if (!meta.thumb && info.provider === 'youtube' && info.vid) {
        meta.thumb = 'https://i.ytimg.com/vi/' + info.vid + '/maxresdefault.jpg';
      }
      if (typeof meta.duration !== 'number') meta.duration = 0;
      return meta;
    }
    function fallback() {
      if (info.provider === 'youtube' && info.vid) {
        return ytApiMeta(info).then(function (m) { return m ? ok(m) : ok({ title: '', thumb: null, duration: 0, source: '' }); });
      }
      return Promise.resolve(ok({ title: '', thumb: null, duration: 0, source: '' }));
    }

    var chain;
    if (info.provider === 'vimeo') {
      chain = vimeoMeta(info).catch(function () { return noembedMeta(info); });
    } else if (info.provider === 'rutube') {
      chain = rutubeMeta(info).catch(function () { return noembedMeta(info); });
    } else {
      chain = noembedMeta(info);
    }
    return chain.then(ok).catch(fallback).then(function (meta) {
      if (!meta) return null;
      if (info.provider === 'youtube' && info.vid && (!meta.duration || meta.duration <= 0)) {
        return tryDevDuration(info.vid).then(function (devDur) {
          if (devDur > 0) {
            meta.duration = devDur;
            return meta;
          }
          return ytApiMeta(info).then(function (ytMeta) {
            if (ytMeta && ytMeta.duration > 0) {
              meta.duration = ytMeta.duration;
            }
            return meta;
          }).catch(function () { return meta; });
        });
      }
      return meta;
    });
  }

  // ---------- превью и встраивание ----------

  // цепочка превью для YouTube: maxres -> hq -> mq
  function thumbFallbacks(tile) {
    if (tile.provider === 'youtube' && tile.vid) {
      return [
        'https://i.ytimg.com/vi/' + tile.vid + '/maxresdefault.jpg',
        'https://i.ytimg.com/vi/' + tile.vid + '/hqdefault.jpg',
        'https://i.ytimg.com/vi/' + tile.vid + '/mqdefault.jpg'
      ];
    }
    return tile.thumb ? [tile.thumb] : [];
  }

  // embedUrl -> iframe src; для direct/null вернёт null (плеер <video> или заглушка)
  function embedUrl(tile) {
    if (tile.provider === 'youtube' && tile.vid) {
      return 'https://www.youtube-nocookie.com/embed/' + tile.vid + '?autoplay=1&rel=0&modestbranding=1';
    }
    if (tile.provider === 'vimeo' && tile.vid) {
      return 'https://player.vimeo.com/video/' + tile.vid + '?autoplay=1';
    }
    if (tile.provider === 'rutube' && tile.vid) {
      return 'https://rutube.ru/play/embed/' + tile.vid + '?autoplay=1';
    }
    if (tile.provider === 'vk' && tile.vk) {
      return 'https://vk.com/video_ext.php?oid=' + encodeURIComponent(tile.vk.oid) + '&id=' + encodeURIComponent(tile.vk.id) + '&hd=2&autoplay=1';
    }
    return null;
  }

  function providerLabel(p) { return PROVIDER_LABEL[p] || PROVIDER_LABEL.other; }

  function fmtDuration(sec) {
    sec = Math.round(sec || 0);
    if (!sec || sec < 0) return '';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return h ? h + ':' + p2(m) + ':' + p2(s) : m + ':' + p2(s);
  }

  function parseDuration(val) {
    if (typeof val === 'number') return Math.max(0, Math.round(val));
    if (!val || typeof val !== 'string') return 0;
    val = val.trim();
    if (!val) return 0;
    if (/^\d+$/.test(val)) return parseInt(val, 10);
    var parts = val.split(':').map(function (p) { return p.trim(); });
    if (parts.length === 2) {
      var m = parseInt(parts[0], 10) || 0;
      var s = parseInt(parts[1], 10) || 0;
      return m * 60 + s;
    }
    if (parts.length === 3) {
      var h = parseInt(parts[0], 10) || 0;
      var m = parseInt(parts[1], 10) || 0;
      var s = parseInt(parts[2], 10) || 0;
      return h * 3600 + m * 60 + s;
    }
    var iso = val.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
    if (iso && (iso[1] || iso[2] || iso[3])) {
      return (parseInt(iso[1] || 0, 10) * 3600) + (parseInt(iso[2] || 0, 10) * 60) + parseInt(iso[3] || 0, 10);
    }
    return 0;
  }

  window.__PVB_VIDEOS = {
    parse: parse,
    resolve: resolve,
    embedUrl: embedUrl,
    thumbFallbacks: thumbFallbacks,
    providerLabel: providerLabel,
    fmtDuration: fmtDuration,
    parseDuration: parseDuration,
    canonicalUrl: canonicalUrl
  };
})();
