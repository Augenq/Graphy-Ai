# Frontend: сайт Graphy

React 19, TypeScript, Vite, компоненты `@maxhub/max-ui`, формулы KaTeX. Один и тот же сайт работает в браузере и внутри MAX WebView.

```bash
npm install
npm run dev          # http://localhost:5174, ожидает запущенный агент (см. ../README.md)
npm run typecheck
npm run build        # dist/, его раздаёт scripts/web-server.mjs
```

## Структура `src/`

| Путь | Что там |
|---|---|
| `App.tsx` | оболочка: маршруты по хэшу (`#s/<id>`, `#search`, `#settings/<раздел>`, `#school`), боковая панель, режимы адаптивной раскладки |
| `components/` | чат (`Chat`, `Composer`, `Blocks`), форма вопросов, настройки, поиск, панель файлов и плана |
| `components/school/` | вкладка «Школа»: экран учителя (`Teacher*`) и ученика (`Student*`) |
| `lib/` | клиент API и событий, состояние, вход через MAX (`max.ts`), школа (`school.ts`), переводы |
| `styles/` | стили по областям; токены цвета и размеров |

Тёмная и светлая темы, размер и ширина текста настраиваются в «Настройки → Внешний вид». Для телефонов отдельная раскладка (`styles/mobile.css`).
