/* PinVideoBoard — конфигурация */
window.__PVB_CONFIG = {
  // владелец репозитория — только его логин получает права редактирования
  owner: 'Mmitekk',
  // репозиторий для GitHub Contents API (чтение/запись data/db.js)
  repo: 'Mmitekk/PinVideoBoard',
  branch: 'main',
  dataPath: 'data/db.js',
  // префикс сообщений коммитов, которые делает сайт
  commitPrefix: 'PinVideoBoard',
  // DEV_MODE: на localhost разрешает сохранение без токена через tools/dev-server.mjs.
  // На GitHub Pages флаг инертен (там localhost-условие не выполняется).
  devMode: true
};
