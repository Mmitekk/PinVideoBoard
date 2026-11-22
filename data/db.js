// PinVideoBoard — данные досок.
// Файл редактируется самим сайтом (вход по GitHub-токену) и коммитится в репозиторий.
// Структура: window.__PVB_DATA = { version, updatedAt, boards: [ { id, name, createdAt, columns: [ {id,name,color} ], tiles: [ {id, columnId, url, provider, vid, title, thumb, duration, tags, note, addedAt} ] } ] }
window.__PVB_DATA = {
  "version": 1,
  "updatedAt": "2026-11-22T00:00:00.000Z",
  "boards": [
    {
      "id": "b-main",
      "name": "Основная",
      "createdAt": "2026-11-22T00:00:00.000Z",
      "columns": [
        { "id": "c-later", "name": "Смотреть позже", "color": "#4a9eff" },
        { "id": "c-watching", "name": "Смотрю", "color": "#d29922" },
        { "id": "c-done", "name": "Просмотрено", "color": "#3fb950" }
      ],
      "tiles": []
    }
  ]
};
